/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// pr restack（PW-PR-RESTACK-*）を、runCli をプロセス内で呼んで確かめる。
// GitHub は偽サーバ、git は一時リポ（origin は bare）で、実際の git を動かす。
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { lines, operationsOf, stateFile } from '../_helpers/workspace-inspect.js'
import { AMBIGUOUS_MESSAGE, ambiguousWorkspaceFiles, NO_ACTIVE_FILES, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { finishPullRequestData, graphql, openWorkspace, rest } from '../_helpers/workspace.js'
import type { ConfigOptions, FinishPullRequestSample, Workspace } from '../_helpers/workspace.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { PUSH_TIMEOUT_MILLISECONDS } from '@pecot/workflow-core/infra/git.js'

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

// 親ブランチは Issue #11 の feat/demo/11、子ブランチは Issue #12 の feat/demo/12
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

// 子 PR。open なら main に向いた PR #21、省くと PR は無い
function upperPullRequests(state?: 'OPEN'): ResponseRule {
  const node = { number: 21, state, headRefName: UPPER, baseRefName: 'main', isDraft: false, isCrossRepository: false, repository: { owner: { login: 'acme' }, name: 'demo' } }
  const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: state === undefined ? [] : [node] } } }
  return graphql('ListPullRequestsByHead', data, { variables: { headRefName: UPPER } })
}

// 子 PR #21 の本文・base・リンク済みの Issue。既定は、main に向き、Closes #12 がまだリンクになっていない
function upperDetail(sample: Readonly<FinishPullRequestSample> = {}): ResponseRule {
  return graphql('GetPullRequestForFinish', finishPullRequestData({ state: 'OPEN', body: UPPER_BODY, head: UPPER, closing: [], ...sample }), { variables: { number: 21 } })
}

// 子 PR の本文を読み、保存し直す応答
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

