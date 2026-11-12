// dependabot sync の振る舞い（PW-DEPENDABOT-SYNC-*）を、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { beforeEach, describe, expect, it } from 'vitest'

import { DEPENDABOT_COMMANDS } from '../../src/commands/dependabot.js'
import type { JsonObject } from '../../src/domain/json.js'
import { JSON_NULL } from '../../src/domain/json-null.js'
import { setEnvironment, useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import {
  failedRule,
  HOUR,
  issueList,
  listings,
  MINUTE,
  patched,
  pullRequest,
  pullRequestList,
  TODAY_TITLE,
  trackerBody,
  trackerIssue,
} from '../_helpers/dependabot-case.js'
import type { PrOptions } from '../_helpers/dependabot-case.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { CliResult, RunningGithub } from '../_helpers/interface-case.js'
import type { ResponseRule } from '../fake-github/server.js'
import { boardRules, createdTracker, freezeClock, graphqlServerError, missingTokenStderr, PRIORITY_FIELD, prepareSync, WORKFLOW_FIELD } from '../_helpers/tracker-sync-case.js'
import type { SyncSetup } from '../_helpers/tracker-sync-case.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

beforeEach(() => {
  freezeClock()
})

const BOTH_FILLED = [WORKFLOW_FIELD, PRIORITY_FIELD]
const COUNTS_ONE = 'count: open dependabot PRs: 1\ncount: PRs awaiting a decision: 1\ncount: PRs awaiting a decision without check results: 0\n'
const FAILURE_CODE = 1
const MAJOR = { kind: 'major' }

interface Run {
  readonly result: CliResult
  readonly github: RunningGithub
}

async function sync(rules: readonly ResponseRule[], argv: readonly string[] = [], setup?: Readonly<SyncSetup>): Promise<Run> {
  prepareSync(setup)
  const github = await startGithub(rules)
  const result = await runInProcess(['dependabot', 'sync', ...argv], DEPENDABOT_COMMANDS)
  return { result, github }
}

function labelsOf(github: Readonly<RunningGithub>): string[] {
  return github.requests().map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}

function writtenBodies(github: Readonly<RunningGithub>): unknown[] {
  return github.requests().flatMap(request => request.type === 'rest' && request.method !== 'GET' ? [request.body] : [])
}

function stderrAfterCounts(result: Readonly<CliResult>): string {
  return result.stderr.split('\n').slice(3).join('\n')
}

const OLD_ROW = trackerBody([[1, 'Bump old', 'failed']])
const NO_PRS_COUNTS = 'count: open dependabot PRs: 0\ncount: PRs awaiting a decision: 0\ncount: PRs awaiting a decision without check results: 0\n'
const OTHER_WARNING = 'warning: multiple open Trackers; using #9 (lowest number) and leaving #12 open\n'

// 使う Tracker のほかに、open の別の Tracker・閉じた Tracker・印の無い Issue を混ぜる。どれも番号は使う Tracker と違う
function withOthers(tracker: Readonly<JsonObject>): JsonObject[] {
  return [trackerIssue(12, OLD_ROW), tracker, trackerIssue(5, OLD_ROW, 'closed'), { number: 7, state: 'open', body: 'マーカーの無い Issue' }]
}

const READS = ['ListOpenPullRequests', 'GET /repos/acme/demo/issues']
const ROW_2 = '| <!-- pecot-dependabot-pr: pr/2 --> `Bump left-pad` | [#2](https://ghes.example.com/acme/demo/pull/2) | passed |'

async function createNewTracker(): Promise<Run> {
  const nodes = [pullRequest({ number: 2, ...MAJOR }), pullRequest({ number: 3, name: 'lodash' })]
  return await sync([...listings(nodes), createdTracker(100), ...boardRules(100, { priority: 'medium', onlyIfEmpty: false })])
}

describe('dependabot sync', () => {
  it('open の Tracker が無く、判断を待つ PR があると、label が dependabot-pr の Tracker の Issue を作る', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-01')
    const { result, github } = await createNewTracker()
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(writtenBodies(github)[0]).toEqual({
      title: TODAY_TITLE,
      body: `<!-- pecot-dependabot-pr: tracker -->\n\n<!-- pecot-dependabot-pr: list-begin -->\n## dependabot PR\n\n| title | PR | checks |\n|---|---|---|\n${ROW_2}\n<!-- pecot-dependabot-pr: list-end -->\n`,
      labels: ['dependabot-pr'],
    })
  })

  it('Tracker の Issue を作ると、ボードに足す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-02')
    const { github } = await createNewTracker()
    expect(labelsOf(github)).toEqual([...READS, 'POST /repos/acme/demo/issues', 'GetIssueNodeId', 'AddToProject', 'UpdateProjectItemField', 'UpdateProjectItemField'])
    expect(github.requests()[4]).toMatchObject({ operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: 'I_100' } })
  })

  it('Tracker の Issue を作ると、Status を Backlog にする', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-03')
    const { github } = await createNewTracker()
    expect(github.requests()).toContainEqual(expect.objectContaining({ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'PVTI_100', fieldId: WORKFLOW_FIELD, optionId: 'o1' } }))
  })

  it('Tracker の Issue を作ると、Priority を medium にする', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-04')
    const { github } = await createNewTracker()
    expect(github.requests()).toContainEqual(expect.objectContaining({ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'PVTI_100', fieldId: PRIORITY_FIELD, optionId: 'p2' } }))
  })

  it('open の Tracker が無く、判断を待つ PR も無いと、Tracker の Issue を作らない', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-05')
    const { result, github } = await sync(listings([pullRequest({ number: 3, name: 'lodash' })]))
    expect(result.code).toBe(0)
    expect(labelsOf(github)).toEqual(READS)
  })

  it('open の Tracker が無く、判断を待つ PR も無いと、skipped の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-06')
    const { result } = await sync(listings([pullRequest({ number: 3, name: 'lodash' })]))
    expect(result.stderr).toBe('count: open dependabot PRs: 1\ncount: PRs awaiting a decision: 0\ncount: PRs awaiting a decision without check results: 0\nskipped: Tracker creation\n')
  })

  it('open の Tracker があると、list-begin と list-end の間の表を、判断を待つ PR の行に書き直す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-07')
    const existing = trackerBody([[1, 'Bump old', 'failed']], '\n人の注記\n')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, existing)]), patched(9, { body: trackerBody([[2, 'Bump left-pad', 'passed']], '\n人の注記\n') }), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: BOTH_FILLED })]
    const { result, github } = await sync(rules)
    expect(result.code).toBe(0)
    expect(labelsOf(github)).toContain('PATCH /repos/acme/demo/issues/9')
    expect(writtenBodies(github)).toEqual([{ body: trackerBody([[2, 'Bump left-pad', 'passed']], '\n人の注記\n') }])
  })

  it.for([
    { name: 'major', pr: { kind: 'major' }, reason: 'major', id: 'PW-DEPENDABOT-SYNC-08' },
    { name: 'update type が決まらない', pr: { kind: 'none' }, reason: 'unknown update type', id: 'PW-DEPENDABOT-SYNC-08' },
    { name: '最初の commit の author が dependabot でない', pr: { commitAuthor: 'someone' }, reason: 'unknown update type', id: 'PW-DEPENDABOT-SYNC-08' },
    { name: '最初の commit の署名が有効でない', pr: { isSigned: false }, reason: 'unknown update type', id: 'PW-DEPENDABOT-SYNC-08' },
    { name: '検証が FAILURE', pr: { rollup: 'FAILURE' }, reason: 'checks failed', id: 'PW-DEPENDABOT-SYNC-09' },
    { name: '検証が ERROR', pr: { rollup: 'ERROR' }, reason: 'checks failed', id: 'PW-DEPENDABOT-SYNC-09' },
    { name: '検証が 25 時間たっても終わらない', pr: { rollup: 'PENDING', age: 25 * HOUR }, reason: 'checks not finishing', id: 'PW-DEPENDABOT-SYNC-10' },
    { name: '検証が結果なしのまま 25 時間たつ', pr: { rollup: JSON_NULL, age: 25 * HOUR }, reason: 'checks not finishing', id: 'PW-DEPENDABOT-SYNC-10' },
    { name: 'auto-merge が無く、検証が 25 時間たっても終わらない', pr: { hasAutoMerge: false, rollup: 'PENDING', age: 25 * HOUR }, reason: 'no auto-merge', id: 'PW-DEPENDABOT-SYNC-10' },
    { name: '検証が 23 時間しかたっていない', pr: { rollup: 'PENDING', age: 23 * HOUR }, reason: undefined, id: 'PW-DEPENDABOT-SYNC-10' },
    { name: 'base が 31 分前に進んで競合している', pr: { mergeable: 'CONFLICTING', age: 2 * HOUR, baseAge: 31 * MINUTE }, reason: 'conflict', id: 'PW-DEPENDABOT-SYNC-11' },
    { name: 'base が 29 分前に進んで競合している', pr: { mergeable: 'CONFLICTING', age: 2 * HOUR, baseAge: 29 * MINUTE }, reason: undefined, id: 'PW-DEPENDABOT-SYNC-11' },
    { name: '最後の push が 31 分前で競合している', pr: { mergeable: 'CONFLICTING', age: 31 * MINUTE }, reason: 'conflict', id: 'PW-DEPENDABOT-SYNC-11' },
    { name: '最後の push の後に merge queue から外された', pr: { hasAutoMerge: false, age: 2 * HOUR, dequeuedAge: 5 * MINUTE }, reason: 'dequeued', id: 'PW-DEPENDABOT-SYNC-12' },
    { name: '最後の push の前に merge queue から外された', pr: { hasAutoMerge: false, age: 10 * MINUTE, dequeuedAge: 20 * MINUTE }, reason: undefined, id: 'PW-DEPENDABOT-SYNC-12' },
    { name: 'auto-merge が無く、最後の push が 31 分前', pr: { hasAutoMerge: false, age: 31 * MINUTE }, reason: 'no auto-merge', id: 'PW-DEPENDABOT-SYNC-13' },
    { name: 'auto-merge が無く、最後の push が 29 分前', pr: { hasAutoMerge: false, age: 29 * MINUTE }, reason: undefined, id: 'PW-DEPENDABOT-SYNC-13' },
    { name: '自動マージの対象で、待つ理由が無い', pr: {}, reason: undefined, id: 'PW-DEPENDABOT-SYNC-14' },
  ] satisfies readonly { name: string, pr: PrOptions, reason: string | undefined, id: string }[])('$name PR は、理由 $reason で扱う', async (row, context) => {
    await verifies(context, row.id)
    const { result } = await sync(listings([pullRequest({ number: 2, ...row.pr })]), ['--dry-run'])
    expect(result.code).toBe(0)
    const expected = row.reason === undefined
      ? 'count: open dependabot PRs: 1\ncount: PRs awaiting a decision: 0\ncount: PRs awaiting a decision without check results: 0\ndry-run: would skip Tracker creation\n'
      : `${row.reason === 'checks not finishing' && row.pr.rollup === JSON_NULL ? COUNTS_ONE.replace('without check results: 0', 'without check results: 1') : COUNTS_ONE}dry-run: would create Tracker "${TODAY_TITLE}"\ndry-run: would add PR #2 to new Tracker (${row.reason})\n`
    expect(result.stderr).toBe(expected)
  })

  it('PR の一覧を取れ、Tracker の本文の印が正しいと、PR の数と判断を待つ PR の数と検証の結果が無い PR の数の count の行を出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-15')
    const nodes = [
      pullRequest({ number: 2, ...MAJOR, rollup: JSON_NULL }),
      pullRequest({ number: 3, ...MAJOR }),
      pullRequest({ number: 4, name: 'lodash', rollup: JSON_NULL }),
      pullRequest({ number: 5, name: 'other', author: { __typename: 'User', login: 'someone' }, ...MAJOR }),
    ]
    const { result } = await sync(listings(nodes), ['--dry-run'])
    expect(result.stderr.split('\n').slice(0, 3)).toEqual(['count: open dependabot PRs: 3', 'count: PRs awaiting a decision: 2', 'count: PRs awaiting a decision without check results: 1'])
  })

  it('表に PR を足すと、added の行を理由とともに標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-16')
    const nodes = [pullRequest({ number: 2, ...MAJOR }), pullRequest({ number: 6, rollup: 'FAILURE', mergeable: 'CONFLICTING', age: 2 * HOUR })]
    const rules = [...listings(nodes, [trackerIssue(9, trackerBody([[2, 'Bump left-pad', 'passed']]))]), patched(9), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: BOTH_FILLED })]
    const { result } = await sync(rules)
    expect(stderrAfterCounts(result)).toBe('added: PR #6 to Tracker #9 (checks failed, conflict)\n')
  })

  it('表から PR を外すと、removed の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-17')
    const existing = trackerBody([[1, 'Bump old', 'failed'], [2, 'Bump left-pad', 'passed']])
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, existing)]), patched(9), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: BOTH_FILLED })]
    const { result } = await sync(rules)
    expect(stderrAfterCounts(result)).toBe('removed: PR #1 from Tracker #9\n')
  })

  const CHECKS_CHANGED = trackerBody([[2, 'Bump left-pad', 'failed']])

  it('行の足し外しが無く本文だけが変わると、本文を書き直す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-18')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, CHECKS_CHANGED)]), patched(9, { body: trackerBody([[2, 'Bump left-pad', 'passed']]) }), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: BOTH_FILLED })]
    const { result, github } = await sync(rules)
    expect(result.code).toBe(0)
    expect(writtenBodies(github)).toEqual([{ body: trackerBody([[2, 'Bump left-pad', 'passed']]) }])
  })

  it('行の足し外しが無く本文だけが変わると、updated の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-19')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, CHECKS_CHANGED)]), patched(9), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: BOTH_FILLED })]
    const { result } = await sync(rules)
    expect(result.stdout).toBe('')
    expect(stderrAfterCounts(result)).toBe('updated: Tracker #9 body\n')
  })

  const SAME = trackerBody([[2, 'Bump left-pad', 'passed']])

  it.for([
    { name: 'LF', body: SAME },
    { name: 'CRLF', body: SAME.replaceAll('\n', '\r\n') },
  ])('書き直した本文が今の本文（$name）と同じだと、本文を書き直さない', async (row, context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-20')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, row.body)]), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: BOTH_FILLED })]
    const { result, github } = await sync(rules)
    expect(result.code).toBe(0)
    expect(writtenBodies(github).filter(body => body !== undefined)).toEqual([])
  })

  it('書き直した本文が今の本文と同じだと、unchanged の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-21')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, SAME)]), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: BOTH_FILLED })]
    const { result } = await sync(rules)
    expect(stderrAfterCounts(result)).toBe('unchanged: Tracker #9\n')
  })

  const CLOSING_ISSUES = withOthers(trackerIssue(9, OLD_ROW))
  const CLOSING = [patched(9, { body: trackerBody([]) }), patched(9, { state: 'closed', state_reason: 'completed' })]
  it('判断を待つ PR が無く open の Tracker があると、表を none に書き直す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-22')
    const { result, github } = await sync([...listings([], CLOSING_ISSUES), ...CLOSING])
    expect(result.code).toBe(0)
    expect(writtenBodies(github)[0]).toEqual({ body: trackerBody([]) })
  })

  it('表を none に書き直すと、Tracker を completed の理由で閉じる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-23')
    const { github } = await sync([...listings([], CLOSING_ISSUES), ...CLOSING])
    expect(writtenBodies(github)[1]).toEqual({ state: 'closed', state_reason: 'completed' })
  })

  it('Tracker を閉じると、closed の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-24')
    const { result } = await sync([...listings([], CLOSING_ISSUES), ...CLOSING])
    expect(result.stderr).toBe(`${OTHER_WARNING}${NO_PRS_COUNTS}removed: PR #1 from Tracker #9\nclosed: Tracker #9\n`)
  })

  const EMPTY_ISSUES = withOthers(trackerIssue(9, trackerBody([])))

  it('表が既に none の open の Tracker があると、本文を書き直さない', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-25')
    const { result, github } = await sync([...listings([], EMPTY_ISSUES), patched(9, { state: 'closed' })])
    expect(result.code).toBe(0)
    expect(writtenBodies(github)).toEqual([{ state: 'closed', state_reason: 'completed' }])
  })

  it('表が既に none の open の Tracker があると、Tracker を閉じる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-26')
    const { result } = await sync([...listings([], EMPTY_ISSUES), patched(9, { state: 'closed', state_reason: 'completed' })])
    expect(result.stderr).toBe(`${OTHER_WARNING}${NO_PRS_COUNTS}closed: Tracker #9\n`)
  })

  it.for([
    { name: 'Status', filled: [WORKFLOW_FIELD], updated: PRIORITY_FIELD },
    { name: 'Priority', filled: [PRIORITY_FIELD], updated: WORKFLOW_FIELD },
  ])('閉じない open の Tracker の $name だけが埋まっていると、空の欄だけに値を入れる', async (row, context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-27')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, SAME)]), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: row.filled })]
    const { github } = await sync(rules)
    const updates = github.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')
    expect(updates).toMatchObject([{ variables: { fieldId: row.updated } }])
  })

  const TWO_TRACKERS = [
    trackerIssue(12, trackerBody([[1, 'Bump old', 'failed']])),
    trackerIssue(9, trackerBody([[1, 'Bump old', 'failed']])),
    trackerIssue(5, trackerBody([[1, 'Bump old', 'failed']]), 'closed'),
    { number: 7, state: 'open', body: 'マーカーの無い Issue' },
  ]

  async function syncWithTwoTrackers(): Promise<Run> {
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], TWO_TRACKERS), patched(9), ...boardRules(9, { priority: 'medium', onlyIfEmpty: true, filled: BOTH_FILLED })]
    return await sync(rules)
  }

  it('open の Tracker が複数あると、番号が最小のものを使う', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-28')
    const { result, github } = await syncWithTwoTrackers()
    expect(result.code).toBe(0)
    expect(labelsOf(github)).toContain('PATCH /repos/acme/demo/issues/9')
  })

  it('open の Tracker が複数あると、使わないものを閉じない', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-29')
    const { github } = await syncWithTwoTrackers()
    expect(labelsOf(github).filter(label => label.startsWith('PATCH'))).toEqual(['PATCH /repos/acme/demo/issues/9'])
  })

  it('open の Tracker が複数あると、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-30')
    const { result } = await syncWithTwoTrackers()
    expect(result.stderr).toBe(`${OTHER_WARNING}${COUNTS_ONE}added: PR #2 to Tracker #9 (major)\nremoved: PR #1 from Tracker #9\n`)
  })

  it('--dry-run を付けて打つと、GitHub への書き込みをしない', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-31')
    const closing = await sync(listings([], [trackerIssue(9, OLD_ROW)]), ['--dry-run'])
    expect(labelsOf(closing.github)).toEqual(READS)
    const creating = await sync(listings([pullRequest({ number: 2, ...MAJOR })]), ['--dry-run'])
    expect(labelsOf(creating.github)).toEqual(READS)
  })

  it('--dry-run を付けて打つと、予定の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-32')
    const { result } = await sync(listings([], [trackerIssue(9, OLD_ROW)]), ['--dry-run'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(stderrAfterCounts(result)).toBe('dry-run: would remove PR #1 from Tracker #9\ndry-run: would close Tracker #9\n')
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-33')
    const { result, github } = await sync([], [], { hasConfig: false })
    expect(result).toEqual({ code: FAILURE_CODE, stdout: '', stderr: 'error: no active project\n' })
    expect(github.requests()).toEqual([])
  })

  it('--repo を省いて git の remote のリポジトリを読めないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-34')
    const { result, github } = await sync([], [], { hasRemote: false })
    expect(result).toEqual({ code: FAILURE_CODE, stdout: '', stderr: 'error: could not read the repository from the git remote\n' })
    expect(github.requests()).toEqual([])
  })

  async function syncWithoutToken(): Promise<Run & { readonly root: string }> {
    const project = prepareSync()
    setEnvironment({ [project.tokenVariable]: undefined })
    const github = await startGithub([])
    const result = await runInProcess(['dependabot', 'sync', '--dry-run'], DEPENDABOT_COMMANDS)
    return { result, github, root: project.root }
  }

  it('GitHub のトークンが見つからないと、error の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-35')
    const { result, root } = await syncWithoutToken()
    expect(result.stderr).toBe(missingTokenStderr(root))
    expect(result.stdout).toBe('')
  })

  it('GitHub のトークンが見つからないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-36')
    const { result, github } = await syncWithoutToken()
    expect(result.code).toBe(FAILURE_CODE)
    expect(github.requests()).toEqual([])
  })

  const TRACKER_WITH_OLD_ROW = trackerIssue(9, OLD_ROW)

  it.for([
    { name: 'PR の一覧', rules: [failedRule({ operation: 'ListOpenPullRequests' })], reads: ['ListOpenPullRequests'], message: graphqlServerError },
    { name: 'Issue の一覧', rules: [pullRequestList([pullRequest({ number: 2, ...MAJOR })]), failedRule({ method: 'GET', path: '/repos/acme/demo/issues' })], reads: READS, message: () => 'GitHub API error: 500' },
  ])('$name を取れないと、何も書かない', async (row, context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-37')
    const { result, github } = await sync(row.rules)
    expect(result.stderr).toBe(`error: could not list pull requests or issues: ${row.message(github.url)}\n`)
    expect(labelsOf(github)).toEqual(row.reads)
  })

  it.for([
    { name: 'PR の一覧', rules: [failedRule({ operation: 'ListOpenPullRequests' })] },
    { name: 'Issue の一覧', rules: [pullRequestList([pullRequest({ number: 2, ...MAJOR })]), failedRule({ method: 'GET', path: '/repos/acme/demo/issues' })] },
  ])('$name を取れないと、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-38')
    const { result } = await sync(row.rules)
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stdout).toBe('')
  })

  async function syncWithBrokenMarkers(): Promise<Run> {
    const broken = trackerIssue(9, '<!-- pecot-dependabot-pr: tracker -->')
    return await sync(listings([pullRequest({ number: 2, ...MAJOR })], [broken]))
  }

  it('使う Tracker の本文に list-begin と list-end の印が 1 組だけ無いと、何も書かない', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-39')
    const { result, github } = await syncWithBrokenMarkers()
    expect(result.stderr).toBe('error: Tracker #9: cannot rewrite the list: the Tracker body does not have exactly one pair of list-begin / list-end markers\n')
    expect(labelsOf(github)).toEqual(READS)
  })

  it('使う Tracker の本文に list-begin と list-end の印が 1 組だけ無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-40')
    const { result } = await syncWithBrokenMarkers()
    expect(result.code).toBe(FAILURE_CODE)
  })

  async function syncWithFailedRewrite(): Promise<Run> {
    return await sync([...listings([], withOthers(TRACKER_WITH_OLD_ROW)), failedRule({ method: 'PATCH', path: '/repos/acme/demo/issues/9' }, 422)])
  }

  it('Tracker の本文の書き直しに失敗すると、Tracker を閉じない', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-41')
    const { result, github } = await syncWithFailedRewrite()
    expect(result.stderr).toBe(`${OTHER_WARNING}${NO_PRS_COUNTS}error: could not update Tracker #9 body: GitHub API error: 422\n`)
    expect(labelsOf(github).filter(label => label.startsWith('PATCH'))).toEqual(['PATCH /repos/acme/demo/issues/9'])
  })

  it('Tracker の本文の書き直しに失敗すると、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-42')
    const { result } = await syncWithFailedRewrite()
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).not.toContain('removed:')
  })

  async function syncWithFailedClose(): Promise<Run> {
    const rules = [...listings([], withOthers(TRACKER_WITH_OLD_ROW)), patched(9, { body: trackerBody([]) }), failedRule({ method: 'PATCH', path: '/repos/acme/demo/issues/9', body: { state: 'closed' } })]
    return await sync(rules)
  }

  it('表を none に書き直した後で Tracker を閉じられないと、次の実行でやり直す旨の error の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-43')
    const { result } = await syncWithFailedClose()
    expect(result.stderr).toBe(`${OTHER_WARNING}${NO_PRS_COUNTS}removed: PR #1 from Tracker #9\nerror: could not close Tracker #9 after setting its list to none; will retry on the next run: GitHub API error: 500\n`)
  })

  it('表を none に書き直した後で Tracker を閉じられないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-44')
    const { result } = await syncWithFailedClose()
    expect(result.code).toBe(FAILURE_CODE)
  })

  async function syncWithFailedBoard(): Promise<Run> {
    const [nodeId] = boardRules(100, { priority: 'medium', onlyIfEmpty: false })
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })]), createdTracker(100), ...nodeId === undefined ? [] : [nodeId], failedRule({ operation: 'AddToProject' })]
    return await sync(rules)
  }

  it('Tracker の作成かボードへの追加に失敗すると、Tracker の error の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-45')
    const created = await syncWithFailedBoard()
    expect(stderrAfterCounts(created.result)).toBe(`created: Tracker "${TODAY_TITLE}"\nadded: PR #2 to new Tracker (major)\nerror: Tracker: ${graphqlServerError(created.github.url)}\n`)
    const creation = await sync([...listings([pullRequest({ number: 2, ...MAJOR })]), failedRule({ method: 'POST', path: '/repos/acme/demo/issues' })])
    expect(stderrAfterCounts(creation.result)).toBe('error: Tracker: GitHub API error: 500\n')
  })

  it('Tracker の作成かボードへの追加に失敗すると、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-46')
    const { result } = await syncWithFailedBoard()
    expect(result.code).toBe(FAILURE_CODE)
  })

  it('open の Tracker のボード登録に失敗すると、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-DEPENDABOT-SYNC-45')
    await verifies(context, 'PW-DEPENDABOT-SYNC-46')
    const [nodeId] = boardRules(9, { priority: 'medium', onlyIfEmpty: true })
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, SAME)]), ...nodeId === undefined ? [] : [nodeId], failedRule({ operation: 'AddToProject' })]
    const { result, github } = await sync(rules)
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe(`${COUNTS_ONE}unchanged: Tracker #9\nerror: Tracker: ${graphqlServerError(github.url)}\n`)
  })

  it('Issue の一覧にラベルと state=all を付けて要求する', async () => {
    const { github } = await sync([pullRequestList([]), issueList([])])
    expect(github.requests()[1]).toMatchObject({ method: 'GET', query: { labels: 'dependabot-pr', state: 'all', per_page: '100' } })
  })
})
