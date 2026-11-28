/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 読み取りの結果の形の値は readonly にしない */
// project_check の振る舞いを、MCP のツールの結果で確かめる。読み取りは公式の GitHub MCP の結果の形で渡す。
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { PROJECT_CHECK } from '../../src/commands/project-check.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { step } from '../_helpers/step.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'

useIsolatedEnvironment()

type Json = Record<string, unknown>

const PROBLEMS = z.array(z.record(z.string(), z.unknown()))
const WORKFLOW_NAMES = ['Pending', 'Backlog', 'Blocked', 'Ready', 'Active', 'In Review', 'Archived']
const STATUS_NAMES = ['Todo', 'In Progress', 'Done', 'Needs Attention']

const listProjects = (titles: readonly string[], hasNextPage = false): Json => ({ projects: { projects: titles.map((title, index) => ({ id: index + 1, node_id: `PVT_${String(index + 1)}`, number: index + 1, title })), pageInfo: { hasNextPage } } })
const field = (id: number, name: string, names?: readonly string[]): Json => ({
  id,
  node_id: `PVTF_${String(id)}`,
  name,
  data_type: names === undefined ? 'text' : 'single_select',
  ...names !== undefined && { options: names.map((option, index) => ({ id: `o${String(id)}_${String(index)}`, name: { raw: option } })) },
})
const workflow = (names: readonly string[] = WORKFLOW_NAMES, name = 'pecot-status'): Json => field(2, name, names)
const status = (names: readonly string[] = STATUS_NAMES): Json => field(3, 'Status', names)
const fieldsRead = (fields: readonly Json[], hasNextPage = false): Json => ({ fields: { fields, pageInfo: { hasNextPage } } })
const READY_BOARD = fieldsRead([field(1, 'Title'), workflow(), status()])
const option = (name: string): Json => ({ name })

async function check(arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce([PROJECT_CHECK], 'project_check', { owner: 'acme', ...arguments_ })
}

async function fields(arguments_: Readonly<Record<string, unknown>>, read: Json = READY_BOARD): Promise<ToolOutcome> {
  return await check({ method: 'fields', project: 1, reads: { fields: read }, ...arguments_ })
}

function problemsOf(outcome: Readonly<ToolOutcome>): readonly Readonly<Record<string, unknown>>[] {
  expect(outcome.isError).toBe(false)
  return PROBLEMS.parse(outcome.structured['problems'])
}

const codesOf = (outcome: Readonly<ToolOutcome>): readonly (readonly unknown[])[] => problemsOf(outcome).map(problem => [problem['field'], problem['code']])

async function create(arguments_: Readonly<Record<string, unknown>> = {}, projects: readonly Json[] = [listProjects(['other'])]): Promise<ToolOutcome> {
  return await check({ method: 'create', owner_type: 'user', title: 'board', reads: { projects }, ...arguments_ })
}

const laneBoard = (lanes: readonly string[]): Json => fieldsRead([workflow(), status(), field(4, 'pecot-lane', lanes)])

