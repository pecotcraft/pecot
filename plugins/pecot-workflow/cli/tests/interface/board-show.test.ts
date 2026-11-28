/* eslint-disable unicorn/no-null -- 結果の JSON の null と比べる */
// board_show の振る舞いを、MCP のツールの結果で確かめる。GitHub は読まず、公式の MCP の読み取りを reads に渡す
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { step } from '../../../../../libs/interface-spec/src/vitest/step.js'
import { BOARD_SHOW_TOOLS } from '../../src/commands/board-show.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { setUpProject } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { containing } from '../hooks/_helpers/text.js'

useIsolatedEnvironment()

type Json = Readonly<Record<string, unknown>>

const CONFIG_FILE = 'ghes.example.com_acme_board_acme.json'
const CONFIG = {
  host: 'ghes.example.com',
  owner: 'acme',
  project: { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields: { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6', blocked: 'o7' } } } },
  repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'main' }, { owner: 'acme', name: 'other', develop_branch: 'main' }],
}

const TASK_BODY = '## Goal — 一覧画面から状態を確認できる\n\n利用者が一覧画面で各項目の状態を確認できる。\n'

function option(id: string, name: string): Json {
  return { id, name: { raw: name, html: name } }
}

const WORKFLOW_FIELD = { id: 101, node_id: 'PVTSSF_workflow', name: 'pecot-status', data_type: 'single_select', options: [
  option('o1', 'Backlog'), option('o2', 'Pending'), option('o3', 'Ready'), option('o4', 'Active'), option('o5', 'In Review'), option('o6', 'Archived'), option('o7', 'Blocked'),
] }
const LANE_FIELD = { id: 103, node_id: 'PVTSSF_lane', name: 'pecot-lane', data_type: 'single_select', options: [option('l1', 'cli'), option('l2', 'docs')] }

const FIELDS = { fields: { fields: [WORKFLOW_FIELD, LANE_FIELD] } }
const FIELDS_WITHOUT_LANE = { fields: { fields: [WORKFLOW_FIELD] } }

interface CardSpec {
  readonly number: number
  readonly column: string
  readonly repository?: string
  readonly state?: string
  readonly lane?: string
  readonly isPullRequest?: boolean
}

function card(spec: Readonly<CardSpec>): Json {
  const { number, column, repository = 'acme/demo', state = 'open', lane, isPullRequest = false } = spec
  const kind = isPullRequest ? 'pull' : 'issues'
  return {
    id: 1000 + number,
    content_type: isPullRequest ? 'PullRequest' : 'Issue',
    content: { number, title: `Item ${String(number)}`, state, html_url: `https://ghes.example.com/${repository}/${kind}/${String(number)}`, repository, labels: [] },
    fields: [{ id: 101, name: 'pecot-status', value: { name: column } }, ...lane === undefined ? [] : [{ id: 103, name: 'pecot-lane', value: { name: lane } }]],
    updated_at: '2026-11-01T00:00:00Z',
  }
}

function page(cards: readonly Json[], hasNextPage = false): Json {
  return { items: { items: cards, pageInfo: { hasNextPage } } }
}

function issueRead(number: number): Json {
  return { issue: { number, title: `Item ${String(number)}`, state: 'open', body: TASK_BODY, html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}` } }
}

function blockedBy(issue: string, numbers: readonly number[]): Json {
  return { issue, result: { issues: numbers.map(number => ({ number, state: 'open', html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}` })) } }
}

// 7 は前提なし、8 は開いた 5 が前提、9 は前提を読まない。10 は閉じている。20 は PR。3 だけ acme/other
const CARDS = [
  card({ number: 1, column: 'Backlog', lane: 'cli' }),
  card({ number: 7, column: 'Ready', lane: 'cli' }),
  card({ number: 8, column: 'Blocked' }),
  card({ number: 9, column: 'Ready' }),
  card({ number: 10, column: 'Archived', state: 'closed' }),
  card({ number: 20, column: 'In Review', isPullRequest: true, lane: 'cli' }),
  card({ number: 3, column: 'Active', repository: 'acme/other', lane: 'docs' }),
]

const JUDGED_READS = {
  issues: [issueRead(7), issueRead(8), issueRead(5)],
  blocked_by: [blockedBy('acme/demo/7', []), blockedBy('acme/demo/8', [5])],
}

function useProject(): void {
  setUpProject({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: `${JSON.stringify(CONFIG)}\n` } })
}

async function show(arguments_: Json): Promise<ToolOutcome> {
  return await step('board_show を呼ぶ', async () => await callToolOnce(BOARD_SHOW_TOOLS, 'board_show', arguments_))
}

interface ItemShape {
  readonly number: number
  readonly column: string
  readonly repository?: string
  readonly lane?: string | null
  readonly isPullRequest?: boolean
  readonly readiness?: Json | null
}

