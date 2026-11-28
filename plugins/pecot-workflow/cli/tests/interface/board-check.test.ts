// board_check の振る舞いを、MCP のツールの結果で確かめる。動かすカードは acme/demo/7、前提は acme/demo/5
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { step } from '../../../../../libs/interface-spec/src/vitest/step.js'
import { BOARD_CHECK_TOOLS } from '../../src/commands/board-check.js'
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

const TASK_BODY = '## Goal — 一覧画面から状態を確認できる\n\n利用者が一覧画面で各項目の状態を確認できる。\n'

function option(id: string, name: string): Readonly<Record<string, unknown>> {
  return { id, name: { raw: name, html: name } }
}

const PROJECT_FIELDS = { fields: { fields: [
  { id: 101, node_id: 'PVTSSF_workflow', name: 'pecot-status', data_type: 'single_select', options: [
    option('o1', 'Backlog'), option('o2', 'Pending'), option('o3', 'Ready'), option('o4', 'Active'), option('o5', 'In Review'), option('o6', 'Archived'), option('o7', 'Blocked'),
  ] },
  { id: 102, node_id: 'PVTSSF_status', name: 'Status', data_type: 'single_select', options: [option('s1', 'Todo'), option('s2', 'Needs Attention')] },
  { id: 103, node_id: 'PVTF_note', name: 'Note', data_type: 'text' },
] } }

function issueRead(number: number): Readonly<Record<string, unknown>> {
  return { issue: { number, title: `[Task] Issue ${String(number)}`, state: 'open', body: TASK_BODY, html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}` } }
}

function blockedBy(issue: string, numbers: readonly number[]): Readonly<Record<string, unknown>> {
  return { issue, result: { issues: numbers.map(number => ({ number, state: 'open', html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}` })) } }
}

function cards(column: string, numbers: readonly number[] = [7, 5]): Readonly<Record<string, unknown>> {
  return { items: { items: numbers.map(number => ({ content: { number, repository: 'acme/demo' }, fields: [{ id: 101, name: 'pecot-status', value: { name: number === 7 ? column : 'Active' } }] })) } }
}

// isLinked なら 7 は開いた 5 を前提に持つ。7 のカードは Pending にある
function readsOf(isLinked: boolean): Readonly<Record<string, unknown>> {
  return {
    issues: [issueRead(7), issueRead(5)],
    blocked_by: [blockedBy('acme/demo/7', isLinked ? [5] : []), blockedBy('acme/demo/5', [])],
    project_items: [cards('Pending')],
    project_fields: PROJECT_FIELDS,
  }
}

const TARGET = { method: 'update_project_item', owner: 'acme', project_number: 1, issue_number: 7, item_owner: 'acme', item_repo: 'demo' }

function useProject(): void {
  setUpProject({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: `${JSON.stringify(CONFIG)}\n` } })
}

async function check(arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await step('board_check を呼ぶ', async () => await callToolOnce(BOARD_CHECK_TOOLS, 'board_check', { ...TARGET, ...arguments_ }))
}

