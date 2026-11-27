/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// board-sync の action を、inputs を置いてプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import { rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { main } from '../../src/board-sync.js'
import { useIsolatedEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { botResult, commentsFailure, commentsRule, humanResult, prerequisitesRule } from '../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { IssueSpec } from '../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { runActionCase, setUpProject, startGithub } from '../_helpers/action-case.js'
import type { ActionResult, ProjectFixture, RunningGithub } from '../_helpers/action-case.js'
import { graphqlRule, requestLabels, restRule, STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/github-rules.js'

useIsolatedEnvironment()

type Json = Record<string, unknown>
type Inputs = Readonly<Record<string, string | undefined>>

const HOST = 'github.com'
const FULL_WORKFLOW = { backlog: 'o1', blocked: 'ob', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' }
const STATUS = { id: 'PVTSSF_status', options: { todo: 'st1', in_progress: 'st2', done: 'st3', needs_attention: 'st4' } }
const PROJECTS_DIRECTORY = '.pecot/config/projects'
const CONFIG_NAME = `${HOST}_acme_board_acme`
const SECOND_NAME = `${HOST}_acme_other_acme`
const NO_ACTIVE = 'error: no active project\n  call project_activate with project: <PROJECT>\n'
const UNSUPPORTED = 'warning: this GitHub Enterprise Server does not support issue dependencies (blockedBy); no column is moved\n'
const notStarted = { number: 9 }

const DEFAULT_REPOSITORIES: readonly Json[] = [{ owner: 'acme', name: 'demo', develop_branch: 'main' }]

// Blocked と Status の値を持つ設定
function boardConfig(workflowOptions: Record<string, string> = FULL_WORKFLOW, repositories: readonly Json[] = DEFAULT_REPOSITORIES): Json {
  const fields = { workflow: { id: 'PVTSSF_workflow', options: workflowOptions }, status: STATUS }
  return { host: HOST, owner: 'acme', project: { number: 1, id: 'PVT_1', board_url: `https://${HOST}/users/acme/projects/1`, fields }, repositories }
}

const contentOf = (config: Json): string => `${JSON.stringify(config, undefined, 2)}\n`

interface ItemExtra {
  readonly blockedBy?: number
  readonly repository?: string
  readonly title?: string
  readonly isPullRequest?: boolean
  readonly updatedAt?: string
  readonly state?: string
  readonly field?: string
  /**
  進行の欄のほかに値を持つ単一選択のフィールドの名前
  */
  readonly others?: readonly string[]
}

// 一覧の応答に載る、着手の判定の軽い入力
function item(id: string, number: number, workflow: string, extra: ItemExtra = {}): Json {
  const { repository = 'demo' } = extra
  const progress = extra.blockedBy === undefined ? {} : { issueType: null, subIssues: { totalCount: 0 }, parent: null, blockedBy: { totalCount: extra.blockedBy } }
  return {
    id,
    updatedAt: extra.updatedAt ?? '2026-01-02T03:04:05Z',
    fieldValues: { nodes: [{ field: { id: 'PVTSSF_workflow', name: extra.field ?? 'pecot-status' }, name: workflow }, ...(extra.others ?? []).map(name => ({ field: { id: `F_${name}`, name }, name: 'High' }))] },
    content: { id: `I_${String(number)}`, number, title: extra.title ?? `課題${String(number)}`, state: extra.state ?? 'OPEN', url: `https://${HOST}/acme/${repository}/${extra.isPullRequest === true ? 'pull' : 'issues'}/${String(number)}`, labels: { nodes: [] }, repository: { owner: { login: 'acme' }, name: repository }, ...progress },
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
const stable = (stderr: string): string => stderr.replaceAll(/http:\/\/127\.0\.0\.1:\d+/gu, 'http://127.0.0.1:PORT')

interface SyncRun extends ActionResult {
  readonly github: RunningGithub
}

/**
設定を置き、偽サーバを始めて action を呼ぶ。config が false なら設定を置かない
*/
async function sync(rules: ResponseRule[], inputs: Inputs = {}, config: Json | false = boardConfig(), files: Readonly<Record<string, string>> = {}): Promise<SyncRun> {
  const project = setUpProject({ files: config === false ? files : { [`${PROJECTS_DIRECTORY}/${CONFIG_NAME}.json`]: contentOf(config), ...files } })
  if (config === false) removeDefaultConfig(project, files)
  const github = await startGithub(rules)
  return { ...await runActionCase(main, { token: 'dummy-token', ...inputs }), github }
}

// setUpProject が置いた設定を消す。files が同じパスに置いたときは残す
function removeDefaultConfig(project: Readonly<ProjectFixture>, files: Readonly<Record<string, string>>): void {
  const relative = `${PROJECTS_DIRECTORY}/${project.configFile}`
  if (!Object.hasOwn(files, relative)) rmSync(path.join(project.root, relative))
}

const writes = (run: Readonly<SyncRun>): string[] => requestLabels(run.github.requests()).filter(label => label === 'UpdateProjectItemField')

// Blocked の #4 を Ready へ動かす 1 回分の応答
const blockedToReadyRules = (): ResponseRule[] => [rateLimit(100), board(item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3'), rateLimit(130)]
const syncWithPoints = async (rules: ResponseRule[], inputs: Inputs = {}): Promise<SyncRun> => await sync([rateLimit(100), ...rules, rateLimit(130)], inputs)

describe('board sync', () => {
  it('Blocked の Issue の判定が startable なら、Ready へ動かす', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-01')
    await explains('`board-sync` の action のテストです。Blocked の Issue が着手できる状態（`startable`）の場合に、Ready へ移動し、`moved` の行と GraphQL の点数を出力することを確認します。')
    const result = await sync(blockedToReadyRules())
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
  })

  it('進行の欄が旧い名前のボードでも、同じ Issue を動かし、旧い名前の警告と project_init の案内を出す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-33')
    await explains('`board-sync` の action のテストです。進行の欄が旧い名前（`pecot-workflow-acme`）のボードでも同じ Issue を移動し、旧い名前の警告と `project_init` の案内を出力することを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked', { field: 'pecot-workflow-acme' })), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3'), rateLimit(130)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: this board uses the old field name pecot-workflow-acme\n  call project_init with owner: "acme", name: <name>, host: "github.com"\nmoved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
  })

  it('Item の値に pecot-priority・pecot-size が残るボードでは、同じ Issue を動かし、残った名前と project_init の案内を出す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-34')
    await explains('`board-sync` の action のテストです。Item の値に `pecot-priority` と `pecot-size` が残るボードでも Issue を移動し、残った名前と `project_init` の案内を出力することを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked', { others: ['pecot-priority'] }), item('PVTI_5', 5, 'Archived', { state: 'CLOSED', others: ['pecot-size', 'pecot-priority'] })), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3'), rateLimit(130)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: this board still has fields pecot does not use: pecot-priority, pecot-size\n  call project_init with owner: "acme", name: <name>, host: "github.com"\nmoved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
  })

  it('旧い名前の欄と pecot-priority・pecot-size が残るボードでは、1 つの warning で project_init を案内する', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-33')
    await verifies(context, 'PA-BOARD-SYNC-34')
    await explains('`board-sync` の action のテストです。旧い名前の欄と使わないフィールドの両方が残るボードの場合に、1 つの warning にまとめて `project_init` を案内することを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked', { field: 'pecot-workflow-acme', others: ['pecot-size', 'pecot-priority'] })), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3'), rateLimit(130)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: this board uses the old field name pecot-workflow-acme and still has fields pecot does not use: pecot-priority, pecot-size\n  call project_init with owner: "acme", name: <name>, host: "github.com"\nmoved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
  })

  it('Ready の Issue に済んでいない前提があると、Blocked へ動かす', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-02')
    await explains('`board-sync` の action のテストです。Ready の Issue に済んでいない前提がある場合に、Blocked へ移動し、その理由を `moved` の行に出力することを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready', { blockedBy: 1 })), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), write('PVTI_1', 'ob'), rateLimit(130)])
    expect(result.stderr).toBe(`moved: #1 Ready -> Blocked (blocked by #9 (not in review: #9 (not started)))\n${RATE_NOTE}`)
  })

  it('着手の跡の無い Active と In Review の Issue を、判定に合った列へ戻す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-03')
    await explains('`board-sync` の action のテストです。着手の跡（ブランチや PR）を持たない Active と In Review の Issue を、判定に合った Ready へ戻すことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review')), prerequisitesRule({ number: 2 }), prerequisitesRule({ number: 3 }), write('PVTI_2', 'o3'), write('PVTI_3', 'o3'), rateLimit(130)])
    expect(result.stderr).toBe(`moved: #2 Active -> Ready (startable)\nmoved: #3 In Review -> Ready (startable)\n${RATE_NOTE}`)
  })

  it('着手の跡のある Issue は、blocked でも列と札を変えず、warning を出す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-04')
    await explains('`board-sync` の action のテストです。着手の跡を持つ Issue の前提が済んでいない場合でも、列と Status を変えず、`warning` の行だけを出力することを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_2', 2, 'Active')), prerequisitesRule({ number: 2, branch: 'feat/2', blockedBy: [notStarted] }), rateLimit(130)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: #2 is in Active but blocked by #9\n${RATE_NOTE}`)
    expect(writes(result)).toEqual([])
  })

  it('前提が無くブランチのある Blocked の Issue は、Ready へ動かさない', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-05')
    await explains('`board-sync` の action のテストです。前提を持たず、ブランチを持つ Blocked の Issue は、Ready へ移動せず、書き込みも行わないことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked', { blockedBy: 0 })), prerequisitesRule({ number: 4, branch: 'feat/4' }), rateLimit(130)])
    expect(result.stderr).toBe(RATE_NOTE)
    expect(writes(result)).toEqual([])
  })

  it('Backlog と Pending の Issue は、前提を読まず、動かさない', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-06')
    await explains('`board-sync` の action のテストです。Backlog と Pending の Issue は、前提を読み込まず、移動もしないことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_7', 7, 'Backlog'), item('PVTI_8', 8, 'Pending')), rateLimit(130)])
    expect(result.stderr).toBe(RATE_NOTE)
    expect(requestLabels(result.github.requests())).not.toContain('GetIssuePrerequisites')
    expect(writes(result)).toEqual([])
  })

  it('前提がマージされずに閉じた Issue の札を Needs Attention にする', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-07')
    await explains('`board-sync` の action のテストです。前提がマージされないまま閉じた場合に、Issue を Blocked へ移動し、Status を `Needs Attention` に設定することを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), write('PVTI_1', 'ob'), write('PVTI_1', 'st4'), rateLimit(130)])
    expect(result.stderr).toBe(`moved: #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\nset: Status of #1 to Needs Attention\n${RATE_NOTE}`)
  })

  it('前提がすべて済んだ Issue の Needs Attention を、Todo に戻す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-08')
    await explains('`board-sync` の action のテストです。前提がすべて済んだ Issue の Status が `Needs Attention` の場合に、Status を `Todo` に戻すことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [done] }), commentsRule(1), write('PVTI_1', 'st1'), rateLimit(130)])
    expect(result.stderr).toBe(`set: Status of #1 to Todo\n${RATE_NOTE}`)
  })

  it.for(['question', 'failed', 'limit'])('bot が書いた最後の自動処理の結果が %s なら、前提が済んでも Needs Attention を Todo に戻さない', async (result, context) => {
    await verifies(context, 'PA-BOARD-SYNC-32')
    await explains(`\`board-sync\` の action のテストです。bot が書いた最後の自動処理の結果が \`${result}\` の場合に、前提が済んでいても \`Needs Attention\` を戻さないことを確認します。`)
    const comments = [botResult('pr-created'), { body: '答えを書きました' }, botResult(result)]
    const run = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [done] }), commentsRule(1, comments), rateLimit(130)])
    expect(run.code).toBe(0)
    expect(run.stderr).toBe(RATE_NOTE)
    expect(writes(run)).toEqual([])
  })

  it('人が書いた自動処理の結果の目印は見ず、前提がすべて済んだ Issue の Needs Attention を Todo に戻す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-08')
    await explains('`board-sync` の action のテストです。人が書いたコメントの目印を自動処理の結果と見なさず、前提がすべて済んだ Issue の Status を `Todo` に戻すことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [done] }), commentsRule(1, [humanResult('question')]), write('PVTI_1', 'st1'), rateLimit(130)])
    expect(result.stderr).toBe(`set: Status of #1 to Todo\n${RATE_NOTE}`)
  })

  it('bot が書いた最後の自動処理の結果が人の対応を待たないものなら、Needs Attention を Todo に戻す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-08')
    await explains('`board-sync` の action のテストです。bot が書いた最後の結果が `out-of-scope` のように人の対応を待たないものの場合に、Status を `Todo` に戻すことを確認します。')
    const comments = [botResult('question'), botResult('out-of-scope')]
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [done] }), commentsRule(1, comments), write('PVTI_1', 'st1'), rateLimit(130)])
    expect(result.stderr).toBe(`set: Status of #1 to Todo\n${RATE_NOTE}`)
  })

  it('札が Needs Attention の Issue のコメントを読めないと、判定を出せない warning を出し、札を戻さない', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-23')
    await explains('`board-sync` の action のテストです。Status が `Needs Attention` の Issue のコメントを取得できない場合に、warning を出力し、Status を戻さないことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [done] }), commentsFailure(1), rateLimit(130)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: could not judge #1: GitHub API error: 500\n${RATE_NOTE}`)
    expect(writes(result)).toEqual([])
  })

  it('dry-run を true にすると、同じ文を dry-run の行で出し、ボードに書かない', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-09')
    await explains('`board-sync` の action のテストです。input の `dry-run` が `true` の場合に、移動の予定を `dry-run` の行として出力し、ボードには書き込まないことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 1, label: 'Needs Attention', blockedBy: [{ number: 5, state: 'CLOSED' }] }), commentsRule(1), prerequisitesRule({ number: 4 }), rateLimit(100)], { 'dry-run': 'true' })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`dry-run: would move #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\ndry-run: would move #4 Blocked -> Ready (startable)\n${NO_POINTS_USED}`)
    expect(writes(result)).toEqual([])
  })

  it('dry-run で札を変える予定も、dry-run の行で出す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-09')
    await explains('`board-sync` の action のテストです。input の `dry-run` が `true` の場合に、Status を変える予定も `dry-run` の行として出力し、ボードには書き込まないことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), prerequisitesRule({ number: 3, label: 'Needs Attention', blockedBy: [done] }), commentsRule(3), rateLimit(100)], { 'dry-run': 'true' })
    expect(result.stderr).toBe(`dry-run: would move #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\ndry-run: would set Status of #1 to Needs Attention\ndry-run: would set Status of #3 to Todo\n${NO_POINTS_USED}`)
    expect(writes(result)).toEqual([])
  })

  it('dry-run に true・false 以外を渡すと、GitHub を読まず、入力の誤りとして終了コード 2 を返す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-35')
    await explains('`board-sync` の action のテストです。input の `dry-run` に `true` と `false` 以外の値を渡した場合に、GitHub を読まず、入力の誤りとして終了コード 2 を返すことを確認します。')
    const result = await sync([], { 'dry-run': 'yes' })
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid input: .*dry_run/su)
    expect(result.github.requests()).toEqual([])
  })

  it('書き込みに失敗した Issue は、warning を出し、ほかの Issue を続けてから、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-10')
    await explains('`board-sync` の action のテストです。1 件の Issue の書き込みが失敗した場合に、warning を出力して残りの Issue の処理を続け、最後に step を失敗にすることを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 4 }), failedWrite('ob'), write('PVTI_4', 'o3'), rateLimit(130)])
    expect(result.code).toBe(1)
    expect(stable(result.stderr)).toBe(`warning: could not move #1: ${SERVER_ERROR}\nmoved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}error: could not write 1 Issue to the board\n`)
    expect(writes(result)).toHaveLength(2)
  })

  it('列の書き込みが成功し札の書き込みだけ失敗すると、move の行の後に warning を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-10')
    await explains('`board-sync` の action のテストです。列の書き込みが成功し、Status の書き込みだけが失敗した場合に、`moved` の行の後に warning を出力し、step を失敗にすることを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 5, state: 'CLOSED' }] }), write('PVTI_1', 'ob'), failedWrite('st4'), rateLimit(130)])
    expect(result.code).toBe(1)
    expect(stable(result.stderr)).toBe(`moved: #1 Ready -> Blocked (blocked by #5 (closed without merge: #5))\nwarning: could not move #1: ${SERVER_ERROR}\n${RATE_NOTE}error: could not write 1 Issue to the board\n`)
    expect(writes(result)).toHaveLength(2)
  })

  it('選択肢の ID が古くて 2 件の書き込みに失敗すると、warning を 2 行と ID を読み直す案内を 1 回出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-10')
    await explains('`board-sync` の action のテストです。選択肢の ID が古く、2 件の書き込みが失敗した場合に、warning を 2 行と ID を読み直す案内を 1 回だけ出力することを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, blockedBy: [notStarted] }), staleOptionUpdate(2), rateLimit(130)])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe([
      `warning: could not move #1: ${STALE_OPTION_TEXT}`,
      `  hint: if the board options were recreated, call project_activate with project: "${CONFIG_NAME}" to read their IDs again`,
      `warning: could not move #3: ${STALE_OPTION_TEXT}`,
      `${RATE_NOTE}error: could not write 2 Issues to the board`,
      '',
    ].join('\n'))
    expect(writes(result)).toHaveLength(2)
  })

  it('一覧で前提が 0 件の Ready の Issue だけ、前提を個別に読まない', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-11')
    await explains('`board-sync` の action のテストです。一覧の応答で前提が 0 件と分かる Ready の Issue だけは、前提を個別に読み込まないことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready', { blockedBy: 0 }), item('PVTI_4', 4, 'Blocked', { blockedBy: 0 }), item('PVTI_2', 2, 'Active', { blockedBy: 0 })), prerequisitesRule({ number: 4 }), prerequisitesRule({ number: 2, branch: 'feat/2' }), write('PVTI_4', 'o3'), rateLimit(130)])
    expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    expect(requestLabels(result.github.requests()).filter(label => label === 'GetIssuePrerequisites')).toHaveLength(2)
  })

  it('動かす先の値がボードに無いと、動かさず、warning を 1 回出す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-12')
    await explains('`board-sync` の action のテストです。進行の欄に `Blocked` の選択肢が存在しない場合に、Issue を移動せず、warning を 1 回だけ出力することを確認します。')
    const withoutBlocked = Object.fromEntries(Object.entries(FULL_WORKFLOW).filter(([name]) => name !== 'blocked'))
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, blockedBy: [notStarted] }), rateLimit(130)], {}, boardConfig(withoutBlocked))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: the board has no option Blocked; add it with project_init\n${RATE_NOTE}`)
    expect(writes(result)).toEqual([])
  })

  it('Issue の依存関係に対応しない GHES では、warning を 1 回出し、終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-13')
    await explains('`board-sync` の action のテストです。Issue の依存関係（`blockedBy`）に対応しない GitHub Enterprise Server の場合に、warning を 1 回だけ出力し、何も移動せずに成功することを確認します。')
    const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), unsupported, rateLimit(100)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`${UNSUPPORTED}${NO_POINTS_USED}`)
    expect(writes(result)).toEqual([])
  })

  it('一覧の新しいクエリがスキーマの失敗になると、古いクエリで読み直し、前提を読まずに終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-22')
    await explains('`board-sync` の action のテストです。一覧の新しいクエリがスキーマのエラーで拒否された場合に、古いクエリで読み直し、前提は読み込まずに成功することを確認します。')
    const rejected: ResponseRule = { match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
    const legacy = graphqlRule('ListProjectItemsLegacy', { node: { items: { nodes: [item('PVTI_1', 1, 'Ready')], pageInfo: { hasNextPage: false, endCursor: null } } } })
    const result = await sync([rateLimit(100), rejected, legacy, rateLimit(100)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`${UNSUPPORTED}${NO_POINTS_USED}`)
    expect(requestLabels(result.github.requests())).not.toContain('GetIssuePrerequisites')
  })

  it('点数の使用量と残りを、実行の前後の差で、count の行で出す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-14')
    await explains('`board-sync` の action のテストです。GraphQL の点数について、実行の前後の差から使用量と残りを `count` の行として出力することを確認します。')
    const result = await sync([rateLimit(100), board(), rateLimit(130)])
    expect(result.stderr).toBe(RATE_NOTE)
  })

  it('点数の差が負なら、使用量の行を省く', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-14')
    await explains('`board-sync` の action のテストです。GraphQL の点数の差が負の値の場合に、使用量の行を省き、残りの行だけを出力することを確認します。')
    const result = await sync([rateLimit(4990), board(), rateLimit(10)])
    expect(result.stderr).toBe('count: GraphQL points remaining: 4990\n')
  })

  it('点数の窓が実行の途中で切り替わると、差が正でも使用量の行を省く', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-14')
    await explains('`board-sync` の action のテストです。GraphQL の点数の窓が実行の途中で切り替わった場合に、差が正の値でも使用量の行を省くことを確認します。')
    const result = await sync([rateLimit(100), board(), rateLimit(130, RESET + 3600)])
    expect(result.stderr).toBe('count: GraphQL points remaining: 4870\n')
  })

  it('点数を読めなくても、その行を省いて続ける', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-15')
    await explains('`board-sync` の action のテストです。GraphQL の点数の取得が失敗した場合に、点数の行を省いて処理を続けることを確認します。')
    const missing: ResponseRule = { match: { method: 'GET', path: '/rate_limit' }, respond: { status: 404, body: { message: 'Not Found' } }, times: 2 }
    const result = await sync([missing, board(item('PVTI_4', 4, 'Blocked')), prerequisitesRule({ number: 4 }), write('PVTI_4', 'o3')])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('moved: #4 Blocked -> Ready (startable)\n')
  })

  it('ボードの取得で GitHub API がエラーを返すと、点数の行を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-16')
    await explains('`board-sync` の action のテストです。ボードの取得で GitHub API が 500 を返した場合に、点数の行とエラーを出力し、step を失敗にすることを確認します。')
    const result = await sync([rateLimit(100), { match: { operation: 'ListProjectItems' }, respond: { status: 500, body: { message: 'Server Error' } }, times: 1 }, rateLimit(101)])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(stable(result.stderr)).toBe(`count: GraphQL points used: 1\ncount: GraphQL points remaining: 4899\nerror: could not read project board: ${SERVER_ERROR}\n`)
  })

  it('判定を読めない Issue があると、warning の行を出し、その Issue を動かさない', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-23')
    await explains('`board-sync` の action のテストです。リポジトリの設定に `develop_branch` が無く判定できない場合に、warning を出力し、その Issue を移動しないことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), rateLimit(130)], {}, boardConfig(FULL_WORKFLOW, [{ owner: 'acme', name: 'demo' }]))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: could not judge #1: develop_branch is not set for acme/demo\n${RATE_NOTE}`)
    expect(writes(result)).toEqual([])
  })

  it('Ready の Issue の前提が輪になると、Blocked へ動かす', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-24')
    await explains('`board-sync` の action のテストです。Ready の Issue 同士が互いを前提にしている場合に、どちらも Blocked へ移動し、循環する Issue の並びを理由に出力することを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_1', 1, 'Ready'), item('PVTI_2', 2, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [{ number: 2 }] }), prerequisitesRule({ number: 2, blockedBy: [{ number: 1 }] }), write('PVTI_1', 'ob'), write('PVTI_2', 'ob'), rateLimit(130)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`moved: #1 Ready -> Blocked (blocked by #2 (cycle: #1 -> #2 -> #1))\nmoved: #2 Ready -> Blocked (blocked by #1 (cycle: #1 -> #2 -> #1))\n${RATE_NOTE}`)
  })

  it('PR・Tracker・Epic のカードは、列と札を動かさない', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-25')
    await explains('`board-sync` の action のテストです。PR・Tracker・Epic のカードは、列と Status のどちらも動かさないことを確認します。')
    const result = await sync([rateLimit(100), board(item('PVTI_10', 10, 'Blocked', { isPullRequest: true }), item('PVTI_11', 11, 'Blocked', { title: '[Tracker] 追跡' }), item('PVTI_12', 12, 'Blocked')), prerequisitesRule({ number: 12, issueType: 'Epic', subIssues: 2 }), rateLimit(130)])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(RATE_NOTE)
    expect(writes(result)).toEqual([])
    expect(requestLabels(result.github.requests()).filter(label => label === 'GetIssuePrerequisites')).toHaveLength(1)
  })

  it('複数のリポがあるボードでは、設定の最初のリポ以外の Issue を owner/repo#N で表す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-26')
    await explains('`board-sync` の action のテストです。複数のリポジトリを登録したボードの場合に、設定の最初のリポジトリ以外の Issue を `owner/repo#N` の形で出力することを確認します。')
    const repositories = [{ owner: 'acme', name: 'demo', develop_branch: 'main' }, { owner: 'acme', name: 'other', develop_branch: 'main' }]
    const result = await sync([rateLimit(100), board(item('PVTI_4', 4, 'Blocked'), item('PVTI_6', 6, 'Blocked', { repository: 'other' })), prerequisitesRule({ number: 4 }), prerequisitesRule({ number: 6, repo: 'other' }), write('PVTI_4', 'o3'), write('PVTI_6', 'o3'), rateLimit(130)], {}, boardConfig(FULL_WORKFLOW, repositories))
    expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\nmoved: acme/other#6 Blocked -> Ready (startable)\n${RATE_NOTE}`)
  })

  describe('設定の解決', () => {
    const second = `${PROJECTS_DIRECTORY}/${SECOND_NAME}.json`

    it('設定が 1 つなら、それを使う', async (context) => {
      await verifies(context, 'PA-BOARD-SYNC-17')
      await explains('`board-sync` の action のテストです。プロジェクトの設定が 1 つだけの場合に、その設定を使って処理することを確認します。')
      const result = await sync(blockedToReadyRules())
      expect(result.code).toBe(0)
      expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    })

    it('設定が 2 つ以上で project が無いと、project を求めて終了コード 1 で止まる', async (context) => {
      await verifies(context, 'PA-BOARD-SYNC-18')
      await explains('`board-sync` の action のテストです。設定が 2 つ以上あり、input の `project` が無い場合に、GitHub を読まず、使える設定の名前を示して step を失敗にすることを確認します。')
      const result = await sync([], {}, boardConfig(), { [second]: contentOf(boardConfig()) })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`error: no active project, and 2 project configs exist\n  choose one with project: <NAME>\n  available: ${CONFIG_NAME}, ${SECOND_NAME}\n`)
      expect(result.github.requests()).toEqual([])
    })

    it.for([SECOND_NAME, `${SECOND_NAME}.json`])('project で設定名 %s を渡すと、設定が 2 つ以上あっても、その設定を使う', async (name, context) => {
      await verifies(context, 'PA-BOARD-SYNC-19')
      await explains('`board-sync` の action のテストです。input の `project` に設定名を渡した場合に、設定が 2 つ以上あっても、指定した設定を使うことを確認します。')
      const result = await sync(blockedToReadyRules(), { project: name }, boardConfig({ ...FULL_WORKFLOW, ready: 'o3_first' }), { [second]: contentOf(boardConfig()) })
      expect(result.stderr).toBe(`moved: #4 Blocked -> Ready (startable)\n${RATE_NOTE}`)
    })

    it.for(['nothing', '../x'])('project の設定 %j が無いと、使える設定の名前を出して終了コード 1 で終わる', async (name, context) => {
      await verifies(context, 'PA-BOARD-SYNC-20')
      await explains('`board-sync` の action のテストです。input の `project` に存在しない設定名を渡した場合に、使える設定の名前を出力し、step を失敗にすることを確認します。')
      const result = await sync([], { project: name })
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(`error: project config not found: ${name}\n  available: ${CONFIG_NAME}\n`)
      expect(result.github.requests()).toEqual([])
    })

    it('設定がまったく無いと、アクティブなプロジェクトが無いと出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PA-BOARD-SYNC-21')
      await explains('`board-sync` の action のテストです。設定がまったく存在しない場合に、アクティブなプロジェクトが存在しないことを示すエラーを出力し、step を失敗にすることを確認します。')
      const result = await sync([], {}, false)
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(NO_ACTIVE)
    })

    it('設定の JSON が読めないと、error の行を出して終了コード 1 で終わる', async (context) => {
      await verifies(context, 'PA-BOARD-SYNC-27')
      await explains('`board-sync` の action のテストです。設定の JSON を読み取れない場合に、GitHub へ要求せず、`invalid config file` で始まるエラーを出力して step を失敗にすることを確認します。')
      const file = `${PROJECTS_DIRECTORY}/${CONFIG_NAME}.json`
      const result = await sync([], {}, false, { [file]: '{ broken' })
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^error: invalid config file: [^\n]+\n$/u)
      expect(result.stderr).toContain(file)
      expect(result.github.requests()).toEqual([])
    })
  })

  it('更新の新しい 20 件を超える Archived の項目があると、超えた分だけをボードから削除し、deleted の行を出す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-28')
    await explains('`board-sync` の action のテストです。更新の新しい 20 件を超える Archived の項目がある場合に、超えた分だけを削除し、`deleted` の行を出力することを確認します。')
    const result = await syncWithPoints([board(...archivedItems(22), olderBacklog()), deletion('PVTI_a01'), deletion('PVTI_a02')])
    expect(result.code).toBe(0)
    const deleted: string[] = []
    for (const request of result.github.requests()) {
      if (request.type !== 'graphql' || request.operation !== 'DeleteProjectItem') continue
      const variables: object = request.variables ?? {}
      deleted.push(String(Reflect.get(variables, 'itemId')))
    }
    expect(deleted.toSorted((first, second) => first.localeCompare(second))).toEqual(['PVTI_a01', 'PVTI_a02'])
    expect(result.stderr).toBe(`deleted: 2 archived items\n${RATE_NOTE}`)
  })

  it('Archived の項目がちょうど 20 件なら、ボードから何も削除しない', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-28')
    await explains('`board-sync` の action のテストです。Archived の項目がちょうど 20 件の場合に、ボードから何も削除せず、`deleted` の行も出力しないことを確認します。')
    const result = await syncWithPoints([board(...archivedItems(20), olderBacklog())])
    expect(requestLabels(result.github.requests())).not.toContain('DeleteProjectItem')
    expect(result.stderr).not.toContain('archived')
  })

  it('dry-run を true にすると、Archived の項目を削除せず、削除する件数を dry-run の行で出す', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-29')
    await explains('`board-sync` の action のテストです。input の `dry-run` が `true` の場合に、Archived の項目を削除せず、削除する予定の件数を `dry-run` の行で出力することを確認します。')
    const result = await syncWithPoints([board(...archivedItems(22), olderBacklog())], { 'dry-run': 'true' })
    expect(result.code).toBe(0)
    expect(requestLabels(result.github.requests())).not.toContain('DeleteProjectItem')
    expect(result.stderr).toBe(`dry-run: would delete 2 archived items\n${RATE_NOTE}`)
  })

  it('Archived の項目を削除できなかったなら、warning の行を出して続け、error の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PA-BOARD-SYNC-30')
    await verifies(context, 'PA-BOARD-SYNC-31')
    await explains('`board-sync` の action のテストです。Archived の項目の削除が失敗した場合に、warning を出力して処理を続け、最後に `error` の行を出力して step を失敗にすることを確認します。')
    const result = await syncWithPoints([board(...archivedItems(22), olderBacklog()), deletion('PVTI_a01', 500), deletion('PVTI_a02')])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`deleted: 1 archived items\nwarning: failed to delete 1 archived items\n${RATE_NOTE}error: could not delete 1 archived item from the board\n`)
  })
})
