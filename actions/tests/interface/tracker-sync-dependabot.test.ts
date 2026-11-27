// tracker-sync の source dependabot の振る舞い（PA-TRACKER-SYNC-01〜46）を、action の処理をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { beforeEach, describe, expect, it } from 'vitest'

import type { JsonObject } from '@pecot/workflow-core/domain/json.js'
import { JSON_NULL } from '@pecot/workflow-core/domain/json-null.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
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
} from '../_helpers/tracker-sync-dependabot-case.js'
import type { PrOptions } from '../_helpers/tracker-sync-dependabot-case.js'
import { startGithub } from '../_helpers/action-case.js'
import type { ActionResult, RunningGithub } from '../_helpers/action-case.js'
import type { ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { boardRules, createdTracker, freezeClock, graphqlServerError, missingTokenStderr, prepareSync, runSync, STALE_OPTION_TEXT, staleOptionUpdate, TOKEN_VARIABLE, WORKFLOW_FIELD } from '../_helpers/tracker-sync-case.js'
import type { SyncSetup } from '../_helpers/tracker-sync-case.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

beforeEach(() => {
  freezeClock()
})

const STATUS_FILLED = [WORKFLOW_FIELD]
const COUNTS_ONE = 'count: open dependabot PRs: 1\ncount: PRs awaiting a decision: 1\ncount: PRs awaiting a decision without check results: 0\n'
const FAILURE_CODE = 1
const MAJOR = { kind: 'major' }

interface Run {
  readonly result: ActionResult
  readonly github: RunningGithub
}

async function sync(rules: readonly ResponseRule[], inputs: Readonly<Record<string, string>> = {}, setup?: Readonly<SyncSetup>): Promise<Run> {
  prepareSync(setup)
  const github = await startGithub(rules)
  const result = await runSync('dependabot', inputs)
  return { result, github }
}

function labelsOf(github: Readonly<RunningGithub>): string[] {
  return github.requests().map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}

function writtenBodies(github: Readonly<RunningGithub>): unknown[] {
  return github.requests().flatMap(request => request.type === 'rest' && request.method !== 'GET' ? [request.body] : [])
}

function stderrAfterCounts(result: Readonly<ActionResult>): string {
  return result.stderr.split('\n').slice(3).join('\n')
}

const OLD_ROW = trackerBody([[1, 'Bump old', 'failed']])
const NO_PRS_COUNTS = 'count: open dependabot PRs: 0\ncount: PRs awaiting a decision: 0\ncount: PRs awaiting a decision without check results: 0\n'
const OTHER_WARNING = 'warning: multiple open Trackers; using #9 (lowest number) and leaving #12 open\n'
const AMBIGUOUS_STDERR = 'error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ghes.example.com_acme_board_acme, second\n'

// 使う Tracker のほかに、open の別の Tracker・閉じた Tracker・印の無い Issue を混ぜる。どれも番号は使う Tracker と違う
function withOthers(tracker: Readonly<JsonObject>): JsonObject[] {
  return [trackerIssue(12, OLD_ROW), tracker, trackerIssue(5, OLD_ROW, 'closed'), { number: 7, state: 'open', body: 'マーカーの無い Issue' }]
}

const READS = ['ListOpenPullRequests', 'GET /repos/acme/demo/issues']
const ROW_2 = '| <!-- pecot-dependabot-pr: pr/2 --> `Bump left-pad` | [#2](https://ghes.example.com/acme/demo/pull/2) | passed |'

async function createNewTracker(): Promise<Run> {
  const nodes = [pullRequest({ number: 2, ...MAJOR }), pullRequest({ number: 3, name: 'lodash' })]
  return await sync([...listings(nodes), createdTracker(100), ...boardRules(100, { onlyIfEmpty: false })])
}

describe('tracker sync', () => {
  it('open の Tracker が無く、判断を待つ PR があると、label が dependabot-pr の Tracker の Issue を作る', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-01')
    await explains('open の Tracker は存在せず、判断を待つ PR（人の判断を要する dependabot の PR）が存在する場合のテストです。ラベル `dependabot-pr` を付けた Tracker の Issue を、PR の表を含む本文で作成することを確認します。')
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
    await verifies(context, 'PA-TRACKER-SYNC-02')
    await explains('Tracker の Issue を作成した場合のテストです。作成した Issue をボードに追加することを確認します。')
    const { github } = await createNewTracker()
    expect(labelsOf(github)).toEqual([...READS, 'POST /repos/acme/demo/issues', 'GetIssueNodeId', 'AddToProject', 'UpdateProjectItemField'])
    expect(github.requests()[4]).toMatchObject({ operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: 'I_100' } })
  })

  it('Tracker の Issue を作ると、Status を Backlog にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-03')
    await explains('Tracker の Issue を作成した場合のテストです。ボード上の Status を `Backlog` にすることを確認します。')
    const { github } = await createNewTracker()
    expect(github.requests()).toContainEqual(expect.objectContaining({ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'PVTI_100', fieldId: WORKFLOW_FIELD, optionId: 'o1' } }))
  })

  it('Tracker の Issue を作ると、ボードの欄は Status だけを入れ、Priority を入れない', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-04')
    await explains('Tracker の Issue を作成した場合のテストです。ボードの欄は Status だけを設定し、Priority は設定しないことを確認します。')
    const { result, github } = await createNewTracker()
    expect(result.code).toBe(0)
    const updates = github.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')
    expect(updates.map(request => request.type === 'graphql' ? request.variables : undefined)).toEqual([{ projectId: 'PVT_1', itemId: 'PVTI_100', fieldId: WORKFLOW_FIELD, optionId: 'o1' }])
  })

  it('open の Tracker が無く、判断を待つ PR も無いと、Tracker の Issue を作らない', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-05')
    await explains('open の Tracker も判断を待つ PR も存在しない場合のテストです。Tracker の Issue を作成しないことを確認します。')
    const { result, github } = await sync(listings([pullRequest({ number: 3, name: 'lodash' })]))
    expect(result.code).toBe(0)
    expect(labelsOf(github)).toEqual(READS)
  })

  it('open の Tracker が無く、判断を待つ PR も無いと、skipped の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-06')
    await explains('open の Tracker も判断を待つ PR も存在しない場合のテストです。件数の行に続けて、`skipped: Tracker creation` の行を標準エラーに出力することを確認します。')
    const { result } = await sync(listings([pullRequest({ number: 3, name: 'lodash' })]))
    expect(result.stderr).toBe('count: open dependabot PRs: 1\ncount: PRs awaiting a decision: 0\ncount: PRs awaiting a decision without check results: 0\nskipped: Tracker creation\n')
  })

  it('open の Tracker があると、list-begin と list-end の間の表を、判断を待つ PR の行に書き直す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-07')
    await explains('open の Tracker が存在する場合のテストです。本文の `list-begin` と `list-end` の間の表を、判断を待つ PR の行に書き換え、前後の文は残すことを確認します。')
    const existing = trackerBody([[1, 'Bump old', 'failed']], '\n人の注記\n')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, existing)]), patched(9, { body: trackerBody([[2, 'Bump left-pad', 'passed']], '\n人の注記\n') }), ...boardRules(9, { onlyIfEmpty: true, filled: STATUS_FILLED })]
    const { result, github } = await sync(rules)
    expect(result.code).toBe(0)
    expect(labelsOf(github)).toContain('PATCH /repos/acme/demo/issues/9')
    expect(writtenBodies(github)).toEqual([{ body: trackerBody([[2, 'Bump left-pad', 'passed']], '\n人の注記\n') }])
  })

  it.for([
    { name: 'major', pr: { kind: 'major' }, reason: 'major', id: 'PA-TRACKER-SYNC-08' },
    { name: 'update type が決まらない', pr: { kind: 'none' }, reason: 'unknown update type', id: 'PA-TRACKER-SYNC-08' },
    { name: '最初の commit の author が dependabot でない', pr: { commitAuthor: 'someone' }, reason: 'unknown update type', id: 'PA-TRACKER-SYNC-08' },
    { name: '最初の commit の署名が有効でない', pr: { isSigned: false }, reason: 'unknown update type', id: 'PA-TRACKER-SYNC-08' },
    { name: '検証が FAILURE', pr: { rollup: 'FAILURE' }, reason: 'checks failed', id: 'PA-TRACKER-SYNC-09' },
    { name: '検証が ERROR', pr: { rollup: 'ERROR' }, reason: 'checks failed', id: 'PA-TRACKER-SYNC-09' },
    { name: '検証が 25 時間たっても終わらない', pr: { rollup: 'PENDING', age: 25 * HOUR }, reason: 'checks not finishing', id: 'PA-TRACKER-SYNC-10' },
    { name: '検証が結果なしのまま 25 時間たつ', pr: { rollup: JSON_NULL, age: 25 * HOUR }, reason: 'checks not finishing', id: 'PA-TRACKER-SYNC-10' },
    { name: 'auto-merge が無く、検証が 25 時間たっても終わらない', pr: { hasAutoMerge: false, rollup: 'PENDING', age: 25 * HOUR }, reason: 'no auto-merge', id: 'PA-TRACKER-SYNC-10' },
    { name: '検証が 23 時間しかたっていない', pr: { rollup: 'PENDING', age: 23 * HOUR }, reason: undefined, id: 'PA-TRACKER-SYNC-10' },
    { name: 'base が 31 分前に進んで競合している', pr: { mergeable: 'CONFLICTING', age: 2 * HOUR, baseAge: 31 * MINUTE }, reason: 'conflict', id: 'PA-TRACKER-SYNC-11' },
    { name: 'base が 29 分前に進んで競合している', pr: { mergeable: 'CONFLICTING', age: 2 * HOUR, baseAge: 29 * MINUTE }, reason: undefined, id: 'PA-TRACKER-SYNC-11' },
    { name: '最後の push が 31 分前で競合している', pr: { mergeable: 'CONFLICTING', age: 31 * MINUTE }, reason: 'conflict', id: 'PA-TRACKER-SYNC-11' },
    { name: '最後の push の後に merge queue から外された', pr: { hasAutoMerge: false, age: 2 * HOUR, dequeuedAge: 5 * MINUTE }, reason: 'dequeued', id: 'PA-TRACKER-SYNC-12' },
    { name: '最後の push の前に merge queue から外された', pr: { hasAutoMerge: false, age: 10 * MINUTE, dequeuedAge: 20 * MINUTE }, reason: undefined, id: 'PA-TRACKER-SYNC-12' },
    { name: 'auto-merge が無く、最後の push が 31 分前', pr: { hasAutoMerge: false, age: 31 * MINUTE }, reason: 'no auto-merge', id: 'PA-TRACKER-SYNC-13' },
    { name: 'auto-merge が無く、最後の push が 29 分前', pr: { hasAutoMerge: false, age: 29 * MINUTE }, reason: undefined, id: 'PA-TRACKER-SYNC-13' },
    { name: '自動マージの対象で、待つ理由が無い', pr: {}, reason: undefined, id: 'PA-TRACKER-SYNC-14' },
  ] satisfies readonly { name: string, pr: PrOptions, reason: string | undefined, id: string }[])('$name PR は、理由 $reason で扱う', async (row, context) => {
    await verifies(context, row.id)
    await explains('PR の状態ごとの、判断を待つ PR かどうかの判定のテストです。input の `dry-run` を `true` にして実行し、`major` の更新や検証の失敗など人の判断を要する PR だけが、その理由とともに追加予定の行に出ることを確認します。')
    const { result } = await sync(listings([pullRequest({ number: 2, ...row.pr })]), { 'dry-run': 'true' })
    expect(result.code).toBe(0)
    const expected = row.reason === undefined
      ? 'count: open dependabot PRs: 1\ncount: PRs awaiting a decision: 0\ncount: PRs awaiting a decision without check results: 0\ndry-run: would skip Tracker creation\n'
      : `${row.reason === 'checks not finishing' && row.pr.rollup === JSON_NULL ? COUNTS_ONE.replace('without check results: 0', 'without check results: 1') : COUNTS_ONE}dry-run: would create Tracker "${TODAY_TITLE}"\ndry-run: would add PR #2 to new Tracker (${row.reason})\n`
    expect(result.stderr).toBe(expected)
  })

  it('PR の一覧を取れ、Tracker の本文の印が正しいと、PR の数と判断を待つ PR の数と検証の結果が無い PR の数の count の行を出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-15')
    await explains('input の `dry-run` を `true` にし、PR の一覧を取得でき、Tracker の本文の印も正しい場合のテストです。open の dependabot PR の数、判断を待つ PR の数、検証の結果がない PR の数を、`count:` の行に出力することを確認します。')
    const nodes = [
      pullRequest({ number: 2, ...MAJOR, rollup: JSON_NULL }),
      pullRequest({ number: 3, ...MAJOR }),
      pullRequest({ number: 4, name: 'lodash', rollup: JSON_NULL }),
      pullRequest({ number: 5, name: 'other', author: { __typename: 'User', login: 'someone' }, ...MAJOR }),
    ]
    const { result } = await sync(listings(nodes), { 'dry-run': 'true' })
    expect(result.stderr.split('\n').slice(0, 3)).toEqual(['count: open dependabot PRs: 3', 'count: PRs awaiting a decision: 2', 'count: PRs awaiting a decision without check results: 1'])
  })

  it('表に PR を足すと、added の行を理由とともに標準エラーに出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-16')
    await explains('表に PR を追加した場合のテストです。`added:` の行を、理由とともに標準エラーに出力することを確認します。')
    const nodes = [pullRequest({ number: 2, ...MAJOR }), pullRequest({ number: 6, rollup: 'FAILURE', mergeable: 'CONFLICTING', age: 2 * HOUR })]
    const rules = [...listings(nodes, [trackerIssue(9, trackerBody([[2, 'Bump left-pad', 'passed']]))]), patched(9), ...boardRules(9, { onlyIfEmpty: true, filled: STATUS_FILLED })]
    const { result } = await sync(rules)
    expect(stderrAfterCounts(result)).toBe('added: PR #6 to Tracker #9 (checks failed, conflict)\n')
  })

  it('表から PR を外すと、removed の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-17')
    await explains('表から PR を削除した場合のテストです。`removed:` の行を標準エラーに出力することを確認します。')
    const existing = trackerBody([[1, 'Bump old', 'failed'], [2, 'Bump left-pad', 'passed']])
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, existing)]), patched(9), ...boardRules(9, { onlyIfEmpty: true, filled: STATUS_FILLED })]
    const { result } = await sync(rules)
    expect(stderrAfterCounts(result)).toBe('removed: PR #1 from Tracker #9\n')
  })

  const CHECKS_CHANGED = trackerBody([[2, 'Bump left-pad', 'failed']])

  it('行の足し外しが無く本文だけが変わると、本文を書き直す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-18')
    await explains('PR の行は増減せず、本文だけが変わる場合のテストです。Tracker の本文を更新することを確認します。')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, CHECKS_CHANGED)]), patched(9, { body: trackerBody([[2, 'Bump left-pad', 'passed']]) }), ...boardRules(9, { onlyIfEmpty: true, filled: STATUS_FILLED })]
    const { result, github } = await sync(rules)
    expect(result.code).toBe(0)
    expect(writtenBodies(github)).toEqual([{ body: trackerBody([[2, 'Bump left-pad', 'passed']]) }])
  })

  it('行の足し外しが無く本文だけが変わると、updated の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-19')
    await explains('PR の行は増減せず、本文だけが変わる場合のテストです。`updated:` の行を標準エラーに出力し、標準出力には何も出力しないことを確認します。')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, CHECKS_CHANGED)]), patched(9), ...boardRules(9, { onlyIfEmpty: true, filled: STATUS_FILLED })]
    const { result } = await sync(rules)
    expect(result.stdout).toBe('')
    expect(stderrAfterCounts(result)).toBe('updated: Tracker #9 body\n')
  })

  const SAME = trackerBody([[2, 'Bump left-pad', 'passed']])

  it.for([
    { name: 'LF', body: SAME },
    { name: 'CRLF', body: SAME.replaceAll('\n', '\r\n') },
  ])('書き直した本文が今の本文（$name）と同じだと、本文を書き直さない', async (row, context) => {
    await verifies(context, 'PA-TRACKER-SYNC-20')
    await explains(`書き換えた後の本文が、今の本文（改行が \`${row.name}\`）と同じ場合のテストです。本文を更新しないことを確認します。`)
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, row.body)]), ...boardRules(9, { onlyIfEmpty: true, filled: STATUS_FILLED })]
    const { result, github } = await sync(rules)
    expect(result.code).toBe(0)
    expect(writtenBodies(github).filter(body => body !== undefined)).toEqual([])
  })

  it('書き直した本文が今の本文と同じだと、unchanged の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-21')
    await explains('書き換えた後の本文が今の本文と同じ場合のテストです。`unchanged: Tracker #9` の行を標準エラーに出力することを確認します。')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, SAME)]), ...boardRules(9, { onlyIfEmpty: true, filled: STATUS_FILLED })]
    const { result } = await sync(rules)
    expect(stderrAfterCounts(result)).toBe('unchanged: Tracker #9\n')
  })

  const CLOSING_ISSUES = withOthers(trackerIssue(9, OLD_ROW))
  const CLOSING = [patched(9, { body: trackerBody([]) }), patched(9, { state: 'closed', state_reason: 'completed' })]
  it('判断を待つ PR が無く open の Tracker があると、表を none に書き直す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-22')
    await explains('判断を待つ PR が存在せず、open の Tracker がある場合のテストです。Tracker の本文の表を `none` に書き換えることを確認します。')
    const { result, github } = await sync([...listings([], CLOSING_ISSUES), ...CLOSING])
    expect(result.code).toBe(0)
    expect(writtenBodies(github)[0]).toEqual({ body: trackerBody([]) })
  })

  it('表を none に書き直すと、Tracker を completed の理由で閉じる', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-23')
    await explains('表を `none` に書き換えた場合のテストです。Tracker を、理由 `completed` で閉じることを確認します。')
    const { github } = await sync([...listings([], CLOSING_ISSUES), ...CLOSING])
    expect(writtenBodies(github)[1]).toEqual({ state: 'closed', state_reason: 'completed' })
  })

  it('Tracker を閉じると、closed の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-24')
    await explains('Tracker を閉じた場合のテストです。`closed:` の行を標準エラーに出力することを確認します。')
    const { result } = await sync([...listings([], CLOSING_ISSUES), ...CLOSING])
    expect(result.stderr).toBe(`${OTHER_WARNING}${NO_PRS_COUNTS}removed: PR #1 from Tracker #9\nclosed: Tracker #9\n`)
  })

  const EMPTY_ISSUES = withOthers(trackerIssue(9, trackerBody([])))

  it('表が既に none の open の Tracker があると、本文を書き直さない', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-25')
    await explains('表が既に `none` の open の Tracker がある場合のテストです。本文を書き換えないことを確認します。')
    const { result, github } = await sync([...listings([], EMPTY_ISSUES), patched(9, { state: 'closed' })])
    expect(result.code).toBe(0)
    expect(writtenBodies(github)).toEqual([{ state: 'closed', state_reason: 'completed' }])
  })

  it('表が既に none の open の Tracker があると、Tracker を閉じる', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-26')
    await explains('表が既に `none` の open の Tracker がある場合のテストです。Tracker を閉じて、`closed:` の行を標準エラーに出力することを確認します。')
    const { result } = await sync([...listings([], EMPTY_ISSUES), patched(9, { state: 'closed', state_reason: 'completed' })])
    expect(result.stderr).toBe(`${OTHER_WARNING}${NO_PRS_COUNTS}closed: Tracker #9\n`)
  })

  it.for([
    { name: 'Status が空', filled: [], updated: [WORKFLOW_FIELD] },
    { name: 'Status が埋まっている', filled: [WORKFLOW_FIELD], updated: [] },
  ])('閉じない open の Tracker の $name と、Status が空のときだけ Backlog を入れ、Priority を入れない', async (row, context) => {
    await verifies(context, 'PA-TRACKER-SYNC-27')
    await explains('閉じない open の Tracker をボードに登録する場合のテストです。Status が空のときだけ `Backlog` を設定し、Priority は設定しないことを確認します。')
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, SAME)]), ...boardRules(9, { onlyIfEmpty: true, filled: row.filled })]
    const { github } = await sync(rules)
    const updates = github.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')
    expect(updates).toHaveLength(row.updated.length)
    expect(updates).toMatchObject(row.updated.map(fieldId => ({ variables: { fieldId } })))
  })

  const TWO_TRACKERS = [
    trackerIssue(12, trackerBody([[1, 'Bump old', 'failed']])),
    trackerIssue(9, trackerBody([[1, 'Bump old', 'failed']])),
    trackerIssue(5, trackerBody([[1, 'Bump old', 'failed']]), 'closed'),
    { number: 7, state: 'open', body: 'マーカーの無い Issue' },
  ]

  async function syncWithTwoTrackers(): Promise<Run> {
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], TWO_TRACKERS), patched(9), ...boardRules(9, { onlyIfEmpty: true, filled: STATUS_FILLED })]
    return await sync(rules)
  }

  it('open の Tracker が複数あると、番号が最小のものを使う', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-28')
    await explains('open の Tracker が複数ある場合のテストです。番号が最も小さい Tracker を使うことを確認します。')
    const { result, github } = await syncWithTwoTrackers()
    expect(result.code).toBe(0)
    expect(labelsOf(github)).toContain('PATCH /repos/acme/demo/issues/9')
  })

  it('open の Tracker が複数あると、使わないものを閉じない', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-29')
    await explains('open の Tracker が複数ある場合のテストです。使わない Tracker を閉じないことを確認します。')
    const { github } = await syncWithTwoTrackers()
    expect(labelsOf(github).filter(label => label.startsWith('PATCH'))).toEqual(['PATCH /repos/acme/demo/issues/9'])
  })

  it('open の Tracker が複数あると、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-30')
    await explains('open の Tracker が複数ある場合のテストです。警告の行を標準エラーに出力することを確認します。')
    const { result } = await syncWithTwoTrackers()
    expect(result.stderr).toBe(`${OTHER_WARNING}${COUNTS_ONE}added: PR #2 to Tracker #9 (major)\nremoved: PR #1 from Tracker #9\n`)
  })

  it('dry-run が true だと、GitHub への書き込みをしない', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-31')
    await explains('input の `dry-run` を `true` にした場合のテストです。Tracker を閉じる場合と作成する場合のどちらでも、GitHub へ書き込まないことを確認します。')
    const closing = await sync(listings([], [trackerIssue(9, OLD_ROW)]), { 'dry-run': 'true' })
    expect(labelsOf(closing.github)).toEqual(READS)
    const creating = await sync(listings([pullRequest({ number: 2, ...MAJOR })]), { 'dry-run': 'true' })
    expect(labelsOf(creating.github)).toEqual(READS)
  })

  it('dry-run が true だと、予定の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-32')
    await explains('input の `dry-run` を `true` にした場合のテストです。予定の行（`dry-run: would ...`）を標準エラーに出力し、step を成功にすることを確認します。')
    const { result } = await sync(listings([], [trackerIssue(9, OLD_ROW)]), { 'dry-run': 'true' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(stderrAfterCounts(result)).toBe('dry-run: would remove PR #1 from Tracker #9\ndry-run: would close Tracker #9\n')
  })

  it('対象のリポを含む設定が 2 つ以上あると、候補の名前と project の案内を error の行に出して step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-33')
    await explains('対象のリポジトリを含むプロジェクトの設定が 2 つ以上ある場合のテストです。候補の名前と設定の選び方の案内を `error` の行に出し、GitHub へ要求を送らずに step を失敗にすることを確認します。')
    const { result, github } = await sync([], {}, { ambiguous: true })
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe(AMBIGUOUS_STDERR)
    expect(github.requests()).toEqual([])
  })

  it('対象のリポを含む設定が無いと、error の行を出して step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-95')
    await explains('対象のリポジトリを含むプロジェクトの設定が存在しない場合のテストです。設定の候補を `error` の行に出し、GitHub へ要求を送らずに step を失敗にすることを確認します。')
    const { result, github } = await sync([], {}, { repositories: ['other'] })
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe('error: acme/demo is not in any project config\n  available: ghes.example.com_acme_board_acme\n')
    expect(github.requests()).toEqual([])
  })

  it('project で設定の名前を渡すと、対象のリポを含む設定が 2 つ以上あっても、その設定を使う', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-96')
    await explains('input の `project` に設定の名前を渡した場合のテストです。対象のリポジトリを含む設定が 2 つ以上あっても、指定した設定を使って成功することを確認します。')
    const { result } = await sync(listings([], []), { project: 'second' }, { ambiguous: true })
    expect(result.code).toBe(0)
  })

  it.for([
    { name: '空', repository: '' },
    { name: 'owner だけ', repository: 'acme' },
  ])('GITHUB_REPOSITORY が $name だと、error の行を出して step を失敗にする', async (row, context) => {
    await verifies(context, 'PA-TRACKER-SYNC-34')
    await explains(`環境変数 \`GITHUB_REPOSITORY\` が${row.name}の場合のテストです。\`owner/repo\` の形でないことを \`error\` の行に出し、GitHub へ要求を送らずに step を失敗にすることを確認します。`)
    const { result, github } = await sync([], {}, { repository: row.repository })
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe(`error: GITHUB_REPOSITORY is not owner/repo: '${row.repository}'\n`)
    expect(github.requests()).toEqual([])
  })

  it('GITHUB_REPOSITORY が無いと、error の行を出して step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-34')
    await explains('環境変数 `GITHUB_REPOSITORY` が設定されていない場合のテストです。`owner/repo` の形でないことを `error` の行に出し、GitHub へ要求を送らずに step を失敗にすることを確認します。')
    prepareSync()
    setEnvironment({ GITHUB_REPOSITORY: undefined })
    const github = await startGithub([])
    const result = await runSync('dependabot')
    expect(result).toEqual({ code: FAILURE_CODE, stdout: '', stderr: 'error: GITHUB_REPOSITORY is not owner/repo: \'\'\n' })
    expect(github.requests()).toEqual([])
  })

  it('GitHub のトークンが見つからないと、error の行を標準エラーに出して step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-35')
    await explains('GitHub のトークンが見つからない場合のテストです。`error:` の行を標準エラーに出力し、標準出力には何も出力せずに step を失敗にすることを確認します。')
    const project = prepareSync()
    setEnvironment({ [TOKEN_VARIABLE]: undefined })
    const github = await startGithub([])
    const result = await runSync('dependabot', { 'dry-run': 'true' })
    expect(result).toEqual({ code: FAILURE_CODE, stdout: '', stderr: missingTokenStderr(project.root) })
    expect(github.requests()).toEqual([])
  })

  const TRACKER_WITH_OLD_ROW = trackerIssue(9, OLD_ROW)

  it.for([
    { name: 'PR の一覧', rules: [failedRule({ operation: 'ListOpenPullRequests' })], reads: ['ListOpenPullRequests'], message: graphqlServerError },
    { name: 'Issue の一覧', rules: [pullRequestList([pullRequest({ number: 2, ...MAJOR })]), failedRule({ method: 'GET', path: '/repos/acme/demo/issues' })], reads: READS, message: () => 'GitHub API error: 500' },
  ])('$name を取れないと、何も書かずに step を失敗にする', async (row, context) => {
    await verifies(context, 'PA-TRACKER-SYNC-37')
    await verifies(context, 'PA-TRACKER-SYNC-38')
    await explains('PR の一覧と Issue の一覧のそれぞれを取得できない場合のテストです。どちらの場合も、エラーを標準エラーに出力し、GitHub へ書き込まずに step を失敗にすることを確認します。')
    const { result, github } = await sync(row.rules)
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe(`error: could not list pull requests or issues: ${row.message(github.url)}\n`)
    expect(labelsOf(github)).toEqual(row.reads)
  })

  it('Issue の一覧の応答が JSON でないと、何も書かずに step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-37')
    await verifies(context, 'PA-TRACKER-SYNC-38')
    await explains('Issue の一覧の応答が JSON として読めない場合のテストです。`error` の行を標準エラーに出力し、GitHub へ書き込まずに step を失敗にすることを確認します。')
    const unreadable: ResponseRule = { ...issueList([]), respond: { status: 200, text: '' } }
    const { result, github } = await sync([pullRequestList([pullRequest({ number: 2, ...MAJOR })]), unreadable])
    expect(result).toEqual({ code: FAILURE_CODE, stdout: '', stderr: 'error: Unexpected end of JSON input\n' })
    expect(labelsOf(github)).toEqual(READS)
  })

  it('使う Tracker の本文に list-begin と list-end の印が 1 組だけ無いと、何も書かずに step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-39')
    await verifies(context, 'PA-TRACKER-SYNC-40')
    await explains('使う Tracker の本文に `list-begin` と `list-end` の印が 1 組そろっていない場合のテストです。表を書き換えられないことを `error` の行に出し、GitHub へ書き込まずに step を失敗にすることを確認します。')
    const { result, github } = await sync(listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, '<!-- pecot-dependabot-pr: tracker -->')]))
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe('error: Tracker #9: cannot rewrite the list: the Tracker body does not have exactly one pair of list-begin / list-end markers\n')
    expect(labelsOf(github)).toEqual(READS)
  })

  it('Tracker の本文の書き直しに失敗すると、Tracker を閉じずに step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-41')
    await verifies(context, 'PA-TRACKER-SYNC-42')
    await explains('Tracker の本文の書き換えに失敗した場合のテストです。`could not update Tracker #9 body` の行を出し、Tracker を閉じずに step を失敗にすることを確認します。')
    const { result, github } = await sync([...listings([], withOthers(TRACKER_WITH_OLD_ROW)), failedRule({ method: 'PATCH', path: '/repos/acme/demo/issues/9' }, 422)])
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe(`${OTHER_WARNING}${NO_PRS_COUNTS}error: could not update Tracker #9 body: GitHub API error: 422\n`)
    expect(labelsOf(github).filter(label => label.startsWith('PATCH'))).toEqual(['PATCH /repos/acme/demo/issues/9'])
  })

  it('表を none に書き直した後で Tracker を閉じられないと、次の実行でやり直す旨の error の行を出して step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-43')
    await verifies(context, 'PA-TRACKER-SYNC-44')
    await explains('表を `none` に書き換えた後、Tracker を閉じられない場合のテストです。次の実行でやり直すことを示す `error` の行を出し、step を失敗にすることを確認します。')
    const rules = [...listings([], withOthers(TRACKER_WITH_OLD_ROW)), patched(9, { body: trackerBody([]) }), failedRule({ method: 'PATCH', path: '/repos/acme/demo/issues/9', body: { state: 'closed' } })]
    const { result } = await sync(rules)
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe(`${OTHER_WARNING}${NO_PRS_COUNTS}removed: PR #1 from Tracker #9\nerror: could not close Tracker #9 after setting its list to none; will retry on the next run: GitHub API error: 500\n`)
  })

  it('Tracker の作成かボードへの追加に失敗すると、Tracker の error の行を出して step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-45')
    await verifies(context, 'PA-TRACKER-SYNC-46')
    await explains('Tracker の作成かボードへの追加に失敗した場合のテストです。どちらの場合も、`error: Tracker:` の行を標準エラーに出力して step を失敗にすることを確認します。')
    const [nodeId] = boardRules(100, { onlyIfEmpty: false })
    const created = await sync([...listings([pullRequest({ number: 2, ...MAJOR })]), createdTracker(100), ...nodeId === undefined ? [] : [nodeId], failedRule({ operation: 'AddToProject' })])
    expect(created.result.code).toBe(FAILURE_CODE)
    expect(stderrAfterCounts(created.result)).toBe(`created: Tracker "${TODAY_TITLE}"\nadded: PR #2 to new Tracker (major)\nerror: Tracker: ${graphqlServerError(created.github.url)}\n`)
    const creation = await sync([...listings([pullRequest({ number: 2, ...MAJOR })]), failedRule({ method: 'POST', path: '/repos/acme/demo/issues' })])
    expect(creation.result.code).toBe(FAILURE_CODE)
    expect(stderrAfterCounts(creation.result)).toBe('error: Tracker: GitHub API error: 500\n')
  })

  it('選択肢の ID が古くて Status を書けないと、error の行と ID を読み直す案内を出して step を失敗にする', async (context) => {
    await verifies(context, 'PA-TRACKER-SYNC-93')
    await explains('ボードの選択肢の ID が古く、作成した Tracker の Status を書き込めない場合のテストです。書き込めなかった欄と、ID を読み直す案内を `error` の行に出して step を失敗にすることを確認します。')
    const added = boardRules(100, { onlyIfEmpty: false }).filter(rule => rule.match.operation !== 'UpdateProjectItemField')
    const { result } = await sync([...listings([pullRequest({ number: 2, ...MAJOR })]), createdTracker(100), ...added, staleOptionUpdate()])
    expect(result.code).toBe(FAILURE_CODE)
    expect(stderrAfterCounts(result)).toBe([
      `created: Tracker "${TODAY_TITLE}"`,
      'added: PR #2 to new Tracker (major)',
      `error: could not set status backlog of Tracker #100: ${STALE_OPTION_TEXT}`,
      '  hint: if the board options were recreated, call project_activate with project: "ghes.example.com_acme_board_acme" to read their IDs again',
      '',
    ].join('\n'))
  })

  it('open の Tracker のボード登録に失敗すると、error の行を出して step を失敗にする', async () => {
    await explains('open の Tracker のボードへの登録に失敗した場合のテストです。`error:` の行を標準エラーに出力して step を失敗にすることを確認します。')
    const [nodeId] = boardRules(9, { onlyIfEmpty: true })
    const rules = [...listings([pullRequest({ number: 2, ...MAJOR })], [trackerIssue(9, SAME)]), ...nodeId === undefined ? [] : [nodeId], failedRule({ operation: 'AddToProject' })]
    const { result, github } = await sync(rules)
    expect(result.code).toBe(FAILURE_CODE)
    expect(result.stderr).toBe(`${COUNTS_ONE}unchanged: Tracker #9\nerror: Tracker: ${graphqlServerError(github.url)}\n`)
  })

  it('Issue の一覧にラベルと state=all を付けて要求する', async () => {
    await explains('Issue の一覧を取得する要求のテストです。ラベル `dependabot-pr` と `state=all` を指定して要求することを確認します。')
    const { github } = await sync([pullRequestList([]), issueList([])])
    expect(github.requests()[1]).toMatchObject({ method: 'GET', query: { labels: 'dependabot-pr', state: 'all', per_page: '100' } })
  })
})
