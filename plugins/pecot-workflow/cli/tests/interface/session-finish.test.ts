/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
// session finish の振る舞い（PW-SESSION-FINISH-*）を、runCli をプロセス内で呼んで確かめる。
// GitHub は偽サーバ、git は一時リポ（origin は bare）、設定は一時ディレクトリのファイルにする。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../../src/commands/registry.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import { AMBIGUOUS_MESSAGE, ambiguousWorkspaceFiles, NO_ACTIVE_FILES, SECOND_PROJECT } from '../_helpers/project-selection.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { verifies } from '../_helpers/verifies.js'
import { filesOf, KIND_FAILURE, lines, operationsOf, restRequests, stateFile } from '../_helpers/workspace-inspect.js'
import { finishPullRequestData, graphql, HOST, issueKindData, openWorkspace, rest, rule } from '../_helpers/workspace.js'
import type { FinishPullRequestSample, ResponseRuleList, Workspace, WorkspaceOptions } from '../_helpers/workspace.js'
import { settleWithFakeDelays, useFakeDelays } from '../_helpers/interface-case.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { IssueSpec, TargetSpec } from '../_helpers/prerequisites.js'
import type { ResponseRule } from '../fake-github/server.js'

useIsolatedEnvironment()

const BRANCH = 'feat/demo/12'
const REMOTE_DELETE_FAILED = new RegExp(`^deleting remote branch ${BRANCH} failed: `, 'u')
const KIND_WARNING_NOT_CLOSED = /^warning: reading Issue #12 failed: GraphQL query error: Server error '500 Internal Server Error' for url '[^']+'\n {2}For more information check: [^\n]+\/500; not closed\n/mu

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
async function finishTool(workspace: Readonly<Workspace>, argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const previous = process.cwd()
  process.chdir(workspace.directory)
  try {
    return await callToolOnce(COMMANDS, 'session_finish', { pr_ref: 'acme/demo/21', ...argumentsOfTool })
  }
  finally {
    process.chdir(previous)
  }
}

// #12 を待つ Issue。#13 は未着手で Blocked、#14 は #12 の上に積んで着手し In Review

const UPPER = 'feat/demo/14'
// PR #21 がマージされ、閉じた #12
const DONE_12: IssueSpec = { number: 12, state: 'CLOSED', branch: BRANCH, pullRequests: [{ number: 21, head: BRANCH, state: 'MERGED' }] }
// PR #21 はマージされたが、まだ開いている（GitHub に close が届く前の）#12
const MERGED_UNCLOSED_12: IssueSpec = { ...DONE_12, state: 'OPEN' }