// 結果の board.items の 1 件
function shownItem(shape: Readonly<ItemShape>): Json {
  const { number, column, repository = 'acme/demo', lane = null, isPullRequest = false, readiness = null } = shape
  return {
    id: 1000 + number,
    workflow: column,
    lane,
    title: `Item ${String(number)}`,
    updatedAt: '2026-11-01T00:00:00Z',
    content: { number, state: 'OPEN', url: `https://ghes.example.com/${repository}/${isPullRequest ? 'pull' : 'issues'}/${String(number)}`, labels: [], repository },
    readiness,
  }
}

const ANY_TEXT: unknown = expect.any(String)
const STARTABLE = { kind: 'startable', stackOn: null, reason: null, text: ANY_TEXT }
const BLOCKED = { kind: 'blocked', stackOn: null, reason: ANY_TEXT, text: containing('#5') }

const SHOWN_ITEM = z.record(z.string(), z.unknown())
const SHOWN_BOARD = z.object({ items: z.array(SHOWN_ITEM) })

function itemsOf(outcome: Readonly<ToolOutcome>): readonly Json[] {
  return SHOWN_BOARD.parse(outcome.structured['board']).items
}

describe('board_show', () => {
  it('ボードのカードと欄の読み取りを渡すと、Backlog から In Review までの開いた項目を board に入れる', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-01')
    await verifies(context, 'PW-BOARD-SHOW-15')
    await explains('カードの一覧と欄の読み取りだけを渡した場合のテストです。閉じた項目と `Archived` の項目を除いた開いた項目を `board` に入れ、前提を読まない Issue の `readiness` を `null` にすることを確認します。')
    useProject()
    const outcome = await show({ reads: { items: [page(CARDS)], fields: FIELDS } })
    await step('結果を確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(itemsOf(outcome)).toEqual([
        shownItem({ number: 1, column: 'Backlog', lane: 'cli' }),
        shownItem({ number: 7, column: 'Ready', lane: 'cli' }),
        shownItem({ number: 8, column: 'Blocked' }),
        shownItem({ number: 9, column: 'Ready' }),
        shownItem({ number: 20, column: 'In Review', lane: 'cli', isPullRequest: true }),
        shownItem({ number: 3, column: 'Active', repository: 'acme/other', lane: 'docs' }),
      ])
      expect(outcome.structured['mismatches']).toBe(0)
    })
  })

  it('json を付けても、結果の項目を json を省いたときと同じにする', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-02')
    await explains('`json` を付けて呼んだ場合のテストです。結果の `board`・`lanes`・`mismatches` が、`json` を省いて呼んだ場合と同じであることを確認します。')
    useProject()
    const reads = { items: [page(CARDS)], fields: FIELDS, ...JUDGED_READS }
    const asText = await show({ reads })
    const asJson = await show({ json: true, reads })
    await step('結果を確かめる', () => {
      expect(asJson.isError).toBe(false)
      expect(asJson.structured).toEqual(asText.structured)
    })
  })

  it('repo を付けると、そのリポジトリの項目だけを board に入れ、lanes もその項目で数える', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-03')
    await explains('`repo` に `acme/other` を指定した場合のテストです。そのリポジトリの項目だけを `board` に入れ、`lanes` もその項目だけで数えることを確認します。')
    useProject()
    const outcome = await show({ repo: 'acme/other', reads: { items: [page(CARDS)], fields: FIELDS } })
    await step('結果を確かめる', () => {
      expect(itemsOf(outcome)).toEqual([shownItem({ number: 3, column: 'Active', repository: 'acme/other', lane: 'docs' })])
      expect(outcome.structured['lanes']).toEqual([{ name: 'cli', count: 0, startable: 0 }, { name: 'docs', count: 1, startable: 0 }])
    })
  })

  it('アクティブなプロジェクトが無いと、kind が no-active-project の失敗を返す', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-10')
    await explains('プロジェクトの設定が存在しない状態で呼んだ場合のテストです。`kind` が `no-active-project` の失敗を返すことを確認します。')
    setEnvironment({ CLAUDE_PROJECT_DIR: makeTemporaryDirectory('pecot-project-') })
    const outcome = await show({ reads: { items: [page(CARDS)], fields: FIELDS } })
    await step('結果を確かめる', () => {
      expect(outcome.isError).toBe(true)
      expect(outcome.structured['kind']).toBe('no-active-project')
    })
  })

  it('前提を読んだ Ready と Blocked の Issue に readiness を入れ、判定とずれた列でも動かさない', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-14')
    await verifies(context, 'PW-BOARD-SHOW-15')
    await verifies(context, 'PW-BOARD-SHOW-33')
    await explains('`Ready` の #7 と `Blocked` の #8 の前提を `reads.blocked_by` に渡した場合のテストです。#7 を着手できる、#8 を開いた前提を待つと判定し、前提を読まない #9 の判定を `null` にすることを確認します。')
    useProject()
    const outcome = await show({ reads: { items: [page(CARDS)], fields: FIELDS, ...JUDGED_READS } })
    await step('結果を確かめる', () => {
      const items = itemsOf(outcome)
      expect(items.find(item => item['id'] === 1007)).toEqual(shownItem({ number: 7, column: 'Ready', lane: 'cli', readiness: STARTABLE }))
      expect(items.find(item => item['id'] === 1008)).toEqual(shownItem({ number: 8, column: 'Blocked', readiness: BLOCKED }))
      expect(items.find(item => item['id'] === 1009)).toEqual(shownItem({ number: 9, column: 'Ready' }))
      expect(outcome.structured['mismatches']).toBe(0)
      expect(outcome.structured).not.toHaveProperty('warnings')
    })
  })

  it('判定に要る前提の Issue の読み取りが無いと、readiness を unknown にして理由を入れる', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-18')
    await explains('#8 の前提の #5 を `reads.issues` に渡さない場合のテストです。#8 の判定を `unknown` にし、不足している読み取りを理由の文に入れることを確認します。')
    useProject()
    const outcome = await show({ reads: { items: [page(CARDS)], fields: FIELDS, issues: [issueRead(7), issueRead(8)], blocked_by: JUDGED_READS.blocked_by } })
    await step('結果を確かめる', () => {
      const blocked = itemsOf(outcome).find(item => item['id'] === 1008)
      expect(blocked?.['readiness']).toEqual({ kind: 'unknown', stackOn: null, reason: null, text: containing('issue_read') })
    })
  })

  it('判定と列のずれた Issue があると、件数を mismatches に入れ、pecot-board-sync を warning で案内する', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-33')
    await explains('開いた前提を待つ #8 が `Ready` の列にある場合のテストです。食い違いの件数 1 を `mismatches` に入れ、`pecot-board-sync` のワークフローを `warnings` で案内することを確認します。')
    useProject()
    const cards = CARDS.map(item => item['id'] === 1008 ? card({ number: 8, column: 'Ready' }) : item)
    const outcome = await show({ reads: { items: [page(cards)], fields: FIELDS, ...JUDGED_READS } })
    await step('結果を確かめる', () => {
      expect(outcome.structured['mismatches']).toBe(1)
      expect(outcome.structured['warnings']).toEqual([expect.stringMatching(/^1 Ready or Blocked Issue may be in a column or Status that does not match its judgment; start the pecot-board-sync workflow with actions_run_trigger/u)])
      expect(itemsOf(outcome).find(item => item['id'] === 1008)?.['workflow']).toBe('Ready')
    })
  })

  it('ボードに pecot-lane があると、各 Item の lane と、選択肢の順の lanes を PR を除いて数える', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-38')
    await explains('ボードに `pecot-lane` の欄がある場合のテストです。`lanes` に、選択肢の順で開いた Issue の数と着手できる数を入れ、値の無い Issue を最後に数え、PR を数えないことを確認します。')
    useProject()
    const outcome = await show({ reads: { items: [page(CARDS)], fields: FIELDS, ...JUDGED_READS } })
    await step('結果を確かめる', () => {
      expect(outcome.structured['lanes']).toEqual([
        { name: 'cli', count: 2, startable: 1 },
        { name: 'docs', count: 1, startable: 0 },
        { name: null, count: 2, startable: 0 },
      ])
    })
  })

  it('ボードに pecot-lane が無いと、各 Item の lane を null に、lanes を空にする', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-40')
    await explains('ボードに `pecot-lane` の欄が存在しない場合のテストです。各 Item の `lane` を `null` にし、`lanes` を空の配列にすることを確認します。')
    useProject()
    const outcome = await show({ reads: { items: [page(CARDS)], fields: FIELDS_WITHOUT_LANE } })
    await step('結果を確かめる', () => {
      expect(itemsOf(outcome).map(item => item['lane'])).toEqual([null, null, null, null, null, null])
      expect(outcome.structured['lanes']).toEqual([])
    })
  })

  it('reads.items の最後のページに続きがあると、読んだ分だけを返し、warning を 1 つ入れる', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-43')
    await explains('`reads.items` の最後のページの `hasNextPage` が `true` の場合のテストです。読んだページの項目だけを返し、残りのページがある旨の警告を 1 つ入れることを確認します。')
    useProject()
    const outcome = await show({ reads: { items: [page(CARDS.slice(0, 2), true)], fields: FIELDS } })
    await step('結果を確かめる', () => {
      expect(itemsOf(outcome).map(item => item['id'])).toEqual([1001, 1007])
      expect(outcome.structured['warnings']).toEqual(['the last page in reads.items has more pages: the board shows only the items read so far'])
    })
  })
})
