/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// board sync の振る舞い（PW-BOARD-SYNC-*）を、runCli をプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { ResponseRule } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import type { IssueSpec } from '../_helpers/prerequisites.js'
import { CONFIG_FILE, DEFAULT_HOST, graphqlRule, projectConfig, requestLabels, restRule, runCommand, runTool, STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/command-harness.js'
import type { CommandResult, ToolResult } from '../_helpers/command-harness.js'
import { addedToBoard, boardItems, fieldUpdated, issueNodeId, linkedRepositories } from '../_helpers/board-issue-case.js'

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
function boardConfig(workflowOptions: Record<string, string> = FULL_WORKFLOW, repositories?: readonly Json[]): Json {
  const base = projectConfig(repositories === undefined ? { workflowOptions } : { workflowOptions, repositories })
  const project = asJson(base['project'])
  return { ...base, project: { ...project, fields: { ...asJson(project['fields']), status: STATUS } } }
}

interface ItemExtra {
  readonly blockedBy?: number
  readonly repository?: string
  readonly title?: string
  readonly isPullRequest?: boolean
  readonly updatedAt?: string
  readonly state?: string
}

// 一覧の応答に載る、着手の判定の軽い入力
function item(id: string, number: number, workflow: string, extra: ItemExtra = {}): Json {
  const { repository = 'demo' } = extra
  const progress = extra.blockedBy === undefined ? {} : { issueType: null, subIssues: { totalCount: 0 }, parent: null, blockedBy: { totalCount: extra.blockedBy } }
  return {
    id,
    updatedAt: extra.updatedAt ?? '2026-01-02T03:04:05Z',
    fieldValues: { nodes: [{ field: { name: 'pecot-workflow-acme' }, name: workflow }] },
    content: { id: `I_${String(number)}`, number, title: extra.title ?? `課題${String(number)}`, state: extra.state ?? 'OPEN', url: `https://${DEFAULT_HOST}/acme/${repository}/${extra.isPullRequest === true ? 'pull' : 'issues'}/${String(number)}`, labels: { nodes: [] }, repository: { owner: { login: 'acme' }, name: repository }, ...progress },
  }
}

const deletion = (itemId: string, status = 200): ResponseRule => status === 200
  ? graphqlRule('DeleteProjectItem', { deleteProjectV2Item: { deletedItemId: itemId } }, { projectId: 'PVT_1', itemId })
  : { match: { operation: 'DeleteProjectItem', variables: { projectId: 'PVT_1', itemId } }, respond: { status, body: { message: 'Server Error' } }, times: 1 }
const archivedItems = (count: number): Json[] => Array.from({ length: count }, (_unused, index) => item(`PVTI_a${String(index + 1).padStart(2, '0')}`, 100 + index, 'Archived', { state: 'CLOSED', updatedAt: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00Z` }))
// Archived より古い updatedAt の Backlog。絞り込みが無いと、これも削除の対象になる
const olderBacklog = (): Json => item('PVTI_r1', 11, 'Backlog', { updatedAt: '2026-01-01T00:00:00Z' })

const RESET = 1_800_000_000
const board = (...nodes: Json[]): ResponseRule => graphqlRule('ListProjectItems', { node: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } })
const write = (itemId: string, optionId: string): ResponseRule => graphqlRule('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } }, { itemId, optionId })
const failedWrite = (optionId: string): ResponseRule => ({ match: { operation: 'UpdateProjectItemField', variables: { itemId: 'PVTI_1', optionId } }, respond: { status: 500, body: { message: 'boom' } }, times: 1 })
const rateLimit = (used: number, reset = RESET): ResponseRule => restRule('GET', '/rate_limit', 200, { resources: { graphql: { limit: 5000, used, remaining: 5000 - used, reset } } })
const RATE_NOTE = 'count: GraphQL points used: 30\ncount: GraphQL points remaining: 4870\n'
const NO_POINTS_USED = 'count: GraphQL points used: 0\ncount: GraphQL points remaining: 4900\n'
const done: IssueSpec = { number: 5, state: 'CLOSED', pullRequests: [{ number: 50, state: 'MERGED' }] }
// 偽サーバの 500 の文。ポートは実行ごとに変わるので、stable で置き換えて比べる
const SERVER_ERROR = 'GraphQL query error: Server error \'500 Internal Server Error\' for url \'http://127.0.0.1:PORT/graphql\'\n  For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500'
// project activate の案内に出る名前（CONFIG_FILE のファイル名から .json を除いたもの）
const ACTIVE_PROJECT = path.basename(CONFIG_FILE, '.json')
const stable = (stderr: string): string => stderr.replaceAll(/http:\/\/127\.0\.0\.1:\d+/gu, 'http://127.0.0.1:PORT')

async function sync(rules: ResponseRule[], argv: readonly string[] = [], config: Json | false = boardConfig()): Promise<CommandResult> {
  return await runCommand({ argv: ['board', 'sync', ...argv], github: rules, config })
}

function expectClean(result: Readonly<Pick<CommandResult, 'problems' | 'unused'>>): void {
  expect(result.problems).toEqual([])
  expect(result.unused).toEqual([])
}

const writes = (result: Readonly<Pick<CommandResult, 'requests'>>): string[] => requestLabels(result.requests).filter(label => label === 'UpdateProjectItemField')

// Blocked の #4 を Ready へ動かす 1 回分の応答
const blockedToReadyRules = (): ResponseRule[] => [rateLimit(100), board(item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3'), rateLimit(130)]
const contentOf = (config: Json): string => `${JSON.stringify(config, undefined, 2)}\n`

const syncWithPoints = async (rules: ResponseRule[], argv: readonly string[] = []): Promise<CommandResult> => await sync([rateLimit(100), ...rules, rateLimit(130)], argv)
const tool = async (name: string, arguments_: Json, rules: ResponseRule[], config: Json = boardConfig()): Promise<ToolResult> => await runTool({ tool: name, arguments: arguments_, github: rules, config })

// board_sync の MCP の呼び出し。GraphQL の点数の読み取りを前後に置く
const withPoints = (...rules: ResponseRule[]): ResponseRule[] => [rateLimit(100), ...rules, rateLimit(130)]
const syncBoard = async (...rules: ResponseRule[]): Promise<ToolResult> => await tool('board_sync', {}, withPoints(...rules))
const syncBoardWith = async (config: Json, ...rules: ResponseRule[]): Promise<ToolResult> => await tool('board_sync', {}, withPoints(...rules), config)
const syncTool = async (arguments_: Json, run: Readonly<{ github?: ResponseRule[], config?: Json | false, files?: Record<string, string> }>): Promise<ToolResult> =>
  await runTool({ tool: 'board_sync', arguments: arguments_, github: run.github ?? [], config: run.config ?? boardConfig(), ...run.files !== undefined && { files: run.files } })
const stableWarnings = (result: ToolResult): string[] => (Array.isArray(result.structured['warnings']) ? result.structured['warnings'].map(String) : []).map(warning => stable(warning))

// board show の data を確かめる応答。Ready の #1 に済んでいない前提があり、列が判定と合わない
const showRules = (): ResponseRule[] => [
  board(item('PVTI_1', 1, 'Ready')),
  restRule('GET', '/repos/acme/demo/dependabot/alerts', 200, [{ security_vulnerability: { severity: 'high' } }]),
  prerequisitesRule({ number: 1, blockedBy: [notStarted] }),
]

describe('board sync', () => {
  it('Blocked の Issue の判定が startable なら、Ready へ動かす', async () => {
    const result = await sync(blockedToReadyRules())
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
  })

  it('Ready の Issue に済んでいない前提があると、Blocked へ動かす', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready', { blockedBy: 1 })), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), write('PVTI_1', 'ob'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`moved: #1 Ready -> Blocked (blocked by #9 (not in review: #9 (not started)))\n${RATE_NOTE}`)
  })

  it('着手の跡の無い Active と In Review の Issue を、判定に合った列へ戻す', async () => {
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

  it('前提が無くブランチのある Blocked の Issue は、Ready へ動かさない', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked', { blockedBy: 0 })), prerequisitesRule({ number: 4, branch: 'feat/4' }), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(RATE_NOTE)
    expect(writes(result)).toEqual([])
  })

  it('Backlog と Pending の Issue は、前提を読まず、動かさない', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_7', 7, 'Backlog'), item('PVTI_8', 8, 'Pending')), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(RATE_NOTE)
    expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
    expect(writes(result)).toEqual([])
  })

  it('前提がマージされずに閉じた Issue の札を Needs Attention にする', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), write('PVTI_1', 'ob'), write('PVTI_1', 'st4'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`moved: #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\nset: Status of #1 to Needs Attention\n${RATE_NOTE}`)
  })

  it('前提がすべて済んだ Issue の Needs Attention を、Todo に戻す', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [done] }), write('PVTI_1', 'st1'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`set: Status of #1 to Todo\n${RATE_NOTE}`)
  })

  it('--dry-run を付けると、同じ文を dry-run の行で出し、ボードに書かない', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-09')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [{ number: 5, state: 'CLOSED' }] }), prerequisitesRule({ number: 4 }), rateLimit(100)], ['--dry-run'])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`dry-run: would move #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\ndry-run: would move #4 Blocked -> Ready (startable)\n${NO_POINTS_USED}`)
    expect(writes(result)).toEqual([])
  })

  it('--dry-run で札を変える予定も、dry-run の行で出す', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-09')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), prerequisitesRule({ number: 3, label: 'Needs Attention', blockedBy: [done] }), rateLimit(100)], ['--dry-run'])
    expectClean(result)
    expect(result.stderr).toBe(`dry-run: would move #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\ndry-run: would set Status of #1 to Needs Attention\ndry-run: would set Status of #3 to Todo\n${NO_POINTS_USED}`)
    expect(writes(result)).toEqual([])
  })

  it('書き込みに失敗した Issue は、warning を出し、ほかの Issue を続けてから、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-10')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 4 }), failedWrite('ob'), write('PVTI_4', 'o3'), rateLimit(130)])
    expectClean(result)
    expect(result.code).toBe(1)
    expect(stable(result.stderr)).toBe(`warning: could not move #1: ${SERVER_ERROR}\nmoved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}error: could not write 1 Issue to the board\n`)
    expect(writes(result)).toHaveLength(2)
  })

  it('列の書き込みが成功し札の書き込みだけ失敗すると、move の行の後に warning を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-10')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), write('PVTI_1', 'ob'), failedWrite('st4'), rateLimit(130)])
    expectClean(result)
    expect(result.code).toBe(1)
    expect(stable(result.stderr)).toBe(`moved: #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\nwarning: could not move #1: ${SERVER_ERROR}\n${RATE_NOTE}error: could not write 1 Issue to the board\n`)
    expect(writes(result)).toHaveLength(2)
  })

  it('選択肢の ID が古くて 2 件の書き込みに失敗すると、warning を 2 行と ID を読み直す案内を 1 回出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-10')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, blockedBy: [notStarted] }), staleOptionUpdate(2), rateLimit(130)])
    expectClean(result)
    expect(result.code).toBe(1)
    expect(result.stderr).toBe([
      `warning: could not move #1: ${STALE_OPTION_TEXT}`,
      `  hint: if the board options were recreated, run pecot project activate ${ACTIVE_PROJECT} to read their IDs again`,
      `warning: could not move #3: ${STALE_OPTION_TEXT}`,
      `${RATE_NOTE}error: could not write 2 Issues to the board`,
      '',
    ].join('\n'))
    expect(writes(result)).toHaveLength(2)
  })

  it('一覧で前提が 0 件の Ready の Issue だけ、前提を個別に読まない', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready', { blockedBy: 0 }), item('PVTI_4', 4, 'Blocked', { blockedBy: 0 }), item('PVTI_2', 2, 'Active', { blockedBy: 0 })), prerequisitesRule({ number: 4 }), prerequisitesRule({ number: 2, branch: 'feat/2' }), write('PVTI_4', 'o3'), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    expect(requestLabels(result.requests).filter(label => label === 'GetIssuePrerequisites')).toHaveLength(2)
  })

  it('動かす先の値がボードに無いと、動かさず、warning を 1 回出す', async () => {
    const withoutBlocked = Object.fromEntries(Object.entries(FULL_WORKFLOW).filter(([name]) => name !== 'blocked'))
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, blockedBy: [notStarted] }), rateLimit(130)], [], boardConfig(withoutBlocked))
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: the board has no option Blocked; add it with pecot project init\n${RATE_NOTE}`)
    expect(writes(result)).toEqual([])
  })

  it('Issue の依存関係に対応しない GHES では、warning を 1 回出し、終了コード 0 で終わる', async () => {
    const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), unsupported, rateLimit(100)])
    expect(result.problems).toEqual([])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`${UNSUPPORTED}${NO_POINTS_USED}`)
    expect(writes(result)).toEqual([])
  })

  it('一覧の新しいクエリがスキーマの失敗になると、古いクエリで読み直し、前提を読まずに終了コード 0 で終わる', async () => {
    const rejected: ResponseRule = { match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
    const legacy = graphqlRule('ListProjectItemsLegacy', { node: { items: { nodes: [item('PVTI_1', 1, 'Ready')], pageInfo: { hasNextPage: false, endCursor: null } } } })
    const result = await sync([rateLimit(100), rejected, legacy, rateLimit(100)])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`${UNSUPPORTED}${NO_POINTS_USED}`)
    expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
  })

  it('点数の使用量と残りを、実行の前後の差で、標準エラーに count の行で出す', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-14')
    const result = await sync([rateLimit(100), board(), rateLimit(130)])
    expectClean(result)
    expect(result.stderr).toBe(RATE_NOTE)
  })

  it('点数の差が負なら、使用量の行を省く', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-14')
    const result = await sync([rateLimit(4990), board(), rateLimit(10)])
    expectClean(result)
    expect(result.stderr).toBe('count: GraphQL points remaining: 4990\n')
  })

  it('点数の窓が実行の途中で切り替わると、差が正でも使用量の行を省く', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-14')
    const result = await sync([rateLimit(100), board(), rateLimit(130, RESET + 3600)])
    expectClean(result)
    expect(result.stderr).toBe('count: GraphQL points remaining: 4870\n')
  })

  it('点数を読めなくても、その行を省いて続ける', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-15')
    const missing: ResponseRule = { match: { method: 'GET', path: '/rate_limit' }, respond: { status: 404, body: { message: 'Not Found' } }, times: 2 }
    const result = await sync([missing, board(item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3')])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('moved: #4 Blocked -> Ready (startable)\n')
  })

  it('ボードの取得で GitHub API がエラーを返すと、点数の行を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-16')
    const result = await sync([rateLimit(100), { match: { operation: 'ListProjectItems' }, respond: { status: 500, body: { message: 'Server Error' } }, times: 1 }, rateLimit(101)])
    expectClean(result)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(stable(result.stderr)).toBe(`count: GraphQL points used: 1\ncount: GraphQL points remaining: 4899\nerror: could not read project board: ${SERVER_ERROR}\n`)
  })

  it('判定を読めない Issue があると、warning の行を出し、その Issue を動かさない', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), rateLimit(130)], [], boardConfig(FULL_WORKFLOW, [{ owner: 'acme', name: 'demo' }]))
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: could not judge #1: develop_branch is not set for acme/demo\n${RATE_NOTE}`)
    expect(writes(result)).toEqual([])
  })

  it('Ready の Issue の前提が輪になると、Blocked へ動かす', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_2', 2, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 2 }] }), prerequisitesRule({ number: 2, blockedBy: [{ number: 1 }] }), write('PVTI_1', 'ob'), write('PVTI_2', 'ob'), rateLimit(130)])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`moved: #1 Ready -> Blocked (blocked by #2 (cycle: #1 -> #2 -> #1))\nmoved: #2 Ready -> Blocked (blocked by #1 (cycle: #1 -> #2 -> #1))\n${RATE_NOTE}`)
  })

  it('PR・Tracker・Epic のカードは、列と札を動かさない', async () => {
    const result = await sync([rateLimit(100), board(item('PVTI_10', 10, 'Blocked', { isPullRequest: true }), item('PVTI_11', 11, 'Blocked', { title: '[Tracker] 追跡' }), item('PVTI_12', 12, 'Blocked')), prerequisitesRule({ number: 12, issueType: 'Epic', subIssues: 2 }), rateLimit(130)])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(RATE_NOTE)
    expect(writes(result)).toEqual([])
    expect(requestLabels(result.requests).filter(label => label === 'GetIssuePrerequisites')).toHaveLength(1)
  })

  it('複数のリポがあるボードでは、設定の最初のリポ以外の Issue を owner/repo#N で表す', async () => {
    const repositories = [{ owner: 'acme', name: 'demo', develop_branch: 'main' }, { owner: 'acme', name: 'other', develop_branch: 'main' }]
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked'), item('PVTI_6', 6, 'Blocked', { repository: 'other' })), prerequisitesRule({ number: 4 }), prerequisitesRule({ number: 6, repo: 'other' }), write('PVTI_4', 'o3'), write('PVTI_6', 'o3'), rateLimit(130)], [], boardConfig(FULL_WORKFLOW, repositories))
    expectClean(result)
    expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\nmoved: acme/other#6 Blocked -> Ready (startable)\n${RATE_NOTE}`)
  })

  describe('設定の解決', () => {
    const second = `${PROJECTS_DIRECTORY}/${DEFAULT_HOST}_acme_other_acme.json`

    it('.active が無く、設定が 1 つなら、それを使う', async () => {
      const result = await runCommand({ argv: ['board', 'sync'], github: blockedToReadyRules(), config: false, files: { [CONFIG_FILE]: contentOf(boardConfig()) } })
      expectClean(result)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    })

    it('.active が無く、設定が 2 つ以上なら、--project を求めて終了コード 1 で止まる', async () => {
      const result = await runCommand({ argv: ['board', 'sync'], github: [], config: false, files: { [CONFIG_FILE]: contentOf(boardConfig()), [second]: contentOf(boardConfig()) } })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`error: no active project, and 2 project configs exist\n  choose one with --project <NAME>\n  available: ${DEFAULT_HOST}_acme_board_acme, ${DEFAULT_HOST}_acme_other_acme\n`)
      expect(result.requests).toEqual([])
    })

    it.for([`${DEFAULT_HOST}_acme_other_acme`, `${DEFAULT_HOST}_acme_other_acme.json`])('--project で設定名 %s を渡すと、アクティブな設定ではなく、その設定を使う', async (name) => {
      const other = boardConfig()
      const result = await runCommand({ argv: ['board', 'sync', '--project', name], github: blockedToReadyRules(), config: projectConfig(), files: { [second]: contentOf({ ...other, project: { ...asJson(other['project']), id: 'PVT_1' } }) } })
      expectClean(result)
      expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    })

    it.for(['nothing', '../x', ''])('--project の設定 %j が無いと、使える設定の名前を出して終了コード 1 で終わる', async (name) => {
      const result = await sync([], ['--project', name])
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(`error: project config not found: ${name}\n  available: ${DEFAULT_HOST}_acme_board_acme\n`)
      expect(result.requests).toEqual([])
    })

    it('設定がまったく無いと、アクティブなプロジェクトが無いと出して終了コード 1 で終わる', async () => {
      const result = await sync([], [], false)
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(NO_ACTIVE)
    })

    it('設定の JSON が読めないと、error の行を出して終了コード 1 で終わる', async () => {
      const result = await runCommand({ argv: ['board', 'sync'], github: [], config: false, files: { [CONFIG_FILE]: '{ broken' } })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^error: invalid config file: [^\n]+\n$/u)
      expect(result.stderr).toContain(CONFIG_FILE)
      expect(result.requests).toEqual([])
    })
  })

  it('更新の新しい 20 件を超える Archived の項目があると、超えた分だけをボードから削除し、deleted の行を標準エラーに出す', async () => {
    const result = await syncWithPoints([board(...archivedItems(22), olderBacklog()), deletion('PVTI_a01'), deletion('PVTI_a02')])
    expectClean(result)
    expect(result.code).toBe(0)
    const deleted = result.requests.filter(request => request.type === 'graphql' && request.operation === 'DeleteProjectItem').map(request => request.type === 'graphql' ? Reflect.get(asJson(request.variables), 'itemId') : undefined)
    expect(deleted.toSorted((first, second) => String(first).localeCompare(String(second)))).toEqual(['PVTI_a01', 'PVTI_a02'])
    expect(result.stderr).toBe(`deleted: 2 archived items\n${RATE_NOTE}`)
  })

  it('Archived の項目がちょうど 20 件なら、ボードから何も削除しない', async () => {
    const result = await syncWithPoints([board(...archivedItems(20), olderBacklog())])
    expectClean(result)
    expect(requestLabels(result.requests)).not.toContain('DeleteProjectItem')
    expect(result.stderr).not.toContain('archived')
  })

  it('--dry-run を付けると、Archived の項目を削除せず、削除する件数を dry-run の行で標準エラーに出す', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-29')
    const result = await syncWithPoints([board(...archivedItems(22), olderBacklog())], ['--dry-run'])
    expectClean(result)
    expect(result.code).toBe(0)
    expect(requestLabels(result.requests)).not.toContain('DeleteProjectItem')
    expect(result.stderr).toBe(`dry-run: would delete 2 archived items\n${RATE_NOTE}`)
  })

  it('Archived の項目を削除できなかったなら、warning の行を出して続け、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-BOARD-SYNC-31')
    const result = await syncWithPoints([board(...archivedItems(22), olderBacklog()), deletion('PVTI_a01', 500), deletion('PVTI_a02')])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`deleted: 1 archived items\nwarning: failed to delete 1 archived items\n${RATE_NOTE}error: could not delete 1 archived item from the board\n`)
  })

  describe('MCP の data', () => {
    it('Issue を動かすと、動かした Issue と削除した Archived の件数を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-01')
      const result = await tool('board_sync', {}, blockedToReadyRules())
      expect(result.structured).toEqual({ moves: [{ issue: '#4', from: 'Blocked', to: 'Ready', reason: 'startable' }], deletedArchived: 0 })
    })

    it('dry_run で呼ぶと、札を変える予定も moves に入れて dryRun を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-09')
      const rules = [rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), prerequisitesRule({ number: 3, label: 'Needs Attention', blockedBy: [done] }), rateLimit(100)]
      const result = await tool('board_sync', { dry_run: true }, rules)
      expect(result.structured).toEqual({
        moves: [
          { issue: '#1', from: 'Ready', to: 'Blocked', label: 'Needs Attention', reason: 'blocked by #5 (closed without merge: #5)' },
          { issue: '#3', label: 'Todo', reason: 'startable' },
        ],
        deletedArchived: 0,
        dryRun: true,
      })
    })

    it('20 件を超えた Archived を削除すると、その件数を deletedArchived に返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-28')
      const result = await tool('board_sync', {}, [rateLimit(100), board(...archivedItems(22), olderBacklog()), deletion('PVTI_a01'), deletion('PVTI_a02'), rateLimit(130)])
      expect(result.structured).toEqual({ moves: [], deletedArchived: 2 })
    })

    it('Archived の削除が一部で失敗すると、削除できた件数と warning を data に残して失敗を返す', async (context) => {
      await verifies(context, 'PW-COMMON-18')
      await verifies(context, 'PW-COMMON-19')
      await verifies(context, 'PW-BOARD-SYNC-30')
      await verifies(context, 'PW-BOARD-SYNC-31')
      const result = await tool('board_sync', {}, [rateLimit(100), board(...archivedItems(22), olderBacklog()), deletion('PVTI_a01', 500), deletion('PVTI_a02'), rateLimit(130)])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'partial-failure' } })
      expect(result.structured).toEqual({
        moves: [],
        deletedArchived: 1,
        kind: 'partial-failure',
        detail: 'could not delete 1 archived item from the board',
        warnings: ['failed to delete 1 archived items'],
      })
    })
  })

  describe('MCP の呼び出し', () => {
    const second = `${PROJECTS_DIRECTORY}/${DEFAULT_HOST}_acme_other_acme.json`

    it('Ready の Issue に済んでいない前提があると、Blocked へ動かし、moves に入れる', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-02')
      const result = await syncBoard(board(item('PVTI_1', 1, 'Ready', { blockedBy: 1 })), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), write('PVTI_1', 'ob'))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [{ issue: '#1', from: 'Ready', to: 'Blocked', reason: 'blocked by #9 (not in review: #9 (not started))' }], deletedArchived: 0 })
    })

    it('着手の跡の無い Active と In Review の Issue を、判定に合った列へ戻す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-03')
      const result = await syncBoard(board(item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review')), prerequisitesRule({ number: 2 }), prerequisitesRule({ number: 3 }), write('PVTI_2', 'o3'), write('PVTI_3', 'o3'))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [{ issue: '#2', from: 'Active', to: 'Ready', reason: 'startable' }, { issue: '#3', from: 'In Review', to: 'Ready', reason: 'startable' }], deletedArchived: 0 })
    })

    it('着手の跡のある Issue は、blocked でも列と札を変えず、warnings で知らせる', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-04')
      const result = await syncBoard(board(item('PVTI_2', 2, 'Active')), prerequisitesRule({ number: 2, branch: 'feat/2', blockedBy: [notStarted] }))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [], deletedArchived: 0, warnings: ['#2 is in Active but blocked by #9'] })
      expect(writes(result)).toEqual([])
    })

    it('前提が無くブランチのある Blocked の Issue は、Ready へ動かさない', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-05')
      const result = await syncBoard(board(item('PVTI_4', 4, 'Blocked', { blockedBy: 0 })), prerequisitesRule({ number: 4, branch: 'feat/4' }))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [], deletedArchived: 0 })
      expect(writes(result)).toEqual([])
    })

    it('Backlog と Pending の Issue は、前提を読まず、動かさない', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-06')
      const result = await syncBoard(board(item('PVTI_7', 7, 'Backlog'), item('PVTI_8', 8, 'Pending')))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [], deletedArchived: 0 })
      expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
    })

    it('前提がマージされずに閉じた Issue の札を Needs Attention にする', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-07')
      const result = await syncBoard(board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), write('PVTI_1', 'ob'), write('PVTI_1', 'st4'))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [{ issue: '#1', from: 'Ready', to: 'Blocked', label: 'Needs Attention', reason: 'blocked by #5 (closed without merge: #5)' }], deletedArchived: 0 })
    })

    it('前提がすべて済んだ Issue の Needs Attention を、Todo に戻す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-08')
      const result = await syncBoard(board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [done] }), write('PVTI_1', 'st1'))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [{ issue: '#1', label: 'Todo', reason: 'startable' }], deletedArchived: 0 })
    })

    it('書き込みに失敗した Issue を warnings に入れてほかの Issue を続け、kind が partial-failure の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-10')
      const result = await syncBoard(board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 4 }), failedWrite('ob'), write('PVTI_4', 'o3'))
      expectClean(result)
      expect(result.isError).toBe(true)
      expect({ ...result.structured, warnings: stableWarnings(result) }).toEqual({
        moves: [{ issue: '#4', from: 'Blocked', to: 'Ready', reason: 'startable' }],
        deletedArchived: 0,
        kind: 'partial-failure',
        detail: 'could not write 1 Issue to the board',
        warnings: [`could not move #1: ${SERVER_ERROR.replace('\n  ', '\n')}`],
      })
      expect(writes(result)).toHaveLength(2)
    })

    it('選択肢の ID が古くて 2 件の書き込みに失敗すると、project_activate の案内を 1 回だけ添える', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-10')
      const result = await syncBoard(board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, blockedBy: [notStarted] }), staleOptionUpdate(2))
      expectClean(result)
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({
        moves: [],
        deletedArchived: 0,
        kind: 'partial-failure',
        detail: 'could not write 2 Issues to the board',
        warnings: [
          `could not move #1: ${STALE_OPTION_TEXT}\nhint: if the board options were recreated, run project_activate with project: "${ACTIVE_PROJECT}" to read their IDs again`,
          `could not move #3: ${STALE_OPTION_TEXT}`,
        ],
      })
    })

    it('一覧で前提が 0 件の Ready の Issue だけ、前提を個別に読まない', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-11')
      const result = await syncBoard(board(item('PVTI_1', 1, 'Ready', { blockedBy: 0 }), item('PVTI_4', 4, 'Blocked', { blockedBy: 0 }), item('PVTI_2', 2, 'Active', { blockedBy: 0 })), prerequisitesRule({ number: 4 }), prerequisitesRule({ number: 2, branch: 'feat/2' }), write('PVTI_4', 'o3'))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [{ issue: '#4', from: 'Blocked', to: 'Ready', reason: 'startable' }], deletedArchived: 0 })
      expect(requestLabels(result.requests).filter(label => label === 'GetIssuePrerequisites')).toHaveLength(2)
    })

    it('動かす先の値がボードに無いと、動かさず、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-12')
      const withoutBlocked = Object.fromEntries(Object.entries(FULL_WORKFLOW).filter(([name]) => name !== 'blocked'))
      const result = await syncBoardWith(boardConfig(withoutBlocked), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, blockedBy: [notStarted] }))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [], deletedArchived: 0, warnings: ['the board has no option Blocked; add it with project_init'] })
      expect(writes(result)).toEqual([])
    })

    it.for([
      { name: 'Issue の依存関係に対応しない GHES', id: 'PW-BOARD-SYNC-13', rules: (): ResponseRule[] => [board(item('PVTI_1', 1, 'Ready')), { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }] },
      { name: '一覧の新しいクエリがスキーマの失敗になる', id: 'PW-BOARD-SYNC-22', rules: (): ResponseRule[] => [{ match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }, graphqlRule('ListProjectItemsLegacy', { node: { items: { nodes: [item('PVTI_1', 1, 'Ready')], pageInfo: { hasNextPage: false, endCursor: null } } } })] },
    ])('$name とき、warnings に 1 つ入れ、何も動かさずに成功を返す', async (row, context) => {
      await verifies(context, row.id)
      const result = await tool('board_sync', {}, [rateLimit(100), ...row.rules(), rateLimit(100)])
      expect(result.problems).toEqual([])
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({ moves: [], deletedArchived: 0, warnings: ['this GitHub Enterprise Server does not support issue dependencies (blockedBy); no column is moved'] })
      expect(writes(result)).toEqual([])
    })

    it('ボードの取得で GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-16')
      const result = await tool('board_sync', {}, [rateLimit(100), { match: { operation: 'ListProjectItems' }, respond: { status: 500, body: { message: 'Server Error' } }, times: 1 }, rateLimit(101)])
      expectClean(result)
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('github-api')
      expect(stable(String(result.structured['detail']))).toBe(`could not read project board: ${SERVER_ERROR}`)
    })

    it('判定を読めない Issue があると、理由を warnings に入れ、その Issue を動かさない', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-23')
      const result = await syncBoardWith(boardConfig(FULL_WORKFLOW, [{ owner: 'acme', name: 'demo' }]), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [], deletedArchived: 0, warnings: ['could not judge #1: develop_branch is not set for acme/demo'] })
      expect(writes(result)).toEqual([])
    })

    it('Ready の Issue の前提が輪になると、Blocked へ動かす', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-24')
      const result = await syncBoard(board(item('PVTI_1', 1, 'Ready'), item('PVTI_2', 2, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 2 }] }), prerequisitesRule({ number: 2, blockedBy: [{ number: 1 }] }), write('PVTI_1', 'ob'), write('PVTI_2', 'ob'))
      expectClean(result)
      expect(result.structured).toEqual({
        moves: [
          { issue: '#1', from: 'Ready', to: 'Blocked', reason: 'blocked by #2 (cycle: #1 -> #2 -> #1)' },
          { issue: '#2', from: 'Ready', to: 'Blocked', reason: 'blocked by #1 (cycle: #1 -> #2 -> #1)' },
        ],
        deletedArchived: 0,
      })
    })

    it('PR・Tracker・Epic のカードは、列と札を動かさない', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-25')
      const result = await syncBoard(board(item('PVTI_10', 10, 'Blocked', { isPullRequest: true }), item('PVTI_11', 11, 'Blocked', { title: '[Tracker] 追跡' }), item('PVTI_12', 12, 'Blocked')), prerequisitesRule({ number: 12, issueType: 'Epic', subIssues: 2 }))
      expectClean(result)
      expect(result.structured).toEqual({ moves: [], deletedArchived: 0 })
      expect(writes(result)).toEqual([])
    })

    it('設定の最初のリポ以外の Issue を動かすと、moves の issue を owner/repo#N で表す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-26')
      const repositories = [{ owner: 'acme', name: 'demo', develop_branch: 'main' }, { owner: 'acme', name: 'other', develop_branch: 'main' }]
      const result = await syncBoardWith(boardConfig(FULL_WORKFLOW, repositories), board(item('PVTI_4', 4, 'Blocked'), item('PVTI_6', 6, 'Blocked', { repository: 'other' })), prerequisitesRule({ number: 4 }), prerequisitesRule({ number: 6, repo: 'other' }), write('PVTI_4', 'o3'), write('PVTI_6', 'o3'))
      expectClean(result)
      expect(result.structured['moves']).toEqual([
        { issue: '#4', from: 'Blocked', to: 'Ready', reason: 'startable' },
        { issue: 'acme/other#6', from: 'Blocked', to: 'Ready', reason: 'startable' },
      ])
    })

    it('.active が無く、設定が 1 つなら、それを使う', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-17')
      const result = await syncTool({}, { github: blockedToReadyRules(), config: false, files: { [CONFIG_FILE]: contentOf(boardConfig()) } })
      expectClean(result)
      expect(result.structured).toEqual({ moves: [{ issue: '#4', from: 'Blocked', to: 'Ready', reason: 'startable' }], deletedArchived: 0 })
    })

    it('.active が無く、設定が 2 つ以上なら、project を求める detail を入れ、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-18')
      const result = await syncTool({}, { config: false, files: { [CONFIG_FILE]: contentOf(boardConfig()), [second]: contentOf(boardConfig()) } })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'no-active-project', detail: `no active project, and 2 project configs exist\n  choose one with project: <NAME>\n  available: ${DEFAULT_HOST}_acme_board_acme, ${DEFAULT_HOST}_acme_other_acme` })
      expect(result.requests).toEqual([])
    })

    it('project に設定名を渡すと、アクティブな設定ではなく、その設定を使う', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-19')
      const other = boardConfig()
      const result = await syncTool({ project: `${DEFAULT_HOST}_acme_other_acme` }, { github: blockedToReadyRules(), config: projectConfig(), files: { [second]: contentOf({ ...other, project: { ...asJson(other['project']), id: 'PVT_1' } }) } })
      expectClean(result)
      expect(result.structured).toEqual({ moves: [{ issue: '#4', from: 'Blocked', to: 'Ready', reason: 'startable' }], deletedArchived: 0 })
    })

    it('project の設定が無いと、使える設定の名前を detail に入れ、kind が project-not-found の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-20')
      const result = await syncTool({ project: 'nothing' }, {})
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'project-not-found', detail: `project config not found: nothing\n  available: ${DEFAULT_HOST}_acme_board_acme` })
      expect(result.requests).toEqual([])
    })

    it('設定がまったく無いと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-21')
      const result = await syncTool({}, { config: false })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'no-active-project', detail: 'no active project\n  run: project_activate with project: <PROJECT>' })
    })

    it('設定の JSON が読めないと、kind が config-invalid の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-27')
      const result = await syncTool({}, { config: false, files: { [CONFIG_FILE]: '{ broken' } })
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('config-invalid')
      expect(result.structured['detail']).toMatch(/^invalid config file: [^\n]+$/u)
      expect(result.requests).toEqual([])
    })

    it('dry_run を付けると、Archived の項目を削除せず、削除する予定の件数を deletedArchived に入れる', async (context) => {
      await verifies(context, 'PW-BOARD-SYNC-29')
      const rules = withPoints(board(...archivedItems(22), olderBacklog()))
      const result = await tool('board_sync', { dry_run: true }, rules)
      expectClean(result)
      expect(result.structured).toEqual({ moves: [], deletedArchived: 2, dryRun: true })
      expect(requestLabels(result.requests)).not.toContain('DeleteProjectItem')
    })
  })
})

