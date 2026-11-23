/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// pr restack（PW-PR-RESTACK-*）を、runCli をプロセス内で呼んで確かめる。
// GitHub は偽サーバ、git は一時リポ（origin は bare）で、実際の git を動かす。
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { verifies } from '../_helpers/verifies.js'
import { lines, operationsOf, stateFile } from '../_helpers/workspace-inspect.js'
import { AMBIGUOUS_MESSAGE, ambiguousWorkspaceFiles, NO_ACTIVE_FILES, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { finishPullRequestData, graphql, openWorkspace, rest } from '../_helpers/workspace.js'
import type { ConfigOptions, FinishPullRequestSample, Workspace } from '../_helpers/workspace.js'
import type { ResponseRule } from '../fake-github/server.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { PUSH_TIMEOUT_MILLISECONDS } from '../../src/infra/git.js'

useIsolatedEnvironment()

// 30 秒かかる pre-push のフックを置き、そのパスを返す。時間切れの後にすぐ返らないと、テストの時間切れで落ちる
function installSlowPrePush(workspace: Readonly<Workspace>): string {
  const hooks = path.resolve(workspace.directory, workspace.git(['rev-parse', '--git-path', 'hooks']).trim())
  mkdirSync(hooks, { recursive: true })
  const hook = path.join(hooks, 'pre-push')
  writeFileSync(hook, '#!/bin/sh\nexec sleep 30\n')
  chmodSync(hook, 0o755)
  return hook
}

// 下の段は Issue #11 の feat/demo/11、上の段は Issue #12 の feat/demo/12
const LOWER = 'feat/demo/11'
const UPPER = 'feat/demo/12'
const BASE_FILE = stateFile('.pecot-base')
const PROGRESS_FILE = stateFile('.pecot-restack')

function lowerPullRequests(state: 'OPEN' | 'MERGED' | 'CLOSED' | undefined, times = 1): ResponseRule {
  const node = { number: 20, state, headRefName: LOWER, baseRefName: 'main', isDraft: false, isCrossRepository: false, repository: { owner: { login: 'acme' }, name: 'demo' } }
  const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: state === undefined ? [] : [node] } } }
  return graphql('ListPullRequestsByHead', data, { variables: { headRefName: LOWER }, times })
}

const UPPER_PULL_REQUEST = '/repos/acme/demo/pulls/21'
const UPPER_BODY = 'upper\n\nCloses #12'

// 上の段の PR。open なら main に向いた PR #21、省くと PR は無い
function upperPullRequests(state?: 'OPEN'): ResponseRule {
  const node = { number: 21, state, headRefName: UPPER, baseRefName: 'main', isDraft: false, isCrossRepository: false, repository: { owner: { login: 'acme' }, name: 'demo' } }
  const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: state === undefined ? [] : [node] } } }
  return graphql('ListPullRequestsByHead', data, { variables: { headRefName: UPPER } })
}

// 上の段の PR #21 の本文・base・リンク済みの Issue。既定は、main に向き、Closes #12 がまだリンクになっていない
function upperDetail(sample: Readonly<FinishPullRequestSample> = {}): ResponseRule {
  return graphql('GetPullRequestForFinish', finishPullRequestData({ state: 'OPEN', body: UPPER_BODY, head: UPPER, closing: [], ...sample }), { variables: { number: 21 } })
}

// 上の段の PR の本文を読み、保存し直す応答
const RESAVE_RULES: readonly ResponseRule[] = [
  upperPullRequests('OPEN'),
  upperDetail(),
  rest('PATCH', UPPER_PULL_REQUEST, 200, { number: 21, body: UPPER_BODY }),
]
const RELINKED = 'updated: PR #21 relinked to its closing Issues\n'
const PLANNED_RELINK = `dry-run: would update PR of ${UPPER} relinked to its closing Issues\n`

function commitFile(workspace: Readonly<Workspace>, file: string, content: string, message: string): void {
  writeFileSync(path.join(workspace.directory, file), content)
  workspace.git(['add', file])
  workspace.git(['commit', '-m', message])
}

function head(workspace: Readonly<Workspace>, reference = 'HEAD'): string {
  return workspace.git(['rev-parse', reference]).trim()
}

// 1〜20 の行のファイル。changed の行だけを、その文字列に替える
function numbered(changed: Readonly<Record<number, string>>): string {
  return Array.from({ length: 20 }, (_, index) => `${changed[index + 1] ?? String(index + 1)}\n`).join('')
}