describe('board_check', () => {
  it('前提の無いカードを Ready に書くと、problem の無い結果を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-01')
    await explains('前提を持たない Issue のカードを、欄の名前と選択肢の名前で `Ready` に移す場合のテストです。問題の無い結果を返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { name: 'pecot-status', value: 'Ready' }, reads: readsOf(false) })
    await step('結果を確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({ problems: [] })
    })
  })

  it('判定に関わらない列へ書くと、前提を読まずに problem の無い結果を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-01')
    await explains('欄の ID と選択肢の ID で `Active` に移す場合のテストです。Issue と前提の読み取りを渡さなくても、問題の無い結果を返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { id: 101, value: 'o4' }, reads: { project_fields: PROJECT_FIELDS, project_items: [cards('Ready')] } })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [] })
    })
  })

  it('ボードに無い欄の名前を渡すと、unknown-field の problem と欄の名前の候補を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-02')
    await explains('ボードに存在しない欄の名前（`Priority`）を指定した場合のテストです。`unknown-field` の問題と、ボードの欄の名前を候補として返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { name: 'Priority', value: 'High' }, reads: readsOf(false) })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'updated_field.name', code: 'unknown-field', message: 'the board has no field named Priority', candidates: ['pecot-status', 'Status', 'Note'] }] })
    })
  })

  it('欄の ID の形で選択肢の名前を渡すと、unknown-option の problem と選択肢の ID の候補を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-02')
    await explains('欄を ID で指定し、値に選択肢の名前（`Ready`）を渡した場合のテストです。ID の形は名前を受けないため、`unknown-option` の問題と、列の選択肢の ID を候補として返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { id: 101, value: 'Ready' }, reads: readsOf(false) })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'updated_field.value', code: 'unknown-option', message: 'Ready is not an option ID (the id form does not take names) of pecot-status that can be set here', candidates: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'] }] })
    })
  })

  it('開いた前提を持つカードを Ready に書くと、status-mismatch の problem と Blocked の候補を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-03')
    await explains('開いた Issue を前提に持つカードを `Ready` へ移そうとした場合のテストです。前提の判定と食い違うため、`status-mismatch` の問題と、候補の `Blocked` を返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { name: 'pecot-status', value: 'Ready' }, reads: readsOf(true) })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'updated_field.value', code: 'status-mismatch', message: '#7 belongs in Blocked by its prerequisites, not Ready', candidates: ['Blocked'] }] })
    })
  })

  it('前提の無いカードを Blocked に書くと、status-mismatch の problem と Ready の候補を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-03')
    await explains('前提を持たないカードを `Blocked` へ移そうとした場合のテストです。前提の判定と食い違うため、`status-mismatch` の問題と、候補の `Ready` を返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { name: 'pecot-status', value: 'Blocked' }, reads: readsOf(false) })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'updated_field.value', code: 'status-mismatch', message: '#7 belongs in Ready by its prerequisites, not Blocked', candidates: ['Ready'] }] })
    })
  })

  it('ボードの欄の読み取りが無いと、list_project_fields を案内する read-required の problem を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-04')
    await explains('`reads` を渡さずに呼んだ場合のテストです。欄と選択肢を確かめられないため、`list_project_fields` の読み取りを案内する `read-required` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { name: 'pecot-status', value: 'Ready' } })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'reads.project_fields', code: 'read-required', message: 'read the board fields with projects_list (method list_project_fields)' }] })
    })
  })

  it('Ready へ移すときにカードの読み取りが無いと、list_project_items を案内する read-required の problem を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-04')
    await explains('`Ready` へ移すときに、カードの読み取り（`reads.project_items`）を渡さない場合のテストです。列を判定できないため、`list_project_items` の読み取りを案内する `read-required` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { name: 'pecot-status', value: 'Ready' }, reads: { project_fields: PROJECT_FIELDS } })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'reads.project_items', code: 'read-required', message: 'read the cards with projects_list (method list_project_items) to judge the column' }] })
    })
  })

  it('ボードに無いカードを渡すと、add_project_item を案内する not-found の problem を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-05')
    await explains('カードの一覧に存在しない Issue を移そうとした場合のテストです。先に `add_project_item` でボードへ追加するよう案内する `not-found` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ updated_field: { name: 'pecot-status', value: 'Ready' }, reads: { ...readsOf(false), project_items: [cards('Ready', [5])] } })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [{ field: 'issue_number', code: 'not-found', message: 'acme/demo/7 is not on the board acme/1: add it with projects_write (method add_project_item) first' }] })
    })
  })

  it('プロジェクトに無いリポジトリの Issue を渡すと、not-in-project の problem を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-06')
    await explains('プロジェクトの設定に存在しないリポジトリ（`acme/other`）の Issue を指定した場合のテストです。`item_repo` の `not-in-project` の問題を返すことを確認します。')
    useProject()
    const outcome = await check({ item_repo: 'other', updated_field: { name: 'Note', value: 'x' }, reads: readsOf(false) })
    await step('結果を確かめる', () => {
      expect(outcome.structured['problems']).toContainEqual(expect.objectContaining({ field: 'item_repo', code: 'not-in-project' }))
    })
  })

  it('設定のボードと違う owner と project_number を渡すと、設定の値を候補にした value の problem を返す', async (context) => {
    await verifies(context, 'PW-BOARD-CHECK-06')
    await explains('設定に記録したボード（`acme` の 1 番）と違う `owner`・`project_number` を指定した場合のテストです。それぞれの `value` の問題と、設定の値の候補を返すことを確認します。')
    useProject()
    const outcome = await check({ owner: 'other', project_number: 2, updated_field: { name: 'Note', value: 'x' }, reads: readsOf(false) })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [
        { field: 'owner', code: 'value', message: 'the board of acme/demo is owned by acme', candidates: ['acme'] },
        { field: 'project_number', code: 'value', message: 'the board of acme/demo is project 1', candidates: ['1'] },
      ] })
    })
  })

  it.for([
    { name: 'id と name の両方', field: { id: 101, name: 'pecot-status', value: 'o3' }, expected: { field: 'updated_field', code: 'value', message: 'give either updated_field.id or updated_field.name, not both' } },
    { name: 'id と name のどちらも無い形', field: { value: 'o3' }, expected: { field: 'updated_field', code: 'required', message: 'give updated_field.id or updated_field.name' } },
  ])('updated_field に $name を渡すと、欄の指定を求める problem を返す', async (row, context) => {
    await verifies(context, 'PW-BOARD-CHECK-07')
    await explains(`\`updated_field\` に${row.name}を渡した場合のテストです。欄を 1 通りで指定するよう求める問題を返すことを確認します。`)
    useProject()
    const outcome = await check({ updated_field: row.field, reads: readsOf(false) })
    await step('結果を確かめる', () => {
      expect(outcome.structured).toEqual({ problems: [row.expected] })
    })
  })
})