describe('board add', () => {
  describe('MCP の data', () => {
    it('Issue を足すと、足した Issue・設定した Status を返す', async () => {
      const result = await tool('board_add', { issue_ref: 'acme/demo/7' }, [linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])
      expect(result.structured).toEqual({ issue: 'acme/demo/7', added: true, status: 'ready' })
    })

    it('dry_run で呼ぶと、足す予定の Issue・Status と dryRun を返す', async () => {
      const result = await tool('board_add', { issue_ref: 'acme/demo/7', status: 'active', dry_run: true }, [linkedRepositories(), issueNodeId()])
      expect(result.structured).toEqual({ issue: 'acme/demo/7', added: true, status: 'active', dryRun: true })
    })
  })
})

describe('board move', () => {
  describe('MCP の data', () => {
    it('Status を設定すると、その Issue と Status を返す', async () => {
      const result = await tool('board_move', { issue_ref: 'acme/demo/7', status: 'in_review' }, [linkedRepositories(), boardItems(), fieldUpdated('o5')])
      expect(result.structured).toEqual({ issue: 'acme/demo/7', status: 'in_review' })
    })

    it('dry_run で呼ぶと、設定する予定の Status と dryRun を返し、フィールドを書かない', async () => {
      const result = await tool('board_move', { issue_ref: 'acme/demo/7', status: 'in_review', dry_run: true }, [linkedRepositories(), boardItems()])
      expect(result.structured).toEqual({ issue: 'acme/demo/7', status: 'in_review', dryRun: true })
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
    })
  })
})