// 上の段の base の記録を、下の段の今の remote の先頭で書く
function recordLowerBase(workspace: Readonly<Workspace>): void {
  const target = path.join(workspace.directory, BASE_FILE)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11\n`)
}

interface StackedOptions {
  readonly github?: readonly ResponseRule[]
  /**
  false なら、上の段を push しない
  */
  readonly isPushed?: boolean
  readonly config?: ConfigOptions | false
  readonly files?: Readonly<Record<string, string>>
}

// main の上に下の段、その上に上の段を積み、上の段を checkout して base の記録を書く
async function openStacked(options: Readonly<StackedOptions> = {}): Promise<Workspace> {
  const workspace = await openWorkspace({
    branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'lower.txt': '1\n' } }] }],
    github: options.github ?? [],
    ...options.config !== undefined && { config: options.config },
    ...options.files !== undefined && { files: options.files },
  })
  workspace.git(['checkout', '-b', UPPER, `origin/${LOWER}`])
  commitFile(workspace, 'upper.txt', 'upper\n', 'upper')
  if (options.isPushed !== false) workspace.git(['push', '-u', 'origin', UPPER])
  recordLowerBase(workspace)
  return workspace
}

// #12 の判定。#11 の PR #20 が開いていれば stackable、前提が無ければ startable
const STACKABLE_RULE = prerequisitesRule({ number: 12, blockedBy: [{ number: 11, branch: LOWER, pullRequests: [{ number: 20, head: LOWER }] }] })
const STARTABLE_RULE = prerequisitesRule({ number: 12 })

// 記録を置かずに、main の上に下の段、その上に上の段を積んで push する。別の worktree や clone で checkout したのと同じ形
async function openInferred(github: readonly ResponseRule[]): Promise<Workspace> {
  const workspace = await openWorkspace({ baseRecord: false, branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'lower.txt': '1\n' } }] }], github })
  workspace.git(['checkout', '-b', UPPER, `origin/${LOWER}`])
  commitFile(workspace, 'upper.txt', 'upper\n', 'upper')
  workspace.git(['push', '-u', 'origin', UPPER])
  return workspace
}

// 下の段を、進めた main の上へ載せ直して force-push する。上の段は古い下の段の上に残る
function rebaseLowerOntoAdvancedMain(workspace: Readonly<Workspace>): void {
  pushTo(workspace, 'origin/main', 'main', 'main.txt', 'main\n')
  workspace.git(['checkout', '-b', 'rebased-lower', `origin/${LOWER}`])
  workspace.git(['rebase', 'origin/main'])
  workspace.git(['push', '--force', 'origin', `HEAD:refs/heads/${LOWER}`])
  workspace.git(['checkout', UPPER])
  workspace.git(['fetch', 'origin'])
}

// 別のブランチでコミットを作り、origin の target へ push して、上の段に戻る
function pushTo(workspace: Readonly<Workspace>, from: string, target: string, file: string, content: string): void {
  workspace.git(['checkout', '-b', `work-${target.replaceAll('/', '-')}`, from])
  commitFile(workspace, file, content, `change ${file}`)
  workspace.git(['push', '--force', 'origin', `HEAD:refs/heads/${target}`])
  workspace.git(['checkout', UPPER])
}

// 下の段を squash で main へ入れ、下の段のブランチを消す
function mergeLower(workspace: Readonly<Workspace>): void {
  pushTo(workspace, 'origin/main', 'main', 'lower.txt', '1\n')
  workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
}

// GitHub がマージの後に行う書き換え。上の段のコミットを、新しい main の上に作り直して置き換える
function rewriteUpperOnRemote(workspace: Readonly<Workspace>): void {
  workspace.git(['fetch', 'origin'])
  workspace.git(['checkout', '-b', 'rewritten', 'origin/main'])
  workspace.git(['cherry-pick', UPPER])
  workspace.git(['commit', '--amend', '--no-edit', '--date', '2001-01-01T00:00:00Z'])
  workspace.git(['push', '--force', 'origin', `HEAD:refs/heads/${UPPER}`])
  workspace.git(['checkout', UPPER])
}

function preReceiveHook(workspace: Readonly<Workspace>): string {
  return path.join(workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim(), 'hooks', 'pre-receive')
}

// origin への push を、すべて拒む
function rejectPushes(workspace: Readonly<Workspace>): void {
  const hook = preReceiveHook(workspace)
  mkdirSync(path.dirname(hook), { recursive: true })
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
}

function allowPushes(workspace: Readonly<Workspace>): void {
  rmSync(preReceiveHook(workspace))
}

// origin/main の上で lower.txt を content にしたコミットを作り、origin の target へ force push する
function pushLowerFileOnMain(workspace: Readonly<Workspace>, target: string, content: string): void {
  workspace.git(['checkout', '--detach', 'origin/main'])
  commitFile(workspace, 'lower.txt', content, `lower ${content.trim()}`)
  workspace.git(['push', '--force', 'origin', `HEAD:refs/heads/${target}`])
  workspace.git(['checkout', UPPER])
}

// 下の段を、main の上の別のコミットに書き換える
function rewriteLower(workspace: Readonly<Workspace>, content: string): void {
  pushLowerFileOnMain(workspace, LOWER, content)
}

// push を拒ませて打ち、手元だけが載せ直された形にしてから、push を許す
async function restackLocallyOnly(workspace: Readonly<Workspace>): Promise<void> {
  rejectPushes(workspace)
  const rejected = await workspace.run(['pr', 'restack'])
  expect(lines(rejected.stderr)[0]).toMatch(/^error: push was rejected: /u)
  allowPushes(workspace)
}

// HEAD の reflog のうち、rebase が書いた項目の数。rebase は、コミットを作り直さずに済んでも項目を書く
function rebaseEntries(workspace: Readonly<Workspace>): number {
  return lines(workspace.git(['reflog', '--format=%gs', 'HEAD'])).filter(line => line.startsWith('rebase')).length
}

function subjectsBetween(workspace: Readonly<Workspace>, from: string, to: string): readonly string[] {
  return lines(workspace.git(['log', '--format=%s', `${from}..${to}`]))
}

// 下の段と上の段が同じファイルを足して、載せ直しが衝突する形にする
function makeConflict(workspace: Readonly<Workspace>): void {
  pushTo(workspace, `origin/${LOWER}`, LOWER, 'upper.txt', 'lower\n')
}

async function callTool(workspace: Readonly<Workspace>, arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const previous = process.cwd()
  process.chdir(workspace.directory)
  try {
    return await callToolOnce(COMMANDS, 'pr_restack', arguments_)
  }
  finally {
    process.chdir(previous)
  }
}

describe('pr restack', () => {
  describe('--check', () => {
    it('下の段が動いていないと、up to date の行を標準出力に出す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on ${LOWER}\n`, stderr: '' })
    })

    it('下の段にコミットが足されていると、base moved を添えた needs restack の行を出す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      workspace.advanceRemote(LOWER)
      const before = head(workspace)
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} on ${LOWER} (base moved)\n`, stderr: '' })
      expect(head(workspace)).toBe(before)
    })

    it('下の段の PR がマージ済みだと、needs restack の行に開発ブランチと PR の番号を出す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
      mergeLower(workspace)
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} onto main (base #20 merged)\n`, stderr: '' })
    })

    it('未コミットの変更があっても、確かめて終了コード 0 で終わる', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      writeFileSync(path.join(workspace.directory, 'upper.txt'), 'edited\n')
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result.code).toBe(0)
    })
  })

  it('下の段にコミットが足されていると、載せ直して push し、base の記録を新しい位置に書き直す', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    workspace.advanceRemote(LOWER)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
    const lowerHead = head(workspace, `origin/${LOWER}`)
    expect(head(workspace, 'HEAD~1')).toBe(lowerHead)
    expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(head(workspace))
    expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${lowerHead} acme/demo#11`)
    expect(workspace.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(UPPER)
  })

  it('--dry-run を付けると、載せ直しと push をせずに、する予定を dry-run の行で出す', async (context) => {
    await verifies(context, 'PW-PR-RESTACK-22')
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    workspace.advanceRemote(LOWER)
    const before = head(workspace)
    const record = workspace.read(BASE_FILE)
    rejectPushes(workspace)
    const result = await workspace.run(['pr', 'restack', '--dry-run'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would update ${UPPER} restacked on ${LOWER}\n` })
    expect(head(workspace)).toBe(before)
    expect(workspace.read(BASE_FILE)).toBe(record)
  })

  it('下の段がマージ済みで、GitHub が上の段を書き換えていると、push せずに remote へ合わせ、記録を開発ブランチに変える', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...RESAVE_RULES] })
    mergeLower(workspace)
    rewriteUpperOnRemote(workspace)
    const rewritten = workspace.remoteGit(['rev-parse', UPPER]).trim()
    rejectPushes(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} synced with origin/${UPPER}\n${RELINKED}` })
    expect(head(workspace)).toBe(rewritten)
    expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
    expect(workspace.requests().find(request => request.type === 'rest' && request.method === 'PATCH')).toMatchObject({ path: UPPER_PULL_REQUEST, body: { body: UPPER_BODY } })
  })

  it('下の段の直しが上の段の変更の近くに入ってからマージされても、GitHub が書き換えた上の段へ合わせる', async () => {
    const workspace = await openWorkspace({
      branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'f.txt': numbered({ 2: 'lower' }) } }] }],
      github: [lowerPullRequests('MERGED'), upperPullRequests()],
    })
    workspace.git(['checkout', '-b', UPPER, `origin/${LOWER}`])
    commitFile(workspace, 'f.txt', numbered({ 2: 'lower', 8: 'upper' }), 'upper')
    workspace.git(['push', '-u', 'origin', UPPER])
    recordLowerBase(workspace)
    // 下の段の直し（5 行目）は、上の段の変更（8 行目）の前後 3 行に入る
    pushTo(workspace, 'origin/main', 'main', 'f.txt', numbered({ 2: 'lower', 5: 'fixed' }))
    workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    rewriteUpperOnRemote(workspace)
    const rewritten = workspace.remoteGit(['rev-parse', UPPER]).trim()
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} synced with origin/${UPPER}\n` })
    expect(head(workspace)).toBe(rewritten)
  })

  it('下の段がマージ済みで、remote の上の段が書き換わっていないと、開発ブランチへ載せ直して push する', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...RESAVE_RULES] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n${RELINKED}` })
    expect(head(workspace, 'HEAD~1')).toBe(head(workspace, 'origin/main'))
    expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(head(workspace))
    expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
  })

  it('開発ブランチへ載せ直しても、上の段の PR が無ければ、本文を保存し直さない', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), upperPullRequests()] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
    expect(operationsOf(workspace)).not.toContain(`PATCH ${UPPER_PULL_REQUEST}`)
  })

  it('下の段に積んだまま載せ直すと、上の段の PR を引かず、本文を保存し直さない', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    workspace.advanceRemote(LOWER)
    const result = await workspace.run(['pr', 'restack'])
    expect(result.code).toBe(0)
    expect(operationsOf(workspace)).toStrictEqual(['ListPullRequestsByHead'])
  })

  it('本文の保存し直しが失敗すると、手で保存し直す案内を添えた warning を出して終了コード 0 で終わる', async () => {
    const failing = [upperPullRequests('OPEN'), upperDetail(), rest('PATCH', UPPER_PULL_REQUEST, 500, { message: 'failure' })]
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...failing] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result.code).toBe(0)
    const stderr = lines(result.stderr)
    expect(stderr[0]).toBe(`updated: ${UPPER} restacked on main`)
    expect(stderr[1]).toMatch(/^warning: cannot relink PR #21 to its closing Issues: /u)
    expect(stderr.at(-1)).toBe('  to link them, save the body of PR #21 again on GitHub without changes')
    expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
  })

  it.for([
    { name: 'PR の base が既定のブランチでない', sample: { defaultBranch: 'trunk' } },
    { name: '本文に閉じるキーワードが無い', sample: { body: 'upper' } },
    { name: '本文の Issue が既にリンクされている', sample: { closing: [12] } },
  ])('$name とき、PR の本文を保存し直さない', async ({ sample }) => {
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), upperPullRequests('OPEN'), upperDetail(sample)] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
    expect(operationsOf(workspace)).not.toContain(`PATCH ${UPPER_PULL_REQUEST}`)
  })

  it('下の段のマージの後に --dry-run を付けると、載せ直しと保存し直しの予定を出し、GitHub に書き込まない', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack', '--dry-run'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would update ${UPPER} restacked on main\n${PLANNED_RELINK}` })
    expect(operationsOf(workspace)).toStrictEqual(['ListPullRequestsByHead'])
  })

  it('下の段が動いていないと、何も変えずに unchanged の行を出す', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    const before = head(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `unchanged: ${UPPER} is up to date\n` })
    expect(head(workspace)).toBe(before)
  })

  it('載せ直しが衝突すると、衝突したファイルと続行・取りやめの案内を出して、終了コード 3 で終わる', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    makeConflict(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result.code).toBe(3)
    expect(lines(result.stderr)).toStrictEqual([
      'error: conflict in upper.txt',
      '  resolve the conflicts and git add the files, then run: pecot pr restack --continue',
      '  or go back to the position before the restack: pecot pr restack --abort',
    ])
    expect(workspace.exists(PROGRESS_FILE)).toBe(true)
  })

  it('未コミットの変更があると、載せ直さずに終了コード 2 で終わる', async () => {
    const workspace = await openStacked()
    writeFileSync(path.join(workspace.directory, 'upper.txt'), 'edited\n')
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 2, stdout: '', stderr: 'error: working tree has uncommitted changes\n' })
    expect(operationsOf(workspace)).toStrictEqual([])
  })

  it.for<{ readonly name: string, readonly state: 'CLOSED' | undefined, readonly expected: string }>([
    { name: 'PR が閉じている', state: 'CLOSED', expected: `error: base branch ${LOWER} is gone and PR #20 was not merged\n` },
    { name: 'PR が無い', state: undefined, expected: `error: base branch ${LOWER} is gone and it has no merged PR\n` },
  ])('下の段のブランチが消えていて、$name と、終了コード 1 で終わる', async (row) => {
    const workspace = await openStacked({ github: [lowerPullRequests(row.state)] })
    workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: row.expected })
  })

  it('開発ブランチから着手した記録があると、fetch と載せ直しをせずに up to date と出す', async () => {
    const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }] })
    workspace.advanceRemote('main')
    const tracked = head(workspace, 'origin/main')
    expect(await workspace.run(['pr', 'restack', '--check'])).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on main\n`, stderr: '' })
    expect(await workspace.run(['pr', 'restack'])).toStrictEqual({ code: 0, stdout: '', stderr: `unchanged: ${UPPER} is up to date\n` })
    expect(head(workspace, 'origin/main')).toBe(tracked)
  })

  it('記録が無く、判定が startable なら、fetch してから判定を読み、載せ直さずに up to date と出す', async () => {
    const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }], baseRecord: false, github: [STARTABLE_RULE, STARTABLE_RULE] })
    workspace.advanceRemote('main')
    const tracked = head(workspace, 'origin/main')
    expect(await workspace.run(['pr', 'restack', '--check'])).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on main\n`, stderr: '' })
    expect(await workspace.run(['pr', 'restack'])).toStrictEqual({ code: 0, stdout: '', stderr: `unchanged: ${UPPER} is up to date\n` })
    expect(head(workspace, 'origin/main')).not.toBe(tracked)
  })

  describe('記録が無い作業ディレクトリ', () => {
    it('判定が stackable で下の段にコミットが足されていると、下の段の上に載せ直し、積んだ記録を書く', async () => {
      const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
      workspace.advanceRemote(LOWER)
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
      const lowerHead = head(workspace, `origin/${LOWER}`)
      expect(head(workspace, 'HEAD~1')).toBe(lowerHead)
      expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${lowerHead} acme/demo#11`)
    })

    it('下の段を載せ直して force-push した後も、下の段に積んだものとして base moved を出す', async () => {
      const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
      rebaseLowerOntoAdvancedMain(workspace)
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} on ${LOWER} (base moved)\n`, stderr: '' })
    })

    it('下の段の追跡参照が手元に無くても、求める前に fetch して、下の段に積んだものとして扱う', async () => {
      const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
      workspace.git(['update-ref', '-d', `refs/remotes/origin/${LOWER}`])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on ${LOWER}\n`, stderr: '' })
    })

    it('判定が blocked なら、warning を出し、積んでいないものとして up to date と出す', async () => {
      const blocked = prerequisitesRule({ number: 12, blockedBy: [{ number: 11 }] })
      const workspace = await openInferred([blocked])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`up to date: ${UPPER} on main\n`)
      expect(result.stderr).toMatch(/^warning: cannot infer the stacked base: blocked by #11/u)
    })

    it('載せ直しが衝突すると、途中の記録に載せ直す前の記録の位置を書き、--continue で終える', async () => {
      const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
      const recorded = head(workspace, `origin/${LOWER}`)
      makeConflict(workspace)
      const conflicted = await workspace.run(['pr', 'restack'])
      expect(conflicted.code).toBe(3)
      expect(workspace.read(PROGRESS_FILE).trim().split(' ').at(-1)).toBe(recorded)
      writeFileSync(path.join(workspace.directory, 'upper.txt'), 'resolved\n')
      workspace.git(['add', 'upper.txt'])
      const result = await workspace.run(['pr', 'restack', '--continue'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
      expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11`)
    })
  })

  it('remote に上の段のブランチが無いと、載せ直すだけで push しない', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], isPushed: false })
    workspace.advanceRemote(LOWER)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
    expect(head(workspace, 'HEAD~1')).toBe(head(workspace, `origin/${LOWER}`))
    expect(workspace.remoteGit(['branch', '--list', UPPER]).trim()).toBe('')
  })

  it('--abort を付けると、載せ直しの前の位置に戻し、途中の記録を消す', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    const before = head(workspace)
    const record = workspace.read(BASE_FILE)
    makeConflict(workspace)
    await workspace.run(['pr', 'restack'])
    const result = await workspace.run(['pr', 'restack', '--abort'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `unchanged: ${UPPER} restack aborted\n` })
    expect(head(workspace)).toBe(before)
    expect(workspace.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(UPPER)
    expect(workspace.read(BASE_FILE)).toBe(record)
    expect(workspace.exists(PROGRESS_FILE)).toBe(false)
  })

  it('衝突を解いてから --continue を付けると、載せ直しを終えて push し、記録を書き直す', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    makeConflict(workspace)
    await workspace.run(['pr', 'restack'])
    writeFileSync(path.join(workspace.directory, 'upper.txt'), 'resolved\n')
    workspace.git(['add', 'upper.txt'])
    const result = await workspace.run(['pr', 'restack', '--continue'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
    expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(head(workspace))
    expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11`)
    expect(workspace.exists(PROGRESS_FILE)).toBe(false)
  })

  it('下の段がマージ済みで衝突を解いてから --continue を付けると、載せ直しを終えて、PR の本文を保存し直す', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...RESAVE_RULES] })
    pushTo(workspace, 'origin/main', 'main', 'upper.txt', 'main\n')
    workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    const stopped = await workspace.run(['pr', 'restack'])
    expect(stopped.code).toBe(3)
    writeFileSync(path.join(workspace.directory, 'upper.txt'), 'resolved\n')
    workspace.git(['add', 'upper.txt'])
    const planned = await workspace.run(['pr', 'restack', '--continue', '--dry-run'])
    expect(planned).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would update ${UPPER} restacked on main\n${PLANNED_RELINK}` })
    const result = await workspace.run(['pr', 'restack', '--continue'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n${RELINKED}` })
  })

  it('衝突を解かずに --continue を付けると、もう一度終了コード 3 で終わる', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    makeConflict(workspace)
    await workspace.run(['pr', 'restack'])
    const result = await workspace.run(['pr', 'restack', '--continue'])
    expect(result.code).toBe(3)
    expect(lines(result.stderr)[0]).toBe('error: conflict in upper.txt')
    expect(workspace.exists(PROGRESS_FILE)).toBe(true)
  })

  it('利用者が自分で rebase を終えた後に --continue を付けると、push して base の記録を書き直す', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    makeConflict(workspace)
    await workspace.run(['pr', 'restack'])
    writeFileSync(path.join(workspace.directory, 'upper.txt'), 'resolved\n')
    workspace.git(['add', 'upper.txt'])
    workspace.git(['-c', 'core.editor=true', 'rebase', '--continue'])
    const result = await workspace.run(['pr', 'restack', '--continue'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
    expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(head(workspace))
    expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11`)
    expect(workspace.exists(PROGRESS_FILE)).toBe(false)
  })
  it.for([{ flag: '--continue' }, { flag: '--abort' }])('途中の記録が無いのに $flag を付けると、利用者が始めた rebase を動かさずに終了コード 2 で終わる', async (row) => {
    const workspace = await openStacked()
    makeConflict(workspace)
    workspace.git(['fetch', 'origin'])
    expect(() => workspace.git(['rebase', `origin/${LOWER}`])).toThrow(Error)
    const stopped = head(workspace)
    const result = await workspace.run(['pr', 'restack', row.flag])
    expect(result).toStrictEqual({ code: 2, stdout: '', stderr: 'error: no restack in progress\n  to restack the branch, run: pecot pr restack\n' })
    expect(head(workspace)).toBe(stopped)
    expect(workspace.exists(path.join('.git', 'rebase-merge'))).toBe(true)
  })

  it('--check・--continue・--abort を 2 つ以上付けると、終了コード 2 で終わる', async () => {
    const workspace = await openStacked()
    const result = await workspace.run(['pr', 'restack', '--check', '--abort'])
    expect(result).toStrictEqual({ code: 2, stdout: '', stderr: 'error: give only one of check, continue and abort\n' })
  })

  it('remote の上の段にだけあるコミットがあると、載せ直さずに終了コード 1 で終わる', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    pushTo(workspace, `origin/${UPPER}`, UPPER, 'suggestion.txt', 's\n')
    workspace.advanceRemote(LOWER)
    const before = head(workspace)
    const remote = workspace.remoteGit(['rev-parse', UPPER]).trim()
    const result = await workspace.run(['pr', 'restack'])
    expect(result.code).toBe(1)
    expect(lines(result.stderr)).toStrictEqual([
      `error: origin/${UPPER} has commits that are not in ${UPPER}`,
      `  ${UPPER} is back at the position before the restack`,
      `  rebase or merge them into ${UPPER} first, then run again: pecot pr restack`,
    ])
    expect(head(workspace)).toBe(before)
    expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(remote)
  })

  it('push が拒まれると、base の記録を書き直さずに終了コード 1 で終わる', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    workspace.advanceRemote(LOWER)
    const record = workspace.read(BASE_FILE)
    rejectPushes(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result.code).toBe(1)
    expect(lines(result.stderr)[0]).toMatch(/^error: push was rejected: /u)
    expect(lines(result.stderr).slice(-2)).toStrictEqual([
      `  ${UPPER} is restacked locally and the base record is unchanged`,
      '  run again: pecot pr restack',
    ])
    expect(workspace.read(BASE_FILE)).toBe(record)
  })

  it('push が時間切れになると、手で push する案内を出して記録を書き直さずに終わり、手で push した後に打つと remote へ合わせる', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN', 2)] })
    workspace.advanceRemote(LOWER)
    const record = workspace.read(BASE_FILE)
    const hook = installSlowPrePush(workspace)
    // 10 分を待てないので、push の時間切れの時計だけを縮める。止め方と時間切れの変換は実物の runGitAsync を通る
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const shortened = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => timeout(milliseconds === PUSH_TIMEOUT_MILLISECONDS ? 1000 : milliseconds))
    let result: Awaited<ReturnType<Workspace['run']>>
    try {
      result = await workspace.run(['pr', 'restack'])
    }
    finally {
      shortened.mockRestore()
    }
    expect(result.code).toBe(1)
    expect(lines(result.stderr)).toStrictEqual([
      'error: push timed out after 600 seconds',
      `  ${UPPER} is restacked locally and the base record is unchanged`,
      `  push the branch yourself: git push --force-with-lease origin ${UPPER}`,
      '  then run: pecot pr restack',
    ])
    expect(workspace.read(BASE_FILE)).toBe(record)

    rmSync(hook)
    workspace.git(['push', '--force-with-lease', 'origin', UPPER])
    const resumed = await workspace.run(['pr', 'restack'])
    expect(resumed).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} synced with origin/${UPPER}\n` })
    expect(workspace.read(BASE_FILE)).toContain(head(workspace, `origin/${LOWER}`))
  })

  it('git fetch が失敗すると、終了コード 1 で終わる', async () => {
    const workspace = await openStacked()
    const bare = workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim()
    renameSync(bare, `${bare}.moved`)
    const result = await workspace.run(['pr', 'restack'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: cannot fetch origin: /u)
  })

  it('積んだ base の記録の形が誤っていると、終了コード 1 で終わる', async () => {
    const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }], files: { [BASE_FILE]: 'garbage\n' } })
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: .pecot-base is malformed: garbage\n' })
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    const workspace = await openStacked({ files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n` })
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    const workspace = await openStacked({ config: false })
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: (none)\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で確かめる', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(['pr', 'restack', '--check', '--project', SECOND_PROJECT])
    expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on ${LOWER}\n`, stderr: '' })
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で確かめる', async () => {
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], files: NO_ACTIVE_FILES })
    const result = await workspace.run(['pr', 'restack', '--check'])
    expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on ${LOWER}\n`, stderr: '' })
  })

  describe('載せ直し済みの判断', () => {
    it('下の段がマージ済みで push が拒まれた後に打ち直すと、rebase をせずに push し、記録を開発ブランチに書き直す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED', 2), upperPullRequests()] })
      mergeLower(workspace)
      await restackLocallyOnly(workspace)
      const restacked = head(workspace)
      const rebases = rebaseEntries(workspace)
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
      expect(rebaseEntries(workspace)).toBe(rebases)
      expect(head(workspace)).toBe(restacked)
      expect(subjectsBetween(workspace, 'origin/main', `origin/${UPPER}`)).toStrictEqual(['upper'])
      expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(restacked)
      expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
    })

    it('push が拒まれた後に打ち直すとき、--dry-run を付けると、rebase と push をせずに restacked の予定を出す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED', 2)] })
      mergeLower(workspace)
      await restackLocallyOnly(workspace)
      const restacked = head(workspace)
      const record = workspace.read(BASE_FILE)
      const remote = workspace.remoteGit(['rev-parse', UPPER]).trim()
      const result = await workspace.run(['pr', 'restack', '--dry-run'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would update ${UPPER} restacked on main\n${PLANNED_RELINK}` })
      expect(head(workspace)).toBe(restacked)
      expect(workspace.read(BASE_FILE)).toBe(record)
      expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(remote)
    })

    it('手で載せ直して push した後に打つと、rebase と push をせずに remote へ合わせ、記録を開発ブランチからの着手に書き直す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED', 2), upperPullRequests()] })
      mergeLower(workspace)
      const recorded = workspace.read(BASE_FILE).split(' ', 2)[1] ?? ''
      workspace.git(['fetch', 'origin'])
      workspace.git(['rebase', '--onto', 'origin/main', recorded])
      workspace.git(['push', '--force', 'origin', UPPER])
      const restacked = head(workspace)
      rejectPushes(workspace)
      const planned = await workspace.run(['pr', 'restack', '--dry-run'])
      expect(planned).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would update ${UPPER} synced with origin/${UPPER}\n${PLANNED_RELINK}` })
      const rebases = rebaseEntries(workspace)
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} synced with origin/${UPPER}\n` })
      expect(rebaseEntries(workspace)).toBe(rebases)
      expect(head(workspace)).toBe(restacked)
      expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
    })

    it('下の段が動いた間に打って push が拒まれ、その後に下の段が squash でマージされてから打ち直すと、古い下の段のコミットを積み直さずに載せ直す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN'), lowerPullRequests('MERGED'), upperPullRequests()] })
      rewriteLower(workspace, 'first\n')
      await restackLocallyOnly(workspace)
      // マージの時に下の段の変更が直されるので、古い下の段のコミットを積み直すと衝突する
      pushLowerFileOnMain(workspace, 'main', 'squashed\n')
      workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
      expect(subjectsBetween(workspace, 'origin/main', `origin/${UPPER}`)).toStrictEqual(['upper'])
      expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
    })

    it('push が拒まれた後に開発ブランチが進んでから打ち直すと、開発ブランチのコミットを積み直さずに載せ直す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED', 2), upperPullRequests()] })
      mergeLower(workspace)
      await restackLocallyOnly(workspace)
      // squash で入ったファイルを main が変えるので、main のコミットを積み直すと衝突する
      pushLowerFileOnMain(workspace, 'main', 'changed\n')
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
      expect(head(workspace, 'HEAD~1')).toBe(head(workspace, 'origin/main'))
      expect(subjectsBetween(workspace, 'origin/main', `origin/${UPPER}`)).toStrictEqual(['upper'])
      expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
    })

    it('push が拒まれた後に下の段が書き換えられてから打ち直すと、古い下の段のコミットを積み直さずに載せ直す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN', 2)] })
      rewriteLower(workspace, 'first\n')
      await restackLocallyOnly(workspace)
      rewriteLower(workspace, 'second\n')
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
      expect(head(workspace, 'HEAD~1')).toBe(head(workspace, `origin/${LOWER}`))
      expect(subjectsBetween(workspace, `origin/${LOWER}`, `origin/${UPPER}`)).toStrictEqual(['upper'])
      expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11`)
    })

    it('手で載せ直して push した後に --check を付けると、up to date の行を出し、記録を書き換えない', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
      mergeLower(workspace)
      const record = workspace.read(BASE_FILE)
      workspace.git(['fetch', 'origin'])
      workspace.git(['rebase', '--onto', 'origin/main', record.split(' ', 2)[1] ?? ''])
      workspace.git(['push', '--force', 'origin', UPPER])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on main\n`, stderr: '' })
      expect(workspace.read(BASE_FILE)).toBe(record)
    })

    it('手で載せ直した後に check を付けると、MCP の outcome が up-to-date になる', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-24')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      rewriteLower(workspace, 'rewritten\n')
      const record = workspace.read(BASE_FILE)
      workspace.git(['fetch', 'origin'])
      workspace.git(['rebase', '--onto', `origin/${LOWER}`, record.split(' ', 2)[1] ?? ''])
      const outcome = await callTool(workspace, { check: true })
      expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
      expect(workspace.read(BASE_FILE)).toBe(record)
    })

    it('開発ブランチを merge で取り込んだ後に --check を付けると、needs restack の行を出す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
      mergeLower(workspace)
      workspace.git(['fetch', 'origin'])
      workspace.git(['merge', '--no-edit', 'origin/main'])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} onto main (base #20 merged)\n`, stderr: '' })
    })

    it('下の段が古い位置へ戻された後に --check を付けると、needs restack の行を出す', async () => {
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      workspace.remoteGit(['update-ref', `refs/heads/${LOWER}`, workspace.remoteGit(['rev-parse', 'main']).trim()])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} on ${LOWER} (base moved)\n`, stderr: '' })
    })
  })

  describe('MCP の data', () => {
    it('check を付けて、載せ直しが要るときは、outcome と cause を返す', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-03')
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
      mergeLower(workspace)
      const outcome = await callTool(workspace, { check: true })
      expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'needs-restack', cause: 'base-merged', pullRequest: 20 })
      expect(outcome.isError).toBe(false)
    })

    it('載せ直して push すると、outcome が restacked で pushed が true になる', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-04')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      workspace.advanceRemote(LOWER)
      const outcome = await callTool(workspace, {})
      expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
    })

    it('開発ブランチへ載せ直して PR の本文を保存し直すと、relinked に PR の番号を返す', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-34')
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...RESAVE_RULES] })
      mergeLower(workspace)
      const outcome = await callTool(workspace, {})
      expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'restacked', pushed: true, relinked: 21 })
    })

    it('衝突すると、衝突したファイルを conflicts に入れて git-conflict を返す', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-07')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      makeConflict(workspace)
      const outcome = await callTool(workspace, {})
      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toMatchObject({ kind: 'git-conflict', branch: UPPER, base: LOWER, outcome: 'conflict', conflicts: ['upper.txt'] })
    })

    describe('MCP の呼び出し', () => {
      it('check を付けて、下の段が動いていないと、outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-01')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
      })

      it('check を付けて、下の段にコミットが足されていると、outcome を needs-restack、cause を base-moved にし、ブランチを動かさない', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-02')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        workspace.advanceRemote(LOWER)
        const before = head(workspace)
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'needs-restack', cause: 'base-moved' })
        expect(head(workspace)).toBe(before)
      })

      it('載せ直すと、base の記録を新しい base のブランチと位置に書き直す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-04')
        await verifies(context, 'PW-PR-RESTACK-19')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        workspace.advanceRemote(LOWER)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
        const lowerHead = head(workspace, `origin/${LOWER}`)
        expect(head(workspace, 'HEAD~1')).toBe(lowerHead)
        expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(head(workspace))
        expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${lowerHead} acme/demo#11`)
      })

      it('下の段がマージ済みで GitHub が上の段を書き換えていると、push せずに remote へ合わせ、記録から積んだ先の Issue を外して PR の本文を保存し直す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-05')
        await verifies(context, 'PW-PR-RESTACK-19')
        await verifies(context, 'PW-PR-RESTACK-34')
        const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...RESAVE_RULES] })
        mergeLower(workspace)
        rewriteUpperOnRemote(workspace)
        const rewritten = workspace.remoteGit(['rev-parse', UPPER]).trim()
        rejectPushes(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'synced', relinked: 21 })
        expect(head(workspace)).toBe(rewritten)
        expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
        expect(workspace.requests().find(request => request.type === 'rest' && request.method === 'PATCH')).toMatchObject({ path: UPPER_PULL_REQUEST, body: { body: UPPER_BODY } })
      })

      it.for([
        { name: 'PR の base が既定のブランチでない', sample: { defaultBranch: 'trunk' } },
        { name: '本文に閉じるキーワードが無い', sample: { body: 'upper' } },
        { name: '本文の Issue が既にリンクされている', sample: { closing: [12] } },
      ])('$name とき、PR の本文を保存し直さず、relinked を返さない', async ({ sample }, context) => {
        await verifies(context, 'PW-PR-RESTACK-34')
        const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), upperPullRequests('OPEN'), upperDetail(sample)] })
        mergeLower(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'restacked', pushed: true })
        expect(operationsOf(workspace)).not.toContain(`PATCH ${UPPER_PULL_REQUEST}`)
      })

      it('PR の本文の保存し直しに失敗すると、手で保存し直す案内を添えて warnings に入れ、成功を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-35')
        const failing = [upperPullRequests('OPEN'), upperDetail(), rest('PATCH', UPPER_PULL_REQUEST, 500, { message: 'failure' })]
        const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...failing] })
        mergeLower(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.isError).toBe(false)
        expect(outcome.structured).toMatchObject({ branch: UPPER, base: 'main', outcome: 'restacked', pushed: true })
        expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot relink PR #21 to its closing Issues: [^\n]+\n {2}to link them, save the body of PR #21 again on GitHub without changes$/u)])
        expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
      })

      it('下の段が動いていないと、何も変えずに outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-06')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        const before = head(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
        expect(head(workspace)).toBe(before)
      })

      it('載せ直しが衝突すると、continue・abort の案内を detail に入れ、途中の記録を書く', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-07')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        makeConflict(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({
          kind: 'git-conflict',
          detail: 'conflict in upper.txt\n  resolve the conflicts and git add the files, then call pr_restack with continue: true\n  or go back to the position before the restack: pr_restack with abort: true',
          branch: UPPER,
          base: LOWER,
          outcome: 'conflict',
          conflicts: ['upper.txt'],
        })
        expect(workspace.exists(PROGRESS_FILE)).toBe(true)
      })

      it('未コミットの変更があると、載せ直さずに kind が preflight-failed の失敗を返し、check では確かめない', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-08')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        writeFileSync(path.join(workspace.directory, 'upper.txt'), 'edited\n')
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'preflight-failed', detail: 'working tree has uncommitted changes' })
        expect(operationsOf(workspace)).toStrictEqual([])
        const checked = await callTool(workspace, { check: true })
        expect(checked.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
      })

      it.for<{ readonly name: string, readonly state: 'CLOSED' | undefined, readonly detail: string }>([
        { name: 'PR が閉じている', state: 'CLOSED', detail: `base branch ${LOWER} is gone and PR #20 was not merged` },
        { name: 'PR が無い', state: undefined, detail: `base branch ${LOWER} is gone and it has no merged PR` },
      ])('下の段のブランチが消えていて、$name と、kind が pr-state の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-RESTACK-09')
        const workspace = await openStacked({ github: [lowerPullRequests(row.state)] })
        workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'pr-state', detail: row.detail })
      })

      it('開発ブランチから着手した記録があると、fetch と載せ直しをせずに、check の有無によらず outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-10')
        const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }] })
        workspace.advanceRemote('main')
        const tracked = head(workspace, 'origin/main')
        const checked = await callTool(workspace, { check: true })
        expect(checked.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'up-to-date' })
        const restacked = await callTool(workspace, {})
        expect(restacked.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'up-to-date' })
        expect(head(workspace, 'origin/main')).toBe(tracked)
      })

      it('記録が無く、判定は startable なら、fetch してから判定を読み、載せ直さずに outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-10')
        await verifies(context, 'PW-PR-RESTACK-30')
        const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }], baseRecord: false, github: [STARTABLE_RULE] })
        workspace.advanceRemote('main')
        const tracked = head(workspace, 'origin/main')
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'up-to-date' })
        expect(head(workspace, 'origin/main')).not.toBe(tracked)
      })

      it('remote に今のブランチが無いと、載せ直すだけで push せず、pushed を false にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-11')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], isPushed: false })
        workspace.advanceRemote(LOWER)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: false })
        expect(workspace.remoteGit(['branch', '--list', UPPER]).trim()).toBe('')
      })

      it('abort を付けると、載せ直しの前の位置に戻し、途中の記録を消して、outcome を aborted にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-12')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        const before = head(workspace)
        const record = workspace.read(BASE_FILE)
        makeConflict(workspace)
        await callTool(workspace, {})
        const outcome = await callTool(workspace, { abort: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'aborted' })
        expect(head(workspace)).toBe(before)
        expect(workspace.read(BASE_FILE)).toBe(record)
        expect(workspace.exists(PROGRESS_FILE)).toBe(false)
      })

      it('衝突を解いてから continue を付けると、載せ直しを終えて push し、記録を書き直す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-13')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        makeConflict(workspace)
        await callTool(workspace, {})
        writeFileSync(path.join(workspace.directory, 'upper.txt'), 'resolved\n')
        workspace.git(['add', 'upper.txt'])
        const outcome = await callTool(workspace, { continue: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
        expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11`)
        expect(workspace.exists(PROGRESS_FILE)).toBe(false)
      })

      it('衝突を解かずに continue を付けると、もう一度 kind が git-conflict の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-13')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        makeConflict(workspace)
        await callTool(workspace, {})
        const outcome = await callTool(workspace, { continue: true })
        expect(outcome.structured).toMatchObject({ kind: 'git-conflict', conflicts: ['upper.txt'] })
        expect(workspace.exists(PROGRESS_FILE)).toBe(true)
      })

      it('利用者が自分で rebase を終えた後に continue を付けると、push と記録の書き直しだけを進める', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-13')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        makeConflict(workspace)
        await callTool(workspace, {})
        writeFileSync(path.join(workspace.directory, 'upper.txt'), 'resolved\n')
        workspace.git(['add', 'upper.txt'])
        workspace.git(['-c', 'core.editor=true', 'rebase', '--continue'])
        const outcome = await callTool(workspace, { continue: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
        expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(head(workspace))
        expect(workspace.exists(PROGRESS_FILE)).toBe(false)
      })

      it.for([{ flag: 'continue' }, { flag: 'abort' }])('途中の記録が無いのに $flag を付けると、利用者が始めた rebase を動かさずに kind が invalid-input の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-RESTACK-14')
        await verifies(context, 'PW-COMMON-27')
        const workspace = await openStacked()
        makeConflict(workspace)
        workspace.git(['fetch', 'origin'])
        expect(() => workspace.git(['rebase', `origin/${LOWER}`])).toThrow(Error)
        const stopped = head(workspace)
        const outcome = await callTool(workspace, { [row.flag]: true })
        expect(outcome.structured).toStrictEqual({ kind: 'invalid-input', detail: 'no restack in progress\n  to restack the branch, call pr_restack' })
        expect(head(workspace)).toBe(stopped)
        expect(workspace.exists(path.join('.git', 'rebase-merge'))).toBe(true)
      })

      it('check・continue・abort を 2 つ以上付けると、kind が invalid-input の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-15')
        const workspace = await openStacked()
        const outcome = await callTool(workspace, { check: true, abort: true })
        expect(outcome.structured).toStrictEqual({ kind: 'invalid-input', detail: 'give only one of check, continue and abort' })
      })

      it('remote のブランチにだけあるコミットがあると、載せ直しの前の位置へ戻し、push をせずに kind が git-unresolved の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-16')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        pushTo(workspace, `origin/${UPPER}`, UPPER, 'suggestion.txt', 's\n')
        workspace.advanceRemote(LOWER)
        const before = head(workspace)
        const remote = workspace.remoteGit(['rev-parse', UPPER]).trim()
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({
          kind: 'git-unresolved',
          detail: `origin/${UPPER} has commits that are not in ${UPPER}\n  ${UPPER} is back at the position before the restack\n  rebase or merge them into ${UPPER} first, then call pr_restack again`,
        })
        expect(head(workspace)).toBe(before)
        expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(remote)
      })

      it('push が拒まれると、base の記録を書き直さずに kind が git-unresolved の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-17')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        workspace.advanceRemote(LOWER)
        const record = workspace.read(BASE_FILE)
        rejectPushes(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured['kind']).toBe('git-unresolved')
        expect(String(outcome.structured['detail'])).toMatch(/^push was rejected: /u)
        expect(workspace.read(BASE_FILE)).toBe(record)
      })

      it('push が 10 分で終わらないと、git を止め、手で push してから pr_restack を呼ぶ案内を detail に入れ、記録を書き直さない', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-33')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        workspace.advanceRemote(LOWER)
        const record = workspace.read(BASE_FILE)
        installSlowPrePush(workspace)
        const timeout = AbortSignal.timeout.bind(AbortSignal)
        const shortened = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => timeout(milliseconds === PUSH_TIMEOUT_MILLISECONDS ? 1000 : milliseconds))
        let outcome: ToolOutcome
        try {
          outcome = await callTool(workspace, {})
        }
        finally {
          shortened.mockRestore()
        }
        expect(outcome.structured).toStrictEqual({
          kind: 'git-unresolved',
          detail: `push timed out after 600 seconds\n  ${UPPER} is restacked locally and the base record is unchanged\n  push the branch yourself: git push --force-with-lease origin ${UPPER}\n  then call pr_restack`,
        })
        expect(workspace.read(BASE_FILE)).toBe(record)
      })

      it('git fetch が失敗すると、kind が git-unresolved の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-18')
        const workspace = await openStacked()
        const bare = workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim()
        renameSync(bare, `${bare}.moved`)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured['kind']).toBe('git-unresolved')
        expect(String(outcome.structured['detail'])).toMatch(/^cannot fetch origin: /u)
      })

      it('積んだ base の記録の形が誤っていると、kind が content-invalid の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-20')
        const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }], files: { [BASE_FILE]: 'garbage\n' } })
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'content-invalid', detail: '.pecot-base is malformed: garbage' })
      })

      it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と project の案内を入れて kind が no-active-project の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-21')
        const workspace = await openStacked({ files: ambiguousWorkspaceFiles() })
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'no-active-project', detail: `acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}` })
      })

      it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-31')
        const workspace = await openStacked({ config: false })
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: (none)' })
      })

      it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で確かめる', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-32')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], files: ambiguousWorkspaceFiles() })
        const outcome = await callTool(workspace, { check: true, project: SECOND_PROJECT })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
      })

      it('下の段がマージ済みで push が拒まれた後に呼び直すと、rebase をせずに push し、outcome を restacked にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-23')
        const workspace = await openStacked({ github: [lowerPullRequests('MERGED', 2), upperPullRequests()] })
        mergeLower(workspace)
        await restackLocallyOnly(workspace)
        const restacked = head(workspace)
        const rebases = rebaseEntries(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'restacked', pushed: true })
        expect(rebaseEntries(workspace)).toBe(rebases)
        expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(restacked)
        expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
      })

      it('手で載せ直して push した後に呼ぶと、rebase と push をせずに remote へ合わせ、outcome を synced にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-23')
        const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), upperPullRequests()] })
        mergeLower(workspace)
        const recorded = workspace.read(BASE_FILE).split(' ', 2)[1] ?? ''
        workspace.git(['fetch', 'origin'])
        workspace.git(['rebase', '--onto', 'origin/main', recorded])
        workspace.git(['push', '--force', 'origin', UPPER])
        rejectPushes(workspace)
        const rebases = rebaseEntries(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'synced' })
        expect(rebaseEntries(workspace)).toBe(rebases)
        expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
      })

      it('push が拒まれた後に開発ブランチが進んでから呼び直すと、開発ブランチのコミットを積み直さずに載せ直す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-25')
        const workspace = await openStacked({ github: [lowerPullRequests('MERGED', 2), upperPullRequests()] })
        mergeLower(workspace)
        await restackLocallyOnly(workspace)
        pushLowerFileOnMain(workspace, 'main', 'changed\n')
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'restacked', pushed: true })
        expect(subjectsBetween(workspace, 'origin/main', `origin/${UPPER}`)).toStrictEqual(['upper'])
      })

      it.for([
        { name: '開発ブランチを merge で取り込んだ', scene: 'merged', expected: { branch: UPPER, base: 'main', outcome: 'needs-restack', cause: 'base-merged', pullRequest: 20 } },
        { name: '下の段が古い位置へ戻された', scene: 'rewound', expected: { branch: UPPER, base: LOWER, outcome: 'needs-restack', cause: 'base-moved' } },
      ])('$name 後に check を付けると、載せ直しが要ると判断する', async (row, context) => {
        await verifies(context, 'PW-PR-RESTACK-26')
        const workspace = await openStacked({ github: [lowerPullRequests(row.scene === 'merged' ? 'MERGED' : 'OPEN')] })
        if (row.scene === 'merged') {
          mergeLower(workspace)
          workspace.git(['fetch', 'origin'])
          workspace.git(['merge', '--no-edit', 'origin/main'])
        }
        else {
          workspace.remoteGit(['update-ref', `refs/heads/${LOWER}`, workspace.remoteGit(['rev-parse', 'main']).trim()])
        }
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toStrictEqual(row.expected)
      })

      it('記録が無く、判定は stackable で下の段にコミットが足されていると、下の段の上に載せ直して積んだ記録を書く', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-27')
        const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
        workspace.advanceRemote(LOWER)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
        expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11`)
      })

      it('積んだ先を求めて始めた載せ直しが衝突すると、途中の記録に載せ直す前の記録の位置を書き、continue で終える', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-28')
        const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
        const recorded = head(workspace, `origin/${LOWER}`)
        makeConflict(workspace)
        const conflicted = await callTool(workspace, {})
        expect(conflicted.structured['kind']).toBe('git-conflict')
        expect(workspace.read(PROGRESS_FILE).trim().split(' ').at(-1)).toBe(recorded)
        writeFileSync(path.join(workspace.directory, 'upper.txt'), 'resolved\n')
        workspace.git(['add', 'upper.txt'])
        const outcome = await callTool(workspace, { continue: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
      })

      it('記録が無く、判定は blocked なら、warnings に入れ、積んでいないものとして outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-29')
        const workspace = await openInferred([prerequisitesRule({ number: 12, blockedBy: [{ number: 11 }] })])
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toMatchObject({ branch: UPPER, base: 'main', outcome: 'up-to-date' })
        expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot infer the stacked base: blocked by #11/u)])
      })

      it('記録が無く下の段の追跡参照が手元に無くても、求める前に fetch して、下の段に積んだものとして扱う', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-30')
        const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
        workspace.git(['update-ref', '-d', `refs/remotes/origin/${LOWER}`])
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
      })
    })
  })
})
