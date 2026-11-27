// issue_dependency_check の振る舞いを、MCP のツールの結果で確かめる。待つ側は acme/demo/7、前提は acme/demo/5
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { step } from '../../../../../libs/interface-spec/src/vitest/step.js'
import { ISSUE_DEPENDENCY_CHECK_TOOLS } from '../../src/commands/issue-dependency-check.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { setUpProject } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'

useIsolatedEnvironment()

const CONFIG_FILE = 'ghes.example.com_acme_board_acme.json'
const CONFIG = {
  host: 'ghes.example.com',
  owner: 'acme',
  project: { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields: { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6', blocked: 'o7' } } } },
  repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'main' }],
}

const TASK_BODY = '## Goal — 一覧画面から状態を確認できる\n\n利用者が一覧画面で各項目の状態を確認できる。\n\n## Acceptance — 一覧に状態の列が出る\n\n- 状態の列が一覧に出る — 確認: 一覧画面を開く\n'
const WAITS_FOR_FIVE = `${TASK_BODY}\n## Waits for merge\n\n- #5: スキーマが先に要る\n`

function option(id: string, name: string): Readonly<Record<string, unknown>> {
  return { id, name: { raw: name, html: name } }
}

const PROJECT_FIELDS = { fields: { fields: [
  { id: 101, node_id: 'PVTSSF_workflow', name: 'pecot-status', data_type: 'single_select', options: [
    option('o1', 'Backlog'), option('o2', 'Pending'), option('o3', 'Ready'), option('o4', 'Active'), option('o5', 'In Review'), option('o6', 'Archived'), option('o7', 'Blocked'),
  ] },
  { id: 102, node_id: 'PVTSSF_status', name: 'Status', data_type: 'single_select', options: [option('s1', 'Todo'), option('s2', 'Needs Attention')] },
] } }

