/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// session finish の振る舞い（PW-SESSION-FINISH-*）を、runCli をプロセス内で呼んで確かめる。
// GitHub は偽サーバ、git は一時リポ（origin は bare）、設定は一時ディレクトリのファイルにする。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../../src/commands/registry.js'
import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { AMBIGUOUS_MESSAGE, ambiguousWorkspaceFiles, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { Settle, ToolOutcome } from '../_helpers/mcp-client.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { filesOf, KIND_FAILURE, lines, operationsOf, restRequests, stateFile } from '../_helpers/workspace-inspect.js'
import { finishPullRequestData, graphql, HOST, issueKindData, openWorkspace, rest, rule } from '../_helpers/workspace.js'
import type { FinishPullRequestSample, ResponseRuleList, Workspace, WorkspaceOptions } from '../_helpers/workspace.js'
import { settleWithFakeDelays, useFakeDelays } from '../_helpers/interface-case.js'
import { prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { IssueSpec, TargetSpec } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'

useIsolatedEnvironment()

const BRANCH = 'feat/demo/12'
const REMOTE_DELETE_FAILED = new RegExp(`^deleting remote branch ${BRANCH} failed: `, 'u')

const MERGED = 'GetPullRequestForFinish'

function kindRule(number: number, options: Readonly<{ subIssues?: number, issueType?: string, state?: string }> = {}): ReturnType<typeof graphql> {
  return graphql('GetIssueKind', issueKindData({ number, ...options }), { variables: { number } })
}

function closeRule(number: number, status = 200): ReturnType<typeof rest> {
  return rest('PATCH', `/repos/acme/demo/issues/${String(number)}`, status, status === 200 ? { number, state: 'closed' } : { message: 'Server Error' })
}

function deleteRule(status = 204, message?: string): ReturnType<typeof rest> {
  return rest('DELETE', `/repos/acme/demo/git/refs/heads/${BRANCH}`, status, message === undefined ? undefined : { message })
}

// number の Issue を待つ Issue（blocking）の読み取り
function waitingRule(waiting: readonly number[], number = 12): ResponseRule {
  const nodes = waiting.map(other => ({ id: `I_demo_${String(other)}`, number: other, state: 'OPEN', repository: { owner: { login: 'acme' }, name: 'demo' } }))
  return graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: nodes.length, nodes } } } }, { variables: { number } })
}

// 種別を読み、close でき、待つ Issue の無い Issue
function closedRules(number: number): ResponseRuleList {
  return [kindRule(number), closeRule(number), waitingRule([], number)]
}

function mergedRules(sample: Readonly<FinishPullRequestSample> = {}, extra: ResponseRuleList = closedRules(12)): ResponseRuleList {
  return [graphql(MERGED, finishPullRequestData(sample)), ...extra]
}

const ALL_FLAGS = ['.pecot-base', '.pecot-session-title']
// 古い版が作ったまま残るフラグ。session finish は触れない
const LEFTOVER_FLAGS = ['.pecot-quick-mode', '.pecot-active']

function flagFiles(): Record<string, string> {
  return Object.fromEntries([...ALL_FLAGS, ...LEFTOVER_FLAGS].map(name => [stateFile(name), 'x\n']))
}

function currentBranch(workspace: Readonly<Workspace>, cwd?: string): string {
  return workspace.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim()
}

function hasBranch(workspace: Readonly<Workspace>): boolean {
  return workspace.git(['branch', '--list', BRANCH]).trim() !== ''
}

function cleanupBranch(extra: Readonly<WorkspaceOptions> = {}): Promise<Workspace> {
  return openWorkspace({
    branch: BRANCH,
    branches: [{ name: BRANCH, commits: [{ message: '未マージの変更', files: { 'feature.txt': 'x\n' } }] }],
    ...extra,
  })
}

const CLEANUP = ['session', 'finish', 'acme/demo/21']
// eslint-disable-next-line unicorn/no-null -- 応答の形（PR が無いと null）
const NO_PULL_REQUEST = { repository: { pullRequest: null } }

// コマンドは process.cwd() を作業リポジトリとして読むので、呼ぶ間だけ移る
async function finishTool(workspace: Readonly<Workspace>, argumentsOfTool: Readonly<Record<string, unknown>>, settle?: Settle): Promise<ToolOutcome> {
  const previous = process.cwd()
  process.chdir(workspace.directory)
  try {
    return await callToolOnce(COMMANDS, 'session_finish', { pr_ref: 'acme/demo/21', ...argumentsOfTool }, settle)
  }
  finally {
    process.chdir(previous)
  }
}

// #12 を待つ Issue。#13 は未着手で Blocked、#14 は #12 の上にスタックして着手し In Review

const UPPER = 'feat/demo/14'
// PR #21 がマージされ、閉じた #12
const DONE_12: IssueSpec = { number: 12, state: 'CLOSED', branch: BRANCH, pullRequests: [{ number: 21, head: BRANCH, state: 'MERGED' }] }
// PR #21 はマージされたが、まだ開いている（GitHub に close が届く前の）#12
const MERGED_UNCLOSED_12: IssueSpec = { ...DONE_12, state: 'OPEN' }

function boardItemRule(number: number, column: string): ResponseRule {
  const projectItems = { nodes: [{ id: `PVTI_${String(number)}`, project: { id: 'PVT_1' }, fieldValues: { nodes: [{ field: { id: 'PVTSSF_workflow', name: 'pecot-status' }, name: column }] } }] }
  const issue = { number, title: `課題${String(number)}`, state: 'OPEN', url: `https://${HOST}/acme/demo/issues/${String(number)}`, repository: { owner: { login: 'acme' }, name: 'demo' }, projectItems }
  return graphql('GetIssueBoardItem', { repository: { issue } }, { variables: { number } })
}