// 子ブランチの base の記録を、親ブランチの今の remote の先頭で書く
function recordLowerBase(workspace: Readonly<Workspace>): void {
  const target = path.join(workspace.directory, BASE_FILE)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11\n`)
}

interface StackedOptions {
  readonly github?: readonly ResponseRule[]
  /**
  false なら、子ブランチを push しない
  */
  readonly isPushed?: boolean
  readonly config?: ConfigOptions | false
  readonly files?: Readonly<Record<string, string>>
}

// main の上に親ブランチ、その上に子ブランチをスタックし、子ブランチを checkout して base の記録を書く
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

// 記録を置かずに、main の上に親ブランチ、その上に子ブランチをスタックして push する。別の worktree や clone で checkout したのと同じ形
async function openInferred(github: readonly ResponseRule[]): Promise<Workspace> {
  const workspace = await openWorkspace({ baseRecord: false, branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'lower.txt': '1\n' } }] }], github })
  workspace.git(['checkout', '-b', UPPER, `origin/${LOWER}`])
  commitFile(workspace, 'upper.txt', 'upper\n', 'upper')
  workspace.git(['push', '-u', 'origin', UPPER])
  return workspace
}

// 親ブランチを、進めた main の上へスタックし直して force-push する。子ブランチは古い親ブランチの上に残る
function rebaseLowerOntoAdvancedMain(workspace: Readonly<Workspace>): void {
  pushTo(workspace, 'origin/main', 'main', 'main.txt', 'main\n')
  workspace.git(['checkout', '-b', 'rebased-lower', `origin/${LOWER}`])
  workspace.git(['rebase', 'origin/main'])
  workspace.git(['push', '--force', 'origin', `HEAD:refs/heads/${LOWER}`])
  workspace.git(['checkout', UPPER])
  workspace.git(['fetch', 'origin'])
}

// 別のブランチでコミットを作り、origin の target へ push して、子ブランチに戻る
function pushTo(workspace: Readonly<Workspace>, from: string, target: string, file: string, content: string): void {
  workspace.git(['checkout', '-b', `work-${target.replaceAll('/', '-')}`, from])
  commitFile(workspace, file, content, `change ${file}`)
  workspace.git(['push', '--force', 'origin', `HEAD:refs/heads/${target}`])
  workspace.git(['checkout', UPPER])
}

// 親ブランチを squash で main へ入れ、親ブランチを消す
function mergeLower(workspace: Readonly<Workspace>): void {
  pushTo(workspace, 'origin/main', 'main', 'lower.txt', '1\n')
  workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
}

// GitHub がマージの後に行う書き換え。子ブランチのコミットを、新しい main の上に作り直して置き換える
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

// 親ブランチを、main の上の別のコミットに書き換える
function rewriteLower(workspace: Readonly<Workspace>, content: string): void {
  pushLowerFileOnMain(workspace, LOWER, content)
}

// push を拒ませて打ち、手元だけがスタックし直された形にしてから、push を許す
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

// 親ブランチと子ブランチが同じファイルを足して、スタックし直しが衝突する形にする
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
    it('親ブランチが動いていないと、up to date の行を標準出力に出す', async () => {
      await explains('親ブランチの状態を確認する、`pr restack --check` のテストです。親ブランチが動いていない場合は、`up to date` の行を標準出力へ出力することを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on ${LOWER}\n`, stderr: '' })
    })

    it('親ブランチにコミットが足されていると、base moved を添えた needs restack の行を出す', async () => {
      await explains('親ブランチの状態を確認する、`pr restack --check` のテストです。親ブランチへコミットが追加された場合は、`base moved` を添えた `needs restack` の行を出力し、ブランチは動かさないことを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      workspace.advanceRemote(LOWER)
      const before = head(workspace)
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} on ${LOWER} (base moved)\n`, stderr: '' })
      expect(head(workspace)).toBe(before)
    })

    it('親 PR がマージ済みだと、needs restack の行に開発ブランチと PR の番号を出す', async () => {
      await explains('親 PR がマージ済みの場合の、`pr restack --check` のテストです。`needs restack` の行へ、開発ブランチと親 PR の番号を含めて出力することを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
      mergeLower(workspace)
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} onto main (base #20 merged)\n`, stderr: '' })
    })

    it('未コミットの変更があっても、確かめて終了コード 0 で終わる', async () => {
      await explains('未コミットの変更がある場合の、`pr restack --check` のテストです。作業ツリーが変更されていても、確認だけを行い、終了コード 0 で終了することを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      writeFileSync(path.join(workspace.directory, 'upper.txt'), 'edited\n')
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result.code).toBe(0)
    })
  })

  it('親ブランチにコミットが足されていると、スタックし直して push し、base の記録を新しい位置に書き直す', async () => {
    await explains('親ブランチが進んだ場合の、`pr restack` の基本的な動作のテストです。親ブランチの上へスタックし直して push し、base の記録（`.pecot-base`）を新しい位置へ書き直すことを確認します。')
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

  it('--dry-run を付けると、スタックし直しと push をせずに、する予定を dry-run の行で出す', async (context) => {
    await verifies(context, 'PW-PR-RESTACK-22')
    await explains('`pr restack` の `--dry-run` のテストです。`--dry-run` を指定した場合は、スタックし直しと push を実行せず、予定を `dry-run` の行で出力して、base の記録も変更しないことを確認します。')
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

  it('親 PR がマージ済みで、GitHub が子ブランチを書き換えていると、push せずに remote へ合わせ、記録を開発ブランチに変える', async () => {
    await explains('親 PR がマージ済みで、GitHub が子ブランチを書き換えた場合の、`pr restack` のテストです。push せずに remote の内容へ合わせ、base の記録を開発ブランチへ変更することを確認します。')
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

  it('親ブランチの直しが子ブランチの変更の近くに入ってからマージされても、GitHub が書き換えた子ブランチへ合わせる', async () => {
    await explains('親ブランチの修正が、子ブランチの変更の近くへ入ってからマージされた場合の、`pr restack` のテストです。GitHub が書き換えた子ブランチへ合わせ、`synced` の行を出力することを確認します。')
    const workspace = await openWorkspace({
      branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'f.txt': numbered({ 2: 'lower' }) } }] }],
      github: [lowerPullRequests('MERGED'), upperPullRequests()],
    })
    workspace.git(['checkout', '-b', UPPER, `origin/${LOWER}`])
    commitFile(workspace, 'f.txt', numbered({ 2: 'lower', 8: 'upper' }), 'upper')
    workspace.git(['push', '-u', 'origin', UPPER])
    recordLowerBase(workspace)
    // 親ブランチの直し（5 行目）は、子ブランチの変更（8 行目）の前後 3 行に入る
    pushTo(workspace, 'origin/main', 'main', 'f.txt', numbered({ 2: 'lower', 5: 'fixed' }))
    workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    rewriteUpperOnRemote(workspace)
    const rewritten = workspace.remoteGit(['rev-parse', UPPER]).trim()
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} synced with origin/${UPPER}\n` })
    expect(head(workspace)).toBe(rewritten)
  })

  it('親 PR がマージ済みで、remote の子ブランチが書き換わっていないと、開発ブランチへスタックし直して push する', async () => {
    await explains('親 PR がマージ済みで、remote の子ブランチが書き換えられていない場合の、`pr restack` のテストです。開発ブランチの上へスタックし直して push し、PR の本文を保存し直すことを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...RESAVE_RULES] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n${RELINKED}` })
    expect(head(workspace, 'HEAD~1')).toBe(head(workspace, 'origin/main'))
    expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(head(workspace))
    expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
  })

  it('開発ブランチへスタックし直しても、子 PR が無ければ、本文を保存し直さない', async () => {
    await explains('開発ブランチへスタックし直す場合の、`pr restack` のテストです。子 PR が存在しないときは、PR の本文を保存し直さないことを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), upperPullRequests()] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
    expect(operationsOf(workspace)).not.toContain(`PATCH ${UPPER_PULL_REQUEST}`)
  })

  it('親ブランチにスタックしたままスタックし直すと、子 PR を取得せず、本文を保存し直さない', async () => {
    await explains('親ブランチの上へスタックし直す場合の、`pr restack` のテストです。親ブランチへスタックしたままのときは、子 PR を取得せず、PR の本文も保存し直さないことを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    workspace.advanceRemote(LOWER)
    const result = await workspace.run(['pr', 'restack'])
    expect(result.code).toBe(0)
    expect(operationsOf(workspace)).toStrictEqual(['ListPullRequestsByHead'])
  })

  it('本文の保存し直しが失敗すると、手で保存し直す案内を添えた warning を出して終了コード 0 で終わる', async () => {
    await explains('PR の本文の保存し直しが失敗した場合の、`pr restack` のテストです。手で保存し直す案内を添えた `warning` を出力し、終了コード 0 で終了することを確認します。')
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
    await explains('開発ブランチへスタックし直した後の、PR の本文の保存し直しのテストです。base が既定のブランチでない場合・閉じるキーワードがない場合・Issue がリンク済みの場合は、保存し直さないことを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), upperPullRequests('OPEN'), upperDetail(sample)] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
    expect(operationsOf(workspace)).not.toContain(`PATCH ${UPPER_PULL_REQUEST}`)
  })

  it('親 PR のマージの後に --dry-run を付けると、スタックし直しと保存し直しの予定を出し、GitHub に書き込まない', async () => {
    await explains('親 PR のマージ後に実行する、`pr restack --dry-run` のテストです。スタックし直しと本文の保存し直しの予定を出力し、GitHub へ書き込まないことを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
    mergeLower(workspace)
    const result = await workspace.run(['pr', 'restack', '--dry-run'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would update ${UPPER} restacked on main\n${PLANNED_RELINK}` })
    expect(operationsOf(workspace)).toStrictEqual(['ListPullRequestsByHead'])
  })

  it('親ブランチが動いていないと、何も変えずに unchanged の行を出す', async () => {
    await explains('親ブランチが動いていない場合の、`pr restack` のテストです。何も変更せず、`unchanged` の行を出力することを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    const before = head(workspace)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `unchanged: ${UPPER} is up to date\n` })
    expect(head(workspace)).toBe(before)
  })

  it('スタックし直しが衝突すると、衝突したファイルと続行・取りやめの案内を出して、終了コード 3 で終わる', async () => {
    await explains('スタックし直しが衝突した場合の、`pr restack` のテストです。衝突したファイルと、続行・取りやめの案内を出力し、終了コード 3 で終了することを確認します。')
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

  it('未コミットの変更があると、スタックし直さずに終了コード 2 で終わる', async () => {
    await explains('未コミットの変更がある場合の、`pr restack` のテストです。作業ツリーが変更されているときは、スタックし直さず、終了コード 2 で終了することを確認します。')
    const workspace = await openStacked()
    writeFileSync(path.join(workspace.directory, 'upper.txt'), 'edited\n')
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 2, stdout: '', stderr: 'error: working tree has uncommitted changes\n' })
    expect(operationsOf(workspace)).toStrictEqual([])
  })

  it.for<{ readonly name: string, readonly state: 'CLOSED' | undefined, readonly expected: string }>([
    { name: 'PR が閉じている', state: 'CLOSED', expected: `error: base branch ${LOWER} is gone and PR #20 was not merged\n` },
    { name: 'PR が無い', state: undefined, expected: `error: base branch ${LOWER} is gone and it has no merged PR\n` },
  ])('親ブランチが消えていて、$name と、終了コード 1 で終わる', async (row) => {
    await explains('親ブランチが消えている場合の、`pr restack` のテストです。親 PR が閉じている場合と存在しない場合のどちらも、理由を示す `error` の行を出力して終了コード 1 で終了することを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests(row.state)] })
    workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: row.expected })
  })

  it('開発ブランチから着手した記録があると、fetch とスタックし直しをせずに up to date と出す', async () => {
    await explains('開発ブランチから着手した記録がある場合の、`pr restack` のテストです。fetch とスタックし直しをせず、`--check` と通常の実行のどちらも最新である旨を出力することを確認します。')
    const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }] })
    workspace.advanceRemote('main')
    const tracked = head(workspace, 'origin/main')
    expect(await workspace.run(['pr', 'restack', '--check'])).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on main\n`, stderr: '' })
    expect(await workspace.run(['pr', 'restack'])).toStrictEqual({ code: 0, stdout: '', stderr: `unchanged: ${UPPER} is up to date\n` })
    expect(head(workspace, 'origin/main')).toBe(tracked)
  })

  it('記録が無く、判定が startable なら、fetch してから判定を読み、スタックし直さずに up to date と出す', async () => {
    await explains('base の記録がなく、判定が `startable` の場合の、`pr restack` のテストです。fetch してから判定を取得し、スタックし直さず、最新である旨を出力することを確認します。')
    const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }], baseRecord: false, github: [STARTABLE_RULE, STARTABLE_RULE] })
    workspace.advanceRemote('main')
    const tracked = head(workspace, 'origin/main')
    expect(await workspace.run(['pr', 'restack', '--check'])).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on main\n`, stderr: '' })
    expect(await workspace.run(['pr', 'restack'])).toStrictEqual({ code: 0, stdout: '', stderr: `unchanged: ${UPPER} is up to date\n` })
    expect(head(workspace, 'origin/main')).not.toBe(tracked)
  })

  describe('記録が無い作業ディレクトリ', () => {
    it('判定が stackable で親ブランチにコミットが足されていると、親ブランチの上にスタックし直し、スタックの記録を書く', async () => {
      await explains('base の記録がない作業ディレクトリでの、`pr restack` のテストです。判定が `stackable` で親ブランチへコミットが追加された場合は、親ブランチの上へスタックし直し、スタックの記録を書くことを確認します。')
      const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
      workspace.advanceRemote(LOWER)
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
      const lowerHead = head(workspace, `origin/${LOWER}`)
      expect(head(workspace, 'HEAD~1')).toBe(lowerHead)
      expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${lowerHead} acme/demo#11`)
    })

    it('親ブランチをスタックし直して force-push した後も、親ブランチにスタックしたものとして base moved を出す', async () => {
      await explains('base の記録がない作業ディレクトリでの、`pr restack --check` のテストです。親ブランチを rebase して force-push した後も、親ブランチにスタックしたものとして `base moved` を出力することを確認します。')
      const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
      rebaseLowerOntoAdvancedMain(workspace)
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} on ${LOWER} (base moved)\n`, stderr: '' })
    })

    it('親ブランチの追跡参照が手元に無くても、求める前に fetch して、親ブランチにスタックしたものとして扱う', async () => {
      await explains('base の記録がない作業ディレクトリでの、`pr restack --check` のテストです。親ブランチの追跡参照が手元にない場合は、求める前に fetch し、親ブランチにスタックしたものとして扱うことを確認します。')
      const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
      workspace.git(['update-ref', '-d', `refs/remotes/origin/${LOWER}`])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on ${LOWER}\n`, stderr: '' })
    })

    it('判定が blocked なら、warning を出し、スタックしていないものとして up to date と出す', async () => {
      await explains('base の記録がない作業ディレクトリでの、`pr restack --check` のテストです。判定が `blocked` の場合は、`warning` を出力し、スタックしていないものとして最新である旨を出力することを確認します。')
      const blocked = prerequisitesRule({ number: 12, blockedBy: [{ number: 11 }] })
      const workspace = await openInferred([blocked])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`up to date: ${UPPER} on main\n`)
      expect(result.stderr).toMatch(/^warning: cannot infer the stacked base: blocked by #11/u)
    })

    it('スタックし直しが衝突すると、途中の記録にスタックし直す前の記録の位置を書き、--continue で終える', async () => {
      await explains('base の記録がない作業ディレクトリで、スタックし直しが衝突した場合の、`pr restack` のテストです。途中の記録へ元の位置を書き、`--continue` で最後まで終えられることを確認します。')
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

  it('remote に子ブランチが無いと、スタックし直すだけで push しない', async () => {
    await explains('remote に子ブランチが存在しない場合の、`pr restack` のテストです。スタックし直すだけで push は行わないことを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], isPushed: false })
    workspace.advanceRemote(LOWER)
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on ${LOWER}\n` })
    expect(head(workspace, 'HEAD~1')).toBe(head(workspace, `origin/${LOWER}`))
    expect(workspace.remoteGit(['branch', '--list', UPPER]).trim()).toBe('')
  })

  it('--abort を付けると、スタックし直す前の位置に戻し、途中の記録を消す', async () => {
    await explains('`pr restack` の `--abort` のテストです。`--abort` を指定した場合は、スタックし直す前の位置へ戻し、途中の記録を削除することを確認します。')
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

  it('--abort と --dry-run を付けると、戻すはずの行を出し、rebase と途中の記録を残す', async () => {
    await explains('`pr restack` の `--abort` と `--dry-run` の組み合わせのテストです。戻す予定の行だけを出力し、rebase と途中の記録は残すことを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    makeConflict(workspace)
    await workspace.run(['pr', 'restack'])
    const result = await workspace.run(['pr', 'restack', '--abort', '--dry-run'])
    expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `dry-run: would leave ${UPPER} restack aborted unchanged\n` })
    expect(workspace.exists(PROGRESS_FILE)).toBe(true)
  })

  it('衝突を解いてから --continue を付けると、スタックし直しを終えて push し、記録を書き直す', async () => {
    await explains('`pr restack` の `--continue` のテストです。衝突を解決してから `--continue` を指定した場合は、スタックし直しを終えて push し、base の記録を書き直すことを確認します。')
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

  it('親 PR がマージ済みで衝突を解いてから --continue を付けると、スタックし直しを終えて、PR の本文を保存し直す', async () => {
    await explains('親 PR がマージ済みで衝突した場合の、`pr restack --continue` のテストです。衝突を解決して続行すると、スタックし直しを終え、PR の本文を保存し直すことを確認します。')
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
    await explains('衝突を解決せずに実行した場合の、`pr restack --continue` のテストです。もう一度、衝突したファイルを示して終了コード 3 で終了し、途中の記録を残すことを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
    makeConflict(workspace)
    await workspace.run(['pr', 'restack'])
    const result = await workspace.run(['pr', 'restack', '--continue'])
    expect(result.code).toBe(3)
    expect(lines(result.stderr)[0]).toBe('error: conflict in upper.txt')
    expect(workspace.exists(PROGRESS_FILE)).toBe(true)
  })

  it('利用者が自分で rebase を終えた後に --continue を付けると、push して base の記録を書き直す', async () => {
    await explains('利用者が自分で rebase を終えた後の、`pr restack --continue` のテストです。続けて push を行い、base の記録を書き直すことを確認します。')
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
    await explains('途中の記録がない状態での、`pr restack` の `--continue` と `--abort` のテストです。利用者が始めた rebase には手を付けず、終了コード 2 で終了することを確認します。')
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
    await explains('`pr restack` に、`--check`・`--continue`・`--abort` を同時に指定した場合のテストです。いずれか 1 つだけを指定する旨の `error` を出力し、終了コード 2 で終了することを確認します。')
    const workspace = await openStacked()
    const result = await workspace.run(['pr', 'restack', '--check', '--abort'])
    expect(result).toStrictEqual({ code: 2, stdout: '', stderr: 'error: give only one of check, continue and abort\n' })
  })

  it('remote の子ブランチにだけあるコミットがあると、スタックし直さずに終了コード 1 で終わる', async () => {
    await explains('remote の子ブランチだけに存在するコミットがある場合の、`pr restack` のテストです。スタックし直さず、元の位置へ戻したうえで、終了コード 1 で終了することを確認します。')
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
    await explains('push が拒否された場合の、`pr restack` のテストです。base の記録を書き直さず、手元だけスタックし直された旨と、再実行の案内を出力して終了コード 1 で終了することを確認します。')
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
    await explains('push が時間切れになった場合の、`pr restack` のテストです。手で push する案内を出力して記録は書き直さず、手で push した後の再実行で remote の内容へ合わせることを確認します。')
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
    await explains('`git fetch` が失敗した場合の、`pr restack` のテストです。remote が参照できないときに、`cannot fetch origin` の `error` を出力して終了コード 1 で終了することを確認します。')
    const workspace = await openStacked()
    const bare = workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim()
    renameSync(bare, `${bare}.moved`)
    const result = await workspace.run(['pr', 'restack'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: cannot fetch origin: /u)
  })

  it('スタックした base の記録の形が誤っていると、終了コード 1 で終わる', async () => {
    await explains('`.pecot-base` の書式が誤っている場合の、`pr restack` のテストです。記録の内容を解析できないときに、書式が誤っている旨の `error` を出力して終了コード 1 で終了することを確認します。')
    const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }], files: { [BASE_FILE]: 'garbage\n' } })
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: .pecot-base is malformed: garbage\n' })
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    await explains('対象のリポジトリを含むプロジェクトの設定が複数ある場合の、`pr restack` のテストです。設定が 2 つあり、`.active` でも選べないときに、候補と `--project` の案内を出力して終了コード 1 で終了することを確認します。')
    const workspace = await openStacked({ files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n` })
  })

  it('対象のリポを含む設定が無いと、error を出して終了コード 1 で終わる', async () => {
    await explains('対象のリポジトリを含むプロジェクトの設定が存在しない場合の、`pr restack` のテストです。該当する設定がないときに、`error` の行を出力して終了コード 1 で終了することを確認します。')
    const workspace = await openStacked({ config: false })
    const result = await workspace.run(['pr', 'restack'])
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: (none)\n' })
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で確かめる', async () => {
    await explains('`pr restack` の `--project` オプションのテストです。対象のリポジトリを含む設定が 2 つある場合でも、`--project` で設定を指定したときに、その設定を使って確認できることを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(['pr', 'restack', '--check', '--project', SECOND_PROJECT])
    expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on ${LOWER}\n`, stderr: '' })
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で確かめる', async () => {
    await explains('`.active` が存在しない場合の、`pr restack` のテストです。対象のリポジトリを含む設定が 1 つだけのときに、その設定を使って確認できることを確認します。')
    const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], files: NO_ACTIVE_FILES })
    const result = await workspace.run(['pr', 'restack', '--check'])
    expect(result).toStrictEqual({ code: 0, stdout: `up to date: ${UPPER} on ${LOWER}\n`, stderr: '' })
  })

  describe('スタックし直し済みの判断', () => {
    it('親 PR がマージ済みで push が拒まれた後に打ち直すと、rebase をせずに push し、記録を開発ブランチに書き直す', async () => {
      await explains('スタックし直し済みかどうかを判断する、`pr restack` のテストです。親 PR がマージ済みで push が拒否された後に再実行すると、rebase せずに push し、記録を開発ブランチへ書き直すことを確認します。')
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
      await explains('push が拒否された後に再実行する、`pr restack --dry-run` のテストです。rebase と push をせず、スタックし直す予定だけを出力することを確認します。')
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

    it('手でスタックし直して push した後に打つと、rebase と push をせずに remote へ合わせ、記録を開発ブランチからの着手に書き直す', async () => {
      await explains('手でスタックし直して push した後の、`pr restack` のテストです。rebase と push をせず、remote の内容へ合わせ、記録を開発ブランチからの着手に書き直すことを確認します。')
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

    it('親ブランチが動いた間に打って push が拒まれ、その後に親 PR が squash でマージされてから打ち直すと、古い親ブランチのコミットを当て直さずにスタックし直す', async () => {
      await explains('親ブランチが動いた間に push が拒否され、その後に親 PR が squash でマージされた場合の、`pr restack` のテストです。古い親ブランチのコミットを当て直さずに、開発ブランチへスタックし直すことを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN'), lowerPullRequests('MERGED'), upperPullRequests()] })
      rewriteLower(workspace, 'first\n')
      await restackLocallyOnly(workspace)
      // マージの時に親ブランチの変更が直されるので、古い親ブランチのコミットを当て直すと衝突する
      pushLowerFileOnMain(workspace, 'main', 'squashed\n')
      workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
      expect(subjectsBetween(workspace, 'origin/main', `origin/${UPPER}`)).toStrictEqual(['upper'])
      expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
    })

    it('push が拒まれた後に開発ブランチが進んでから打ち直すと、開発ブランチのコミットを当て直さずにスタックし直す', async () => {
      await explains('push が拒否された後に、開発ブランチが進んだ場合の、`pr restack` のテストです。開発ブランチのコミットを当て直さずに、スタックし直すことを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED', 2), upperPullRequests()] })
      mergeLower(workspace)
      await restackLocallyOnly(workspace)
      // squash で入ったファイルを main が変えるので、main のコミットを当て直すと衝突する
      pushLowerFileOnMain(workspace, 'main', 'changed\n')
      const result = await workspace.run(['pr', 'restack'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: `updated: ${UPPER} restacked on main\n` })
      expect(head(workspace, 'HEAD~1')).toBe(head(workspace, 'origin/main'))
      expect(subjectsBetween(workspace, 'origin/main', `origin/${UPPER}`)).toStrictEqual(['upper'])
      expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
    })

    it('push が拒まれた後に親ブランチが書き換えられてから打ち直すと、古い親ブランチのコミットを当て直さずにスタックし直す', async () => {
      await explains('push が拒否された後に、親ブランチが書き換えられた場合の、`pr restack` のテストです。古い親ブランチのコミットを当て直さずに、スタックし直すことを確認します。')
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

    it('手でスタックし直して push した後に --check を付けると、up to date の行を出し、記録を書き換えない', async () => {
      await explains('手でスタックし直して push した後の、`pr restack --check` のテストです。`up to date` の行を出力し、base の記録は書き換えないことを確認します。')
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

    it('手でスタックし直した後に check を付けると、MCP の outcome が up-to-date になる', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-24')
      await explains('手でスタックし直した後の、MCP の `pr_restack` の `check` のテストです。`check` を指定した場合に、`outcome` が `up-to-date` になり、記録は書き換えられないことを確認します。')
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
      await explains('開発ブランチを merge で取り込んだ後の、`pr restack --check` のテストです。`needs restack` の行を出力することを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
      mergeLower(workspace)
      workspace.git(['fetch', 'origin'])
      workspace.git(['merge', '--no-edit', 'origin/main'])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} onto main (base #20 merged)\n`, stderr: '' })
    })

    it('親ブランチが古い位置へ戻された後に --check を付けると、needs restack の行を出す', async () => {
      await explains('親ブランチが古い位置へ戻された後の、`pr restack --check` のテストです。`needs restack` の行を出力することを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      workspace.remoteGit(['update-ref', `refs/heads/${LOWER}`, workspace.remoteGit(['rev-parse', 'main']).trim()])
      const result = await workspace.run(['pr', 'restack', '--check'])
      expect(result).toStrictEqual({ code: 0, stdout: `needs restack: ${UPPER} on ${LOWER} (base moved)\n`, stderr: '' })
    })
  })

  describe('MCP の data', () => {
    it('check を付けて、スタックし直しが要るときは、outcome と cause を返す', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-03')
      await explains('MCP の `pr_restack` の `check` のテストです。`check` を指定して、スタックし直しが必要な場合に、`outcome` と `cause` を返すことを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED')] })
      mergeLower(workspace)
      const outcome = await callTool(workspace, { check: true })
      expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'needs-restack', cause: 'base-merged', pullRequest: 20 })
      expect(outcome.isError).toBe(false)
    })

    it('スタックし直して push すると、outcome が restacked で pushed が true になる', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-04')
      await explains('MCP の `pr_restack` の基本的な動作のテストです。スタックし直して push した場合に、`outcome` を `restacked`、`pushed` を `true` にして返すことを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      workspace.advanceRemote(LOWER)
      const outcome = await callTool(workspace, {})
      expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
    })

    it('開発ブランチへスタックし直して PR の本文を保存し直すと、relinked に PR の番号を返す', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-34')
      await explains('親 PR がマージ済みの場合の、MCP の `pr_restack` のテストです。開発ブランチへスタックし直して PR の本文を保存し直したときに、`relinked` に PR の番号を含めて返すことを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...RESAVE_RULES] })
      mergeLower(workspace)
      const outcome = await callTool(workspace, {})
      expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'restacked', pushed: true, relinked: 21 })
    })

    it('衝突すると、衝突したファイルを conflicts に入れて git-conflict を返す', async (context) => {
      await verifies(context, 'PW-PR-RESTACK-07')
      await explains('スタックし直しが衝突した場合の、MCP の `pr_restack` のテストです。衝突したファイルを `conflicts` に含め、種別 `git-conflict` の失敗を返すことを確認します。')
      const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
      makeConflict(workspace)
      const outcome = await callTool(workspace, {})
      expect(outcome.isError).toBe(true)
      expect(outcome.structured).toMatchObject({ kind: 'git-conflict', branch: UPPER, base: LOWER, outcome: 'conflict', conflicts: ['upper.txt'] })
    })

    describe('MCP の呼び出し', () => {
      it('check を付けて、親ブランチが動いていないと、outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-01')
        await explains('MCP の `pr_restack` の `check` のテストです。`check` を指定し、親ブランチが動いていない場合は、`outcome` を `up-to-date` にして返すことを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
      })

      it('check を付けて、親ブランチにコミットが足されていると、outcome を needs-restack、cause を base-moved にし、ブランチを動かさない', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-02')
        await explains('MCP の `pr_restack` の `check` のテストです。親ブランチへコミットが追加されている場合は、`outcome` を `needs-restack`、`cause` を `base-moved` にして返し、ブランチは動かさないことを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        workspace.advanceRemote(LOWER)
        const before = head(workspace)
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'needs-restack', cause: 'base-moved' })
        expect(head(workspace)).toBe(before)
      })

      it('スタックし直すと、base の記録を新しい base のブランチと位置に書き直す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-04')
        await verifies(context, 'PW-PR-RESTACK-19')
        await explains('MCP の `pr_restack` が、base の記録を書き直すテストです。スタックし直した場合に、記録を新しい base のブランチと位置へ書き直すことを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        workspace.advanceRemote(LOWER)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
        const lowerHead = head(workspace, `origin/${LOWER}`)
        expect(head(workspace, 'HEAD~1')).toBe(lowerHead)
        expect(workspace.remoteGit(['rev-parse', UPPER]).trim()).toBe(head(workspace))
        expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${lowerHead} acme/demo#11`)
      })

      it('親 PR がマージ済みで GitHub が子ブランチを書き換えていると、push せずに remote へ合わせ、記録からスタック先の Issue を外して PR の本文を保存し直す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-05')
        await verifies(context, 'PW-PR-RESTACK-19')
        await verifies(context, 'PW-PR-RESTACK-34')
        await explains('親 PR がマージ済みで、GitHub が子ブランチを書き換えた場合の、MCP の `pr_restack` のテストです。push せずに remote の内容へ合わせ、記録からスタック先の Issue を外し、PR の本文を保存し直すことを確認します。')
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
        await explains('開発ブランチへスタックし直した後の、MCP の `pr_restack` のテストです。base が既定のブランチでない場合・閉じるキーワードがない場合・Issue がリンク済みの場合は、保存し直さず、`relinked` も返さないことを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), upperPullRequests('OPEN'), upperDetail(sample)] })
        mergeLower(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'restacked', pushed: true })
        expect(operationsOf(workspace)).not.toContain(`PATCH ${UPPER_PULL_REQUEST}`)
      })

      it('PR の本文の保存し直しに失敗すると、手で保存し直す案内を添えて warnings に入れ、成功を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-35')
        await explains('PR の本文の保存し直しが失敗した場合の、MCP の `pr_restack` のテストです。手で保存し直す案内を添えて `warnings` に含め、成功を返すことを確認します。')
        const failing = [upperPullRequests('OPEN'), upperDetail(), rest('PATCH', UPPER_PULL_REQUEST, 500, { message: 'failure' })]
        const workspace = await openStacked({ github: [lowerPullRequests('MERGED'), ...failing] })
        mergeLower(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.isError).toBe(false)
        expect(outcome.structured).toMatchObject({ branch: UPPER, base: 'main', outcome: 'restacked', pushed: true })
        expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot relink PR #21 to its closing Issues: [^\n]+\n {2}to link them, save the body of PR #21 again on GitHub without changes$/u)])
        expect(workspace.read(BASE_FILE)).toBe(`main ${head(workspace, 'origin/main')}`)
      })

      it('親ブランチが動いていないと、何も変えずに outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-06')
        await explains('親ブランチが動いていない場合の、MCP の `pr_restack` のテストです。何も変更せず、`outcome` を `up-to-date` にして返すことを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        const before = head(workspace)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
        expect(head(workspace)).toBe(before)
      })

      it('スタックし直しが衝突すると、continue・abort の案内を detail に入れ、途中の記録を書く', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-07')
        await explains('スタックし直しが衝突した場合の、MCP の `pr_restack` のテストです。続行・取りやめの案内を `detail` に含め、途中の記録を書くことを確認します。')
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

      it('未コミットの変更があると、スタックし直さずに kind が preflight-failed の失敗を返し、check では確かめない', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-08')
        await explains('未コミットの変更がある場合の、MCP の `pr_restack` のテストです。スタックし直さず、種別 `preflight-failed` の失敗を返し、`check` の場合は確認だけを行うことを確認します。')
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
      ])('親ブランチが消えていて、$name と、kind が pr-state の失敗を返す', async (row, context) => {
        await verifies(context, 'PW-PR-RESTACK-09')
        await explains('親ブランチが消えている場合の、MCP の `pr_restack` のテストです。親 PR が閉じている場合と存在しない場合のどちらも、種別 `pr-state` の失敗を返すことを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests(row.state)] })
        workspace.remoteGit(['update-ref', '-d', `refs/heads/${LOWER}`])
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'pr-state', detail: row.detail })
      })

      it('開発ブランチから着手した記録があると、fetch とスタックし直しをせずに、check の有無によらず outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-10')
        await explains('開発ブランチから着手した記録がある場合の、MCP の `pr_restack` のテストです。fetch とスタックし直しをせず、`check` の有無によらず `outcome` を `up-to-date` にすることを確認します。')
        const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }] })
        workspace.advanceRemote('main')
        const tracked = head(workspace, 'origin/main')
        const checked = await callTool(workspace, { check: true })
        expect(checked.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'up-to-date' })
        const restacked = await callTool(workspace, {})
        expect(restacked.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'up-to-date' })
        expect(head(workspace, 'origin/main')).toBe(tracked)
      })

      it('記録が無く、判定は startable なら、fetch してから判定を読み、スタックし直さずに outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-10')
        await verifies(context, 'PW-PR-RESTACK-30')
        await explains('base の記録がなく、判定が `startable` の場合の、MCP の `pr_restack` のテストです。fetch してから判定を取得し、スタックし直さず、`outcome` を `up-to-date` にすることを確認します。')
        const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }], baseRecord: false, github: [STARTABLE_RULE] })
        workspace.advanceRemote('main')
        const tracked = head(workspace, 'origin/main')
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: 'main', outcome: 'up-to-date' })
        expect(head(workspace, 'origin/main')).not.toBe(tracked)
      })

      it('remote に今のブランチが無いと、スタックし直すだけで push せず、pushed を false にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-11')
        await explains('remote に今のブランチが存在しない場合の、MCP の `pr_restack` のテストです。スタックし直すだけで push は行わず、`pushed` を `false` にして返すことを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], isPushed: false })
        workspace.advanceRemote(LOWER)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: false })
        expect(workspace.remoteGit(['branch', '--list', UPPER]).trim()).toBe('')
      })

      it('abort を付けると、スタックし直す前の位置に戻し、途中の記録を消して、outcome を aborted にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-12')
        await explains('MCP の `pr_restack` の `abort` のテストです。`abort` を指定した場合に、スタックし直す前の位置へ戻し、途中の記録を削除して、`outcome` を `aborted` にすることを確認します。')
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

      it('衝突を解いてから continue を付けると、スタックし直しを終えて push し、記録を書き直す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-13')
        await explains('MCP の `pr_restack` の `continue` のテストです。衝突を解決してから `continue` を指定した場合は、スタックし直しを終えて push し、base の記録を書き直すことを確認します。')
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
        await explains('衝突を解決せずに実行した場合の、MCP の `pr_restack` の `continue` のテストです。もう一度、種別 `git-conflict` の失敗を返し、途中の記録を残すことを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')] })
        makeConflict(workspace)
        await callTool(workspace, {})
        const outcome = await callTool(workspace, { continue: true })
        expect(outcome.structured).toMatchObject({ kind: 'git-conflict', conflicts: ['upper.txt'] })
        expect(workspace.exists(PROGRESS_FILE)).toBe(true)
      })

      it('利用者が自分で rebase を終えた後に continue を付けると、push と記録の書き直しだけを進める', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-13')
        await explains('利用者が自分で rebase を終えた後の、MCP の `pr_restack` の `continue` のテストです。push と base の記録の書き直しだけを進めることを確認します。')
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
        await explains('途中の記録がない状態での、MCP の `pr_restack` の `continue` と `abort` のテストです。利用者が始めた rebase には手を付けず、種別 `invalid-input` の失敗を返すことを確認します。')
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
        await explains('MCP の `pr_restack` に、`check`・`continue`・`abort` を同時に指定した場合のテストです。種別 `invalid-input` の失敗を返すことを確認します。')
        const workspace = await openStacked()
        const outcome = await callTool(workspace, { check: true, abort: true })
        expect(outcome.structured).toStrictEqual({ kind: 'invalid-input', detail: 'give only one of check, continue and abort' })
      })

      it('remote のブランチにだけあるコミットがあると、スタックし直す前の位置へ戻し、push をせずに kind が git-unresolved の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-16')
        await explains('remote の子ブランチだけに存在するコミットがある場合の、MCP の `pr_restack` のテストです。スタックし直す前の位置へ戻し、push せずに、種別 `git-unresolved` の失敗を返すことを確認します。')
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
        await explains('push が拒否された場合の、MCP の `pr_restack` のテストです。base の記録を書き直さず、種別 `git-unresolved` の失敗を返すことを確認します。')
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
        await explains('push が 10 分で完了しない場合の、MCP の `pr_restack` のテストです。git を停止し、手で push してから `pr_restack` を呼ぶ案内を `detail` に含め、記録は書き直さないことを確認します。')
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
        await explains('`git fetch` が失敗した場合の、MCP の `pr_restack` のテストです。remote が参照できないときに、種別 `git-unresolved` の失敗を返すことを確認します。')
        const workspace = await openStacked()
        const bare = workspace.remoteGit(['rev-parse', '--absolute-git-dir']).trim()
        renameSync(bare, `${bare}.moved`)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured['kind']).toBe('git-unresolved')
        expect(String(outcome.structured['detail'])).toMatch(/^cannot fetch origin: /u)
      })

      it('スタックした base の記録の形が誤っていると、kind が content-invalid の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-20')
        await explains('`.pecot-base` の書式が誤っている場合の、MCP の `pr_restack` のテストです。記録の内容を解析できないときに、種別 `content-invalid` の失敗を返すことを確認します。')
        const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER }], files: { [BASE_FILE]: 'garbage\n' } })
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'content-invalid', detail: '.pecot-base is malformed: garbage' })
      })

      it('対象のリポを含む設定が 2 つあり .active も選べないと、候補と project の案内を入れて kind が no-active-project の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-21')
        await explains('対象のリポジトリを含むプロジェクトの設定が複数ある場合の、MCP の `pr_restack` のテストです。設定が 2 つあり、`.active` でも選べないときに、候補と `project` の案内を含む種別 `no-active-project` の失敗を返すことを確認します。')
        const workspace = await openStacked({ files: ambiguousWorkspaceFiles() })
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'no-active-project', detail: `acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${AMBIGUOUS_MESSAGE}` })
      })

      it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-31')
        await explains('対象のリポジトリを含むプロジェクトの設定が存在しない場合の、MCP の `pr_restack` のテストです。該当する設定がないときに、種別 `repo-not-in-project` の失敗を返すことを確認します。')
        const workspace = await openStacked({ config: false })
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ kind: 'repo-not-in-project', detail: 'acme/demo is not in any project config\n  available: (none)' })
      })

      it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で確かめる', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-32')
        await explains('MCP の `pr_restack` の `project` 入力のテストです。対象のリポジトリを含む設定が 2 つある場合でも、`project` で設定を指定したときに、その設定を使って確認できることを確認します。')
        const workspace = await openStacked({ github: [lowerPullRequests('OPEN')], files: ambiguousWorkspaceFiles() })
        const outcome = await callTool(workspace, { check: true, project: SECOND_PROJECT })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
      })

      it('親 PR がマージ済みで push が拒まれた後に呼び直すと、rebase をせずに push し、outcome を restacked にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-23')
        await explains('親 PR がマージ済みで push が拒否された後の、MCP の `pr_restack` のテストです。再度呼び出すと、rebase せずに push し、`outcome` を `restacked` にすることを確認します。')
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

      it('手でスタックし直して push した後に呼ぶと、rebase と push をせずに remote へ合わせ、outcome を synced にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-23')
        await explains('手でスタックし直して push した後の、MCP の `pr_restack` のテストです。rebase と push をせず、remote の内容へ合わせ、`outcome` を `synced` にすることを確認します。')
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

      it('push が拒まれた後に開発ブランチが進んでから呼び直すと、開発ブランチのコミットを当て直さずにスタックし直す', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-25')
        await explains('push が拒否された後に、開発ブランチが進んだ場合の、MCP の `pr_restack` のテストです。開発ブランチのコミットを当て直さずに、スタックし直すことを確認します。')
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
        { name: '親ブランチが古い位置へ戻された', scene: 'rewound', expected: { branch: UPPER, base: LOWER, outcome: 'needs-restack', cause: 'base-moved' } },
      ])('$name 後に check を付けると、スタックし直しが要ると判断する', async (row, context) => {
        await verifies(context, 'PW-PR-RESTACK-26')
        await explains('MCP の `pr_restack` の `check` のテストです。開発ブランチを merge で取り込んだ場合と、親ブランチが古い位置へ戻された場合のどちらも、スタックし直しが必要と判断することを確認します。')
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

      it('記録が無く、判定は stackable で親ブランチにコミットが足されていると、親ブランチの上にスタックし直してスタックの記録を書く', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-27')
        await explains('base の記録がない作業ディレクトリでの、MCP の `pr_restack` のテストです。判定が `stackable` で親ブランチへコミットが追加された場合は、親ブランチの上へスタックし直し、スタックの記録を書くことを確認します。')
        const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
        workspace.advanceRemote(LOWER)
        const outcome = await callTool(workspace, {})
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'restacked', pushed: true })
        expect(workspace.read(BASE_FILE)).toBe(`${LOWER} ${head(workspace, `origin/${LOWER}`)} acme/demo#11`)
      })

      it('スタック先を求めて始めたスタックし直しが衝突すると、途中の記録にスタックし直す前の記録の位置を書き、continue で終える', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-28')
        await explains('base の記録がない作業ディレクトリで、スタックし直しが衝突した場合の、MCP の `pr_restack` のテストです。途中の記録へ元の位置を書き、`continue` で最後まで終えられることを確認します。')
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

      it('記録が無く、判定は blocked なら、warnings に入れ、スタックしていないものとして outcome を up-to-date にする', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-29')
        await explains('base の記録がなく、判定が `blocked` の場合の、MCP の `pr_restack` のテストです。警告を `warnings` に含め、スタックしていないものとして `outcome` を `up-to-date` にすることを確認します。')
        const workspace = await openInferred([prerequisitesRule({ number: 12, blockedBy: [{ number: 11 }] })])
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toMatchObject({ branch: UPPER, base: 'main', outcome: 'up-to-date' })
        expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^cannot infer the stacked base: blocked by #11/u)])
      })

      it('記録が無く親ブランチの追跡参照が手元に無くても、求める前に fetch して、親ブランチにスタックしたものとして扱う', async (context) => {
        await verifies(context, 'PW-PR-RESTACK-30')
        await explains('base の記録がなく、親ブランチの追跡参照も手元にない場合の、MCP の `pr_restack` のテストです。求める前に fetch し、親ブランチにスタックしたものとして扱うことを確認します。')
        const workspace = await openInferred([STACKABLE_RULE, lowerPullRequests('OPEN')])
        workspace.git(['update-ref', '-d', `refs/remotes/origin/${LOWER}`])
        const outcome = await callTool(workspace, { check: true })
        expect(outcome.structured).toStrictEqual({ branch: UPPER, base: LOWER, outcome: 'up-to-date' })
      })
    })
  })
})