describe('project_check', () => {
  describe('create', () => {
    it('owner に同じ名前のボードが無いと、problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-01')
      await explains('`project_check` の `create` のテストです。所有者のボードの一覧に同じ名前のボードが存在しない場合は、問題の無い結果と `ok` の行を返すことを確認します。')
      const outcome = await create()
      await step('problem が無く ok と返り、deletable が無いことを確かめる', () => {
        expect(outcome).toMatchObject({ isError: false, structured: { problems: [] }, text: 'ok' })
        expect(outcome.structured).not.toHaveProperty('deletable')
      })
    })

    it('owner に同じ名前のボードがあると、title-taken の problem にそのボードの番号を添える', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-02')
      await explains('`project_check` の `create` のテストです。2 ページ目に同じ名前のボードが存在する場合は、`title-taken` の問題を返し、その番号を文に含めることを確認します。')
      const outcome = await create({}, [listProjects(['other'], true), listProjects(['a', 'board'])])
      await step('title-taken の problem を確かめる', () => {
        expect(problemsOf(outcome)).toEqual([{ field: 'title', code: 'title-taken', message: 'acme already has a board titled board (#2); choose another title, or use that board with method fields' }])
      })
    })

    it('owner_type と title を渡さず、changes を渡すと、required と unexpected の problem を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-03')
      await explains('`project_check` の `create` の入力のテストです。`owner_type` と `title` が不足し、`changes` を指定した場合は、それぞれ `required` と `unexpected` の問題を返すことを確認します。')
      const outcome = await create({ owner_type: undefined, title: undefined, changes: [{ action: 'delete', name: 'x' }] })
      await step('required と unexpected の problem を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['owner_type', 'required'], ['title', 'required'], ['changes', 'unexpected']])
        expect(problemsOf(outcome)[0]?.['candidates']).toEqual(['user', 'org'])
      })
    })

    it('ボードの一覧を渡していないか、最後のページに続きがあると、read-required の problem を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-04')
      await explains('`project_check` の `create` の読み取りのテストです。ボードの一覧が無い場合と、最後のページに続きがある場合は、`read-required` の問題を返すことを確認します。')
      const unread = await check({ method: 'create', owner_type: 'org', title: 'board' })
      await step('一覧が無いときの read-required の problem を確かめる', () => {
        expect(codesOf(unread)).toEqual([['reads.projects', 'read-required']])
        expect(problemsOf(unread)[0]?.['message']).toBe('read the boards of acme with projects_list (method list_projects, every page) and pass the results as reads.projects')
      })
      const more = await create({}, [listProjects(['other'], true)])
      await step('続きがあるときの read-required の problem を確かめる', () => {
        expect(codesOf(more)).toEqual([['reads.projects', 'read-required']])
      })
    })
  })

  describe('fields', () => {
    it('ボードが pecot の欄の決まりに合うと、problem の無い結果と空の deletable を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-05')
      await explains('`project_check` の `fields` のテストです。進行の欄と Status の選択肢がそろったボードの場合は、問題の無い結果と空の `deletable` を返すことを確認します。')
      const outcome = await fields({})
      await step('problem が無く deletable が空であることを確かめる', () => {
        expect(outcome).toMatchObject({ isError: false, structured: { problems: [], deletable: [] }, text: 'ok' })
      })
    })

    it('pecot-status の欄が無いと、missing-field の problem に作る選択肢を順に並べる', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-06')
      await explains('`project_check` の進行の欄が存在しないボードのテストです。`missing-field` の問題を返し、作る選択肢を色と説明つきで順に案内することを確認します。')
      const read = fieldsRead([field(1, 'Title'), status()])
      const outcome = await fields({}, read)
      await step('missing-field の problem と作る選択肢を確かめる', () => {
        const problems = problemsOf(outcome)
        expect(problems).toEqual([expect.objectContaining({ field: 'pecot-status', code: 'missing-field', candidates: WORKFLOW_NAMES })])
        expect(problems[0]?.['message']).toMatch(/^the board has no pecot-status field; add a create change with these options in this order: Pending \(color GRAY, description "Items on hold/u)
      })
    })

    it('旧い名前の進行の欄だけがあると、pecot-status への rename を案内する', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-06')
      await explains('`project_check` の旧い名前の進行の欄のテストです。旧い名前の欄だけが存在する場合は、`missing-field` の問題で `pecot-status` への改名を案内することを確認します。')
      const read = fieldsRead([workflow(WORKFLOW_NAMES, 'pecot-workflow-acme'), status()])
      const outcome = await fields({}, read)
      await step('rename を案内する problem を確かめる', () => {
        expect(problemsOf(outcome)).toEqual([expect.objectContaining({ field: 'pecot-status', code: 'missing-field', message: 'the board has no pecot-status field; add a rename change from pecot-workflow-acme to pecot-status, which keeps its options and the values on the cards' })])
      })
    })

    it('pecot-status と Status に足りない選択肢があると、missing-option の problem に足す場所を添える', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-07')
      await explains('`project_check` の選択肢が不足しているボードのテストです。進行の欄と Status に不足している選択肢ごとに、`missing-option` の問題と足す位置を返すことを確認します。')
      const read = fieldsRead([workflow(['Pending', 'Backlog', 'Ready', 'Active', 'In Review', 'Archived']), status(['Todo', 'Done'])])
      const outcome = await fields({}, read)
      await step('missing-option の problem と足す位置を確かめる', () => {
        const problems = problemsOf(outcome)
        expect(problems.map(problem => [problem['field'], problem['code'], problem['candidates']])).toEqual([['pecot-status', 'missing-option', ['Blocked']], ['Status', 'missing-option', ['Needs Attention']]])
        expect(problems[0]?.['message']).toMatch(/^pecot-status lacks options: Blocked \(color GRAY, description "[^"]+"\) after Backlog; /u)
      })
    })

    it('changes を当てた後のボードで決まりを見て、決まりに合えば problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-08')
      await explains('`project_check` の `changes` のテストです。`pecot-status` を作る変更と Status の選択肢を足す変更を当てた後のボードが決まりに合う場合は、問題の無い結果を返すことを確認します。')
      const changes = [
        { action: 'create', name: 'pecot-status', options: WORKFLOW_NAMES.map(name => option(name)) },
        { action: 'set-options', name: 'Status', options: STATUS_NAMES.map(name => option(name)) },
      ]
      const outcome = await fields({ changes }, fieldsRead([field(1, 'Title'), status(['Todo', 'In Progress', 'Done'])]))
      await step('problem が無く deletable が空であることを確かめる', () => {
        expect(outcome.structured).toEqual({ problems: [], deletable: [] })
      })
    })

    it('github-ops が断る変更と、カードの値を消す変更を、changes の位置の problem にする', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-09')
      await explains('`project_check` の `changes` の誤りのテストです。既にある欄の作成、存在しない欄の変更、単一選択でない欄の選択肢、選択肢を落とす変更を、`changes` の位置ごとの問題として返すことを確認します。')
      const changes = [
        { action: 'create', name: 'Status', options: [option('x')] },
        { action: 'rename', name: 'Missing', to: 'y' },
        { action: 'set-options', name: 'Title', options: [option('x')] },
        { action: 'set-options', name: 'Status', options: [option('Todo')] },
      ]
      const outcome = await fields({ changes }, fieldsRead([field(1, 'Title'), workflow(), status()]))
      await step('changes の位置ごとの problem を確かめる', () => {
        expect(codesOf(outcome)).toEqual([
          ['changes[0]', 'already-exists'],
          ['changes[1]', 'not-found'],
          ['changes[2]', 'field-type'],
          ['changes[3]', 'option-removed'],
          ['Status', 'missing-option'],
        ])
        expect(problemsOf(outcome)[3]?.['candidates']).toEqual(STATUS_NAMES)
      })
    })

    it('pecot-status が単一選択の欄でないと、field-type の problem を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-10')
      await explains('`project_check` の進行の欄の種類のテストです。`pecot-status` が単一選択の欄でない場合は、`field-type` の問題を返すことを確認します。')
      const outcome = await fields({}, fieldsRead([field(2, 'pecot-status'), status()]))
      await step('field-type の problem を確かめる', () => {
        expect(problemsOf(outcome)).toEqual([{ field: 'pecot-status', code: 'field-type', message: 'pecot-status must be a single select field (it is TEXT); delete or rename it, then create it again' }])
      })
    })

    it('lanes を渡すと、pecot-lane の欄と、足りない lane の値を problem にする', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-11')
      await explains('`project_check` の `lanes` のテストです。`pecot-lane` が存在しない場合は `missing-field`、値が不足している場合は `missing-option` の問題を返し、そろえば問題を返さないことを確認します。')
      const noLane = await fields({ lanes: ['cli', 'docs'] })
      await step('欄が無いときの missing-field の problem を確かめる', () => {
        expect(problemsOf(noLane)).toEqual([expect.objectContaining({ field: 'pecot-lane', code: 'missing-field', candidates: ['cli', 'docs'] })])
      })
      const partial = await fields({ lanes: ['cli', 'docs'] }, laneBoard(['cli']))
      await step('値が足りないときの missing-option の problem を確かめる', () => {
        expect(problemsOf(partial)).toEqual([expect.objectContaining({ field: 'pecot-lane', code: 'missing-option', candidates: ['docs'] })])
      })
      const complete = await fields({ lanes: ['cli'] }, laneBoard(['cli']))
      await step('値がそろうと problem が無いことを確かめる', () => {
        expect(problemsOf(complete)).toEqual([])
      })
    })

    it('pecot が使わない欄と、pecot-status と並ぶ旧い進行の欄を deletable に並べる', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-12')
      await explains('`project_check` の `deletable` のテストです。`pecot-priority`・`pecot-size`・旧い名前の進行の欄を、`pecot-status` がある場合に消せる欄として返すことを確認します。')
      const outcome = await fields({}, fieldsRead([workflow(), status(), field(5, 'pecot-size', ['S']), field(6, 'pecot-priority', ['P1']), workflow(WORKFLOW_NAMES, 'pecot-workflow-acme')]))
      await step('deletable に並ぶ欄を確かめる', () => {
        expect(outcome).toMatchObject({ isError: false, structured: { problems: [], deletable: ['pecot-priority', 'pecot-size', 'pecot-workflow-acme'] } })
        expect(outcome.text).toBe('ok')
      })
    })

    it('project が無く、create の入力を渡し、欄の一覧を読んでいないと、その順に problem にする', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-13')
      await explains('`project_check` の `fields` の入力のテストです。`project` が不足し、`title` を指定し、欄の一覧が無い場合は、`required`・`unexpected`・`read-required` の問題を返すことを確認します。')
      const outcome = await check({ method: 'fields', title: 'board' })
      await step('required・unexpected・read-required の problem を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['project', 'required'], ['title', 'unexpected'], ['reads.fields', 'read-required']])
        expect(outcome.structured).not.toHaveProperty('deletable')
      })
      const more = await fields({}, fieldsRead([workflow(), status()], true))
      await step('続きがあるときの read-required の problem を確かめる', () => {
        expect(codesOf(more)).toEqual([['reads.fields', 'read-required']])
      })
    })

    it('欄の一覧が公式の GitHub MCP の結果の形でないと、kind が github-mcp-shape の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CHECK-14')
      await explains('`project_check` の読み取りの形のテストです。欄の一覧が `list_project_fields` の結果の形でない場合は、`kind` が `github-mcp-shape` の失敗を返すことを確認します。')
      const outcome = await fields({}, { fields: [] })
      await step('github-mcp-shape の失敗を確かめる', () => {
        expect(outcome).toMatchObject({ isError: true, structured: { kind: 'github-mcp-shape' } })
      })
    })
  })
})