function waitingTarget(number: number, blocker: IssueSpec = DONE_12, extra: Partial<TargetSpec> = {}): ResponseRule {
  return prerequisitesRule({ number, blockedBy: [blocker], ...extra })
}

const READY_WRITE_13 = graphql('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_13' } } }, { variables: { itemId: 'PVTI_13', optionId: 'o3' } })
const WAITING_RULES: ResponseRuleList = [
  graphql(MERGED, finishPullRequestData()),
  kindRule(12),
  closeRule(12),
  waitingRule([13, 14]),
  boardItemRule(13, 'Blocked'),
  boardItemRule(14, 'In Review'),
  waitingTarget(13),
  waitingTarget(14, DONE_12, { branch: UPPER }),
]

describe('session finish', () => {
  it('既定ブランチ宛ての PR の参照を渡すと、PR のリポの closing issues と head ブランチ名の末尾の番号の Issue を close し、本文は読まない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-01')
    await explains('`session finish` が閉じる Issue を決める動作のテストです。既定ブランチ宛ての PR の場合に、PR の closing issues と head ブランチ名の末尾の番号の Issue を close し、本文は参照しないことを確認します。')
    const github = mergedRules({ closing: [10, [11, 'acme/other']], body: 'Fixes #13\n' }, [10, 12].flatMap(number => closedRules(number)))
    const workspace = await openWorkspace({ github })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    const closed = restRequests(workspace, 'PATCH')
    expect(closed).toMatchObject([10, 12].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}`, body: { state: 'closed' } })))
  })

  it('閉じた Issue があると、MCP の結果の skippedIssues に already-closed で入れる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-41')
    await explains('`session finish` の MCP の結果のテストです。対象の Issue が既に閉じている場合に、`skippedIssues` に理由 `already-closed` で記録し、close は行わないことを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12, { state: 'CLOSED' }), waitingRule([])]) })
    const outcome = await finishTool(workspace, {})
    expect(outcome.structured).toMatchObject({ closedIssues: [], skippedIssues: [{ number: 12, reason: 'already-closed' }] })
    expect(restRequests(workspace, 'PATCH')).toStrictEqual([])
  })

  it.for([
    { title: 'Issue Type が Epic', options: { issueType: 'Epic' } },
    { title: 'sub-issue を持つ Issue', options: { subIssues: 3 } },
  ])('次の Issue があると（$title）、その Issue を close しない', async (row, context) => {
    await verifies(context, 'PW-SESSION-FINISH-02')
    await explains('`session finish` の対象外の Issue のテストです。Issue Type が Epic の場合と、sub-issue を持つ場合に、その Issue は close せず、PR の Issue だけを close することを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({ closing: [10] }, [kindRule(10, row.options), ...closedRules(12)]) })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
    expect(result.stderr).toContain('count: Issues to close: 1\n')
    expect(result.stderr).toContain('closed: Issue #12\n')
  })

  it('もし Issue の種別と状態を読めないなら、MCP の結果の skippedIssues に failed で入れる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-42')
    await explains('`session finish` の MCP の結果のテストです。Issue の種別と状態を取得できなかった場合に、`skippedIssues` に理由 `failed` で記録することを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({}, [KIND_FAILURE]) })
    const outcome = await finishTool(workspace, {})
    expect(outcome.structured).toMatchObject({ closedIssues: [], skippedIssues: [{ number: 12, reason: 'failed' }] })
  })

  it('--delete-branch を付けて打つと、リモートの head ブランチを削除する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-04')
    await explains('`session finish` の `--delete-branch` のテストです。`--delete-branch` を指定した場合に、リモートの head ブランチを削除することを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule()]) })
    const result = await workspace.run([...CLEANUP, '--delete-branch'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'DELETE')).toMatchObject([{ path: `/repos/acme/demo/git/refs/heads/${BRANCH}` }])
  })

  it('カレントのリポジトリが PR のリポジトリと同じで worktree の外だと、develop_branch のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains('`session finish` の戻り先のブランチのテストです。カレントのリポジトリが PR のリポジトリと同じで、worktree の外の場合に、`develop_branch` のブランチへ切り替えることを確認します。')
    const workspace = await cleanupBranch({ github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain('set: current branch to main\n')
    expect(currentBranch(workspace)).toBe('main')
  })

  it('カレントが worktree だと、置き場所の親ディレクトリの名前の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains('`session finish` の戻り先のブランチのテストです。カレントが worktree の場合に、置き場所の親ディレクトリの名前に対応する `wtN` のブランチへ切り替えることを確認します。')
    const workspace = await cleanupBranch({
      branch: 'main',
      branches: [{ name: 'wt1' }, { name: BRANCH }],
      worktrees: [{ name: 'wt1', branch: 'wt1-work', files: {} }],
      github: mergedRules(),
    })
    const worktree = path.join(workspace.root, 'wt1', 'demo')
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.stderr).toContain('set: current branch to wt1\n')
    expect(currentBranch(workspace, worktree)).toBe('wt1')
  })

  it('カレントが worktree で add の記録があると、記録の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains('`session finish` の戻り先のブランチのテストです。カレントが worktree で追加時の記録がある場合に、記録された `wtN` のブランチへ切り替えることを確認します。')
    const workspace = await cleanupBranch({
      branch: 'main',
      branches: [{ name: 'wt1' }, { name: BRANCH }],
      worktrees: [{ name: 'wt2', branch: 'wt2-work', files: {} }],
      github: mergedRules(),
    })
    const worktree = path.join(workspace.root, 'wt2', 'demo')
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const record = workspace.git(['rev-parse', '--path-format=absolute', '--git-path', 'pecot-worktree-name'], worktree).trim()
    writeFileSync(record, 'wt1\n')
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.stderr).toContain('set: current branch to wt1\n')
    expect(currentBranch(workspace, worktree)).toBe('wt1')
  })

  it('カレントが Claude Code の作った .claude/worktrees/<name> だと、worktree-<name> のブランチに切り替え、head ブランチを消す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains('`session finish` の戻り先のブランチのテストです。カレントが `.claude/worktrees/<name>` の場合は、`worktree-<name>` へ切り替え、head ブランチを削除することを確認します。')
    const workspace = await cleanupBranch({ branch: 'main', github: mergedRules() })
    const worktree = path.join(workspace.directory, '.claude', 'worktrees', 'bold-oak')
    workspace.git(['worktree', 'add', '-q', '-b', 'worktree-bold-oak', worktree])
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.stderr).toContain('set: current branch to worktree-bold-oak\n')
    expect(currentBranch(workspace, worktree)).toBe('worktree-bold-oak')
    expect(hasBranch(workspace)).toBe(false)
  })

  it('.claude/worktrees のフォルダ名の + は、ブランチ名の / に戻して探す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    await explains('`session finish` の戻り先のブランチのテストです。`.claude/worktrees` のフォルダ名に `+` が含まれる場合は、ブランチ名の `/` と読み替えて戻り先を決定することを確認します。')
    const workspace = await cleanupBranch({ branch: 'main', github: mergedRules() })
    const worktree = path.join(workspace.directory, '.claude', 'worktrees', 'team+task')
    workspace.git(['worktree', 'add', '-q', '-b', 'worktree-team/task', worktree])
    workspace.git(['checkout', '-q', BRANCH], worktree)
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.stderr).toContain('set: current branch to worktree-team/task\n')
    expect(currentBranch(workspace, worktree)).toBe('worktree-team/task')
  })

  it('worktree の中で戻り先のブランチが決まらないと、ブランチを切り替えずにローカルの片付けを飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-47')
    await explains('`session finish` の戻り先のブランチが決まらない場合のテストです。worktree の中で戻り先を決定できないときに、ブランチを切り替えず、ローカルの後始末を実施しないことを確認します。')
    const workspace = await cleanupBranch({ branch: 'main', github: mergedRules() })
    const worktree = path.join(workspace.root, 'elsewhere', 'demo')
    workspace.git(['worktree', 'add', '-q', worktree, BRANCH])
    const result = await workspace.run(CLEANUP, worktree)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: cannot determine the branch to return to in this worktree; skipped local cleanup\n')
    expect(result.stderr).not.toContain('set: current branch')
    expect(currentBranch(workspace, worktree)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
  })

  it('ブランチを切り替えると、origin の remote（無ければ最初の remote）から develop_branch を pull する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-07')
    await explains('`session finish` の pull のテストです。ブランチを切り替えた場合に、`origin` の remote から `develop_branch` を pull し、`origin` が存在しなければ最初の remote を使うことを確認します。')
    const workspace = await cleanupBranch({ github: mergedRules() })
    workspace.git(['remote', 'rename', 'origin', 'upstream'])
    workspace.advanceRemote('main')
    expect(workspace.git(['rev-parse', 'main'])).not.toBe(workspace.remoteGit(['rev-parse', 'main']))
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain('updated: main from upstream/main\n')
    expect(workspace.git(['rev-parse', 'main'])).toBe(workspace.remoteGit(['rev-parse', 'main']))
  })

  it('pull すると、ローカルの head ブランチを git branch -D で削除する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-08')
    await explains('`session finish` のローカルブランチの削除のテストです。pull が終わった場合に、ローカルの head ブランチを `git branch -D` で削除することを確認します。')
    const workspace = await cleanupBranch({ github: mergedRules() })
    expect(hasBranch(workspace)).toBe(true)
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain(`deleted: local branch ${BRANCH}\n`)
    expect(hasBranch(workspace)).toBe(false)
  })

  it('ローカルの片付けを終えると、作業の記録のファイル（.pecot-base と .pecot-session-title）を削除し、古い版のファイルは残す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-09')
    await explains('`session finish` のフラグファイルの削除のテストです。ローカルの後始末が終わった場合に、フラグのファイルを削除し、古い版の `.pecot-quick-mode` と `.pecot-active` は残すことを確認します。')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
    await workspace.run(CLEANUP)
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([false, false])
    expect(LEFTOVER_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
  })

  it('.pecot-session-title が PR の Issue でない Issue のものだと、.pecot-base と .pecot-session-title を残す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-46')
    await explains('`session finish` の作業対象の記録のテストです。`.pecot-session-title` が PR 以外の Issue のものの場合は、`.pecot-base` と `.pecot-session-title` を残すことを確認します。')
    const files = { [stateFile('.pecot-base')]: `main ${'0'.repeat(40)}\n`, [stateFile('.pecot-session-title')]: '#30 次の作業\n' }
    const workspace = await cleanupBranch({ github: mergedRules(), files })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('skipped: removing the work target records (they belong to #30)\n')
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
  })

  it('--dry-run を付けて打つと、何も変えずに dry-run: would の行を標準エラーに出す', async () => {
    await explains('`session finish` の `--dry-run` のテストです。`--dry-run` を指定した場合は、リポジトリと GitHub を変更せず、`dry-run: would` の行を標準エラーへ出力することを確認します。')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    const files = filesOf(workspace.directory)
    const result = await workspace.run([...CLEANUP, '--dry-run', '--delete-branch'])
    expect(lines(result.stderr)).toStrictEqual([
      'count: Issues to close: 1',
      'dry-run: would close Issue #12',
      `dry-run: would delete remote branch ${BRANCH}`,
      'dry-run: would set current branch to main',
      'dry-run: would update main from origin/main',
      `dry-run: would delete local branch ${BRANCH}`,
    ])
    expect(restRequests(workspace, 'PATCH')).toStrictEqual([])
    expect(restRequests(workspace, 'DELETE')).toStrictEqual([])
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(filesOf(workspace.directory)).toStrictEqual(files)
  })

  it('実行すると、close する Issue の件数を count の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-13')
    await explains('`session finish` の件数の出力のテストです。実行した場合に、close する Issue の件数を `count` の行として標準エラーに出力することを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({ closing: [10] }, [...closedRules(10), ...closedRules(12)]) })
    const result = await workspace.run(CLEANUP)
    expect(result.stderr.startsWith('count: Issues to close: 2\n')).toBe(true)
  })

  it('ブランチを削除すると、deleted の行を標準エラーに出す', async () => {
    await explains('`session finish` の出力のテストです。ブランチを削除した場合に、`deleted` の行を標準エラーに出力することを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule()]) })
    const result = await workspace.run([...CLEANUP, '-d'])
    expect(result.stderr).toContain(`deleted: remote branch ${BRANCH}\n`)
  })

  it('リモートの head ブランチが既に無いと、unchanged の行を標準エラーに出す', async () => {
    await explains('`session finish` の削除済みのブランチのテストです。リモートの head ブランチが既に存在しない場合に、`unchanged` の行を標準エラーに出力することを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule(422, 'Reference does not exist')]) })
    const result = await workspace.run([...CLEANUP, '-d'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`unchanged: remote branch ${BRANCH} (already deleted)\n`)
  })

  it('ローカルの head ブランチが既に無いなら、warning の行を標準エラーに出す', async () => {
    await explains('`session finish` のローカルブランチが存在しない場合のテストです。ローカルの head ブランチが既に存在しない場合に、`warning` の行を標準エラーに出力し、終了コード 0 で終わることを確認します。')
    const workspace = await openWorkspace({ github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(new RegExp(`\\nwarning: deleting local branch ${BRANCH} failed: .*\\n$`, 'u'))
  })

  it('--delete-branch を付けてローカルの片付けも通すと、結果の行を実行した順で標準エラーへ出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-04')
    await verifies(context, 'PW-SESSION-FINISH-13')
    await explains('`session finish` の出力の順序のテストです。`--delete-branch` を指定し、ローカルの後始末まで実行した場合に、結果の行を実行した順に標準エラーへ出力することを確認します。')
    const workspace = await cleanupBranch({ github: mergedRules({}, [...closedRules(12), deleteRule()]) })
    const result = await workspace.run([...CLEANUP, '-d'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr.split('\n')).toStrictEqual([
      'count: Issues to close: 1',
      'closed: Issue #12',
      `deleted: remote branch ${BRANCH}`,
      'set: current branch to main',
      'updated: main from origin/main',
      `deleted: local branch ${BRANCH}`,
      '',
    ])
  })

  it('origin の develop_branch が無く pull に失敗すると、warning の行を出したうえで、ローカルの head ブランチを削除する', async () => {
    await explains('`session finish` の pull の失敗のテストです。`origin` に `develop_branch` が存在しない場合は、`warning` の行を出力し、ローカルの head ブランチは削除することを確認します。')
    const workspace = await cleanupBranch({ github: mergedRules() })
    workspace.remoteGit(['update-ref', '-d', 'refs/heads/main'])
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    const output = lines(result.stderr)
    expect(output.slice(0, 3)).toStrictEqual(['count: Issues to close: 1', 'closed: Issue #12', 'set: current branch to main'])
    const pulling = output.findIndex(line => line.startsWith('warning: pulling main failed: '))
    expect(pulling).toBe(3)
    expect(output.at(-1)).toBe(`deleted: local branch ${BRANCH}`)
    expect(hasBranch(workspace)).toBe(false)
    expect(result.stderr).not.toContain('updated:')
  })

  it('カレントのリポジトリが PR のリポジトリと違うなら、warning の行を標準エラーに出す', async () => {
    await explains('`session finish` のリポジトリの不一致のテストです。カレントのリポジトリが PR のリポジトリと異なる場合に、`warning` の行を標準エラーに出力することを確認します。')
    const github = [graphql(MERGED, finishPullRequestData({ closing: [], body: '', head: 'feat/other' }))]
    const workspace = await cleanupBranch({ github, config: { hasSecondRepository: true } })
    const result = await workspace.run(['session', 'finish', 'acme/other/21'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: current repository (acme/demo) differs from the PR\'s (acme/other); skipped local cleanup\n')
  })

  it('カレントのリポジトリが PR のリポジトリと違うなら、ローカルの片付けを飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-19')
    await explains('`session finish` のリポジトリの不一致のテストです。カレントのリポジトリが PR のリポジトリと異なる場合に、ローカルの後始末を実施しないことを確認します。')
    const github = [graphql(MERGED, finishPullRequestData({ closing: [], body: '', head: BRANCH }))]
    const workspace = await cleanupBranch({ github, config: { hasSecondRepository: true } })
    const result = await workspace.run(['session', 'finish', 'acme/other/21'])
    expect(result.stderr).not.toContain('current branch')
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
  })

  it('Issue の close に失敗したなら、ほかの Issue と後の処理を続ける', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-21')
    await explains('`session finish` の close の失敗のテストです。Issue の close に失敗した場合は、ほかの Issue の close と後続の処理を継続することを確認します。')
    const github = mergedRules({ closing: [10] }, [kindRule(10), closeRule(10, 500), ...closedRules(12), deleteRule()])
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '-d'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('closed: Issue #12\n')
    expect(result.stderr).toContain(`deleted: remote branch ${BRANCH}\n`)
  })

  it('リモートの head ブランチの削除に失敗したなら、warning の行を標準エラーに出し、終了コード 0 で終わる', async () => {
    await explains('`session finish` のリモートブランチの削除の失敗のテストです。削除に失敗した場合は、`warning` の行を標準エラーへ出力し、終了コード 0 で終わることを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule(403, 'Forbidden')]) })
    const result = await workspace.run([...CLEANUP, '-d'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`warning: deleting remote branch ${BRANCH} failed: `)
    expect(restRequests(workspace, 'DELETE')).toHaveLength(1)
  })

  it('checkout に失敗したなら、pull と git branch -D を飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-23')
    await explains('`session finish` の checkout の失敗のテストです。`develop_branch` の checkout に失敗した場合は、pull とローカルブランチの削除をしないことを確認します。')
    const workspace = await cleanupBranch({ config: { developBranch: 'ghost' }, github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: checking out ghost failed: ')
    expect(result.stderr).not.toContain('updated:')
    expect(result.stderr).not.toContain('deleted: local branch')
    expect(currentBranch(workspace)).toBe(BRANCH)
  })

  it('PR がマージされていないなら、終了コード 1 で終わる', async () => {
    await explains('`session finish` の未マージの PR のテストです。PR がマージされていない場合に、マージを促すエラーを表示して終了コード 1 で終わることを確認します。')
    const workspace = await openWorkspace({ github: mergedRules({ state: 'OPEN' }) })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: PR #21 is not merged yet (state: OPEN); merge it on GitHub first\n' })
  })

  it('PR がマージされていないなら、何も変えない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-25')
    await explains('`session finish` の未マージの PR のテストです。PR がマージされていない場合に、Issue・ブランチ・ファイルのいずれも変更しないことを確認します。')
    const workspace = await cleanupBranch({ github: mergedRules({ state: 'OPEN' }), files: flagFiles() })
    const files = filesOf(workspace.directory)
    await workspace.run([...CLEANUP, '-d'])
    expect(operationsOf(workspace)).toStrictEqual([MERGED])
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
    expect(filesOf(workspace.directory)).toStrictEqual(files)
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないなら、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    await explains('`session finish` のプロジェクト設定の選択のテストです。対象のリポジトリを含む設定が 2 つあり、`.active` でも選べない場合に、候補と `--project` の案内を出力して終了コード 1 で終わることを確認します。')
    const workspace = await openWorkspace({ files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n` })
    expect(workspace.requests()).toStrictEqual([])
  })

  it('対象のリポを含む設定が無いなら、error を出して終了コード 1 で終わる', async () => {
    await explains('`session finish` のプロジェクト設定の選択のテストです。対象のリポジトリを含む設定が存在しない場合に、エラーを出力して終了コード 1 で終わることを確認します。')
    const workspace = await openWorkspace({ config: false })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: (none)\n' })
    expect(workspace.requests()).toStrictEqual([])
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で片付ける', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-44')
    await explains('`session finish` の `--project` のテストです。対象のリポジトリを含む設定が 2 つあっても、`--project` で指定した設定で後始末することを確認します。')
    const workspace = await openWorkspace({ github: mergedRules(), files: ambiguousWorkspaceFiles() })
    const result = await workspace.run([...CLEANUP, '--project', SECOND_PROJECT])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12' }])
  })

  it.for([
    { title: 'PR が無い', rules: [graphql(MERGED, NO_PULL_REQUEST)], expected: 'error: PR not found: acme/demo/21\n' },
    { title: 'PR を取得できない', rules: [rule({ operation: MERGED }, { status: 502, body: { message: 'Bad Gateway' } })], expected: 'error: GraphQL query error: ' },
  ])('次の場合は（$title）、終了コード 1 で終わる', async (row) => {
    await explains('`session finish` の PR を取得できない場合のテストです。PR が存在しない場合と取得に失敗した場合は、標準出力に何も出力せず、終了コード 1 で終わることを確認します。')
    const workspace = await openWorkspace({ github: row.rules })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith(row.expected)).toBe(true)
  })

  it('PR の参照の形が誤っているなら、終了コード 2 で終わる', async () => {
    await explains('`session finish` の引数検証のテストです。PR の参照の形式が誤っている場合に、GitHub へ要求を送信せず、終了コード 2 で終わることを確認します。')
    const workspace = await openWorkspace()
    const result = await workspace.run(['session', 'finish', 'not-a-ref'])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid reference: not-a-ref\n/u)
    expect(workspace.requests()).toStrictEqual([])
  })

  describe('待っている Issue', () => {
    it('片付けると、閉じた Issue を待つ Issue の列を動かし、着手の跡がある Issue は動かさない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-31')
      await verifies(context, 'PW-SESSION-FINISH-32')
      await explains('`session finish` が待機中の Issue を更新する動作のテストです。Issue を閉じた場合に、それを待つ Issue の列を移動し、着手済みの Issue は移動しないことを確認します。')
      const workspace = await cleanupBranch({ github: [...WAITING_RULES, READY_WRITE_13] })
      const result = await workspace.run(CLEANUP)
      expect(result.code).toBe(0)
      expect(lines(result.stderr)).toStrictEqual([
        'count: Issues to close: 1',
        'closed: Issue #12',
        'moved: #13 Blocked -> Ready (startable)',
        `warning: #14 is stacked on #12; run pecot pr restack in the working directory of ${UPPER}`,
        'set: current branch to main',
        'updated: main from origin/main',
        `deleted: local branch ${BRANCH}`,
      ])
      const writes = workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')
      expect(writes).toMatchObject([{ variables: { itemId: 'PVTI_13', optionId: 'o3' } }])
    })

    it('子ブランチがあると、スタックし直しを案内し、子ブランチを消す要求を送らない', async () => {
      await explains('`session finish` の子ブランチのテストです。子ブランチがある場合に、スタックし直す手順を案内し、子ブランチを削除する要求は送信しないことを確認します。')
      const workspace = await openWorkspace({ github: [...WAITING_RULES, READY_WRITE_13, deleteRule()] })
      const result = await workspace.run([...CLEANUP, '-d'])
      expect(result.stderr).toContain(`warning: #14 is stacked on #12; run pecot pr restack in the working directory of ${UPPER}\n`)
      expect(restRequests(workspace, 'DELETE')).toMatchObject([{ path: `/repos/acme/demo/git/refs/heads/${BRANCH}` }])
    })

    it('Issue を閉じた後、ブランチを消す前に、待つ Issue を読んで動かす', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-31')
      await explains('`session finish` の処理順のテストです。Issue を閉じた後でブランチを削除する前に、待機中の Issue を取得して列を移動することを確認します。')
      const workspace = await openWorkspace({ github: [...WAITING_RULES, READY_WRITE_13, deleteRule()] })
      await workspace.run([...CLEANUP, '-d'])
      const operations = operationsOf(workspace)
      expect(operations.indexOf('GetIssueBlockingReferences')).toBeGreaterThan(operations.indexOf('PATCH /repos/acme/demo/issues/12'))
      expect(operations.indexOf('UpdateProjectItemField')).toBeLessThan(operations.indexOf(`DELETE /repos/acme/demo/git/refs/heads/${BRANCH}`))
    })

    it('base が開発ブランチでない PR を片付けても、その PR の Issue を閉じる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-38')
      await explains('`session finish` の base が開発ブランチでない PR のテストです。このような PR を後始末する場合でも、その PR の Issue を閉じることを確認します。')
      const workspace = await openWorkspace({ github: mergedRules({ base: 'feat/demo/11' }) })
      const result = await workspace.run(CLEANUP)
      expect(result.code).toBe(0)
      expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
    })

    it('ローカルの片付けを終えると、base の記録のファイルを消し、古い版の .pecot-active には触れない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-09')
      await explains('`session finish` の base の記録のテストです。ローカルの後始末が終わった場合に、base の記録のファイルを削除し、古い版の `.pecot-active` は残すことを確認します。')
      const files = { [stateFile('.pecot-active')]: 'acme/demo/12\n', [stateFile('.pecot-base')]: `feat/demo/11 ${'0'.repeat(40)} acme/demo#11\n` }
      const workspace = await cleanupBranch({ github: mergedRules(), files })
      await workspace.run(CLEANUP)
      expect([workspace.exists(stateFile('.pecot-active')), workspace.exists(stateFile('.pecot-base'))]).toStrictEqual([true, false])
    })

    it('前提にされていない Issue の PR では、待つ Issue の読み取りを 1 回だけ足し、出力を変えない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-34')
      await explains('`session finish` の待機中の Issue の取得のテストです。前提にされていない Issue の PR の場合に、待機中の Issue の取得を 1 回だけ追加し、出力は変わらないことを確認します。')
      const workspace = await cleanupBranch({ github: mergedRules({}, [...closedRules(12), deleteRule()]) })
      const result = await workspace.run([...CLEANUP, '-d'])
      expect(result).toStrictEqual({
        code: 0,
        stdout: '',
        stderr: `count: Issues to close: 1\nclosed: Issue #12\ndeleted: remote branch ${BRANCH}\nset: current branch to main\nupdated: main from origin/main\ndeleted: local branch ${BRANCH}\n`,
      })
      expect(operationsOf(workspace).filter(operation => operation === 'GetIssueBlockingReferences')).toHaveLength(1)
    })
  })

  describe('MCP の data', () => {
    it('待つ Issue の判定が変わり、子ブランチがあると、readinessChanges と restack を data に返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-33')
      await explains('`session finish` の MCP の結果のテストです。待機中の Issue の判定が変わり、子ブランチがある場合に、`readinessChanges` と `restack` を data に含めることを確認します。')
      const workspace = await cleanupBranch({ github: [...WAITING_RULES, READY_WRITE_13] })

      const outcome = await finishTool(workspace, {})

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        closedIssues: [12],
        skippedIssues: [],
        deletedBranches: [{ branch: BRANCH, location: 'local' }],
        readinessChanges: [{ issue: '#13', from: 'stackable on #12', to: 'startable' }, { issue: '#14', from: 'stackable on #12', to: 'startable' }],
        restack: [{ issue: '#14', branch: UPPER }],
        currentBranch: 'main',
        warnings: [`#14 is stacked on #12; call pr_restack in the working directory of ${UPPER}`],
      })
    })

    it('ブランチの削除とローカルの片付けまで通すと、close した Issue・消したブランチ・切り替えた先を data に返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-14')
      await verifies(context, 'PW-SESSION-FINISH-15')
      await explains('`session finish` の MCP の結果のテストです。ブランチの削除とローカルの後始末まで実行した場合に、close した Issue・削除したブランチ・切り替えた先のブランチを data に含めることを確認します。')
      const workspace = await cleanupBranch({ github: mergedRules({}, [...closedRules(12), deleteRule()]) })

      const outcome = await finishTool(workspace, { delete_branch: true })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        closedIssues: [12],
        skippedIssues: [],
        deletedBranches: [{ branch: BRANCH, location: 'remote' }, { branch: BRANCH, location: 'local' }],
        readinessChanges: [],
        restack: [],
        currentBranch: 'main',
      })
    })

    it('Epic を守って close しなかったとき、その番号と epic を data.skippedIssues に返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-03')
      await explains('`session finish` の MCP の結果のテストです。Epic のために close しなかった場合は、その Issue の番号と理由 `epic` を `skippedIssues` へ含めることを確認します。')
      const workspace = await cleanupBranch({ github: mergedRules({ closing: [10] }, [kindRule(10, { issueType: 'Epic' }), ...closedRules(12)]) })

      const outcome = await finishTool(workspace, {})

      expect(outcome.structured).toEqual({ closedIssues: [12], skippedIssues: [{ number: 10, reason: 'epic' }], deletedBranches: [{ branch: BRANCH, location: 'local' }], readinessChanges: [], restack: [], currentBranch: 'main' })
    })

    it('CLI で --dry-run を付けると、何も変えずに、close・ブランチの削除・切り替えの予定を dry-run の行に出す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-12')
      await explains('`session finish` の `--dry-run` のテストです。ブランチの削除を含めて実行した場合に、何も変更せず、close・ブランチの削除・切り替えの予定を `dry-run` の行に出力することを確認します。')
      const workspace = await cleanupBranch({ github: mergedRules() })

      const result = await workspace.run(['session', 'finish', 'acme/demo/21', '--delete-branch', '--dry-run'])

      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: 'count: Issues to close: 1\ndry-run: would close Issue #12\ndry-run: would delete remote branch feat/demo/12\ndry-run: would set current branch to main\ndry-run: would update main from origin/main\ndry-run: would delete local branch feat/demo/12\n' })
      expect(currentBranch(workspace)).toBe(BRANCH)
      expect([...restRequests(workspace, 'PATCH'), ...restRequests(workspace, 'DELETE')]).toStrictEqual([])
    })

    it('判定が変わらない待つ Issue だけだと、readinessChanges を空の配列にする', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-34')
      await explains('`session finish` の MCP の結果のテストです。判定が変わらない待機中の Issue だけの場合に、`readinessChanges` を空の配列にすることを確認します。')
      const github = [...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), prerequisitesRule({ number: 13, blockedBy: [DONE_12, { number: 15 }] })]
      const outcome = await finishTool(await openWorkspace({ github }), {})
      expect(outcome.structured['readinessChanges']).toStrictEqual([])
    })

    it('子ブランチがあると、pr_restack を warnings で案内し、その子ブランチを消す要求を送らない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-35')
      await explains('`session finish` の MCP の結果のテストです。子ブランチがある場合に、`warnings` に `pr_restack` の案内を含め、その子ブランチを削除する要求は送信しないことを確認します。')
      const workspace = await cleanupBranch({ github: [...WAITING_RULES, READY_WRITE_13, deleteRule()] })
      const outcome = await finishTool(workspace, { delete_branch: true })
      expect(outcome.structured['warnings']).toStrictEqual([`#14 is stacked on #12; call pr_restack in the working directory of ${UPPER}`])
      expect(restRequests(workspace, 'DELETE')).toMatchObject([{ path: `/repos/acme/demo/git/refs/heads/${BRANCH}` }])
    })

    it('リモートの head ブランチが既に無いと、deletedBranches へ入れずに続ける', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-16')
      await explains('`session finish` の MCP の結果のテストです。リモートの head ブランチが既に存在しない場合は、`deletedBranches` へ含めずに処理を続けることを確認します。')
      const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule(422, 'Reference does not exist')]) })
      const outcome = await finishTool(workspace, { delete_branch: true })
      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ closedIssues: [12], deletedBranches: [] })
    })

    it('ローカルの head ブランチが既に無いと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-17')
      await explains('`session finish` の MCP の結果のテストです。ローカルの head ブランチが既に存在しない場合に、`warnings` に 1 件含めることを確認します。')
      const outcome = await finishTool(await openWorkspace({ github: mergedRules() }), {})
      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toStrictEqual([expect.stringMatching(new RegExp(`^deleting local branch ${BRANCH} failed: `, 'u'))])
    })

    it('セッションのリポジトリが PR のリポジトリと違うと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-18')
      await explains('`session finish` の MCP の結果のテストです。セッションのリポジトリが PR のリポジトリと異なる場合に、`warnings` に 1 件含めることを確認します。')
      const github = [graphql(MERGED, finishPullRequestData({ closing: [], body: '', head: 'feat/other' }))]
      const outcome = await finishTool(await cleanupBranch({ github, config: { hasSecondRepository: true } }), { pr_ref: 'acme/other/21' })
      expect(outcome.structured['warnings']).toStrictEqual(['current repository (acme/demo) differs from the PR\'s (acme/other); skipped local cleanup'])
    })

    it('Issue の close に失敗すると、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-20')
      await explains('`session finish` の MCP の結果のテストです。Issue の close に失敗した場合は、`warnings` へ 1 件含めることを確認します。')
      const github = mergedRules({}, [kindRule(12), closeRule(12, 500)])
      const outcome = await finishTool(await cleanupBranch({ github }), {})
      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toStrictEqual([expect.stringMatching(/^closing Issue #12 failed: /u)])
    })

    it('リモートの head ブランチの削除に失敗すると、warnings に 1 つ入れ、成功を返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-39')
      await explains('`session finish` の MCP の結果のテストです。リモートの head ブランチの削除に失敗した場合は、`warnings` へ 1 件含め、成功を返すことを確認します。')
      const workspace = await cleanupBranch({ github: mergedRules({}, [...closedRules(12), deleteRule(403, 'Forbidden')]) })
      const outcome = await finishTool(workspace, { delete_branch: true })
      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toStrictEqual([expect.stringMatching(REMOTE_DELETE_FAILED)])
    })

    it('待つ Issue の列が古い ID で書けないと、warnings に入れて続け、project_activate の案内を 1 回だけ添える', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-40')
      await explains('`session finish` の MCP の結果のテストです。待機中の Issue の列を古い ID で更新できなかった場合に、`warnings` に含めて続け、`project_activate` の案内は 1 回だけ添えることを確認します。')
      const outcome = await finishTool(await openWorkspace({ github: [...WAITING_RULES, staleOptionUpdate()] }), {})
      expect(outcome.isError).toBe(false)
      const warnings = [outcome.structured['warnings']].flat().filter(warning => typeof warning === 'string')
      expect(warnings[0]?.startsWith(`could not move #13: ${STALE_OPTION_TEXT}\n`)).toBe(true)
      expect(warnings.filter(warning => warning.includes('project_activate'))).toHaveLength(1)
    })

    it('読み直しても閉じた Issue が済んだ前提として判定に出ないと、warnings に 1 つ入れて列を動かさない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-36')
      await explains('`session finish` の MCP の結果のテストです。取得し直しても閉じた Issue が済んだ前提として現れない場合に、`warnings` に 1 件含め、列は移動しないことを確認します。')
      const github = [...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12), waitingTarget(13, MERGED_UNCLOSED_12)]
      const workspace = await cleanupBranch({ github })
      useFakeDelays()
      const outcome = await finishTool(workspace, {}, settleWithFakeDelays)
      expect(outcome.structured['warnings']).toStrictEqual([expect.stringMatching(/^could not confirm that GitHub reflects the close of #12 in the readiness of #13; its column was not moved/u)])
      expect(operationsOf(workspace)).not.toContain('UpdateProjectItemField')
    })

    it('CLI で --dry-run を付けると、閉じる予定の Issue を済んだものとして判定し、列を書かずに判定の変化を標準出力に出す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-37')
      await explains('`session finish` の `--dry-run` のテストです。`--dry-run` を指定した場合に、閉じる予定の Issue を済んだものとして判定し、列は更新せず判定の変化を標準出力に出力することを確認します。')
      const github = [...mergedRules({}, [kindRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12)]
      const workspace = await openWorkspace({ github })
      const result = await workspace.run(['session', 'finish', 'acme/demo/21', '--dry-run'])
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('Readiness changed:\n- #13 stackable on #12 -> startable\n')
      expect(operationsOf(workspace)).not.toContain('UpdateProjectItemField')
    })

    it('PR がマージされていないと、GitHub の画面でマージするよう案内する detail を入れて、kind が pr-state の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-24')
      await explains('`session finish` の MCP の失敗のテストです。PR がマージされていない場合に、GitHub の画面でマージするよう案内する `detail` を含め、`kind` が `pr-state` の失敗を返すことを確認します。')
      const outcome = await finishTool(await openWorkspace({ github: mergedRules({ state: 'OPEN' }) }), {})
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'pr-state' } })
      expect(outcome.structured['detail']).toContain('merge it on GitHub first')
      expect(outcome.structured['detail']).not.toContain('pr_merge')
    })

    it('リポを含む設定が 2 つあってアクティブな設定がどれでもないと、候補と project の案内を detail に入れ、no-active-project で失敗する', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-26')
      await explains('`session finish` の MCP の失敗のテストです。対象のリポジトリを含む設定が 2 つあり、アクティブな設定がどれでもない場合に、候補と `project` の案内を `detail` に含め、`no-active-project` で失敗することを確認します。')
      const outcome = await finishTool(await openWorkspace({ files: ambiguousWorkspaceFiles() }), {})
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      expect(outcome.structured['detail']).toContain('choose one with project: <NAME>')
      expect(outcome.structured['detail']).toContain(`available: ${AMBIGUOUS_MESSAGE}`)
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-43')
      await explains('`session finish` の MCP の失敗のテストです。対象のリポジトリを含む設定が存在しない場合に、`kind` が `repo-not-in-project` の失敗を返すことを確認します。')
      const outcome = await finishTool(await openWorkspace({ config: false }), {})
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'repo-not-in-project' } })
    })

    it.for([
      { title: 'PR が無い', rules: [graphql(MERGED, NO_PULL_REQUEST)], expected: 'PR not found: acme/demo/21' },
      { title: 'PR を取得できない', rules: [rule({ operation: MERGED }, { status: 502, body: { message: 'Bad Gateway' } })], expected: 'GraphQL query error: ' },
    ])('次の場合は（$title）、失敗を返す', async (row, context) => {
      await verifies(context, 'PW-SESSION-FINISH-27')
      await explains('`session finish` の MCP の失敗のテストです。PR が存在しない場合と取得に失敗した場合は、原因を `detail` に含む失敗を返すことを確認します。')
      const outcome = await finishTool(await openWorkspace({ github: row.rules }), {})
      expect(outcome.isError).toBe(true)
      expect(outcome.structured['detail']).toContain(row.expected)
    })

    it('pr_ref の形が誤っていると、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-28')
      await explains('`session finish` の MCP の失敗のテストです。`pr_ref` の形式が誤っている場合に、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const workspace = await openWorkspace()
      const outcome = await finishTool(workspace, { pr_ref: 'not-a-ref' })
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(workspace.requests()).toStrictEqual([])
    })

    it('リモートのブランチの削除と checkout が失敗すると、済んだ分と warning を data に返して続ける', async (context) => {
      await verifies(context, 'PW-COMMON-19')
      await explains('`session finish` の MCP の結果のテストです。リモートブランチの削除と checkout が失敗した場合に、完了した分と `warning` を data に含めて処理を続けることを確認します。')
      const workspace = await cleanupBranch({ config: { developBranch: 'ghost' }, github: mergedRules({}, [...closedRules(12), deleteRule(403, 'Forbidden')]) })

      const outcome = await finishTool(workspace, { delete_branch: true })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        closedIssues: [12],
        skippedIssues: [],
        deletedBranches: [],
        readinessChanges: [],
        restack: [],
        currentBranch: BRANCH,
        warnings: [expect.stringMatching(new RegExp(`^deleting remote branch ${BRANCH} failed: `, 'u')), expect.stringMatching(/^checking out ghost failed: /u)],
      })
      expect(currentBranch(workspace)).toBe(BRANCH)
    })
  })
})
