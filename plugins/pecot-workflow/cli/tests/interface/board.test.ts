/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// board sync の振る舞い（PW-BOARD-SYNC-*）を、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { ResponseRule } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { IssueSpec } from '../_helpers/prerequisites.js'
import { CONFIG_FILE, DEFAULT_HOST, graphqlRule, projectConfig, requestLabels, restRule, runCommand } from '../_helpers/command-harness.js'
import type { CommandResult } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

type Json = Record<string, unknown>

const FULL_WORKFLOW = { backlog: 'o1', blocked: 'ob', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' }
const STATUS = { id: 'PVTSSF_status', options: { todo: 'st1', in_progress: 'st2', done: 'st3', needs_attention: 'st4' } }
const PROJECTS_DIRECTORY = '.pecot/config/projects'
const NO_ACTIVE = 'error: no active project\n  run: pecot project activate <PROJECT>\n'
const UNSUPPORTED = 'warning: this GitHub Enterprise Server does not support issue dependencies (blockedBy); no column is moved\n'
const notStarted = { number: 9 }

function asJson(value: unknown): Json {
  if (typeof value !== 'object' || value === null) throw new TypeError('not an object')
  return Object.fromEntries(Object.entries(value))
}

// Blocked と Status の値を持つ設定
function boardConfig(workflowOptions: Record<string, string> = FULL_WORKFLOW): Json {
  const base = projectConfig({ workflowOptions })
  const project = asJson(base['project'])
  return { ...base, project: { ...project, fields: { ...asJson(project['fields']), status: STATUS } } }
}

// 一覧の応答に載る、着手の判定の軽い入力
function item(id: string, number: number, workflow: string, extra: { blockedBy?: number } = {}): Json {
  const progress = extra.blockedBy === undefined ? {} : { issueType: null, subIssues: { totalCount: 0 }, parent: null, blockedBy: { totalCount: extra.blockedBy } }
  return {
    id,
    updatedAt: '2026-01-02T03:04:05Z',
    fieldValues: { nodes: [{ field: { name: 'pecot-workflow-acme' }, name: workflow }] },
    content: { id: `I_${String(number)}`, number, title: `課題${String(number)}`, state: 'OPEN', url: `https://${DEFAULT_HOST}/acme/demo/issues/${String(number)}`, labels: { nodes: [] }, repository: { owner: { login: 'acme' }, name: 'demo' }, ...progress },
  }
}

const board = (...nodes: Json[]): ResponseRule => graphqlRule('ListProjectItems', { node: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } })
const write = (itemId: string, optionId: string): ResponseRule => graphqlRule('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } }, { itemId, optionId })
const rateLimit = (used: number): ResponseRule => restRule('GET', '/rate_limit', 200, { resources: { graphql: { limit: 5000, used, remaining: 5000 - used, reset: 1_800_000_000 } } })
const RATE_NOTE = 'count: GraphQL points used: 30\ncount: GraphQL points remaining: 4870\n'
const done: IssueSpec = { number: 5, state: 'CLOSED', pullRequests: [{ number: 50, state: 'MERGED' }] }

async function sync(rules: ResponseRule[], argv: readonly string[] = [], config: Json | false = boardConfig()): Promise<CommandResult> {
  return await runCommand({ argv: ['board', 'sync', ...argv], github: rules, config })
}

function expectClean(result: Readonly<CommandResult>): void {
  expect(result.problems).toEqual([])
  expect(result.unused).toEqual([])
}

const writes = (result: Readonly<CommandResult>): string[] => requestLabels(result.requests).filter(label => label === 'UpdateProjectItemField')

const rulesFor = (): ResponseRule[] => [rateLimit(100), board(item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3'), rateLimit(130)]
const contentOf = (config: Json): string => `${JSON.stringify(config, undefined, 2)}\n`

describe('board sync', () => {
  it('Blocked の Issue の判定が startable なら、Ready へ動かす', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-01')
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3'), rateLimit(130)])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
  })

  it('Ready の Issue に済んでいない前提があると、Blocked へ動かす', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-02')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready', { blockedBy: 1 })), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), write('PVTI_1', 'ob'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`moved: #1 Ready -> Blocked (blocked by #9 (not in review: #9 (not started)))\n${RATE_NOTE}`)
  })

  it('着手の跡の無い Active と In Review の Issue を、判定に合った列へ戻す', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-03')
    const result = await sync([rateLimit(100), board(item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review')), prerequisitesRule({ number: 2 }), prerequisitesRule({ number: 3 }), write('PVTI_2', 'o3'), write('PVTI_3', 'o3'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`moved: #2 Active -> Ready (startable)\nmoved: #3 In Review -> Ready (startable)\n${RATE_NOTE}`)
  })

  it('着手の跡のある Issue は、blocked でも列と札を変えず、warning を出す', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-04')
    const result = await sync([rateLimit(100), board(item('PVTI_2', 2, 'Active')), prerequisitesRule({ number: 2, branch: 'feat/2', blockedBy: [notStarted] }), rateLimit(130)])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: #2 is in Active but blocked by #9\n${RATE_NOTE}`)
    expect(writes(result)).toEqual([])
  })

  it('前提が無くブランチのある Blocked の Issue は、Ready へ動かさない', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-05')
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked', { blockedBy: 0 })), prerequisitesRule({ number: 4, branch: 'feat/4' }), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(RATE_NOTE)
    expect(writes(result)).toEqual([])
  })

  it('Backlog と Pending の Issue は、前提を読まず、動かさない', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-06')
    const result = await sync([rateLimit(100), board(item('PVTI_7', 7, 'Backlog'), item('PVTI_8', 8, 'Pending')), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(RATE_NOTE)
    expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
    expect(writes(result)).toEqual([])
  })

  it('前提がマージされずに閉じた Issue の札を Needs Attention にする', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-07')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), write('PVTI_1', 'ob'), write('PVTI_1', 'st4'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`moved: #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\nset: Status of #1 to Needs Attention\n${RATE_NOTE}`)
  })

  it('前提がすべて済んだ Issue の Needs Attention を、Todo に戻す', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-08')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [done] }), write('PVTI_1', 'st1'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`set: Status of #1 to Todo\n${RATE_NOTE}`)
  })

  it('--dry-run を付けると、同じ文を dry-run の行で出し、ボードに書かない', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-09')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [{ number: 5, state: 'CLOSED' }] }), prerequisitesRule({ number: 4 }), rateLimit(100)], ['--dry-run'])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('dry-run: would move #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\ndry-run: would move #4 Blocked -> Ready (startable)\ncount: GraphQL points used: 0\ncount: GraphQL points remaining: 4900\n')
    expect(writes(result)).toEqual([])
  })

  it('書き込みに失敗した Issue は、warning を出し、ほかの Issue を続ける', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-10')
    const failedWrite: ResponseRule = { match: { operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_1' } }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 4 }), failedWrite, write('PVTI_4', 'o3'), rateLimit(130)])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^warning: could not move #1: GraphQL query error: [^\n]+\n[^\n]*\nmoved: #4 Blocked -> Ready \(startable\)\ncount: /u)
  })

  it('一覧で前提が 0 件の Ready の Issue だけ、前提を個別に読まない', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-11')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready', { blockedBy: 0 }), item('PVTI_4', 4, 'Blocked', { blockedBy: 0 }), item('PVTI_2', 2, 'Active', { blockedBy: 0 })), prerequisitesRule({ number: 4 }), prerequisitesRule({ number: 2, branch: 'feat/2' }), write('PVTI_4', 'o3'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    expect(requestLabels(result.requests).filter(label => label === 'GetIssuePrerequisites')).toHaveLength(2)
  })

  it('動かす先の値がボードに無いと、動かさず、warning を 1 回出す', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-12')
    const withoutBlocked = Object.fromEntries(Object.entries(FULL_WORKFLOW).filter(([name]) => name !== 'blocked'))
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, blockedBy: [notStarted] }), rateLimit(130)], [], boardConfig(withoutBlocked))
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: the board has no option Blocked; add it with pecot project init\n${RATE_NOTE}`)
    expect(writes(result)).toEqual([])
  })

  it('Issue の依存関係に対応しない GHES では、warning を 1 回出し、終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-13')
    const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), unsupported, rateLimit(100)])
    expect(result.problems).toEqual([])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`${UNSUPPORTED}count: GraphQL points used: 0\ncount: GraphQL points remaining: 4900\n`)
    expect(writes(result)).toEqual([])
  })

  it('一覧の新しいクエリがスキーマの失敗になると、古いクエリで読み直し、前提を読まずに終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-13')
    const rejected: ResponseRule = { match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
    const legacy = graphqlRule('ListProjectItemsLegacy', { node: { items: { nodes: [item('PVTI_1', 1, 'Ready')], pageInfo: { hasNextPage: false, endCursor: null } } } })
    const result = await sync([rateLimit(100), rejected, legacy, rateLimit(100)])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`${UNSUPPORTED}count: GraphQL points used: 0\ncount: GraphQL points remaining: 4900\n`)
    expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
  })

  it('点数の使用量と残りを、実行の前後の差で 、標準エラーに count の行で出す', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-14')
    const result = await sync([rateLimit(4990), board(), rateLimit(10)])
    expectClean(result)
    expect(result.stderr).toBe('count: GraphQL points remaining: 4990\n')
  })

  it('点数を読めなくても、その行を省いて続ける', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-15')
    const missing: ResponseRule = { match: { method: 'GET', path: '/rate_limit' }, respond: { status: 404, body: { message: 'Not Found' } }, times: 2 }
    const result = await sync([missing, board(item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3')])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('moved: #4 Blocked -> Ready (startable)\n')
  })

  it('ボードの取得で GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-16')
    const result = await sync([rateLimit(100), { match: { operation: 'ListProjectItems' }, respond: { status: 500, body: { message: 'Server Error' } }, times: 1 }])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not read project board: GraphQL query error: /u)
  })

  describe('設定の解決', () => {
    const second = `${PROJECTS_DIRECTORY}/${DEFAULT_HOST}_acme_other_acme.json`

    it('.active が無く、設定が 1 つなら、それを使う', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-17')
      const result = await runCommand({ argv: ['board', 'sync'], github: rulesFor(), config: false, files: { [CONFIG_FILE]: contentOf(boardConfig()) } })
      expectClean(result)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    })

    it('.active が無く、設定が 2 つ以上なら、--project を求めて終了コード 1 で止まる', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-18')
      const result = await runCommand({ argv: ['board', 'sync'], github: [], config: false, files: { [CONFIG_FILE]: contentOf(boardConfig()), [second]: contentOf(boardConfig()) } })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`error: no active project, and 2 project configs exist\n  run: pecot board sync --project <NAME>\n  available: ${DEFAULT_HOST}_acme_board_acme, ${DEFAULT_HOST}_acme_other_acme\n`)
      expect(result.requests).toEqual([])
    })

    it('--project で設定名を渡すと、アクティブな設定ではなく、その設定を使う', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-19')
      const other = boardConfig()
      const result = await runCommand({ argv: ['board', 'sync', '--project', `${DEFAULT_HOST}_acme_other_acme`], github: rulesFor(), config: projectConfig(), files: { [second]: contentOf({ ...other, project: { ...asJson(other['project']), id: 'PVT_1' } }) } })
      expectClean(result)
      expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    })

    it('--project の設定が無いと、使える設定の名前を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-20')
      const result = await sync([], ['--project', 'nothing'])
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(`error: project config not found: nothing\n  available: ${DEFAULT_HOST}_acme_board_acme\n`)
      expect(result.requests).toEqual([])
    })

    it('設定がまったく無いと、アクティブなプロジェクトが無いと出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-21')
      const result = await sync([], [], false)
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(NO_ACTIVE)
    })
  })
})