function boardItemRule(number: number, column: string): ResponseRule {
  const projectItems = { nodes: [{ id: `PVTI_${String(number)}`, project: { id: 'PVT_1' }, workflow: { name: column } }] }
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
    const github = mergedRules({ closing: [10, [11, 'acme/other']], body: 'Fixes #13\n' }, [10, 12].flatMap(number => closedRules(number)))
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    const closed = restRequests(workspace, 'PATCH')
    expect(closed).toMatchObject([10, 12].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}`, body: { state: 'closed' } })))
  })

  it('既定ブランチでない base の PR の参照を渡すと、本文のコードと HTML コメントの外の Closes / Fixes / Resolves の Issue も close する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-01')
    const body = 'Fixes #11\n\nResolves #13\n\n```console\nCloses #15\n```\n\n`Closes #16` <!-- Closes #17 -->\n\nCloses acme/other#18\n\nCloses #14\n'
    const github = mergedRules({ base: 'develop', closing: [], body }, [11, 12, 13, 14].flatMap(number => closedRules(number)))
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    const closed = restRequests(workspace, 'PATCH')
    expect(closed).toMatchObject([11, 12, 13, 14].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}`, body: { state: 'closed' } })))
  })

  it('base のリポに既定ブランチが無いと、本文の Closes の Issue も close する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-01')
    // eslint-disable-next-line unicorn/no-null -- 応答の形（既定ブランチが無いと null）
    const github = mergedRules({ defaultBranch: null, closing: [], body: 'Closes #13\n' }, [12, 13].flatMap(number => closedRules(number)))
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([12, 13].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}` })))
  })

  it('閉じた Issue があると、close を送らず、unchanged の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-41')
    const github = mergedRules({ closing: [10] }, [kindRule(10, { state: 'CLOSED' }), waitingRule([], 10), ...closedRules(12)])
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^count: Issues to close: 1\nunchanged: Issue #10 \(already closed\)\nclosed: Issue #12\n$/u)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12' }])
  })

  it('閉じた Issue があると、MCP の結果の skippedIssues に already-closed で入れる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-41')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12, { state: 'CLOSED' }), waitingRule([])]) })
    const outcome = await finishTool(workspace, { skip_local_cleanup: true })
    expect(outcome.structured).toMatchObject({ closedIssues: [], skippedIssues: [{ number: 12, reason: 'already-closed' }] })
    expect(restRequests(workspace, 'PATCH')).toStrictEqual([])
  })

  it('閉じた Issue があると、--dry-run でも close の予定に入れず、unchanged の予定の行を出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-41')
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12, { state: 'CLOSED' }), waitingRule([])]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup', '--dry-run'])
    expect(lines(result.stderr)).toStrictEqual(['count: Issues to close: 0', 'dry-run: would leave Issue #12 (already closed) unchanged'])
  })

  it('閉じた Epic があると、Epic として skipped の行を出す', async () => {
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12, { issueType: 'Epic', state: 'CLOSED' })]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr).toBe('count: Issues to close: 0\nskipped: closing Issue #12 (Epic)\n')
  })

  it.for([
    { title: 'Issue Type が Epic', options: { issueType: 'Epic' } },
    { title: 'sub-issue を持つ Issue', options: { subIssues: 3 } },
  ])('次の Issue があると（$title）、その Issue を close しない', async (row, context) => {
    await verifies(context, 'PW-SESSION-FINISH-02')
    const workspace = await openWorkspace({ github: mergedRules({ closing: [10] }, [kindRule(10, row.options), ...closedRules(12)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
    expect(result.stderr).toContain('count: Issues to close: 1\n')
    expect(result.stderr).toContain('closed: Issue #12\n')
  })

  it('もし Issue の種別と状態を読めないなら、warning の行を出し、その Issue を close しない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-42')
    const workspace = await openWorkspace({ github: mergedRules({}, [KIND_FAILURE]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(KIND_WARNING_NOT_CLOSED)
    expect(result.stderr).toMatch(/\ncount: Issues to close: 0\n$/u)
    expect(restRequests(workspace, 'PATCH')).toStrictEqual([])
  })

  it('もし Issue の種別と状態を読めないなら、MCP の結果の skippedIssues に failed で入れる', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-42')
    const workspace = await openWorkspace({ github: mergedRules({}, [KIND_FAILURE]) })
    const outcome = await finishTool(workspace, { skip_local_cleanup: true })
    expect(outcome.structured).toMatchObject({ closedIssues: [], skippedIssues: [{ number: 12, reason: 'failed' }] })
  })

  it('Epic か sub-issue を持つ Issue があると、skipped の行を標準エラーに出す', async () => {
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12, { subIssues: 1 })]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr).toBe('count: Issues to close: 0\nskipped: closing Issue #12 (Epic)\n')
  })

  it('--delete-branch を付けて打つと、リモートの head ブランチを削除する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-04')
    const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule()]) })
    const result = await workspace.run([...CLEANUP, '--delete-branch', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'DELETE')).toMatchObject([{ path: `/repos/acme/demo/git/refs/heads/${BRANCH}` }])
  })

  it('カレントのリポジトリが PR のリポジトリと同じで worktree の外だと、develop_branch のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
    const workspace = await cleanupBranch({ github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain('set: current branch to main\n')
    expect(currentBranch(workspace)).toBe('main')
  })

  it('カレントが worktree だと、置き場所の親ディレクトリの名前の wtN のブランチに切り替える', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-06')
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

  it('ブランチを切り替えると、origin の remote（無ければ最初の remote）から develop_branch を pull する', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-07')
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
    const workspace = await cleanupBranch({ github: mergedRules() })
    expect(hasBranch(workspace)).toBe(true)
    const result = await workspace.run(CLEANUP)
    expect(result.stderr).toContain(`deleted: local branch ${BRANCH}\n`)
    expect(hasBranch(workspace)).toBe(false)
  })

  it('ローカルの片付けを終えると、フラグのファイルを消し、古い版の .pecot-quick-mode・.pecot-active には触れない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-09')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
    await workspace.run(CLEANUP)
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([false, false])
    expect(LEFTOVER_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
  })

  it('--skip-local-cleanup を付けて打つと、ローカルの片付けをしない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-10')
    const workspace = await cleanupBranch({ github: mergedRules() })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
    expect(result.stderr).not.toContain('current branch')
  })

  it('--skip-local-cleanup を付けて打つと、フラグのファイルを消さない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-11')
    const workspace = await cleanupBranch({ github: mergedRules(), files: flagFiles() })
    await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(ALL_FLAGS.map(name => workspace.exists(stateFile(name)))).toStrictEqual([true, true])
  })

  it('--dry-run を付けて打つと、何も変えずに dry-run: would の行を標準エラーに出す', async () => {
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
    const workspace = await openWorkspace({ github: mergedRules({ closing: [10] }, [...closedRules(10), ...closedRules(12)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr.startsWith('count: Issues to close: 2\n')).toBe(true)
  })

  it('Issue を close すると、closed の行を標準エラーに出す', async () => {
    const workspace = await openWorkspace({ github: mergedRules() })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.stderr).toBe('count: Issues to close: 1\nclosed: Issue #12\n')
  })

  it('ブランチを削除すると、deleted の行を標準エラーに出す', async () => {
    const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule()]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.stderr).toContain(`deleted: remote branch ${BRANCH}\n`)
  })

  it('リモートの head ブランチが既に無いと、unchanged の行を標準エラーに出す', async () => {
    const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule(422, 'Reference does not exist')]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`unchanged: remote branch ${BRANCH} (already deleted)\n`)
  })

  it('ローカルの head ブランチが既に無いなら、warning の行を標準エラーに出す', async () => {
    const workspace = await openWorkspace({ github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(new RegExp(`\\nwarning: deleting local branch ${BRANCH} failed: .*\\n$`, 'u'))
  })

  it('--delete-branch を付けてローカルの片付けも通すと、結果の行を実行した順で標準エラーへ出す', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-04')
    await verifies(context, 'PW-SESSION-FINISH-13')
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
    const github = [graphql(MERGED, finishPullRequestData({ closing: [], body: '', head: 'feat/other' }))]
    const workspace = await cleanupBranch({ github, config: { hasSecondRepository: true } })
    const result = await workspace.run(['session', 'finish', 'acme/other/21'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: current repository (acme/demo) differs from the PR\'s (acme/other); skipped local cleanup\n')
  })

  it('カレントのリポジトリが PR のリポジトリと違うなら、ローカルの片付けを飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-19')
    const github = [graphql(MERGED, finishPullRequestData({ closing: [], body: '', head: BRANCH }))]
    const workspace = await cleanupBranch({ github, config: { hasSecondRepository: true } })
    const result = await workspace.run(['session', 'finish', 'acme/other/21'])
    expect(result.stderr).not.toContain('current branch')
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
  })

  it('Issue の close に失敗したなら、warning の行を標準エラーに出す', async () => {
    const workspace = await openWorkspace({ github: mergedRules({}, [kindRule(12), closeRule(12, 500)]) })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/\nwarning: closing Issue #12 failed: /u)
  })

  it('Issue の close に失敗したなら、ほかの Issue と後の処理を続ける', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-21')
    const github = mergedRules({ closing: [10] }, [kindRule(10), closeRule(10, 500), ...closedRules(12), deleteRule()])
    const workspace = await openWorkspace({ github })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('closed: Issue #12\n')
    expect(result.stderr).toContain(`deleted: remote branch ${BRANCH}\n`)
  })

  it('リモートの head ブランチの削除に失敗したなら、warning の行を標準エラーに出し、終了コード 0 で終わる', async () => {
    const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule(403, 'Forbidden')]) })
    const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`warning: deleting remote branch ${BRANCH} failed: `)
    expect(restRequests(workspace, 'DELETE')).toHaveLength(1)
  })

  it('checkout に失敗したなら、pull と git branch -D を飛ばす', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-23')
    const workspace = await cleanupBranch({ config: { developBranch: 'ghost' }, github: mergedRules() })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: checking out ghost failed: ')
    expect(result.stderr).not.toContain('updated:')
    expect(result.stderr).not.toContain('deleted: local branch')
    expect(currentBranch(workspace)).toBe(BRANCH)
  })

  it('PR がマージされていないなら、終了コード 1 で終わる', async () => {
    const workspace = await openWorkspace({ github: mergedRules({ state: 'OPEN' }) })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: PR #21 is not merged yet (state: OPEN); merge it with pecot pr merge first\n' })
  })

  it('PR がマージされていないなら、何も変えない', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-25')
    const workspace = await cleanupBranch({ github: mergedRules({ state: 'OPEN' }), files: flagFiles() })
    const files = filesOf(workspace.directory)
    await workspace.run([...CLEANUP, '-d'])
    expect(operationsOf(workspace)).toStrictEqual([MERGED])
    expect(currentBranch(workspace)).toBe(BRANCH)
    expect(hasBranch(workspace)).toBe(true)
    expect(filesOf(workspace.directory)).toStrictEqual(files)
  })

  it('対象のリポを含む設定が 2 つあり .active も選べないなら、候補と --project の案内を出して終了コード 1 で終わる', async () => {
    const workspace = await openWorkspace({ files: ambiguousWorkspaceFiles() })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: `error: acme/demo is in 2 project configs\n  choose one with --project <NAME>\n  available: ${AMBIGUOUS_MESSAGE}\n` })
    expect(workspace.requests()).toStrictEqual([])
  })

  it('対象のリポを含む設定が無いなら、error を出して終了コード 1 で終わる', async () => {
    const workspace = await openWorkspace({ config: false })
    const result = await workspace.run(CLEANUP)
    expect(result).toStrictEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: (none)\n' })
    expect(workspace.requests()).toStrictEqual([])
  })

  it('--project を渡すと、対象のリポを含む設定が 2 つあってもその設定で片付ける', async (context) => {
    await verifies(context, 'PW-SESSION-FINISH-44')
    const workspace = await openWorkspace({ github: mergedRules(), files: ambiguousWorkspaceFiles() })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup', '--project', SECOND_PROJECT])
    expect(result.code).toBe(0)
    expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12' }])
  })

  it('.active が無くても、対象のリポを含む設定が 1 つならその設定で片付ける', async () => {
    const workspace = await openWorkspace({ github: mergedRules(), files: NO_ACTIVE_FILES })
    const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
    expect(result.code).toBe(0)
  })

  it.for([
    { title: 'PR が無い', rules: [graphql(MERGED, NO_PULL_REQUEST)], expected: 'error: PR not found: acme/demo/21\n' },
    { title: 'PR を取得できない', rules: [rule({ operation: MERGED }, { status: 502, body: { message: 'Bad Gateway' } })], expected: 'error: GraphQL query error: ' },
  ])('次の場合は（$title）、終了コード 1 で終わる', async (row) => {
    const workspace = await openWorkspace({ github: row.rules })
    const result = await workspace.run(CLEANUP)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith(row.expected)).toBe(true)
  })

  it('PR の参照の形が誤っているなら、終了コード 2 で終わる', async () => {
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
      const workspace = await openWorkspace({ github: [...WAITING_RULES, READY_WRITE_13] })
      const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
      expect(result.code).toBe(0)
      expect(lines(result.stderr)).toStrictEqual([
        'count: Issues to close: 1',
        'closed: Issue #12',
        'moved: #13 Blocked -> Ready (startable)',
        `warning: #14 is stacked on #12; run pecot pr restack in the working directory of ${UPPER}`,
      ])
      const writes = workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')
      expect(writes).toMatchObject([{ variables: { itemId: 'PVTI_13', optionId: 'o3' } }])
    })

    it('待つ Issue の列が古い ID で書けないと、warning と project activate の案内を出して続け、終了コード 0 で終わる', async () => {
      const workspace = await openWorkspace({ github: [...WAITING_RULES, staleOptionUpdate()] })
      const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
      expect(result.code).toBe(0)
      const stderr = lines(result.stderr)
      expect(stderr.slice(0, 3)).toStrictEqual([
        'count: Issues to close: 1',
        'closed: Issue #12',
        `warning: could not move #13: ${STALE_OPTION_TEXT}`,
      ])
      expect(stderr[3]).toMatch(/^ {2}hint: if the board options were recreated, run pecot project activate \S+ to read their IDs again$/u)
      expect(stderr.slice(4)).toStrictEqual([`warning: #14 is stacked on #12; run pecot pr restack in the working directory of ${UPPER}`])
    })

    it('判定が変わった Issue を、stdout の Readiness changed の節に出す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-33')
      const workspace = await openWorkspace({ github: [...WAITING_RULES, READY_WRITE_13] })
      const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
      expect(result.stdout).toBe('Readiness changed:\n- #13 stackable on #12 -> startable\n- #14 stackable on #12 -> startable\n')
    })

    it('判定が変わらない待つ Issue は、Readiness changed の節に出さない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-34')
      // #13 は別の未着手の前提 #15 も待つので、#12 の前後で blocked のまま
      const github = [...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), prerequisitesRule({ number: 13, blockedBy: [DONE_12, { number: 15 }] })]
      const workspace = await openWorkspace({ github })
      const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
      expect(result).toStrictEqual({ code: 0, stdout: '', stderr: 'count: Issues to close: 1\nclosed: Issue #12\n' })
    })

    it('上に積んだ段があると、載せ直しを案内し、上の段のブランチを消す要求を送らない', async () => {
      const workspace = await openWorkspace({ github: [...WAITING_RULES, READY_WRITE_13, deleteRule()] })
      const result = await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
      expect(result.stderr).toContain(`warning: #14 is stacked on #12; run pecot pr restack in the working directory of ${UPPER}\n`)
      expect(restRequests(workspace, 'DELETE')).toMatchObject([{ path: `/repos/acme/demo/git/refs/heads/${BRANCH}` }])
    })

    it('Issue を閉じた後、ブランチを消す前に、待つ Issue を読んで動かす', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-31')
      const workspace = await openWorkspace({ github: [...WAITING_RULES, READY_WRITE_13, deleteRule()] })
      await workspace.run([...CLEANUP, '-d', '--skip-local-cleanup'])
      const operations = operationsOf(workspace)
      expect(operations.indexOf('GetIssueBlockingReferences')).toBeGreaterThan(operations.indexOf('PATCH /repos/acme/demo/issues/12'))
      expect(operations.indexOf('UpdateProjectItemField')).toBeLessThan(operations.indexOf(`DELETE /repos/acme/demo/git/refs/heads/${BRANCH}`))
    })

    it('base が開発ブランチでない PR を片付けても、その PR の Issue を閉じる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-38')
      const workspace = await openWorkspace({ github: mergedRules({ base: 'feat/demo/11' }) })
      const result = await workspace.run([...CLEANUP, '--skip-local-cleanup'])
      expect(result.code).toBe(0)
      expect(restRequests(workspace, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
    })

    it('ローカルの片付けを終えると、base の記録のファイルを消し、古い版の .pecot-active には触れない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-09')
      const files = { [stateFile('.pecot-active')]: 'acme/demo/12\n', [stateFile('.pecot-base')]: `feat/demo/11 ${'0'.repeat(40)} acme/demo#11\n` }
      const workspace = await cleanupBranch({ github: mergedRules(), files })
      await workspace.run(CLEANUP)
      expect([workspace.exists(stateFile('.pecot-active')), workspace.exists(stateFile('.pecot-base'))]).toStrictEqual([true, false])
    })

    it('前提にされていない Issue の PR では、待つ Issue の読み取りを 1 回だけ足し、出力を変えない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-34')
      const workspace = await cleanupBranch({ github: mergedRules({}, [...closedRules(12), deleteRule()]) })
      const result = await workspace.run([...CLEANUP, '-d'])
      expect(result).toStrictEqual({
        code: 0,
        stdout: '',
        stderr: `count: Issues to close: 1\nclosed: Issue #12\ndeleted: remote branch ${BRANCH}\nset: current branch to main\nupdated: main from origin/main\ndeleted: local branch ${BRANCH}\n`,
      })
      expect(operationsOf(workspace).filter(operation => operation === 'GetIssueBlockingReferences')).toHaveLength(1)
    })

    it('待つ Issue の判定に閉じた Issue が済んだ前提として出なければ、1 回だけ読み直してから動かす', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-31')
      const github = [...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12), waitingTarget(13), READY_WRITE_13]
      const workspace = await openWorkspace({ github })
      useFakeDelays()
      const result = await settleWithFakeDelays(workspace.run([...CLEANUP, '--skip-local-cleanup']))
      expect(result.stderr).toContain('moved: #13 Blocked -> Ready (startable)\n')
      expect(operationsOf(workspace).filter(operation => operation === 'GetIssuePrerequisites')).toHaveLength(2)
    })

    it('読み直しても閉じた Issue が済んだ前提として出なければ、board sync で後から直せる旨の warning の行を出して列を動かさない', async () => {
      const github = [...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12), waitingTarget(13, MERGED_UNCLOSED_12)]
      const workspace = await openWorkspace({ github })
      useFakeDelays()
      const result = await settleWithFakeDelays(workspace.run([...CLEANUP, '--skip-local-cleanup']))
      expect(result).toStrictEqual({
        code: 0,
        stdout: '',
        stderr: 'count: Issues to close: 1\nclosed: Issue #12\nwarning: could not confirm that GitHub reflects the close of #12 in the readiness of #13; its column was not moved; run pecot board sync later to move it\n',
      })
    })

    it('--dry-run では、閉じる前の Issue を済んだものとして判定し、列を書かずに予定の行と判定の変化を出す', async () => {
      const github = [...mergedRules({}, [kindRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12)]
      const workspace = await openWorkspace({ github })
      const result = await workspace.run([...CLEANUP, '--dry-run', '--skip-local-cleanup'])
      expect(result).toStrictEqual({
        code: 0,
        stdout: 'Readiness changed:\n- #13 stackable on #12 -> startable\n',
        stderr: 'count: Issues to close: 1\ndry-run: would close Issue #12\ndry-run: would move #13 Blocked -> Ready (startable)\n',
      })
      expect(workspace.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')).toStrictEqual([])
    })
  })

  describe('MCP の data', () => {
    it('待つ Issue の判定が変わり、上に積んだ段があると、readinessChanges と restack を data に返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-33')
      const workspace = await openWorkspace({ github: [...WAITING_RULES, READY_WRITE_13] })

      const outcome = await finishTool(workspace, { skip_local_cleanup: true })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        closedIssues: [12],
        skippedIssues: [],
        deletedBranches: [],
        readinessChanges: [{ issue: '#13', from: 'stackable on #12', to: 'startable' }, { issue: '#14', from: 'stackable on #12', to: 'startable' }],
        restack: [{ issue: '#14', branch: UPPER }],
        warnings: [`#14 is stacked on #12; run pr_restack in the working directory of ${UPPER}`],
      })
    })

    it('ブランチの削除とローカルの片付けまで通すと、close した Issue・消したブランチ・切り替えた先を data に返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-14')
      await verifies(context, 'PW-SESSION-FINISH-15')
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
      const workspace = await openWorkspace({ github: mergedRules({ closing: [10] }, [kindRule(10, { issueType: 'Epic' }), ...closedRules(12)]) })

      const outcome = await finishTool(workspace, { skip_local_cleanup: true })

      expect(outcome.structured).toEqual({ closedIssues: [12], skippedIssues: [{ number: 10, reason: 'epic' }], deletedBranches: [], readinessChanges: [], restack: [] })
    })

    it('dry_run で打つと、close する予定の Issue・消す予定のブランチ・切り替える先と dryRun を data に返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-12')
      const workspace = await cleanupBranch({ github: mergedRules() })

      const outcome = await finishTool(workspace, { delete_branch: true, dry_run: true })

      expect(outcome.structured).toEqual({
        closedIssues: [12],
        skippedIssues: [],
        deletedBranches: [{ branch: BRANCH, location: 'remote' }, { branch: BRANCH, location: 'local' }],
        readinessChanges: [],
        restack: [],
        currentBranch: 'main',
        dryRun: true,
      })
      expect(currentBranch(workspace)).toBe(BRANCH)
      expect([...restRequests(workspace, 'PATCH'), ...restRequests(workspace, 'DELETE')]).toStrictEqual([])
    })

    it('判定が変わらない待つ Issue だけだと、readinessChanges を空の配列にする', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-34')
      const github = [...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), prerequisitesRule({ number: 13, blockedBy: [DONE_12, { number: 15 }] })]
      const outcome = await finishTool(await openWorkspace({ github }), { skip_local_cleanup: true })
      expect(outcome.structured['readinessChanges']).toStrictEqual([])
    })

    it('上に積んだ段があると、pr_restack を warnings で案内し、その段のブランチを消す要求を送らない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-35')
      const workspace = await openWorkspace({ github: [...WAITING_RULES, READY_WRITE_13, deleteRule()] })
      const outcome = await finishTool(workspace, { delete_branch: true, skip_local_cleanup: true })
      expect(outcome.structured['warnings']).toStrictEqual([`#14 is stacked on #12; run pr_restack in the working directory of ${UPPER}`])
      expect(restRequests(workspace, 'DELETE')).toMatchObject([{ path: `/repos/acme/demo/git/refs/heads/${BRANCH}` }])
    })

    it('リモートの head ブランチが既に無いと、deletedBranches へ入れずに続ける', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-16')
      const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule(422, 'Reference does not exist')]) })
      const outcome = await finishTool(workspace, { delete_branch: true, skip_local_cleanup: true })
      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toMatchObject({ closedIssues: [12], deletedBranches: [] })
    })

    it('ローカルの head ブランチが既に無いと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-17')
      const outcome = await finishTool(await openWorkspace({ github: mergedRules() }), {})
      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toStrictEqual([expect.stringMatching(new RegExp(`^deleting local branch ${BRANCH} failed: `, 'u'))])
    })

    it('セッションのリポジトリが PR のリポジトリと違うと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-18')
      const github = [graphql(MERGED, finishPullRequestData({ closing: [], body: '', head: 'feat/other' }))]
      const outcome = await finishTool(await cleanupBranch({ github, config: { hasSecondRepository: true } }), { pr_ref: 'acme/other/21' })
      expect(outcome.structured['warnings']).toStrictEqual(['current repository (acme/demo) differs from the PR\'s (acme/other); skipped local cleanup'])
    })

    it('Issue の close に失敗すると、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-20')
      const github = mergedRules({}, [kindRule(12), closeRule(12, 500)])
      const outcome = await finishTool(await openWorkspace({ github }), { skip_local_cleanup: true })
      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toStrictEqual([expect.stringMatching(/^closing Issue #12 failed: /u)])
    })

    it('リモートの head ブランチの削除に失敗すると、warnings に 1 つ入れ、成功を返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-39')
      const workspace = await openWorkspace({ github: mergedRules({}, [...closedRules(12), deleteRule(403, 'Forbidden')]) })
      const outcome = await finishTool(workspace, { delete_branch: true, skip_local_cleanup: true })
      expect(outcome.isError).toBe(false)
      expect(outcome.structured['warnings']).toStrictEqual([expect.stringMatching(REMOTE_DELETE_FAILED)])
    })

    it('待つ Issue の列が古い ID で書けないと、warnings に入れて続け、project_activate の案内を 1 回だけ添える', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-40')
      const outcome = await finishTool(await openWorkspace({ github: [...WAITING_RULES, staleOptionUpdate()] }), { skip_local_cleanup: true })
      expect(outcome.isError).toBe(false)
      const warnings = [outcome.structured['warnings']].flat().filter(warning => typeof warning === 'string')
      expect(warnings[0]?.startsWith(`could not move #13: ${STALE_OPTION_TEXT}\n`)).toBe(true)
      expect(warnings.filter(warning => warning.includes('project_activate'))).toHaveLength(1)
    })

    it('読み直しても閉じた Issue が済んだ前提として判定に出ないと、warnings に 1 つ入れて列を動かさない', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-36')
      const github = [...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12), waitingTarget(13, MERGED_UNCLOSED_12)]
      const workspace = await openWorkspace({ github })
      useFakeDelays()
      const outcome = await settleWithFakeDelays(finishTool(workspace, { skip_local_cleanup: true }))
      expect(outcome.structured['warnings']).toStrictEqual([expect.stringMatching(/^could not confirm that GitHub reflects the close of #12 in the readiness of #13; its column was not moved/u)])
      expect(operationsOf(workspace)).not.toContain('UpdateProjectItemField')
    })

    it('dry_run だと、閉じる予定の Issue を済んだものとして判定し、列を書かずに判定の変化を readinessChanges に入れる', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-37')
      const github = [...mergedRules({}, [kindRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12)]
      const workspace = await openWorkspace({ github })
      const outcome = await finishTool(workspace, { dry_run: true, skip_local_cleanup: true })
      expect(outcome.structured['readinessChanges']).toStrictEqual([{ issue: '#13', from: 'stackable on #12', to: 'startable' }])
      expect(operationsOf(workspace)).not.toContain('UpdateProjectItemField')
    })

    it('PR がマージされていないと、pr_merge を案内する detail を入れて、kind が pr-state の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-24')
      const outcome = await finishTool(await openWorkspace({ github: mergedRules({ state: 'OPEN' }) }), {})
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'pr-state' } })
      expect(outcome.structured['detail']).toContain('pr_merge')
    })

    it('リポを含む設定が 2 つあってアクティブな設定がどれでもないと、候補と project の案内を detail に入れ、no-active-project で失敗する', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-26')
      const outcome = await finishTool(await openWorkspace({ files: ambiguousWorkspaceFiles() }), {})
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
      expect(outcome.structured['detail']).toContain('choose one with project: <NAME>')
      expect(outcome.structured['detail']).toContain(`available: ${AMBIGUOUS_MESSAGE}`)
    })

    it('対象のリポを含む設定が無いと、kind が repo-not-in-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-43')
      const outcome = await finishTool(await openWorkspace({ config: false }), {})
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'repo-not-in-project' } })
    })

    it.for([
      { title: 'PR が無い', rules: [graphql(MERGED, NO_PULL_REQUEST)], expected: 'PR not found: acme/demo/21' },
      { title: 'PR を取得できない', rules: [rule({ operation: MERGED }, { status: 502, body: { message: 'Bad Gateway' } })], expected: 'GraphQL query error: ' },
    ])('次の場合は（$title）、失敗を返す', async (row, context) => {
      await verifies(context, 'PW-SESSION-FINISH-27')
      const outcome = await finishTool(await openWorkspace({ github: row.rules }), {})
      expect(outcome.isError).toBe(true)
      expect(outcome.structured['detail']).toContain(row.expected)
    })

    it('pr_ref の形が誤っていると、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-SESSION-FINISH-28')
      const workspace = await openWorkspace()
      const outcome = await finishTool(workspace, { pr_ref: 'not-a-ref' })
      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(workspace.requests()).toStrictEqual([])
    })

    it('リモートのブランチの削除と checkout が失敗すると、済んだ分と warning を data に返して続ける', async (context) => {
      await verifies(context, 'PW-COMMON-19')
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