function issueRead(number: number, body = TASK_BODY, extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { issue: { number, title: `[Task] Issue ${String(number)}`, state: 'open', body, html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}`, ...extra } }
}

// issue_read（get）の結果に足す、開いた PR が閉じる旨の項目
function closing(pullRequest: number): Readonly<Record<string, unknown>> {
  return { closed_by_pull_requests: { references: [{ number: pullRequest, state: 'OPEN', url: `https://ghes.example.com/acme/demo/pull/${String(pullRequest)}` }] } }
}

// 開いた PR を pull_request_read（get）で読んだ結果
function pullRequestRead(number: number, head: string, base: string): Readonly<Record<string, unknown>> {
  const branch = (reference: string): Readonly<Record<string, unknown>> => ({ ref: reference, sha: '0123456789abcdef0123456789abcdef01234567', repo: { full_name: 'acme/demo' } })
  return { number, title: `PR ${String(number)}`, state: 'open', draft: false, merged: false, html_url: `https://ghes.example.com/acme/demo/pull/${String(number)}`, head: branch(head), base: branch(base) }
}

function blockedBy(issue: string, numbers: readonly (readonly [number, string])[]): Readonly<Record<string, unknown>> {
  return { issue, result: { issues: numbers.map(([number, state]) => ({ number, state, html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}` })) } }
}

function cards(column: string): Readonly<Record<string, unknown>> {
  return { items: { items: [
    { content: { number: 7, repository: 'acme/demo' }, fields: [{ id: 101, name: 'pecot-status', value: { name: column } }] },
    { content: { number: 5, repository: 'acme/demo' }, fields: [{ id: 101, name: 'pecot-status', value: { name: 'Active' } }] },
  ] } }
}

interface Situation {
  readonly body?: string
  readonly column?: string
  readonly linked?: boolean
}

// 待つ側 7 と前提 5 を読んだ結果。linked なら 7 は 5 を前提に持つ
function readsOf(situation: Readonly<Situation> = {}): Readonly<Record<string, unknown>> {
  const { body = TASK_BODY, column = 'Ready', linked = false } = situation
  return {
    issues: [issueRead(7, body), issueRead(5)],
    blocked_by: [blockedBy('acme/demo/7', linked ? [[5, 'open']] : []), blockedBy('acme/demo/5', [])],
    project_items: [cards(column)],
    project_fields: PROJECT_FIELDS,
  }
}

const TARGET = { owner: 'acme', repo: 'demo', issue_number: 7, type: 'blocked_by', related_issue_number: 5 }
const PROBLEMS = z.array(z.record(z.string(), z.unknown()))

function useProject(): void {
  setUpProject({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: `${JSON.stringify(CONFIG)}\n` } })
}

async function check(arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await step('issue_dependency_check を呼ぶ', async () => await callToolOnce(ISSUE_DEPENDENCY_CHECK_TOOLS, 'issue_dependency_check', { ...TARGET, ...arguments_ }))
}

function problemsOf(outcome: Readonly<ToolOutcome>): readonly Readonly<Record<string, unknown>>[] {
  expect(outcome.isError).toBe(false)
  expect(outcome.structured['problems']).not.toEqual([])
  return PROBLEMS.parse(outcome.structured['problems'])
}

describe('issue_dependency_check', () => {
  describe('前提を付ける', () => {
    it('wait merge の前提を付けると、problem の無い結果と Blocked への移動と Waits for merge の行の追加を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-01')
      await explains('Ready の Issue に、開いた Issue を `wait: merge` と理由を付けて前提に足す場合のテストです。問題の無い結果と、列を `Blocked` へ移す案と、本文の `Waits for merge` の節に行を足す案を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'add', wait: 'merge', reason: 'スキーマが先に要る', reads: readsOf() })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toEqual({ problems: [], expected_status: 'Blocked', waits_for_merge: 'add' })
      })
    })

    it('Waits for merge の節に挙げた前提を付けると、本文の書き換えを求めずに problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-01')
      await explains('本文の `Waits for merge` の節に、同じ理由で前提の行をすでに書いた Issue に、`wait: merge` の前提を足す場合のテストです。本文の書き換えの案を返さず、列を `Blocked` へ移す案を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'add', wait: 'merge', reason: 'スキーマが先に要る', reads: readsOf({ body: WAITS_FOR_FIVE }) })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toEqual({ problems: [], expected_status: 'Blocked' })
      })
    })

    it('PR の無い開いた Issue をスタックの前提に付けると、Blocked への移動を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-01')
      await explains('閉じる PR を持たない開いた Issue を、`wait` の既定（スタック）で前提に足す場合のテストです。スタック先の PR が無いため、本文の書き換えの案を返さず、列を `Blocked` へ移す案を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'add', reads: readsOf() })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toEqual({ problems: [], expected_status: 'Blocked' })
      })
    })

    it('開いた PR を持つ Issue をスタックの前提に付け、その PR を読んでいないと、pull_request_read を案内する warning にして列の案を返さない', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-02')
      await explains('開いた PR を持つ Issue をスタックの前提へ足し、その PR は `reads.pull_requests` で渡さない場合のテストです。スタックできるかを決められないため、`pull_request_read` の読み取りを `warnings` で案内し、`expected_status` を返さないことを確認します。')
      useProject()
      const outcome = await check({ method: 'add', reads: { ...readsOf(), issues: [issueRead(7), issueRead(5, TASK_BODY, closing(11))] } })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toMatchObject({ problems: [] })
        expect(outcome.structured).not.toHaveProperty('expected_status')
        expect(outcome.structured['warnings']).toEqual([expect.stringContaining('pass the result of pull_request_read (method get) for acme/demo#11 in reads.pull_requests')])
      })
    })

    it('Blocked の Issue に、開発ブランチへ向く PR を持つ Issue をスタックの前提で付けると、Ready への移動を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-03')
      await explains('`Blocked` の Issue に、`main` へ向く開いた PR を持つ Issue をスタックの前提で足し、その PR を `reads.pull_requests` に渡す場合のテストです。スタックできると判定し、列を `Ready` へ移す案を返すことを確認します。')
      useProject()
      const reads = { ...readsOf({ column: 'Blocked' }), issues: [issueRead(7), issueRead(5, TASK_BODY, closing(11))], pull_requests: [pullRequestRead(11, 'feat/5', 'main')] }
      const outcome = await check({ method: 'add', reads })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toEqual({ problems: [], expected_status: 'Ready' })
      })
    })

    it('別々に開発ブランチへ向く PR を持つ 2 つの前提になると、1 本にスタックできないとして Blocked への移動を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-03')
      await explains('`main` へ向く PR を持つ前提（#6）がある Ready の Issue に、別の `main` へ向く PR を持つ Issue（#5）を足す場合のテストです。1 本の並びにスタックできないと判定し、列を `Blocked` へ移す案を返すことを確認します。')
      useProject()
      const reads = {
        ...readsOf(),
        issues: [issueRead(7), issueRead(5, TASK_BODY, closing(11)), issueRead(6, TASK_BODY, closing(12))],
        blocked_by: [blockedBy('acme/demo/7', [[6, 'open']]), blockedBy('acme/demo/5', [])],
        pull_requests: [pullRequestRead(11, 'feat/5', 'main'), pullRequestRead(12, 'feat/6', 'main')],
      }
      const outcome = await check({ method: 'add', reads })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toEqual({ problems: [], expected_status: 'Blocked' })
      })
    })

    it('前提の PR の base が、開発ブランチでも読んだ PR の head でもないと、そのブランチの PR を読むよう warning で案内する', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-02')
      await explains('前提の PR が `feat/4` へ向き、`feat/4` を head に持つ PR を `reads.pull_requests` に渡さない場合のテストです。並びをたどれないため、`list_pull_requests` で探して読むことを `warnings` で案内し、`expected_status` を返さないことを確認します。')
      useProject()
      const reads = { ...readsOf(), issues: [issueRead(7), issueRead(5, TASK_BODY, closing(11))], pull_requests: [pullRequestRead(11, 'feat/5', 'feat/4')] }
      const outcome = await check({ method: 'add', reads })
      await step('結果を確かめる', () => {
        expect(outcome.structured).not.toHaveProperty('expected_status')
        expect(outcome.structured['warnings']).toEqual([expect.stringContaining('find the open pull request whose head is feat/4 (list_pull_requests with head)')])
      })
    })

    it('すでに前提に持つ Issue を付けると、already-linked の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-04')
      await explains('待つ側の Issue がすでに前提として持つ Issue を、もう一度足す場合のテストです。`issue_dependency_write` を呼ばないよう案内する `already-linked` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await check({ method: 'add', reads: readsOf({ column: 'Blocked', linked: true }) }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'related_issue_number', code: 'already-linked' })])
      })
    })

    it('前提の側から待つ側へ戻る前提を付けると、輪の道筋を添えて problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-04')
      await explains('前提の Issue（`#5`）が、待つ側の Issue（`#7`）をすでに前提に持つ場合のテストです。前提が輪になるため、道筋を含む `cycle` の問題を返すことを確認します。')
      useProject()
      const reads = { ...readsOf(), blocked_by: [blockedBy('acme/demo/7', []), blockedBy('acme/demo/5', [[7, 'open']])] }
      const problems = problemsOf(await check({ method: 'add', reads }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'related_issue_number', code: 'cycle', message: 'blocked-by would form a cycle: #7 -> #5 -> #7' })])
      })
    })

    it('自分自身を前提にすると、cycle の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-04')
      await explains('待つ側の Issue と同じ Issue を前提に指定した場合のテストです。読み取りの結果を見ずに、`cycle` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await check({ method: 'add', related_issue_number: 7 }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([{ field: 'related_issue_number', code: 'cycle', message: 'an Issue cannot wait for itself: #7 -> #7' }])
      })
    })

    it('前提の blocked-by を読んでいないと、輪を確かめるための読み取りを求める', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-05')
      await explains('前提の Issue（`#5`）の blocked-by を `reads.blocked_by` に渡さない場合のテストです。輪を確認できないため、`issue_dependency_read` で読むよう案内する `read-required` の問題を返すことを確認します。')
      useProject()
      const reads = { ...readsOf(), blocked_by: [blockedBy('acme/demo/7', [])] }
      const problems = problemsOf(await check({ method: 'add', reads }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'reads.blocked_by', code: 'read-required' })])
        expect(problems[0]?.['message']).toContain('to check that the blocked-by forms no cycle')
      })
    })

    it('前提をすでに 50 件持つ Issue に付けると、上限の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-04')
      await explains('待つ側の Issue が、GitHub の上限の 50 件の前提をすでに持つ場合のテストです。新しい前提を足せないため、`limit` の問題を返すことを確認します。')
      useProject()
      const fifty = Array.from({ length: 50 }, (_, index): readonly [number, string] => [100 + index, 'closed'])
      const reads = { ...readsOf(), blocked_by: [blockedBy('acme/demo/7', fifty), blockedBy('acme/demo/5', [])] }
      const problems = problemsOf(await check({ method: 'add', wait: 'merge', reason: 'スキーマが先に要る', reads }))
      await step('結果を確かめる', () => {
        expect(problems).toContainEqual(expect.objectContaining({ field: 'related_issue_number', code: 'limit' }))
      })
    })
  })

  describe('前提を外す', () => {
    it('最後の前提を外すと、problem の無い結果と Ready への移動と Waits for merge の行の削除を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-06')
      await explains('Blocked の Issue から、`Waits for merge` の節に挙げた最後の前提を外す場合のテストです。問題の無い結果と、列を `Ready` へ移す案と、節の行を消す案を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'remove', reads: readsOf({ body: WAITS_FOR_FIVE, column: 'Blocked', linked: true }) })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toEqual({ problems: [], expected_status: 'Ready', waits_for_merge: 'remove' })
      })
    })

    it('前提に持たない Issue を外すと、not-linked の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-07')
      await explains('待つ側の Issue が前提として持たない Issue を外す場合のテストです。`not-linked` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await check({ method: 'remove', reads: readsOf() }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'related_issue_number', code: 'not-linked' })])
      })
    })

    it('remove に wait と reason を渡すと、それぞれ unexpected の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-07')
      await explains('`method` が `remove` で、付けるときだけ使う `wait` と `reason` を渡した場合のテストです。2 つの引数それぞれに `unexpected` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await check({ method: 'remove', wait: 'merge', reason: 'x', reads: readsOf({ body: WAITS_FOR_FIVE, column: 'Blocked', linked: true }) }))
      await step('結果を確かめる', () => {
        expect(problems.map(problem => [problem['field'], problem['code']])).toEqual([['wait', 'unexpected'], ['reason', 'unexpected']])
      })
    })
  })

  describe('引数と読み取り', () => {
    it('type が blocking だと、blocked_by の向きで書くよう problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-08')
      await explains('`type` に `blocking` を渡した場合のテストです。pecot は `blocked_by` だけを書くため、`blocked_by` を候補に含む `direction` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await check({ method: 'add', type: 'blocking', reads: readsOf() }))
      await step('結果を確かめる', () => {
        expect(problems).toContainEqual(expect.objectContaining({ field: 'type', code: 'direction', candidates: ['blocked_by'] }))
      })
    })

    it.for([
      { name: 'merge で理由が無い', input: { wait: 'merge' }, code: 'required' },
      { name: 'スタックで理由がある', input: { reason: 'x' }, code: 'unexpected' },
      { name: '理由が 2 行', input: { wait: 'merge', reason: '1 行目\n2 行目' }, code: 'value' },
    ])('$name とき、reason の problem にする', async ({ name, input, code }, context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-08')
      await explains(`前提を足すときに、${name}場合のテストです。\`reason\` の \`${code}\` の問題を返すことを確認します。`)
      useProject()
      const problems = problemsOf(await check({ method: 'add', ...input, reads: readsOf() }))
      await step('結果を確かめる', () => {
        expect(problems).toContainEqual(expect.objectContaining({ field: 'reason', code }))
      })
    })

    it('読み取りの結果を渡さないと、待つ側の Issue と blocked-by の読み取りを求める', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-05')
      await explains('`reads` を渡さない場合のテストです。待つ側の Issue の `issue_read` と、blocked-by の `issue_dependency_read` を求める `read-required` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await check({ method: 'add' }))
      await step('結果を確かめる', () => {
        expect(problems.map(problem => [problem['field'], problem['code']])).toEqual([['reads.issues', 'read-required'], ['reads.blocked_by', 'read-required']])
      })
    })

    it('blocked-by の結果に続きのページがあると、全ページを読むよう problem で案内する', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-05')
      await explains('待つ側の Issue の blocked-by の結果が、`pageInfo.hasNextPage` で続きのページを示す場合のテストです。すべてのページを読むよう案内する `read-required` の問題を返すことを確認します。')
      useProject()
      const paged = { issue: 'acme/demo/7', result: { issues: [], pageInfo: { hasNextPage: true } } }
      const problems = problemsOf(await check({ method: 'add', reads: { ...readsOf(), blocked_by: [paged, blockedBy('acme/demo/5', [])] } }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'reads.blocked_by', code: 'read-required' })])
        expect(problems[0]?.['message']).toContain('has more pages')
      })
    })

    it('ボードの読み取りを渡さないと、列を決めるための読み取りを求める', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-05')
      await explains('`reads.project_items` と `reads.project_fields` を渡さない場合のテストです。待つ側の列を決められないため、`projects_list` で読むよう案内する問題を 2 つ返すことを確認します。')
      useProject()
      const { issues, blocked_by: dependencies } = readsOf()
      const problems = problemsOf(await check({ method: 'add', wait: 'merge', reason: 'スキーマが先に要る', reads: { issues, blocked_by: dependencies } }))
      await step('結果を確かめる', () => {
        expect(problems.map(problem => [problem['field'], problem['code']])).toEqual([['reads.project_items', 'read-required'], ['reads.project_fields', 'read-required']])
      })
    })

    it('プロジェクトに無いリポジトリの Issue を渡すと、not-in-project の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-09')
      await explains('プロジェクトの設定に存在しないリポジトリ（`acme/other`）の Issue を待つ側に指定した場合のテストです。`repo` の `not-in-project` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await check({ method: 'add', repo: 'other', related_repo: 'demo' }))
      await step('結果を確かめる', () => {
        expect(problems).toContainEqual(expect.objectContaining({ field: 'repo', code: 'not-in-project' }))
      })
    })

    it('reads.blocked_by の結果が公式の MCP の結果の形でないと、github-mcp-shape の失敗にする', async (context) => {
      await verifies(context, 'PW-ISSUE-DEPENDENCY-CHECK-10')
      await explains('`reads.blocked_by` の結果の Issue が、必須の `state` を持たない場合のテストです。種別 `github-mcp-shape` のツールの失敗を返すことを確認します。')
      useProject()
      const broken = { issue: 'acme/demo/7', result: { issues: [{ number: 5 }] } }
      const outcome = await check({ method: 'add', reads: { ...readsOf(), blocked_by: [broken] } })
      await step('結果を確かめる', () => {
        expect(outcome.isError).toBe(true)
        expect(outcome.structured['kind']).toBe('github-mcp-shape')
      })
    })
  })
})