describe('board show', () => {
  describe('MCP の data', () => {
    const repositories = [{ owner: 'acme', name: 'demo', develop_branch: 'main', release_branch: 'release', packages: [{ name: 'pkg', changelog: 'packages/pkg/CHANGELOG.md' }] }]
    const expected = {
      project: { name: `${DEFAULT_HOST}_acme_board_acme`, host: DEFAULT_HOST, owner: 'acme', number: 1, aggregation_repo: null },
      repositories: [{
        full_name: 'acme/demo',
        owner: 'acme',
        name: 'demo',
        develop_branch: 'main',
        release_branch: 'release',
        dependabot_alerts: { enabled: true, open_count: 1, max_severity: 'high', alerts_url: `https://${DEFAULT_HOST}/acme/demo/security/dependabot` },
        release_type: 'multi',
        packages: [{ name: 'pkg', changelog: 'packages/pkg/CHANGELOG.md' }],
      }],
      board: { items: [
        { id: 'PVTI_1', workflow: 'Ready', title: '課題1', updatedAt: '2026-01-02T03:04:05Z', content: { number: 1, state: 'OPEN', url: `https://${DEFAULT_HOST}/acme/demo/issues/1`, labels: [], repository: 'acme/demo' }, readiness: { kind: 'blocked', stackOn: null, reason: 'not-in-review', text: 'blocked by #9 (not in review: #9 (not started))' } },
      ] },
      mismatches: 1,
      warnings: ['1 Ready or Blocked Issue may be in a column or Status that does not match its judgment; run board_sync (dry_run: true to preview) to fix'],
    }

    it('json を省くと、--json の中身に release_type・packages と列の合わない件数を足して返す', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-01')
      await verifies(context, 'PW-BOARD-SHOW-33')
      const result = await tool('board_show', {}, showRules(), boardConfig(FULL_WORKFLOW, repositories))
      expect(result.structured).toEqual(expected)
    })

    it('json を true にしても、同じ data を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-02')
      const result = await tool('board_show', { json: true }, showRules(), boardConfig(FULL_WORKFLOW, repositories))
      expect(result.structured).toEqual(expected)
    })
  })
})
