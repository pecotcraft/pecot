/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
/* eslint-disable unicorn/consistent-function-scoping -- 補助は、使う describe の近くに置く */
/* eslint-disable unicorn/no-unnecessary-parameters -- 補助の引数を、行ごとにそろえる */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// project の 9 個のツールのうち 6 個（PW-PROJECT-*）と、board_show（PW-BOARD-SHOW-*）の振る舞いを、ツールをプロセス内で呼んで確かめる。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { botResult, commentsRule, type IssueSpec, prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { CONFIG_FILE as LEGACY_CONFIG_FILE, DEFAULT_HOST, graphqlRule, projectConfig, requestLabels, restRule, runCommand, runTool } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const PROJECTS_DIRECTORY = '.pecot/config/projects'
const ACTIVE_FILE = `${PROJECTS_DIRECTORY}/.active`
const CONFIG_FILE = `${PROJECTS_DIRECTORY}/${DEFAULT_HOST}_acme_1.json`
const BOARD_URL = `https://${DEFAULT_HOST}/users/acme/projects/1`
const NO_ACTIVE = 'error: no active project\n  call project_activate with project: <PROJECT>\n'
const WORKFLOW_NAMES = ['Backlog', 'Pending', 'Ready', 'Active', 'In Review', 'Archived']
// 実際のボードの並び（Pending が先頭）
const BOARD_ORDER = ['Pending', 'Backlog', 'Ready', 'Active', 'In Review', 'Archived']
const WORKFLOW_NAMES_WITH_BLOCKED = ['Backlog', 'Blocked', 'Pending', 'Ready', 'Active', 'In Review', 'Archived']
const STATUS_NAMES = ['Todo', 'In Progress', 'Done']

type Json = Record<string, unknown>

// 偽サーバの応答

const failing = (operation: string, status = 500): ResponseRule => ({ match: { operation }, respond: { status, body: { message: 'Server Error' } }, times: 1 })
const projectNode = (number: number, title: string): Json => ({ number, title, url: `https://${DEFAULT_HOST}/users/acme/projects/${String(number)}`, id: `PVT_${String(number)}` })
const listProjects = (...nodes: Json[]): ResponseRule => graphqlRule('ListProjectsUser', { user: { projectsV2: { nodes } } })
const options = (names: readonly string[]): Json[] => names.map((name, index) => ({ id: `o${String(index + 1)}`, name, color: 'GRAY', description: `${name} の説明` }))

function standardFields(workflow: readonly string[] = WORKFLOW_NAMES): Json[] {
  return [
    { id: 'PVTF_title', name: 'Title' },
    { id: 'PVTSSF_workflow', name: 'pecot-status', databaseId: 456, options: options(workflow) },
    statusField(),
  ]
}

function statusField(names: readonly string[] = STATUS_NAMES): Json {
  return { id: 'PVTSSF_status', name: 'Status', options: options(names) }
}

const titleOnly: Json[] = [{ id: 'PVTF_title', name: 'Title' }, statusField()]
const titleWithoutStatus: Json[] = [{ id: 'PVTF_title', name: 'Title' }]

function projectFields(fields: Json[] = standardFields(), title = 'board'): ResponseRule {
  return graphqlRule('GetProjectFieldsUser', { user: { projectV2: { id: 'PVT_1', title, url: BOARD_URL, views: { nodes: [{ number: 1 }] }, fields: { nodes: fields } } } })
}

const missingProject = (): ResponseRule[] => [graphqlRule('GetProjectFieldsUser', { user: { projectV2: null } }), graphqlRule('GetProjectFieldsOrg', { organization: { projectV2: null } })]

function linked(...names: string[]): ResponseRule {
  return graphqlRule('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: names.map(name => ({ owner: { login: 'acme' }, name })) } } } })
}

// 同期（設定ファイルの書き直し）で受ける要求の順
const syncRules = (...linkedNames: string[]): ResponseRule[] => [listProjects(projectNode(1, 'board')), projectFields(), linked(...linkedNames)]

const createField = (name: string, id: string): ResponseRule => graphqlRule('CreateProjectField', { createProjectV2Field: { projectV2Field: { id, name, options: [] } } }, { name })
const updateField = (fieldId: string): ResponseRule => graphqlRule('UpdateProjectField', { updateProjectV2Field: { projectV2Field: { id: fieldId, name: 'x', options: [] } } }, { fieldId })
const createFields = (): ResponseRule[] => [createField('pecot-status', 'PVTSSF_w')]

function createRules(finalFields: Json[] = standardFields()): ResponseRule[] {
  return [
    graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }),
    listProjects(),
    graphqlRule('CreateProject', { createProjectV2: { projectV2: { id: 'PVT_1', number: 1, title: 'board', url: BOARD_URL } } }),
    listProjects(projectNode(1, 'board')),
    projectFields(titleOnly),
    ...createFields(),
    updateField('PVTSSF_status'),
    listProjects(projectNode(1, 'board')),
    projectFields(finalFields),
    linked(),
  ]
}

const projectIdRule = (): ResponseRule => graphqlRule('GetProjectIdUser', { user: { projectV2: { id: 'PVT_1' } } })
const linkRules = (): ResponseRule[] => [
  projectIdRule(),
  graphqlRule('GetRepositoryId', { repository: { id: 'R_2' } }),
  graphqlRule('LinkProjectRepository', { linkProjectV2ToRepository: { repository: { id: 'R_2', nameWithOwner: 'acme/other' } } }),
]

const unresolvedRepository = (): ResponseRule => ({ match: { operation: 'GetRepositoryId' }, respond: { status: 200, body: { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository with the name acme/other.' }] } }, times: 1 })

// 一覧の応答に載る、着手の判定の軽い入力
interface ListProgress {
  readonly blockedBy: number
  readonly issueType?: string
}

function progressFields(progress: ListProgress): Json {
  return {
    issueType: progress.issueType === undefined ? null : { name: progress.issueType },
    subIssues: { totalCount: 0 },
    parent: null,
    blockedBy: { totalCount: progress.blockedBy },
  }
}

function item(id: string, number: number, workflow: string, extra: { state?: string, updatedAt?: string, repo?: string, progress?: ListProgress, field?: string } = {}): Json {
  const { state = 'OPEN', updatedAt = '2026-01-02T03:04:05Z', repo: repository = 'demo' } = extra
  return {
    id,
    updatedAt,
    fieldValues: { nodes: [{ field: { id: 'PVTSSF_workflow', name: extra.field ?? 'pecot-status' }, name: workflow }] },
    content: { id: `I_${String(number)}`, number, title: `課題${String(number)}`, state, url: `https://${DEFAULT_HOST}/acme/${repository}/issues/${String(number)}`, labels: { nodes: [] }, repository: { owner: { login: 'acme' }, name: repository }, ...extra.progress !== undefined && progressFields(extra.progress) },
  }
}

const board = (...nodes: Json[]): ResponseRule => graphqlRule('ListProjectItems', { node: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } })
const alerts = (repository: string, body: unknown, status = 200): ResponseRule => restRule('GET', `/repos/acme/${repository}/dependabot/alerts`, status, body)
const twoAlerts = (repository = 'demo'): ResponseRule => alerts(repository, [{ security_vulnerability: { severity: 'high' } }, { security_vulnerability: { severity: 'low' } }])
// 動かす補助

const GHES: Partial<CommandRun> = { remote: { host: DEFAULT_HOST }, configFile: CONFIG_FILE }
const READINESS_HEADER = '| Ref | Title | Readiness |\n|-----|----------|-----------|'

async function run(name: string, input: Readonly<Record<string, unknown>>, github: readonly ResponseRule[] = [], extra: Partial<CommandRun> = {}): Promise<CommandResult> {
  return await runCommand({ tool: name, arguments: input, github, ...GHES, ...extra })
}

function expectClean(result: Readonly<Pick<CommandResult, 'problems' | 'unused'>>): void {
  expect(result.problems).toEqual([])
  expect(result.unused).toEqual([])
}

function asJson(value: unknown): Json {
  if (typeof value !== 'object' || value === null) throw new TypeError('not an object')
  return Object.fromEntries(Object.entries(value))
}

function jsonList(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new TypeError('not an array')
  return value.map(entry => asJson(entry))
}

function savedConfig(result: Readonly<Pick<CommandResult, 'read'>>, file = CONFIG_FILE): Json {
  const text = result.read(file)
  if (text === undefined) throw new Error(`no such file: ${file}`)
  return asJson(JSON.parse(text))
}

function workflowOptions(result: Readonly<CommandResult>): Json {
  const fields = asJson(asJson(savedConfig(result)['project'])['fields'])
  return asJson(asJson(fields['workflow'])['options'])
}

function savedStatus(result: Readonly<CommandResult>): unknown {
  const fields = asJson(asJson(savedConfig(result)['project'])['fields'])
  return fields['status']
}

function repositoryEntries(result: Readonly<CommandResult>): Json[] {
  const entries = savedConfig(result)['repositories']
  return Array.isArray(entries) ? entries.map(entry => asJson(entry)) : []
}

function repositoriesOf(result: Readonly<Pick<CommandResult, 'read'>>, file = CONFIG_FILE): unknown {
  return savedConfig(result, file)['repositories']
}

const configPathOf = (result: Readonly<CommandResult>): string => path.join(result.directory, CONFIG_FILE)

function graphqlVariables(result: Readonly<Pick<CommandResult, 'requests'>>, operation: string): unknown[] {
  return result.requests.filter((request): request is Extract<RecordedRequest, { type: 'graphql' }> => request.type === 'graphql' && request.operation === operation).map(request => request.variables)
}

function variableValues(result: Readonly<Pick<CommandResult, 'requests'>>, operation: string, key: string): unknown[] {
  return graphqlVariables(result, operation).map(variables => Reflect.get(asJson(variables), key))
}

const sorted = (labels: readonly string[]): string[] => labels.toSorted((first, second) => first.localeCompare(second))

// MCP の data の共通の用意
const CONFIG_NAME = path.parse(CONFIG_FILE).name
const OTHER_NAME = `${DEFAULT_HOST}_acme_other_acme`
const otherFile = { [`${PROJECTS_DIRECTORY}/${OTHER_NAME}.json`]: `${JSON.stringify(projectConfig(), undefined, 2)}\n` }
const tool = async (name: string, toolArguments: Record<string, unknown>, github: readonly ResponseRule[] = [], extra: Partial<CommandRun> = {}): ReturnType<typeof runTool> =>
  await runTool({ tool: name, arguments: toolArguments, github, ...GHES, ...extra })
const owned = { owner: 'acme', host: DEFAULT_HOST }
const initArguments = { ...owned, name: 'board' }
const initRules = (fields: Json[]): ResponseRule[] => [listProjects(projectNode(1, 'board')), projectFields(fields)]
const workflowWithBlocked: Json = { id: 'PVTSSF_old', name: 'pecot-status', options: options(WORKFLOW_NAMES_WITH_BLOCKED) }
const withAggregation = (value?: string): Partial<CommandRun> => ({ config: projectConfig(value === undefined ? {} : { extra: { aggregation_repo: value } }) })
// 移行の前の形（進行の欄の旧い名前と、旧い名前の設定ファイル）
const LEGACY_FIELD = 'pecot-workflow-acme'
const LEGACY_NAME = path.parse(LEGACY_CONFIG_FILE).name
const legacyConfig: Partial<CommandRun> = { config: projectConfig({ extra: { workflow_suffix: 'acme' } }), configFile: LEGACY_CONFIG_FILE }
const renameRule = (fieldId = 'PVTSSF_old'): ResponseRule => graphqlRule('RenameProjectField', { updateProjectV2Field: { projectV2Field: { id: fieldId, name: 'pecot-status' } } }, { fieldId, name: 'pecot-status' })
// 廃止した fields.priority・fields.size を足した、旧い形の設定
function withOldFields(saved: Json): Json {
  const project = asJson(saved['project'])
  const oldFields = { priority: { id: 'PVTSSF_priority', options: { high: 'p1', medium: 'p2', low: 'p3' } }, size: { id: 'PVTSSF_size', options: { xs: 's1', s: 's2', m: 's3', l: 's4' } } }
  return { ...saved, project: { ...project, fields: { ...asJson(project['fields']), ...oldFields } } }
}
const movedNote = (name: string): string => `warning: the project config is now named ${name}\n  use this name for the project input and the PECOT_REVIEW_PROJECT variable\n`
// lanes を渡さず、pecot-lane も無いボードの行と案内
const NO_LANES = 'skipped: field pecot-lane (no lanes given)\nwarning: field pecot-lane was not created because no lanes were given\n  choose the lanes (the areas of work, such as plugins, teams or services) and pass them with lanes\n'
const NO_LANES_WARNING = 'field pecot-lane was not created because no lanes were given\n  choose the lanes (the areas of work, such as plugins, teams or services) and pass them with lanes'
const NO_LANES_ROW = { name: 'pecot-lane', change: 'skip', addedOptions: [] }
// pecot-lane と Lanes のビューの用意。ビューの先は個人のボード（databaseId 9）
const VIEW_URL = `${BOARD_URL}/views/2`
const USER_VIEWS_PATH = '/users/9/projectsV2/1/views'
const laneField = (names: readonly string[]): Json => ({ id: 'PVTSSF_lane', name: 'pecot-lane', options: options(names) })
const lanesBody = { name: 'Lanes', layout: 'board', vertical_group_by: [456], group_by: [789] }

function viewTarget(views: Json[] = [], typename = 'User'): ResponseRule {
  const project = { url: BOARD_URL, views: { nodes: [{ number: 1, name: 'View 1' }, ...views] }, fields: { nodes: [{ databaseId: 456, name: 'pecot-status' }, { databaseId: 789, name: 'pecot-lane' }, {}] } }
  return graphqlRule('GetProjectViewTarget', { repositoryOwner: { __typename: typename, ...typename === 'User' && { databaseId: 9 }, projectV2: project } })
}

const CREATED_VIEW = { id: 2, number: 2, name: 'Lanes', html_url: VIEW_URL }
const createView = (status = 201, body: unknown = CREATED_VIEW, viewPath = USER_VIEWS_PATH): ResponseRule => restRule('POST', viewPath, status, body)

function restBodies(result: Readonly<Pick<CommandResult, 'requests'>>, requestPath: string): unknown[] {
  return result.requests.filter((request): request is Extract<RecordedRequest, { type: 'rest' }> => request.type === 'rest' && request.path === requestPath).map(request => request.body)
}

const MANUAL_STEPS = [`open the project: ${BOARD_URL}`, 'add a view named Lanes with the Board layout', 'set Column by to pecot-status', 'set Group by to pecot-lane']

describe('project_list', () => {
  const other = { [`${PROJECTS_DIRECTORY}/${DEFAULT_HOST}_acme_other_acme.json`]: `${JSON.stringify(projectConfig(), undefined, 2)}\n` }

  it('設定ファイルがあると、ファイル名の順に 1 行ずつ出す', async () => {
    await explains('`project_list` の出力のテストです。設定ファイルが存在する場合は、ファイル名の順に 1 行ずつ標準出力へ出力することを確認します。')
    const result = await run('project_list', {}, [], { files: other })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`=== Projects ===\n  ${DEFAULT_HOST}_acme_1 [ACTIVE]\n  ${DEFAULT_HOST}_acme_other_acme\n`)
    expect(result.stderr).toBe('')
  })

  it('アクティブなプロジェクトの設定ファイルの行の末尾に、[ACTIVE] を付ける', async () => {
    await explains('`project_list` のアクティブなプロジェクトの表示のテストです。アクティブなプロジェクトの設定ファイルの行の末尾にだけ、`[ACTIVE]` を付けることを確認します。')
    const result = await run('project_list', {}, [], { files: other })
    const lines = result.stdout.split('\n')
    expect(lines.filter(line => line.endsWith('[ACTIVE]'))).toEqual([`  ${DEFAULT_HOST}_acme_1 [ACTIVE]`])
  })

  it('設定ファイルが 1 つも存在しないと、none の行を出す', async () => {
    await explains('`project_list` の設定ファイルが存在しない場合のテストです。設定ファイルが 1 つも存在しない場合は、`none` の行を出力して終了コード 0 で終わることを確認します。')
    const result = await run('project_list', {}, [], { config: false })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('=== Projects ===\n  none\n')
  })

  describe('MCP の data', () => {
    it('設定ファイルがあると、ファイル名の順で projects に並べ、アクティブな設定の active を true にする', async (context) => {
      await verifies(context, 'PW-PROJECT-LIST-01')
      await verifies(context, 'PW-PROJECT-LIST-02')
      await explains('`project_list` の MCP の結果のテストです。設定ファイルが存在する場合は、ファイル名の順に `projects` へ並べ、アクティブな設定の `active` を `true` にすることを確認します。')
      const result = await tool('project_list', {}, [], { files: otherFile })
      expect(result.structured).toEqual({ projects: [{ name: CONFIG_NAME, active: true }, { name: OTHER_NAME, active: false }] })
    })

    it('設定が 1 つも存在しないと projects を空の配列で返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LIST-03')
      await explains('`project_list` の MCP の結果のテストです。設定ファイルが 1 つも存在しない場合は、`projects` を空の配列で返すことを確認します。')
      const result = await tool('project_list', {}, [], { config: false })
      expect(result.structured).toEqual({ projects: [] })
    })
  })
})

describe('project_search', () => {
  const searchArguments = { owner: 'acme', host: DEFAULT_HOST }
  // 一覧の後に、各プロジェクトのフィールドを番号の順に 1 回ずつ読む
  const fieldsOf = (number: number, fields: Json[] = standardFields()): ResponseRule =>
    graphqlRule('GetProjectFieldsUser', { user: { projectV2: { id: `PVT_${String(number)}`, title: 'board', url: BOARD_URL, views: { nodes: [] }, fields: { nodes: fields } } } }, { projectNumber: number })
  const search = async (nodes: Json[], fields: ResponseRule[] = nodes.map((_, index) => fieldsOf(index + 1, titleOnly))): Promise<CommandResult> =>
    await run('project_search', searchArguments, [listProjects(...nodes), ...fields], { config: false })
  const URL1 = `https://${DEFAULT_HOST}/users/acme/projects/1`
  const URL2 = `https://${DEFAULT_HOST}/users/acme/projects/2`
  const rowsOf = (result: Readonly<CommandResult>): string[] => result.stdout.split('\n').slice(4, -1)

  it('プロジェクトを持つ所有者を渡すと、番号・タイトル・URL の表を出す', async () => {
    await explains('`project_search` の出力のテストです。プロジェクトを持つ所有者を指定した場合は、番号・タイトル・URL の表を標準出力へ出力することを確認します。')
    const result = await search([projectNode(1, 'board')])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toBe(`=== Projects of acme (${DEFAULT_HOST}) ===\n\n#    Title                                    URL\n${'-'.repeat(80)}\n1    board${' '.repeat(35)} ${URL1}\n`)
  })

  it('番号・タイトル・URL を持たないプロジェクトは、タイトルを (untitled) にして出し、フィールドを読まない', async () => {
    await explains('`project_search` の表示のテストです。番号・タイトル・URL を持たないプロジェクトを含む場合に、番号を `?`、タイトルを `(untitled)` にして出力し、そのプロジェクトのフィールドを読まないことを確認します。')
    const result = await search([{ id: 'PVT_9' }], [])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(rowsOf(result)).toEqual([`?    (untitled)${' '.repeat(30)} `])
  })

  it('タイトルが 38 文字を超えると、35 文字に切り詰めて末尾に ... を付ける', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-02')
    await explains('`project_search` のタイトルの省略のテストです。タイトルが 38 文字を超える場合は、35 文字に切り詰めて末尾に `...` を付けることを確認します。')
    const result = await search([projectNode(1, 'x'.repeat(38)), projectNode(2, 'y'.repeat(39))])
    const rows = result.stdout.split('\n').slice(4, 6)
    expect(rows[0]).toContain(` ${'x'.repeat(38)}  `)
    expect(rows[1]).toContain(` ${'y'.repeat(35)}...  `)
  })

  it('プロジェクトが 1 件も存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_search` の検索結果が空の場合のテストです。プロジェクトが 1 件も存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await search([])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: no projects found for acme\n')
  })

  it('GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-04')
    await explains('`project_search` の GitHub API のエラーのテストです。API がエラーを返した場合は、一覧を取得できなかった旨のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('project_search', searchArguments, [failing('ListProjectsUser'), failing('ListProjectsOrg')], { config: false })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not list projects: GraphQL query error: Server error '500 Internal Server Error'/u)
  })

  it('pecot-workflow のフィールドを持つプロジェクトを一覧すると、その行に [INITIALIZED] を付ける', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-05')
    await explains('`project_search` の初期化済みの表示のテストです。pecot-workflow のフィールドを持つプロジェクトの行にだけ、`[INITIALIZED]` を付けることを確認します。')
    const result = await search([projectNode(1, 'board'), projectNode(2, 'plain')], [fieldsOf(1), fieldsOf(2, titleOnly)])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(rowsOf(result)).toEqual([`1    board${' '.repeat(35)} ${URL1} [INITIALIZED]`, `2    plain${' '.repeat(35)} ${URL2}`])
  })

  it('進行の欄が旧い名前のプロジェクトも、その行に [INITIALIZED] を付ける', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-08')
    await explains('`project_search` の初期化済みの表示のテストです。進行の欄が旧い名前のプロジェクトでも、その行に `[INITIALIZED]` を付けることを確認します。')
    const legacy = standardFields().map(field => field['name'] === 'pecot-status' ? { ...field, name: LEGACY_FIELD } : field)
    const result = await search([projectNode(1, 'board')], [fieldsOf(1, legacy)])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(rowsOf(result)).toEqual([`1    board${' '.repeat(35)} ${URL1} [INITIALIZED]`])
  })

  it('アクティブなプロジェクトを一覧すると、その行に [ACTIVE] を付ける', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-06')
    await explains('`project_search` のアクティブなプロジェクトの表示のテストです。アクティブなプロジェクトの行に `[ACTIVE]` を付けることを確認します。')
    const result = await run('project_search', searchArguments, [listProjects(projectNode(1, 'board'), projectNode(2, 'plain')), fieldsOf(1), fieldsOf(2, titleOnly)])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(rowsOf(result)).toEqual([`1    board${' '.repeat(35)} ${URL1} [INITIALIZED] [ACTIVE]`, `2    plain${' '.repeat(35)} ${URL2}`])
  })

  it('プロジェクトのフィールドを読めないと、warning の行を出し、その行に [INITIALIZED] を付けずに続ける', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-07')
    await explains('`project_search` のフィールドを取得できない場合のテストです。あるプロジェクトのフィールドを取得できなかった場合は、`warning` の行を出力し、その行に `[INITIALIZED]` を付けずに処理を続けることを確認します。')
    const result = await search([projectNode(1, 'board'), projectNode(2, 'other')], [failing('GetProjectFieldsUser'), failing('GetProjectFieldsOrg'), fieldsOf(2)])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^warning: could not read the fields of project #1: GraphQL query error: Server error '500 Internal Server Error'/u)
    expect(rowsOf(result)).toEqual([`1    board${' '.repeat(35)} ${URL1}`, `2    other${' '.repeat(35)} ${URL2} [INITIALIZED]`])
  })

  describe('MCP の data', () => {
    it('番号・タイトル・URL と、初期化済みか・アクティブかを projects に返し、検索した owner と host も返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SEARCH-01')
      await explains('`project_search` の MCP の結果のテストです。番号・タイトル・URL・初期化の状態・アクティブの状態を `projects` に含め、検索した `owner` と `host` を返すことを確認します。')
      const result = await tool('project_search', owned, [listProjects(projectNode(1, 'board'), projectNode(2, 'other')), fieldsOf(1), fieldsOf(2, titleOnly)])
      expect(result.structured).toEqual({
        ...owned,
        projects: [{ number: 1, title: 'board', url: BOARD_URL, initialized: true, active: true }, { number: 2, title: 'other', url: URL2, initialized: false, active: false }],
      })
    })

    it('タイトルが 38 文字を超えても、projects の title は切り詰めない', async (context) => {
      await verifies(context, 'PW-PROJECT-SEARCH-02')
      await explains('`project_search` の MCP の結果のテストです。タイトルが 38 文字を超える場合でも、`projects` の `title` は切り詰めないことを確認します。')
      const longTitle = 'y'.repeat(39)
      const result = await tool('project_search', owned, [listProjects(projectNode(1, longTitle)), fieldsOf(1)], { config: false })
      expect(result.structured['projects']).toEqual([{ number: 1, title: longTitle, url: BOARD_URL, initialized: true, active: false }])
    })

    it('プロジェクトが 1 件も存在しないと、kind が project-not-found の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SEARCH-03')
      await explains('`project_search` の MCP の失敗のテストです。プロジェクトが 1 件も存在しない場合は、`kind` が `project-not-found` の失敗を返すことを確認します。')
      const result = await tool('project_search', owned, [listProjects()], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'project-not-found', detail: 'no projects found for acme' } })
    })

    it('GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SEARCH-04')
      await explains('`project_search` の MCP の失敗のテストです。GitHub API がエラーを返した場合は、一覧を取得できなかった旨を `detail` に含む失敗を返すことを確認します。')
      const result = await tool('project_search', owned, [failing('ListProjectsUser'), failing('ListProjectsOrg')], { config: false })
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not list projects: /u)
    })
  })
})

describe('project_init', () => {
  const init = async (rules: ResponseRule[], title = 'board', config: Json | false = false): Promise<CommandResult> => await run('project_init', { owner: 'acme', name: title, host: DEFAULT_HOST }, rules, { config })
  const base = (fields: Json[]): ResponseRule[] => [listProjects(projectNode(1, 'board')), projectFields(fields)]
  const workflowField = (names: readonly string[], name = 'pecot-status'): Json => ({ id: 'PVTSSF_old', name, options: options(names) })
  const unusedFields = (): Json[] => [{ id: 'PVTSSF_priority', name: 'pecot-priority', options: options(['High', 'Medium', 'Low']) }, { id: 'PVTSSF_size', name: 'pecot-size', options: options(['XS', 'S', 'M', 'L']) }]
  const withUnused = (): Json[] => [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...unusedFields()]
  const deleteField = (fieldId: string, name: string): ResponseRule => graphqlRule('DeleteProjectField', { deleteProjectV2Field: { projectV2Field: { id: fieldId, name } } }, { fieldId })
  const deleteRules = (): ResponseRule[] => [deleteField('PVTSSF_priority', 'pecot-priority'), deleteField('PVTSSF_size', 'pecot-size')]
  const confirmed = (): Readonly<Record<string, unknown>> => ({ owner: 'acme', name: 'board', host: DEFAULT_HOST, confirm_delete: true })
  const pendingText = (names: string, again: string): string => `these fields are not used by pecot and are left on the board: ${names}\n  deleting them also deletes their values on every item, and the values cannot be restored\n  show these names to the user and get their approval; only then, ${again}`
  const pendingWarning = (names: string): string => `warning: ${pendingText(names, `call project_init with owner: "acme", name: "board", host: "${DEFAULT_HOST}", confirm_delete: true again`)}\n`
  const skippedFields = `skipped: field pecot-status (already exists)\n${NO_LANES}`
  const syncedLines = (result: Readonly<CommandResult>): string => `created: config file ${configPathOf(result)}\nset: active project to ${path.parse(CONFIG_FILE).name}\n`

  it('フィールドが存在しないプロジェクトに打つと、pecot-status のフィールドを作り、pecot-priority・pecot-size を作らない', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-01')
    await verifies(context, 'PW-PROJECT-INIT-25')
    await explains('`project_init` のフィールドの作成のテストです。フィールドが存在しないプロジェクトの場合は、`pecot-status` のフィールドを作成し、`pecot-priority` と `pecot-size` は作成しないことを確認します。')
    const result = await init([...base(titleOnly), ...createFields(), updateField('PVTSSF_status'), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(variableValues(result, 'CreateProjectField', 'name')).toEqual(['pecot-status'])
  })

  it('フィールドを作ると、created の行を標準エラーに出す', async () => {
    await explains('`project_init` の標準エラーの出力のテストです。フィールドを作成した場合は、`created` の行を標準エラーへ出力することを確認します。')
    const result = await init([...base(titleWithoutStatus), ...createFields(), ...syncRules()])
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`created: field pecot-status (ID: PVTSSF_w)\n${NO_LANES}skipped: field Status (not found)\n${syncedLines(result)}`)
  })

  it('既にあるフィールドは作らずに、skipped の行を標準エラーに出す', async () => {
    await explains('`project_init` の既存のフィールドのテストです。既に存在するフィールドは作成せず、`skipped` の行を標準エラーへ出力することを確認します。')
    const existing = [...titleOnly, workflowField([...WORKFLOW_NAMES_WITH_BLOCKED])]
    const result = await init([...base(existing), updateField('PVTSSF_status'), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`skipped: field pecot-status (already exists)\n${NO_LANES}unchanged: option Blocked in field pecot-status\nadded: option Needs Attention to field Status\n${syncedLines(result)}`)
  })

  it('指定したタイトルのプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_init` のプロジェクトの検索のテストです。指定したタイトルのプロジェクトが存在しない場合は、候補を含むエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await init([listProjects(projectNode(2, 'Other Project'))], 'Nonexistent')
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: project not found: Nonexistent\n  available projects:\n  - Other Project\n')
  })

  it('フィールドの作成で GitHub API がエラーを返すと、終了コード 1 で終わる', async () => {
    await explains('`project_init` の GitHub API のエラーのテストです。フィールドの作成で GitHub API がエラーを返した場合は、終了コード 1 で終わることを確認します。')
    const result = await init([...base(titleOnly), failing('CreateProjectField')])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not initialize project fields: /u)
  })

  it('既にあるフィールドに Blocked と Needs Attention が存在しないと、足して added の行を標準エラーに出す', async () => {
    await explains('`project_init` の選択肢の追加のテストです。既存のフィールドに `Blocked` と `Needs Attention` が存在しない場合は、選択肢を追加し、`added` の行を標準エラーへ出力することを確認します。')
    const existing = [...titleOnly, workflowField(BOARD_ORDER)]
    const result = await init([...base(existing), updateField('PVTSSF_old'), updateField('PVTSSF_status'), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`${skippedFields}added: option Blocked to field pecot-status\nadded: option Needs Attention to field Status\n${syncedLines(result)}`)
  })

  it('選択肢を足すとき、既存の選択肢は id・name・color・description のまま送り、Blocked は Backlog の直後、Needs Attention は末尾に置く', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-07')
    await explains('`project_init` の選択肢の追加のテストです。選択肢を追加する場合は、既存の選択肢を元の値のまま送信し、`Blocked` を `Backlog` の直後、`Needs Attention` を末尾に配置することを確認します。')
    const existing = [...titleOnly, workflowField(BOARD_ORDER)]
    const result = await init([...base(existing), updateField('PVTSSF_old'), updateField('PVTSSF_status'), ...syncRules()])
    const kept = (names: readonly string[]): Json[] => options(names)
    const blocked = { name: 'Blocked', color: 'GRAY', description: 'Tasks waiting for prerequisite Issues. pecot moves them to Ready once they can start.' }
    const attention = { name: 'Needs Attention', color: 'RED', description: 'Waiting for a human decision or action.' }
    expect(graphqlVariables(result, 'UpdateProjectField')).toEqual([
      { fieldId: 'PVTSSF_old', options: [...kept(BOARD_ORDER).slice(0, 2), blocked, ...kept(BOARD_ORDER).slice(2)] },
      { fieldId: 'PVTSSF_status', options: [...kept(STATUS_NAMES), attention] },
    ])
  })

  it('値を足すと、設定ファイルを同期して Blocked・In Progress・Needs Attention の id を書く', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-08')
    await verifies(context, 'PW-PROJECT-INIT-18')
    await explains('`project_init` の設定ファイルの同期のテストです。選択肢を追加した場合は、設定ファイルを同期し、`Blocked`・`In Progress`・`Needs Attention` の id を書き込むことを確認します。')
    const existing = [...titleOnly, workflowField(BOARD_ORDER)]
    const synced = [
      { id: 'PVTF_title', name: 'Title' },
      { id: 'PVTSSF_workflow', name: 'pecot-status', databaseId: 456, options: options(WORKFLOW_NAMES_WITH_BLOCKED) },
      statusField([...STATUS_NAMES, 'Needs Attention']),
    ]
    const result = await init([...base(existing), updateField('PVTSSF_old'), updateField('PVTSSF_status'), listProjects(projectNode(1, 'board')), projectFields(synced), linked()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    expect(asJson(savedConfig(result)['project'])['fields']).toMatchObject({
      workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', blocked: 'o2' } },
    })
    expect(savedStatus(result)).toEqual({ id: 'PVTSSF_status', options: { todo: 'o1', in_progress: 'o2', needs_attention: 'o4' } })
  })

  it('Status に In Progress が存在しないと、設定ファイルに in_progress を書かずに成功する', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-19')
    await explains('`project_init` の設定ファイルの同期のテストです。Status に `In Progress` が存在しない場合でも、設定ファイルに `in_progress` を書き込まずに成功することを確認します。')
    const renamed = ['Todo', 'Doing', 'Done']
    const existing = [...titleWithoutStatus, workflowField(BOARD_ORDER), statusField(renamed)]
    const synced = [
      { id: 'PVTF_title', name: 'Title' },
      { id: 'PVTSSF_workflow', name: 'pecot-workflow-acme', databaseId: 456, options: options(WORKFLOW_NAMES_WITH_BLOCKED) },
      statusField([...renamed, 'Needs Attention']),
    ]
    const result = await init([...base(existing), updateField('PVTSSF_old'), updateField('PVTSSF_status'), listProjects(projectNode(1, 'board')), projectFields(synced), linked()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(savedStatus(result)).toEqual({ id: 'PVTSSF_status', options: { todo: 'o1', needs_attention: 'o4' } })
  })

  it('値が既にあると、書き込まずに unchanged の行を出す', async () => {
    await explains('`project_init` の選択肢が既に存在する場合のテストです。追加する選択肢が既に存在する場合は、何も書き込まず、`unchanged` の行を出力することを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), statusField([...STATUS_NAMES, 'needs attention'])]
    const result = await init([...base(existing), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`${skippedFields}unchanged: option Blocked in field pecot-status\nunchanged: option Needs Attention in field Status\n${syncedLines(result)}`)
    expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
  })

  it('Status のフィールドが存在しないボードでは、何も足さずに skipped の行を出す', async () => {
    await explains('`project_init` の Status のフィールドが存在しない場合のテストです。Status のフィールドが存在しないボードでは、選択肢を追加せず、`skipped` の行を出力することを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
    const result = await init([...base(existing), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`${skippedFields}unchanged: option Blocked in field pecot-status\nskipped: field Status (not found)\n${syncedLines(result)}`)
    expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
  })

  it('選択肢を足せなかったときは、warning の行を出して続け、終了コード 0 で終わる', async () => {
    await explains('`project_init` の選択肢の追加に失敗した場合のテストです。選択肢を追加できなかった場合は、`warning` の行を出力して処理を続け、終了コード 0 で終わることを確認します。')
    const existing = [...titleOnly, workflowField(BOARD_ORDER)]
    const result = await init([...base(existing), failing('UpdateProjectField'), updateField('PVTSSF_status'), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toMatch(/^skipped: field pecot-status \(already exists\)\n.*warning: could not add option Blocked to field pecot-status: .+\nadded: option Needs Attention to field Status\ncreated: config file /su)
    expect(graphqlVariables(result, 'UpdateProjectField')).toHaveLength(2)
  })

  it('HTTP 200 で GraphQL の errors が返って足せなくても、warning の行を出して続け、終了コード 0 で終わる', async () => {
    await explains('`project_init` の選択肢の追加に失敗した場合のテストです。HTTP 200 で GraphQL の `errors` が返り選択肢を追加できなかった場合も、`warning` の行を出力して処理を続け、終了コード 0 で終わることを確認します。')
    const rejected: ResponseRule = { match: { operation: 'UpdateProjectField' }, respond: { status: 200, body: { errors: [{ message: 'Variable $options of type [ProjectV2SingleSelectFieldOptionInput!]! was provided invalid value for 0.id (Field is not defined on ProjectV2SingleSelectFieldOptionInput)' }] } }, times: 1 }
    const existing = [...titleOnly, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
    const result = await init([...base(existing), rejected, ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toMatch(/warning: could not add option Needs Attention to field Status: .+invalid value/u)
    expect(result.stderr).toContain('created: config file ')
  })

  it('設定ファイルがあり、内容がボードから作る内容と同じなら、設定ファイルとアクティブのどちらも書き換えない', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-12')
    await explains('`project_init` の設定ファイルが最新の場合のテストです。設定ファイルの内容がボードから作る内容と同じ場合は、設定ファイルとアクティブな設定を書き換えないことを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), statusField([...STATUS_NAMES, 'Needs Attention'])]
    const rules = (): ResponseRule[] => [...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()]
    const first = await init(rules())
    expect(first.stderr).toContain('created: config file ')
    const second = await init(rules(), 'board', savedConfig(first))
    expect(second.code).toBe(0)
    expectClean(second)
    expect(second.stderr).toBe(`${skippedFields}unchanged: option Blocked in field pecot-status\nunchanged: option Needs Attention in field Status\n`)
    expect(second.read(CONFIG_FILE)).toBe(first.read(CONFIG_FILE))
  })

  it('設定ファイルがあっても内容がボードと違えば（Blocked の id が存在しない）、同期して Blocked の id を書く', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-08')
    await explains('`project_init` の設定ファイルの同期のテストです。設定ファイルの内容がボードと異なる場合は、同期して `Blocked` の id を書き込むことを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
    const stale = projectConfig()
    const result = await init([...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()], 'board', stale)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain(`updated: config file ${configPathOf(result)}`)
    expect(workflowOptions(result)).toHaveProperty('blocked', 'o2')
  })

  it('既にある進行の欄に必須の値が欠けていると、何も書かずに終了コード 1 で終わる', async () => {
    await explains('`project_init` の進行の欄の検証のテストです。既存の進行の欄に必須の選択肢が欠けている場合は、何も書き込まず、終了コード 1 で終わることを確認します。')
    const existing = [...titleOnly, workflowField(['Backlog', 'Blocked'])]
    const result = await init(base(existing))
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toContain('pecot-status field is missing options: Pending, Ready, Active, In Review, Archived')
    expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
    expect(requestLabels(result.requests)).not.toContain('CreateProjectField')
    expect(result.read(CONFIG_FILE)).toBeUndefined()
  })

  it('pecot-status と旧い名前の進行の欄が両方あるボードでは、旧い欄を改名せずに、pecot-status の欄で設定ファイルを同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-14')
    await explains('`project_init` の旧い名前の進行の欄のテストです。`pecot-status` と旧い名前の進行の欄が両方ある場合は、旧い欄を改名せず、`pecot-status` の欄で設定ファイルを同期することを確認します。')
    const legacy = { ...workflowField(WORKFLOW_NAMES_WITH_BLOCKED, LEGACY_FIELD), id: 'PVTSSF_legacy' }
    const existing = [...titleWithoutStatus, legacy, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
    const result = await init([...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(savedConfig(result)).toMatchObject({ project: { fields: { workflow: { id: 'PVTSSF_old' } } } })
    expect(requestLabels(result.requests)).not.toContain('RenameProjectField')
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('旧い名前の進行の欄だけがあるボードでは、名前だけを渡して pecot-status に改名し、renamed の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-20')
    await explains('`project_init` の旧い名前の進行の欄のテストです。旧い名前の進行の欄だけがあるボードでは、`pecot-status` に改名し、`renamed` の行を出力することを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED, LEGACY_FIELD)]
    const renamed = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
    const result = await init([...base(existing), renameRule(), listProjects(projectNode(1, 'board')), projectFields(renamed), linked()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(graphqlVariables(result, 'RenameProjectField')).toEqual([{ fieldId: 'PVTSSF_old', name: 'pecot-status' }])
    expect(result.stderr).toBe(`renamed: field ${LEGACY_FIELD} to pecot-status\n${NO_LANES}unchanged: option Blocked in field pecot-status\nskipped: field Status (not found)\n${syncedLines(result)}`)
    expect(savedConfig(result)).toMatchObject({ project: { fields: { workflow: { id: 'PVTSSF_old' } } } })
  })

  it('旧い名前の設定ファイルがあると、新しい名前に移し、アクティブな設定を新しい名前にする', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-22')
    await explains('`project_init` の旧い名前の設定ファイルのテストです。旧い名前の設定ファイルが存在する場合は、新しい名前へ移し、アクティブな設定も新しい名前にすることを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
    const result = await run('project_init', { owner: 'acme', name: 'board', host: DEFAULT_HOST }, [...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()], legacyConfig)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain(`moved: config file ${path.join(result.directory, LEGACY_CONFIG_FILE)} to ${configPathOf(result)}\n${movedNote(path.parse(CONFIG_FILE).name)}`)
    expect(result.read(LEGACY_CONFIG_FILE)).toBeUndefined()
    expect(savedConfig(result)).not.toHaveProperty('workflow_suffix')
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('同じボードを指す旧い名前の設定ファイルが 2 つあると、欄を改名せず、何も移さずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-24')
    await explains('`project_init` の旧い名前の設定ファイルが重複する場合のテストです。同じボードを指す旧い名前の設定ファイルが 2 つある場合は、名前を変更せず移動もしないで、終了コード 1 で終わることを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED, LEGACY_FIELD)]
    const result = await run('project_init', { owner: 'acme', name: 'board', host: DEFAULT_HOST }, [...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()], { ...legacyConfig, files: otherFile })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`error: several config files point to project #1:\n  - ${path.basename(LEGACY_CONFIG_FILE)}\n  - ${OTHER_NAME}.json\n`)
    expect(result.read(LEGACY_CONFIG_FILE)).toBeDefined()
    expect(result.read(CONFIG_FILE)).toBeUndefined()
    expect(requestLabels(result.requests)).not.toContain('RenameProjectField')
  })

  it('設定ファイルの同期で GitHub API がエラーを返すと、could not sync project config の行を出して終了コード 1 で終わる', async () => {
    await explains('`project_init` の設定ファイルの同期に失敗した場合のテストです。同期で GitHub API がエラーを返した場合は、`could not sync project config` の行を出力して終了コード 1 で終わることを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
    const result = await init([...base(existing), listProjects(projectNode(1, 'board')), failing('GetProjectFieldsUser'), failing('GetProjectFieldsOrg')])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/error: could not sync project config: /u)
    expect(result.stderr).not.toContain('could not initialize project fields')
  })

  it('pecot-priority・pecot-size があるボードに confirm_delete なしで打つと、何も消さずに、名前と承認を求める warning の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-26')
    await explains('`project_init` の未使用のフィールドのテストです。`pecot-priority` と `pecot-size` があるボードで `confirm_delete` を指定しない場合は、何も削除せず、承認を求める `warning` を出力することを確認します。')
    const result = await init([...base(withUnused()), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`${skippedFields}unchanged: option Blocked in field pecot-status\nskipped: field Status (not found)\n${syncedLines(result)}${pendingWarning('pecot-priority, pecot-size')}`)
    expect(requestLabels(result.requests)).not.toContain('DeleteProjectField')
  })

  it('confirm_delete を付けて打つと、設定ファイルを同期した後に 2 つのフィールドを消し、deleted の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-27')
    await explains('`project_init` の `confirm_delete` のテストです。`confirm_delete` を指定した場合は、設定ファイルを同期した後に 2 つのフィールドを削除し、`deleted` の行を出力することを確認します。')
    const result = await run('project_init', confirmed(), [...base(withUnused()), ...syncRules(), ...deleteRules()], { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(graphqlVariables(result, 'DeleteProjectField')).toEqual([{ fieldId: 'PVTSSF_priority' }, { fieldId: 'PVTSSF_size' }])
    expect(result.stderr).toBe(`${skippedFields}unchanged: option Blocked in field pecot-status\nskipped: field Status (not found)\n${syncedLines(result)}deleted: field pecot-priority\ndeleted: field pecot-size\n`)
    const labels = requestLabels(result.requests)
    expect(labels.indexOf('DeleteProjectField')).toBeGreaterThan(labels.indexOf('GetLinkedRepositoriesUser'))
  })

  it('pecot-status と旧い名前の進行の欄が両方あるボードでは、旧い欄も消す予定に入れ、confirm_delete で 3 つを消す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-28')
    await explains('`project_init` の `confirm_delete` のテストです。`pecot-status` と旧い名前の進行の欄が両方あるボードでは、旧い欄も削除の予定に含め、`confirm_delete` で 3 つを削除することを確認します。')
    const legacy = { ...workflowField(WORKFLOW_NAMES_WITH_BLOCKED, LEGACY_FIELD), id: 'PVTSSF_legacy' }
    const existing = [...titleWithoutStatus, legacy, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...unusedFields()]
    const pending = await init([...base(existing), ...syncRules()])
    expect(pending.code).toBe(0)
    expect(pending.stderr).toContain(pendingWarning(`pecot-priority, pecot-size, ${LEGACY_FIELD}`))
    expect(requestLabels(pending.requests)).not.toContain('DeleteProjectField')
    const result = await run('project_init', confirmed(), [...base(existing), ...syncRules(), ...deleteRules(), deleteField('PVTSSF_legacy', LEGACY_FIELD)], { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(graphqlVariables(result, 'DeleteProjectField')).toEqual([{ fieldId: 'PVTSSF_priority' }, { fieldId: 'PVTSSF_size' }, { fieldId: 'PVTSSF_legacy' }])
    expect(result.stderr).toContain(`deleted: field ${LEGACY_FIELD}\n`)
    expect(requestLabels(result.requests)).not.toContain('RenameProjectField')
  })

  it('フィールドの削除で GitHub API がエラーを返すと、could not delete project fields の行を出して終了コード 1 で終わり、同期した設定ファイルは残す', async () => {
    await explains('`project_init` のフィールドの削除に失敗した場合のテストです。削除で GitHub API がエラーを返した場合は、`could not delete project fields` を出力して終了コード 1 で終わり、設定ファイルを残すことを確認します。')
    const result = await run('project_init', confirmed(), [...base(withUnused()), ...syncRules(), failing('DeleteProjectField')], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/error: could not delete project fields: /u)
    expect(result.read(CONFIG_FILE)).toBeDefined()
  })

  it('設定ファイルに fields.priority・fields.size が残っていると、ボードと同じ内容でも update で書き直し、2 つのキーを消す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-30')
    await explains('`project_init` の旧い形の設定ファイルのテストです。設定ファイルに `fields.priority` と `fields.size` が残っている場合は、ボードと同じ内容でも `updated` で書き直し、この 2 つのキーを削除することを確認します。')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), statusField([...STATUS_NAMES, 'Needs Attention'])]
    const rules = (): ResponseRule[] => [...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()]
    const first = await init(rules())
    const second = await init(rules(), 'board', withOldFields(savedConfig(first)))
    expect(second.code).toBe(0)
    expectClean(second)
    expect(second.stderr).toContain(`updated: config file ${configPathOf(second)}\n`)
    expect(second.read(CONFIG_FILE)).toBe(first.read(CONFIG_FILE))
    const fields = asJson(asJson(savedConfig(second)['project'])['fields'])
    expect(Object.keys(fields)).toEqual(['workflow', 'status'])
  })

  describe('pecot-lane と Lanes のビュー', () => {
    const LANES = ['cli', 'skills']
    const initLanes = async (rules: ResponseRule[], lanes: readonly string[] = LANES): Promise<CommandResult> => await run('project_init', { owner: 'acme', name: 'board', host: DEFAULT_HOST, lanes }, rules, { config: false })
    // pecot-lane のほかは揃っていて、Status の欄の無いボード
    const ready = (...extra: Json[]): Json[] => [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...extra]
    const readyLines = 'skipped: field pecot-status (already exists)\n'
    const laneArguments = { ...initArguments, lanes: ['cli', 'skills'] }
    const laneBoard = (...names: string[]): ResponseRule[] => base(ready(laneField(names)))
    const TEXT_LANE = { id: 'PVTF_lane', name: 'pecot-lane' }

    it('lanes を渡し pecot-lane が存在しないと、渡した値で pecot-lane を作り、Lanes のビューを作る', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-40')
      await verifies(context, 'PW-PROJECT-INIT-44')
      await explains('`project_init` の `lanes` のテストです。`lanes` を指定し `pecot-lane` が存在しない場合は、指定した値で `pecot-lane` を作成し、`Lanes` のビューを作成することを確認します。')
      const result = await initLanes([...base(ready()), createField('pecot-lane', 'PVTSSF_lane'), viewTarget(), createView(), ...syncRules()])
      expect(result.code).toBe(0)
      expectClean(result)
      expect(graphqlVariables(result, 'CreateProjectField')).toEqual([{ projectId: 'PVT_1', name: 'pecot-lane', options: [{ name: 'cli', color: 'BLUE', description: '' }, { name: 'skills', color: 'GREEN', description: '' }] }])
      expect(restBodies(result, USER_VIEWS_PATH)).toEqual([lanesBody])
      expect(result.stderr).toBe(`${readyLines}created: field pecot-lane (ID: PVTSSF_lane)\nunchanged: option Blocked in field pecot-status\nskipped: field Status (not found)\ncreated: view Lanes (${VIEW_URL})\n${syncedLines(result)}`)
    })

    it('個人のボードでは、所有者の数値の id のパスにビューを作る', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-45')
      await explains('`project_init` の `Lanes` のビューの作成先のテストです。個人のボードの場合は、所有者の数値の id を使ったパスにビューを作成することを確認します。')
      const result = await initLanes([...laneBoard('cli', 'skills'), viewTarget(), createView(), ...syncRules()])
      expect(result.code).toBe(0)
      expectClean(result)
      expect(requestLabels(result.requests)).toContain(`POST ${USER_VIEWS_PATH}`)
    })

    it('作ったビューの応答に html_url が無いと、url を含めずに created を true にする', async () => {
      await explains('`project_init` の `Lanes` のビューのテストです。作成したビューの応答に `html_url` が無い場合に、`view` に `url` を含めず、`created` を `true` にすることを確認します。')
      const result = await tool('project_init', laneArguments, [...laneBoard('cli', 'skills'), viewTarget(), createView(201, { id: 2, number: 2 }), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['view']).toEqual({ created: true, name: 'Lanes' })
    })

    it('組織のボードでは、組織の名前のパスにビューを作る', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-44')
      await explains('`project_init` の `Lanes` のビューの作成先のテストです。組織のボードの場合は、組織の名前を使ったパスにビューを作成することを確認します。')
      const orgPath = '/orgs/acme/projectsV2/1/views'
      const result = await initLanes([...laneBoard('cli', 'skills'), viewTarget([], 'Organization'), createView(201, { id: 2, number: 2, html_url: VIEW_URL }, orgPath), ...syncRules()])
      expect(result.code).toBe(0)
      expectClean(result)
      expect(restBodies(result, orgPath)).toEqual([lanesBody])
    })

    it('pecot-lane があると、既存の選択肢を id ごと残し、足りない値を末尾に足して update にする', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-41')
      await explains('`project_init` の `pecot-lane` の選択肢のテストです。`pecot-lane` が存在する場合は、既存の選択肢を id ごと残し、不足する値を末尾に追加して `update` にすることを確認します。')
      const result = await tool('project_init', laneArguments, [...laneBoard('cli'), updateField('PVTSSF_lane'), viewTarget(), createView(), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(graphqlVariables(result, 'UpdateProjectField')).toEqual([{ fieldId: 'PVTSSF_lane', options: [{ id: 'o1', name: 'cli', color: 'GRAY', description: 'cli の説明' }, { name: 'skills', color: 'GREEN', description: '' }] }])
      expect(result.structured['fields']).toContainEqual({ name: 'pecot-lane', change: 'update', addedOptions: ['skills'] })
      expect(result.structured['view']).toEqual({ created: true, name: 'Lanes', url: VIEW_URL })
    })

    it('pecot-lane が渡した値を全て持つと、書き込まず、change を unchanged にする', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-42')
      await explains('`project_init` の `pecot-lane` の選択肢のテストです。`pecot-lane` が指定した値をすべて持つ場合は、何も書き込まず、`change` を `unchanged` にすることを確認します。')
      const result = await tool('project_init', laneArguments, [...laneBoard('cli', 'skills'), viewTarget(), createView(), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
      expect(result.structured['fields']).toContainEqual({ name: 'pecot-lane', change: 'unchanged', addedOptions: [] })
    })

    it('lanes が存在せず pecot-lane も存在しないと、作らずに skip とし、warnings で案内し、view を返さない', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-43')
      await verifies(context, 'PW-PROJECT-INIT-48')
      await explains('`project_init` の `lanes` を省略した場合のテストです。`lanes` を指定せず `pecot-lane` も存在しない場合は、作成せずに `skip` とし、`warnings` で案内して `view` を返さないことを確認します。')
      const result = await tool('project_init', initArguments, [...base(ready()), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['fields']).toContainEqual(NO_LANES_ROW)
      expect(result.structured['warnings']).toEqual([NO_LANES_WARNING])
      expect(result.structured).not.toHaveProperty('view')
      expect(requestLabels(result.requests)).not.toContain('CreateProjectField')
      expect(requestLabels(result.requests)).not.toContain('GetProjectViewTarget')
    })

    it('lanes が存在しなくても pecot-lane があると、値を足さずに Lanes のビューを作る', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-44')
      await explains('`project_init` の `lanes` を省略した場合のテストです。`lanes` を指定しなくても `pecot-lane` が存在する場合は、値を追加せずに `Lanes` のビューを作成することを確認します。')
      const result = await tool('project_init', initArguments, [...laneBoard('cli'), viewTarget(), createView(), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
      expect(result.structured['fields']).toContainEqual({ name: 'pecot-lane', change: 'unchanged', addedOptions: [] })
      expect(result.structured['view']).toEqual({ created: true, name: 'Lanes', url: VIEW_URL })
    })

    it('同じ名前のビューがあると、作らずに created を false にし、そのビューの URL を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-46')
      await explains('`project_init` の `Lanes` のビューが存在する場合のテストです。同じ名前のビューが既に存在する場合は、作成せずに `created` を `false` にし、そのビューの URL を返すことを確認します。')
      const result = await tool('project_init', laneArguments, [...laneBoard('cli', 'skills'), viewTarget([{ number: 3, name: 'Lanes' }]), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['view']).toEqual({ created: false, name: 'Lanes', url: `${BOARD_URL}/views/3` })
      expect(result.requests.some(request => request.type === 'rest')).toBe(false)
    })

    it.for([
      { status: 403, message: 'Resource not accessible by integration' },
      { status: 404, message: 'Not Found' },
    ])('ビューの作成が $status で断られると、画面で作る手順を返し、設定ファイルを同期して成功を返す', async ({ status, message }, context) => {
      await verifies(context, 'PW-PROJECT-INIT-47')
      await explains(`\`project_init\` の \`Lanes\` のビューの作成が拒否された場合のテストです。作成が \`${String(status)}\` で拒否された場合は、画面で作成する手順を返し、設定ファイルを同期して成功を返すことを確認します。`)
      const result = await tool('project_init', laneArguments, [...laneBoard('cli', 'skills'), viewTarget(), createView(status, { message }), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['view']).toEqual({ created: false, name: 'Lanes', manual_steps: MANUAL_STEPS })
      const refused = `could not create view Lanes (status ${String(status)}): `
      expect(result.structured['warnings']).toEqual([expect.stringContaining(refused)])
      expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    })

    it('ビューの作成が断られると、警告の行に画面で作る手順を番号つきで出し、終了コード 0 で終わる', async () => {
      await explains('`project_init` の `Lanes` のビューの作成が拒否された場合のテストです。作成が拒否された場合は、画面で作成する手順を番号付きで `warning` の行に出力し、終了コード 0 で終わることを確認します。')
      const result = await initLanes([...laneBoard('cli', 'skills'), viewTarget(), createView(403, { message: 'Resource not accessible by integration' }), ...syncRules()])
      expect(result.code).toBe(0)
      expectClean(result)
      expect(result.stderr).toContain(`\n  create it on the board:\n  1. open the project: ${BOARD_URL}\n  2. add a view named Lanes with the Board layout\n  3. set Column by to pecot-status\n  4. set Group by to pecot-lane\n`)
    })

    it('pecot-lane に値を足す書き込みが断られると、unchanged のまま warnings で知らせ、ビューを作る', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-53')
      await explains('`project_init` の `pecot-lane` の選択肢の追加に失敗した場合のテストです。値を追加する書き込みが拒否された場合は、`unchanged` のまま `warnings` で知らせ、ビューは作成することを確認します。')
      const result = await tool('project_init', laneArguments, [...laneBoard('cli'), failing('UpdateProjectField'), viewTarget(), createView(), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([expect.stringMatching(/^could not add options skills to field pecot-lane: /u)])
      expect(result.structured['fields']).toContainEqual({ name: 'pecot-lane', change: 'unchanged', addedOptions: [] })
      expect(result.structured['view']).toEqual({ created: true, name: 'Lanes', url: VIEW_URL })
    })

    it('ビューの作成がレート制限の 403 で断られると、画面で作る手順を返さずに失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-54')
      await explains('`project_init` のレート制限のテストです。ビューの作成がレート制限の 403 で拒否された場合は、画面で作成する手順を返さず、失敗を返すことを確認します。')
      const result = await tool('project_init', laneArguments, [...laneBoard('cli', 'skills'), viewTarget(), createView(403, { message: 'API rate limit exceeded for installation ID 1.' })], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'github-rate-limit' } })
      expect(JSON.stringify(result.structured)).not.toContain('manual_steps')
    })

    it('ビューの作成で 403・404 のほかのエラーが返ると、終了コード 1 で終わる', async () => {
      await explains('`project_init` のビューの作成のエラーのテストです。ビューの作成で 403 と 404 以外のエラーが返った場合は、終了コード 1 で終わり、設定ファイルは書き込まないことを確認します。')
      const result = await initLanes([...laneBoard('cli', 'skills'), viewTarget(), createView(500, { message: 'Server Error' })])
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: could not initialize project fields \(status 500\): /mu)
      expect(result.read(CONFIG_FILE)).toBeUndefined()
    })

    it('pecot-lane が single select でないと、値を足さずビューも作らずに skip とし、warnings で知らせる', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-49')
      await explains('`project_init` の `pecot-lane` の型のテストです。`pecot-lane` が単一選択のフィールドでない場合は、値を追加せず、ビューも作成せずに `skip` とし、`warnings` で知らせることを確認します。')
      const result = await tool('project_init', laneArguments, [...base(ready(TEXT_LANE)), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['fields']).toContainEqual({ name: 'pecot-lane', change: 'skip', addedOptions: [] })
      expect(result.structured['warnings']).toEqual(['field pecot-lane is not a single select field, so no lanes were added and view Lanes was not created\n  delete or rename that field on the board, then run again'])
      expect(result.structured).not.toHaveProperty('view')
      expect(requestLabels(result.requests)).not.toContain('CreateProjectField')
      expect(requestLabels(result.requests)).not.toContain('GetProjectViewTarget')
    })

    it('pecot-lane を作っても、設定ファイルに pecot-lane の欄と選択肢を書かない', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-50')
      await explains('`project_init` の設定ファイルの内容のテストです。`pecot-lane` を作成しても、設定ファイルには `pecot-lane` の欄と選択肢を書き込まないことを確認します。')
      const synced = [...standardFields(), laneField(['cli', 'skills'])]
      const result = await initLanes([...base(ready()), createField('pecot-lane', 'PVTSSF_lane'), viewTarget(), createView(), listProjects(projectNode(1, 'board')), projectFields(synced), linked()])
      expect(result.code).toBe(0)
      expectClean(result)
      const savedFields = asJson(asJson(savedConfig(result)['project'])['fields'])
      expect(sorted(Object.keys(savedFields))).toEqual(['status', 'workflow'])
      expect(result.read(CONFIG_FILE)).not.toContain('PVTSSF_lane')
    })

    it.for([
      { name: '空の lanes', lanes: [] },
      { name: '空の文字の値', lanes: [''] },
    ])('$name を渡すと、GitHub を呼ばずに kind が invalid-input の失敗を返す', async ({ lanes }, context) => {
      await verifies(context, 'PW-PROJECT-INIT-51')
      await explains('`project_init` の `lanes` の入力検証のテストです。`lanes` が空の配列または空文字を含む場合は、GitHub を呼び出さずに `kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_init', { ...initArguments, lanes }, [], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.requests).toEqual([])
    })
  })

  describe('MCP の data', () => {
    it('作ったフィールドと足した選択肢を fields に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-03')
      await verifies(context, 'PW-PROJECT-INIT-06')
      await explains('`project_init` の MCP の結果のテストです。フィールドを作成し選択肢を追加した場合は、その内容を `fields` に含めて返すことを確認します。')
      const rules = [...initRules([...titleOnly, workflowWithBlocked]), updateField('PVTSSF_status'), ...syncRules()]
      const result = await tool('project_init', initArguments, rules, { config: false })
      expect(result.structured).toEqual({
        fields: [
          { name: 'pecot-status', change: 'unchanged', addedOptions: [] },
          NO_LANES_ROW,
          { name: 'Status', change: 'update', addedOptions: ['Needs Attention'] },
        ],
        migration: { renamed: null, config_moved: null, pending_delete: [], deleted: [] },
        warnings: [NO_LANES_WARNING],
      })
    })

    it('Status の欄が存在しないと、その欄を skip にする', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-02')
      await verifies(context, 'PW-PROJECT-INIT-10')
      await explains('`project_init` の MCP の結果のテストです。Status のフィールドが存在しない場合は、その欄の `change` を `skip` にすることを確認します。')
      const result = await tool('project_init', initArguments, [...initRules(titleWithoutStatus), ...createFields(), ...syncRules()], { config: false })
      expect(result.structured).toMatchObject({ fields: [{ name: 'pecot-status', change: 'create' }, NO_LANES_ROW, { name: 'Status', change: 'skip', addedOptions: [] }], warnings: [NO_LANES_WARNING] })
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
    })

    it('足す選択肢が既にあると、書き込まずに、その欄の change を unchanged にする', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-09')
      await explains('`project_init` の MCP の結果のテストです。追加する選択肢が既に存在する場合は、何も書き込まず、その欄の `change` を `unchanged` にすることを確認します。')
      const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), statusField([...STATUS_NAMES, 'needs attention'])]
      const result = await tool('project_init', initArguments, [...base(existing), ...syncRules()], { config: false })
      expect(result.structured).toEqual({
        fields: [
          { name: 'pecot-status', change: 'unchanged', addedOptions: [] },
          NO_LANES_ROW,
          { name: 'Status', change: 'unchanged', addedOptions: [] },
        ],
        migration: { renamed: null, config_moved: null, pending_delete: [], deleted: [] },
        warnings: [NO_LANES_WARNING],
      })
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
    })

    it('指定したタイトルのプロジェクトが存在しないと、kind が project-not-found の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-04')
      await explains('`project_init` の MCP の失敗のテストです。指定したタイトルのプロジェクトが存在しない場合は、`kind` が `project-not-found` の失敗を返すことを確認します。')
      const result = await tool('project_init', { ...initArguments, name: 'Nonexistent' }, [listProjects(projectNode(2, 'Other Project'))], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'project-not-found', detail: 'project not found: Nonexistent\n  available projects:\n  - Other Project' } })
    })

    it('フィールドの作成で GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-05')
      await explains('`project_init` の MCP の失敗のテストです。フィールドの作成で GitHub API がエラーを返した場合は、`detail` に理由を含む失敗を返すことを確認します。')
      const result = await tool('project_init', initArguments, [...base(titleOnly), failing('CreateProjectField')], { config: false })
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not initialize project fields: /u)
    })

    it('選択肢を足せないと、warnings に入れて続け、成功を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-11')
      await explains('`project_init` の MCP の結果のテストです。選択肢を追加できなかった場合は、`warnings` に含めて処理を続け、成功を返すことを確認します。')
      const existing = [...titleOnly, workflowField(BOARD_ORDER)]
      const result = await tool('project_init', initArguments, [...base(existing), failing('UpdateProjectField'), updateField('PVTSSF_status'), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expectClean(result)
      expect(result.structured['warnings']).toEqual([NO_LANES_WARNING, expect.stringMatching(/^could not add option Blocked to field pecot-status: /u)])
    })

    it('既にある進行の欄に必須の値が欠けていると、何も書かずに、欠けた値を detail に入れて kind が not-initialized の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-13')
      await explains('`project_init` の MCP の失敗のテストです。既存の進行の欄に必須の選択肢が欠けている場合は、何も書き込まず、`kind` が `not-initialized` の失敗を返すことを確認します。')
      const existing = [...titleOnly, workflowField(['Backlog', 'Blocked'])]
      const result = await tool('project_init', initArguments, base(existing), { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
      expect(result.structured['detail']).toContain('pecot-status field is missing options: Pending, Ready, Active, In Review, Archived')
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
      expect(result.read(CONFIG_FILE)).toBeUndefined()
    })

    it('設定ファイルの同期で GitHub API がエラーを返すと、could not sync project config で始まる detail を入れて失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-15')
      await explains('`project_init` の MCP の失敗のテストです。設定ファイルの同期で GitHub API がエラーを返した場合は、`could not sync project config` で始まる `detail` を含む失敗を返すことを確認します。')
      const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
      const result = await tool('project_init', initArguments, [...base(existing), listProjects(projectNode(1, 'board')), failing('GetProjectFieldsUser'), failing('GetProjectFieldsOrg')], { config: false })
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not sync project config: /u)
    })

    it('旧い形のボードと設定ファイルを移すと、改名した旧い名前と移した設定ファイルを migration に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-20')
      await verifies(context, 'PW-PROJECT-INIT-21')
      await verifies(context, 'PW-PROJECT-INIT-22')
      await explains('`project_init` の MCP の結果のテストです。旧い形のボードと設定ファイルを移行した場合は、改名した旧い名前と移動した設定ファイルを `migration` に含めて返すことを確認します。')
      const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED, LEGACY_FIELD)]
      const renamed = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
      const result = await tool('project_init', initArguments, [...base(existing), renameRule(), listProjects(projectNode(1, 'board')), projectFields(renamed), linked()], legacyConfig)
      expectClean(result)
      expect(jsonList(result.structured['fields'])[0]).toEqual({ name: 'pecot-status', change: 'rename', addedOptions: [] })
      expect(result.structured['migration']).toEqual({ renamed: LEGACY_FIELD, config_moved: { from: path.basename(LEGACY_CONFIG_FILE), to: path.basename(CONFIG_FILE) }, pending_delete: [], deleted: [] })
      expect(result.structured['warnings']).toEqual([NO_LANES_WARNING, expect.stringMatching(/^the project config is now named /u)])
      expect(result.read(LEGACY_CONFIG_FILE)).toBeUndefined()
    })

    it('Blocked が存在しない旧い形のボードで改名すると、選択肢を足しても fields の change を rename のまま返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-20')
      await explains('`project_init` の MCP の結果のテストです。`Blocked` が存在しない旧い形のボードで改名した場合は、選択肢を追加しても、`fields` の `change` を `rename` のまま返すことを確認します。')
      const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES, LEGACY_FIELD)]
      const renamed = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
      const result = await tool('project_init', initArguments, [...base(existing), renameRule(), updateField('PVTSSF_old'), listProjects(projectNode(1, 'board')), projectFields(renamed), linked()], { config: false })
      expectClean(result)
      expect(jsonList(result.structured['fields'])[0]).toEqual({ name: 'pecot-status', change: 'rename', addedOptions: ['Blocked'] })
    })

    it('同じボードを指す旧い名前の設定ファイルが 2 つあると、何も移さずに kind が config-invalid の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-24')
      await explains('`project_init` の MCP の失敗のテストです。同じボードを指す旧い名前の設定ファイルが 2 つある場合は、何も移動せず、`kind` が `config-invalid` の失敗を返すことを確認します。')
      const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED)]
      const result = await tool('project_init', initArguments, [...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()], { ...legacyConfig, files: otherFile })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
      expect(result.read(CONFIG_FILE)).toBeUndefined()
    })

    it('suffix を渡すと、入力の誤りとして失敗を返し、GitHub を呼ばない', async () => {
      await explains('`project_init` の廃止した入力のテストです。`suffix` を指定した場合は、入力の誤りとして失敗を返し、GitHub を呼び出さないことを確認します。')
      const result = await tool('project_init', { ...initArguments, suffix: 'acme' }, [], { config: false })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('suffix')
      expect(result.requests).toEqual([])
    })

    it('confirm_delete なしでは、消す予定の名前を pending_delete に入れ、承認を求める文を warnings に入れ、何も消さない', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-26')
      await explains('`project_init` の MCP の `confirm_delete` のテストです。`confirm_delete` を指定しない場合は、削除予定の名前を `pending_delete` に含め、承認を求める文を `warnings` に含め、何も削除しないことを確認します。')
      const result = await tool('project_init', initArguments, [...base(withUnused()), ...syncRules()], { config: false })
      expect(result.isError).toBe(false)
      expectClean(result)
      expect(result.structured['migration']).toEqual({ renamed: null, config_moved: null, pending_delete: ['pecot-priority', 'pecot-size'], deleted: [] })
      expect(result.structured['warnings']).toEqual([NO_LANES_WARNING, pendingText('pecot-priority, pecot-size', `call project_init with owner: "acme", name: "board", host: "${DEFAULT_HOST}", confirm_delete: true again`)])
      expect(jsonList(result.structured['fields']).map(row => row['name'])).toEqual(['pecot-status', 'pecot-lane', 'Status'])
      expect(requestLabels(result.requests)).not.toContain('DeleteProjectField')
    })

    it('confirm_delete: true では、消した名前を deleted に入れ、fields に change が delete の行を入れる', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-27')
      await explains('`project_init` の MCP の `confirm_delete` のテストです。`confirm_delete` に `true` を指定した場合は、削除した名前を `deleted` に含め、`fields` に `change` が `delete` の行を含めることを確認します。')
      const result = await tool('project_init', { ...initArguments, confirm_delete: true }, [...base(withUnused()), ...syncRules(), ...deleteRules()], { config: false })
      expect(result.isError).toBe(false)
      expectClean(result)
      expect(result.structured).toEqual({
        fields: [
          { name: 'pecot-status', change: 'unchanged', addedOptions: [] },
          NO_LANES_ROW,
          { name: 'Status', change: 'skip', addedOptions: [] },
          { name: 'pecot-priority', change: 'delete', addedOptions: [] },
          { name: 'pecot-size', change: 'delete', addedOptions: [] },
        ],
        migration: { renamed: null, config_moved: null, pending_delete: [], deleted: ['pecot-priority', 'pecot-size'] },
        warnings: [NO_LANES_WARNING],
      })
    })

    it('pecot-status と旧い名前の進行の欄が両方あるボードでは、旧い欄の名前を pending_delete の末尾に入れる', async (context) => {
      await verifies(context, 'PW-PROJECT-INIT-28')
      await explains('`project_init` の MCP の `confirm_delete` のテストです。`pecot-status` と旧い名前の進行の欄が両方あるボードでは、旧い欄の名前を `pending_delete` の末尾に含めることを確認します。')
      const legacy = { ...workflowField(WORKFLOW_NAMES_WITH_BLOCKED, LEGACY_FIELD), id: 'PVTSSF_legacy' }
      const existing = [...titleWithoutStatus, legacy, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...unusedFields()]
      const result = await tool('project_init', initArguments, [...base(existing), ...syncRules()], { config: false })
      expectClean(result)
      expect(result.structured['migration']).toMatchObject({ pending_delete: ['pecot-priority', 'pecot-size', LEGACY_FIELD], deleted: [] })
    })
  })
})

describe('project_create', () => {
  const create = async (rules: ResponseRule[]): Promise<CommandResult> => await run('project_create', { owner: 'acme', title: 'board', host: DEFAULT_HOST }, rules, { config: false })

  it('新しいタイトルを渡すと、GitHub にプロジェクトを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-01')
    await explains('`project_create` のプロジェクトの作成のテストです。新しいタイトルを指定した場合は、GitHub にプロジェクトを作成することを確認します。')
    const result = await create(createRules())
    expect(result.code).toBe(0)
    expectClean(result)
    expect(graphqlVariables(result, 'CreateProject')).toEqual([{ ownerId: 'U_1', title: 'board' }])
  })

  it('プロジェクトを作ると、続けて pecot-status のフィールドを足し、pecot-priority・pecot-size を作らない', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-02')
    await verifies(context, 'PW-PROJECT-CREATE-13')
    await explains('`project_create` のフィールドの作成のテストです。プロジェクトを作成した場合は、続けて `pecot-status` のフィールドを作成し、`pecot-priority` と `pecot-size` は作成しないことを確認します。')
    const result = await create(createRules())
    expect(variableValues(result, 'CreateProjectField', 'name')).toEqual(['pecot-status'])
  })

  it('フィールドを足すと、設定ファイルを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-03')
    await explains('`project_create` の設定ファイルの作成のテストです。フィールドを作成した場合は、ホスト・所有者・プロジェクトの番号と id・選択肢の id を含む設定ファイルを作成することを確認します。')
    const result = await create(createRules())
    expect(asJson(savedConfig(result)['project'])['board_url']).toContain(`${BOARD_URL}/views/1`)
    expect(savedConfig(result)).toMatchObject({
      host: DEFAULT_HOST,
      owner: 'acme',
      project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', archived: 'o6' } } } },
      repositories: [],
    })
  })

  it('Status に In Progress があると、設定ファイルに in_progress の id を書く', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-12')
    await explains('`project_create` の設定ファイルの内容のテストです。Status に `In Progress` が存在する場合は、設定ファイルに `in_progress` の id を書き込むことを確認します。')
    const result = await create(createRules())
    expect(savedStatus(result)).toMatchObject({ id: 'PVTSSF_status', options: { todo: 'o1', in_progress: 'o2' } })
  })

  it('設定ファイルを作ると、そのプロジェクトをアクティブにする', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-04')
    await explains('`project_create` のアクティブなプロジェクトのテストです。設定ファイルを作成した場合は、そのプロジェクトをアクティブにすることを確認します。')
    const result = await create(createRules())
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('プロジェクトを作ると、created の行を標準エラーに出す', async () => {
    await explains('`project_create` の標準エラーの出力のテストです。プロジェクトを作成した場合は、`created` の行を標準エラーへ出力し、標準出力には何も出力しないことを確認します。')
    const result = await create(createRules())
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`created: project #1 ${BOARD_URL}\ncreated: field pecot-status (ID: PVTSSF_w)\n${NO_LANES}added: option Needs Attention to field Status\ncreated: config file ${configPathOf(result)}\nset: active project to ${path.parse(CONFIG_FILE).name}\n`)
  })

  it('Status に Needs Attention を足せなくても、warning の行を出して設定ファイルを作る', async () => {
    await explains('`project_create` の Status の選択肢のテストです。Status に `Needs Attention` を追加できない場合でも、`warning` の行を出力して設定ファイルを作成することを確認します。')
    const rules = createRules().map(rule => rule.match.operation === 'UpdateProjectField' ? failing('UpdateProjectField') : rule)
    const result = await create(rules)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toMatch(/warning: could not add option Needs Attention to field Status: [\s\S]+\ncreated: config file /u)
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('同じタイトルのプロジェクトが既にあると、終了コード 1 で終わる', async () => {
    await explains('`project_create` の重複のテストです。同じタイトルのプロジェクトが既に存在する場合は、作成せずにエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await create([graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }), listProjects(projectNode(1, 'board'))])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: project already exists: board\n  url: ${BOARD_URL}\n`)
    expect(requestLabels(result.requests)).not.toContain('CreateProject')
  })

  it('所有者が見つからないと、終了コード 1 で終わる', async () => {
    await explains('`project_create` の所有者の検索のテストです。所有者が見つからない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await create([graphqlRule('GetUserNodeId', { user: null }), graphqlRule('GetOrgNodeId', { organization: null })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: owner not found: acme\n')
  })

  it('プロジェクトの作成で GitHub API がエラーを返すと、終了コード 1 で終わる', async () => {
    await explains('`project_create` の GitHub API のエラーのテストです。プロジェクトの作成で GitHub API がエラーを返した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await create([graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }), listProjects(), failing('CreateProject')])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not create project: /u)
  })

  it('作ったプロジェクトの workflow フィールドに選択肢が足りないと、終了コード 1 で終わる', async () => {
    await explains('`project_create` の進行の欄の検証のテストです。作成したプロジェクトの進行の欄に選択肢が不足している場合は、終了コード 1 で終わり、設定ファイルとアクティブな設定は作成しないことを確認します。')
    const result = await create(createRules(standardFields(['Backlog'])))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('required options: Backlog / Pending / Ready / Active / In Review / Archived')
    // 準拠しないとわかった時点で止まり、設定ファイルも .active も作らない
    expect(result.read(CONFIG_FILE)).toBeUndefined()
    expect(result.read(ACTIVE_FILE)).toBeUndefined()
  })

  describe('pecot-lane と Lanes のビュー', () => {
    // フィールドを作った後に pecot-lane を作り、Status に値を足してからビューを作る
    const laneRules = (): ResponseRule[] => {
      const rules = createRules([...standardFields(), laneField(['cli', 'skills'])])
      const statusIndex = rules.findIndex(rule => rule.match.operation === 'UpdateProjectField')
      return [...rules.slice(0, statusIndex), createField('pecot-lane', 'PVTSSF_lane'), updateField('PVTSSF_status'), viewTarget(), createView(), ...rules.slice(statusIndex + 1)]
    }

    it('lanes を渡すと、その値で pecot-lane を作り、Lanes のビューを作る', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-20')
      await explains('`project_create` の `lanes` のテストです。`lanes` を指定した場合は、その値で `pecot-lane` を作成し、`Lanes` のビューを作成することを確認します。')
      const result = await run('project_create', { owner: 'acme', title: 'board', host: DEFAULT_HOST, lanes: ['cli', 'skills'] }, laneRules(), { config: false })
      expect(result.code).toBe(0)
      expectClean(result)
      expect(variableValues(result, 'CreateProjectField', 'name')).toEqual(['pecot-status', 'pecot-lane'])
      expect(restBodies(result, USER_VIEWS_PATH)).toEqual([lanesBody])
      expect(result.stderr).toContain(`created: field pecot-lane (ID: PVTSSF_lane)\nadded: option Needs Attention to field Status\ncreated: view Lanes (${VIEW_URL})\n`)
    })

    it('lanes が存在しないと、pecot-lane とビューを作らずに、lanes の渡し方を案内する', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-21')
      await explains('`project_create` の `lanes` を省略した場合のテストです。`lanes` を指定しない場合は、`pecot-lane` とビューを作成せず、`lanes` の指定方法を案内することを確認します。')
      const result = await tool('project_create', { ...owned, title: 'board' }, createRules(), { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([NO_LANES_WARNING])
      expect(result.structured).not.toHaveProperty('view')
      expect(variableValues(result, 'CreateProjectField', 'name')).not.toContain('pecot-lane')
    })

    it('作ったフィールドの行を fields に返し、作ったビューを view に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-22')
      await explains('`project_create` の MCP の結果のテストです。作成したフィールドの行を `fields` に含め、作成したビューを `view` に含めて返すことを確認します。')
      const result = await tool('project_create', { ...owned, title: 'board', lanes: ['cli', 'skills'] }, laneRules(), { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['fields']).toEqual([
        { name: 'pecot-status', change: 'create', addedOptions: [] },
        { name: 'pecot-lane', change: 'create', addedOptions: [] },
        { name: 'Status', change: 'update', addedOptions: ['Needs Attention'] },
      ])
      expect(result.structured['view']).toEqual({ created: true, name: 'Lanes', url: VIEW_URL })
    })
  })

  describe('MCP の data', () => {
    const projectInput = { ...owned, title: 'board' }

    it('作ったプロジェクトの番号・URL・タイトル・owner を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-05')
      await explains('`project_create` の MCP の結果のテストです。プロジェクトを作成した場合は、作成したプロジェクトの番号・URL・タイトル・`owner` と `fields` を返すことを確認します。')
      const result = await tool('project_create', projectInput, createRules(), { config: false })
      expect(result.structured).toEqual({
        number: 1, url: BOARD_URL, title: 'board', owner: 'acme',
        fields: [
          { name: 'pecot-status', change: 'create', addedOptions: [] },
          NO_LANES_ROW,
          { name: 'Status', change: 'update', addedOptions: ['Needs Attention'] },
        ],
        warnings: [NO_LANES_WARNING],
      })
    })

    it('Status に Needs Attention を足せないと、warnings に入れて設定ファイルを作る', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-10')
      await explains('`project_create` の MCP の結果のテストです。Status に `Needs Attention` を追加できない場合は、`warnings` に含めて設定ファイルを作成することを確認します。')
      const rules = createRules().map(rule => rule.match.operation === 'UpdateProjectField' ? failing('UpdateProjectField') : rule)
      const result = await tool('project_create', projectInput, rules, { config: false })
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([NO_LANES_WARNING, expect.stringMatching(/^could not add option Needs Attention to field Status: /u)])
      expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    })

    it('同じタイトルのプロジェクトが既にあると、kind が already-exists の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-06')
      await explains('`project_create` の MCP の失敗のテストです。同じタイトルのプロジェクトが既に存在する場合は、`kind` が `already-exists` の失敗を返すことを確認します。')
      const result = await tool('project_create', projectInput, [graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }), listProjects(projectNode(1, 'board'))], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'already-exists' } })
      expect(requestLabels(result.requests)).not.toContain('CreateProject')
    })

    it('所有者が見つからないと、kind が github-not-found の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-07')
      await explains('`project_create` の MCP の失敗のテストです。所有者が見つからない場合は、`kind` が `github-not-found` の失敗を返すことを確認します。')
      const result = await tool('project_create', projectInput, [graphqlRule('GetUserNodeId', { user: null }), graphqlRule('GetOrgNodeId', { organization: null })], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'github-not-found', detail: 'owner not found: acme' } })
    })

    it('プロジェクトの作成で GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-08')
      await explains('`project_create` の MCP の失敗のテストです。プロジェクトの作成で GitHub API がエラーを返した場合は、`detail` に理由を含む失敗を返すことを確認します。')
      const result = await tool('project_create', projectInput, [graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }), listProjects(), failing('CreateProject')], { config: false })
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not create project: /u)
    })

    it('作ったプロジェクトが pecot-workflow に準拠しないと、kind が not-initialized の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-CREATE-09')
      await explains('`project_create` の MCP の失敗のテストです。作成したプロジェクトが pecot-workflow の要件を満たさない場合は、`kind` が `not-initialized` の失敗を返し、設定ファイルは作成しないことを確認します。')
      const result = await tool('project_create', projectInput, createRules(standardFields(['Backlog'])), { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized', number: 1, url: BOARD_URL } })
      expect(result.read(CONFIG_FILE)).toBeUndefined()
    })

    it('suffix を渡すと、入力の誤りとして失敗を返し、プロジェクトを作らない', async () => {
      await explains('`project_create` の廃止した入力のテストです。`suffix` を指定した場合は、入力の誤りとして失敗を返し、プロジェクトを作成しないことを確認します。')
      const result = await tool('project_create', { ...projectInput, suffix: 'acme' }, [], { config: false })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('suffix')
      expect(result.requests).toEqual([])
    })
  })
})

describe('board_show', () => {
  // 前提の無い Issue の読み取り。Active・In Review の Issue は読まれない
  const quietReady = (...numbers: number[]): ResponseRule[] => numbers.map(number => prerequisitesRule({ number }))
  const standardBoard = (): ResponseRule[] => [board(item('PVTI_1', 1, 'Ready'), item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'Archived', { state: 'CLOSED' })), twoAlerts(), ...quietReady(1)]
  const MARKDOWN = [
    '# Project info', '', '## Overview', `- Project: ${DEFAULT_HOST}_acme_1`, `- Host: ${DEFAULT_HOST}`, '- Owner: acme', '- Roadmap repo: none', '',
    '## Registered repositories', '- acme/demo (develop: main)', '    release_type: single', '    dependabot_alerts: open 2', '',
    '## Board status', '', '### Active (1)', '| Ref | Title |', '|-----|----------|', '| acme/demo#2 | 課題2 |', '', '### Ready (1)', '| Ref | Title | Readiness |', '|-----|----------|-----------|', '| acme/demo#1 | 課題1 | startable |', '',
  ].join('\n')

  // 登録順に 2 つのリポジトリを持つ設定
  const twoRepositories = projectConfig({ repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'main' }, { owner: 'acme', name: 'other' }] })

  function archivedItems(count: number): Json[] {
    return Array.from({ length: count }, (_unused, index) => item(`PVTI_a${String(index + 1).padStart(2, '0')}`, 100 + index, 'Archived', { state: 'CLOSED', updatedAt: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00Z` }))
  }

  // Archived より古い updatedAt の Ready・Active を混ぜる。Archived の絞り込みが無いと、これらも削除の対象になる
  const olderActive = (): Json[] => [
    item('PVTI_r1', 11, 'Ready', { updatedAt: '2026-01-01T00:00:00Z' }),
    item('PVTI_r2', 12, 'Active', { updatedAt: '2026-01-01T00:00:00Z' }),
    item('PVTI_r3', 13, 'Ready', { updatedAt: '2025-12-31T00:00:00Z' }),
  ]

  const olderRules = (): ResponseRule[] => quietReady(11, 13)

  it('引数なしで打つと、概要・登録リポジトリ・ボードの状態を Markdown で出す', async () => {
    await explains('`board_show` の出力のテストです。引数を指定しない場合は、概要・登録したリポジトリ・ボードの状態を Markdown で出力することを確認します。')
    const result = await run('board_show', {}, standardBoard())
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toBe(MARKDOWN)
    expect(result.stderr).toBe('')
  })

  it('進行の欄が旧い名前のボードでは、同じ内容を出し、旧い名前の警告と project_init の案内を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-BOARD-SHOW-36')
    await explains('`board_show` の旧い名前の進行の欄のテストです。進行の欄が旧い名前のボードでは、同じ内容を出力し、旧い名前の警告と `project_init` の案内を標準エラーへ出力することを確認します。')
    const legacy = { field: LEGACY_FIELD }
    const result = await run('board_show', {}, [board(item('PVTI_1', 1, 'Ready', legacy), item('PVTI_2', 2, 'Active', legacy), item('PVTI_3', 3, 'Archived', { state: 'CLOSED', ...legacy })), twoAlerts(), ...quietReady(1)])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toBe(MARKDOWN)
    expect(result.stderr).toBe(`warning: this board uses the old field name ${LEGACY_FIELD}\n  call project_init with owner: "acme", name: <name>, host: "ghes.example.com"\n`)
  })

  it('旧い設定（workflow_suffix 付き）で改名済みのボードを読んでも、同じ内容を出し、警告を出さない', async () => {
    await explains('`board_show` の旧い設定のテストです。`workflow_suffix` を持つ旧い設定で改名済みのボードを読んだ場合は、同じ内容を出力し、警告は出力しないことを確認します。')
    const result = await run('board_show', {}, standardBoard(), legacyConfig)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toBe(MARKDOWN.replace(`${DEFAULT_HOST}_acme_1`, () => LEGACY_NAME))
    expect(result.stderr).toBe('')
  })

  it('json を付けて打つと、同じ内容を JSON で出す', async () => {
    await explains('`board_show` の `json` のテストです。`json` を指定した場合は、同じ内容を JSON で出力することを確認します。')
    const result = await run('board_show', { json: true }, standardBoard())
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      project: { name: `${DEFAULT_HOST}_acme_1`, host: DEFAULT_HOST, owner: 'acme', number: 1, aggregation_repo: null },
      repositories: [{
        full_name: 'acme/demo',
        owner: 'acme',
        name: 'demo',
        develop_branch: 'main',
        release_branch: null,
        dependabot_alerts: { enabled: true, open_count: 2, max_severity: 'high', alerts_url: `https://${DEFAULT_HOST}/acme/demo/security/dependabot` },
      }],
      board: { items: [
        { id: 'PVTI_1', workflow: 'Ready', lane: null, title: '課題1', updatedAt: '2026-01-02T03:04:05Z', content: { number: 1, state: 'OPEN', url: `https://${DEFAULT_HOST}/acme/demo/issues/1`, labels: [], repository: 'acme/demo' }, readiness: { kind: 'startable', stackOn: null, reason: null, text: 'startable' } },
        { id: 'PVTI_2', workflow: 'Active', lane: null, title: '課題2', updatedAt: '2026-01-02T03:04:05Z', content: { number: 2, state: 'OPEN', url: `https://${DEFAULT_HOST}/acme/demo/issues/2`, labels: [], repository: 'acme/demo' }, readiness: null },
      ] },
      lanes: [],
    })
  })

  it('repo を渡すと、ボードの項目をそのリポジトリに絞る', async () => {
    await explains('`board_show` の `repo` のテストです。`repo` を指定した場合に、ボードの項目をそのリポジトリに絞り込むことを確認します。')
    const rules = [board(item('PVTI_1', 1, 'Ready'), item('PVTI_9', 9, 'Ready', { repo: 'other' })), twoAlerts(), prerequisitesRule({ number: 9, repo: 'other' })]
    const result = await run('board_show', { repo: 'acme/other' }, rules)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('## Board status (filter: acme/other)')
    expect(result.stdout).toContain('| acme/other#9 | 課題9 |')
    expect(result.stdout).not.toContain('acme/demo#1')
  })

  it('Archived の項目が 20 件を超えていても、ボードから何も削除しない', async () => {
    await explains('`board_show` の `Archived` の項目のテストです。`Archived` の項目が 20 件を超えていても、ボードから項目を削除せず、古い `Ready` と `Active` の項目も残ることを確認します。')
    const result = await run('board_show', {}, [board(...archivedItems(22), ...olderActive()), twoAlerts(), ...olderRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).not.toContain('DeleteProjectItem')
    expect(result.stderr).toBe('')
    // 古い updatedAt の Ready・Active も、ボードの状態に残る
    expect(result.stdout).toContain('| acme/demo#12 | 課題12 |')
    expect(result.stdout).toContain('| acme/demo#11 | 課題11 |')
    expect(result.stdout).toContain('| acme/demo#13 | 課題13 |')
  })

  it('aggregation_repo を設定していると、概要に Roadmap repo として出す', async () => {
    await explains('`board_show` の概要のテストです。`aggregation_repo` を設定している場合は、概要に `Roadmap repo` として出力することを確認します。')
    const result = await run('board_show', {}, standardBoard(), { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) })
    expect(result.stdout).toContain('- Roadmap repo: `acme/roadmap`\n')
  })

  it('Dependabot alert を取れたリポジトリの行に、open の件数か disabled を出す', async () => {
    await explains('`board_show` の Dependabot アラートの表示のテストです。アラートを取得できたリポジトリの行に、未解決の件数または `disabled` を出力することを確認します。')
    const rules = [board(), twoAlerts('demo'), alerts('other', { message: 'Forbidden' }, 403), restRule('GET', '/repos/acme/other/vulnerability-alerts', 404, { message: 'Not Found' })]
    const result = await run('board_show', {}, rules, { config: twoRepositories })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stdout).toContain('- acme/demo (develop: main)\n    release_type: single\n    dependabot_alerts: open 2\n')
    expect(result.stdout).toContain('- acme/other\n    release_type: single\n    dependabot_alerts: disabled\n')
  })

  it('登録したリポジトリの Dependabot alert を取れないと、その行に失敗の理由を出す', async () => {
    await explains('`board_show` の Dependabot アラートの取得に失敗した場合のテストです。登録したリポジトリのアラートを取得できない場合は、その行に失敗の理由を出力することを確認します。')
    const rules = [board(), twoAlerts('demo'), alerts('other', { message: 'Boom' }, 500)]
    const result = await run('board_show', {}, rules, { config: twoRepositories })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('    dependabot_alerts: open 2\n')
    expect(result.stdout).toMatch(/- acme\/other\n {4}release_type: single\n {4}dependabot_alerts: fetch failed \(acme\/other: .*Boom\)\n/u)
    // 取得は並行して送るので、受けた順は問わない
    expect(sorted(requestLabels(result.requests))).toEqual(sorted(['ListProjectItems', 'GET /repos/acme/demo/dependabot/alerts', 'GET /repos/acme/other/dependabot/alerts']))
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`board_show` のアクティブなプロジェクトのテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('board_show', {}, [], { config: false })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(NO_ACTIVE)
  })

  it('ボードの取得で GitHub API がエラーを返すと、終了コード 1 で終わる', async () => {
    await explains('`board_show` の GitHub API のエラーのテストです。ボードの取得で GitHub API がエラーを返した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('board_show', {}, [failing('ListProjectItems')])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not read project board: GraphQL query error: Server error '500 Internal Server Error'/u)
  })

  describe('着手の判定', () => {
    const FULL_WORKFLOW = { backlog: 'o1', blocked: 'ob', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' }
    const STATUS = { id: 'PVTSSF_status', options: { todo: 'st1', in_progress: 'st2', done: 'st3', needs_attention: 'st4' } }

    // Blocked と Status の値を持つ設定
    function boardConfig(repositories?: Json[]): Json {
      const base = projectConfig({ workflowOptions: FULL_WORKFLOW, ...repositories !== undefined && { repositories } })
      const project = asJson(base['project'])
      return { ...base, project: { ...project, fields: { ...asJson(project['fields']), status: STATUS } } }
    }

    const info = async (rules: ResponseRule[], config: Json = boardConfig(), input: Readonly<Record<string, unknown>> = {}): Promise<CommandResult> => await run('board_show', input, [twoAlerts(), ...rules], { config })
    const boardItems = (result: Readonly<CommandResult>): unknown => asJson(asJson(JSON.parse(result.stdout))['board'])['items']
    const notStarted = { number: 9 }
    const NOTE_ONE = 'warning: 1 Ready or Blocked Issue may be in a column or Status that does not match its judgment; run the pecot-board-sync workflow (Run workflow on its page in the Actions tab) to fix'
    const NOTE_TWO = NOTE_ONE.replace('1 Ready or Blocked Issue may be', '2 Ready or Blocked Issues may be')
    const failedRead = (): ResponseRule => ({ match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 })

    it('Ready と Blocked の表に Readiness の列を出し、判定とずれた列にあっても動かさない', async () => {
      await explains('`board_show` の `Readiness` の列のテストです。`Ready` と `Blocked` の表に `Readiness` の列を出力し、判定とずれた列にあっても項目は移動しないことを確認します。')
      const result = await info([
        board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')),
        prerequisitesRule({ number: 1, blockedBy: [notStarted] }),
        prerequisitesRule({ number: 4 }),
      ])
      expect(result.code).toBe(0)
      expectClean(result)
      expect(result.stderr).toBe(`${NOTE_TWO}\n`)
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
      expect(result.stdout).toContain([
        '### Blocked (1)',
        READINESS_HEADER,
        '| acme/demo#4 | 課題4 | startable |',
        '',
        '### Ready (1)',
        READINESS_HEADER,
        '| acme/demo#1 | 課題1 | blocked by #9 (not in review: #9 (not started)) |',
      ].join('\n'))
    })

    it('列と判定の食い違いそうな Issue を見つけると、件数と pecot-board-sync のワークフローの案内を 1 行、標準エラーに出す', async () => {
      await explains('`board_show` の列と判定の食い違いの案内のテストです。食い違っていそうな Issue が存在する場合は、件数と `pecot-board-sync` のワークフローの案内を標準エラーへ 1 行出力することを確認します。')
      const result = await info([board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked'), item('PVTI_5', 5, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 4, blockedBy: [notStarted] }), prerequisitesRule({ number: 5 })])
      expectClean(result)
      expect(result.stderr).toBe(`${NOTE_TWO}\n`)
    })

    it('board sync と同じ規則で数え、項目の食い違いを数え、動かす先の値がボードに存在しない Issue は数えない', async () => {
      await explains('`board_show` の列と判定の食い違いの件数のテストです。ボードの判定と同じ規則で数え、ラベルの食い違いも数え、移動先の選択肢がボードに存在しない Issue は数えないことを確認します。')
      const withoutBlocked = boardConfig()
      const project = asJson(withoutBlocked['project'])
      const fields = asJson(project['fields'])
      const workflow = asJson(fields['workflow'])
      const options = Object.fromEntries(Object.entries(asJson(workflow['options'])).filter(([name]) => name !== 'blocked'))
      const config = { ...withoutBlocked, project: { ...project, fields: { ...fields, workflow: { ...workflow, options } } } }
      const result = await info([board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, label: 'Needs Attention', blockedBy: [{ number: 5, state: 'CLOSED', pullRequests: [{ number: 50, state: 'MERGED' }] }] }), commentsRule(3)], config)
      expectClean(result)
      expect(result.stderr).toBe(`${NOTE_ONE}\n`)
    })

    it('Bot が書いた待ちの結果のコメントを持つ Needs Attention の項目は、食い違いに数えない', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-33')
      await explains('`board_show` の `Needs Attention` ラベルのテストです。Bot が書いた待ちの結果のコメントを持つ `Needs Attention` のラベルは、食い違いに数えないことを確認します。')
      const done: IssueSpec = { number: 5, state: 'CLOSED', pullRequests: [{ number: 50, state: 'MERGED' }] }
      const result = await info([board(item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 3, label: 'Needs Attention', blockedBy: [done] }), commentsRule(3, [botResult('question')])])
      expectClean(result)
      expect(result.stderr).toBe('')
    })

    it('Active と In Review の Issue は、前提を読まず、Readiness の列も出さない', async () => {
      await explains('`board_show` の `Active` と `In Review` の Issue のテストです。これらの Issue は、前提を取得せず、`Readiness` の列も出力しないことを確認します。')
      const result = await info([board(item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review'), item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1 })], boardConfig(), { json: true })
      expectClean(result)
      expect(variableValues(result, 'GetIssuePrerequisites', 'number')).toEqual([1])
      expect(boardItems(result)).toMatchObject([{ readiness: null }, { readiness: null }, { readiness: { kind: 'startable' } }])
    })

    it('一覧で前提が 0 件の Issue は、前提を個別に読まず、一覧の値で判定する', async () => {
      await explains('`board_show` の前提が 0 件の Issue のテストです。一覧で前提が 0 件の Issue は、前提を個別に取得せず、一覧の値で判定することを確認します。')
      const result = await info([board(item('PVTI_4', 4, 'Blocked', { progress: { blockedBy: 0 } }), item('PVTI_1', 1, 'Ready', { progress: { blockedBy: 0 } }))])
      expectClean(result)
      expect(result.stderr).toBe(`${NOTE_ONE}\n`)
      expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
      expect(result.stdout).toContain('| acme/demo#4 | 課題4 | startable |')
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | startable |')
    })

    it('一覧で前提が 0 件の Epic は、判定を出さず、前提を個別に読まない', async () => {
      await explains('`board_show` の Epic の判定のテストです。一覧で前提が 0 件の Epic は、判定を出力せず、前提を個別に取得しないことを確認します。')
      const result = await info([board(item('PVTI_1', 1, 'Ready', { progress: { blockedBy: 0, issueType: 'Epic' } }))], boardConfig(), { json: true })
      expectClean(result)
      expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
      expect(boardItems(result)).toMatchObject([{ readiness: null }])
    })

    it('一覧で前提が 1 件以上の Issue だけ、その件数で前提を読む', async () => {
      await explains('`board_show` の前提の取得のテストです。一覧で前提が 1 件以上の Issue だけ、その件数に応じて前提を取得することを確認します。')
      const result = await info([
        board(item('PVTI_1', 1, 'Ready', { progress: { blockedBy: 1 } }), item('PVTI_5', 5, 'Ready', { progress: { blockedBy: 0 } }), item('PVTI_6', 6, 'Ready', { progress: { blockedBy: 60 } }), item('PVTI_7', 7, 'Ready', { progress: { blockedBy: 9 } })),
        prerequisitesRule({ number: 1, blockedBy: [notStarted] }),
        prerequisitesRule({ number: 6, blockedBy: [notStarted] }),
        prerequisitesRule({ number: 7, blockedBy: [notStarted] }),
      ])
      expectClean(result)
      expect(variableValues(result, 'GetIssuePrerequisites', 'number')).toEqual([1, 6, 7])
      expect(variableValues(result, 'GetIssuePrerequisites', 'blockedByFirst')).toEqual([8, 50, 9])
    })

    it('読み取りに失敗した Issue は unknown と出し、列を動かさない', async () => {
      await explains('`board_show` の前提を取得できない場合のテストです。取得に失敗した Issue は `unknown` と出力し、列は移動しないことを確認します。')
      const result = await info([board(item('PVTI_1', 1, 'Ready')), failedRead()])
      expectClean(result)
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/\| acme\/demo#1 \| 課題1 \| unknown \(GraphQL query error: Server error '500 Internal Server Error' for url '[^']+' For more information check: [^)]+\) \|/u)
      expect(result.stderr).toBe('')
    })

    it('読み取りに失敗した Issue の JSON の readiness は、stackOn と reason を null で持つ', async () => {
      await explains('`board_show` の前提を取得できない場合のテストです。取得に失敗した Issue の JSON では、`readiness` の `stackOn` と `reason` が `null` になることを確認します。')
      const result = await info([board(item('PVTI_1', 1, 'Ready')), failedRead()], boardConfig(), { json: true })
      expectClean(result)
      expect(boardItems(result)).toMatchObject([{ readiness: { kind: 'unknown', stackOn: null, reason: null } }])
    })

    it('前提が存在しない Issue だけのボードでは、すべて startable で、列を動かさない', async () => {
      await explains('`board_show` の前提を持たない Issue のテストです。前提を持たない Issue だけのボードでは、すべて `startable` と判定し、列は移動しないことを確認します。')
      const result = await info([board(item('PVTI_1', 1, 'Ready'), item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review')), prerequisitesRule({ number: 1 })])
      expectClean(result)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | startable |')
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
    })

    it('前提の Issue への言及を読まず、Development 欄のマージ済みの PR で、済んだ前提と判定する', async () => {
      await explains('`board_show` の済んだ前提の判定のテストです。前提の Issue への言及は読まず、Development 欄にマージ済みの PR がある場合に、済んだ前提と判定することを確認します。')
      const done: IssueSpec = { number: 9, state: 'CLOSED', pullRequests: [{ number: 90, state: 'MERGED' }] }
      const result = await info([board(item('PVTI_1', 1, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [done] })])
      expectClean(result)
      expect(requestLabels(result.requests)).toContain('GetIssuePrerequisites')
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | startable |')
    })

    it('PR のカードと Tracker は、前提を読まない', async () => {
      await explains('`board_show` の対象外のカードのテストです。PR のカードと Tracker は、前提を取得しないことを確認します。')
      const pullRequest = item('PVTI_5', 5, 'Ready')
      const tracker = item('PVTI_6', 6, 'Ready')
      const result = await info([
        board(
          { ...pullRequest, content: { ...asJson(pullRequest['content']), url: `https://${DEFAULT_HOST}/acme/demo/pull/5` } },
          { ...tracker, content: { ...asJson(tracker['content']), title: '[Tracker] 進め方' } },
          item('PVTI_1', 1, 'Ready'),
        ),
        prerequisitesRule({ number: 1 }),
      ])
      expectClean(result)
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | startable |')
      expect(result.stdout).toContain('| acme/demo#5 | 課題5 | - |')
    })

    it('Epic は判定を出さず、JSON の readiness は null', async () => {
      await explains('`board_show` の Epic の判定のテストです。Epic は判定を出力せず、JSON の `readiness` が `null` になることを確認します。')
      const result = await info([board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, issueType: 'Epic', subIssues: 2 })], boardConfig(), { json: true })
      expectClean(result)
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
      expect(boardItems(result)).toMatchObject([{ readiness: null }])
    })

    it('develop_branch が存在しないリポジトリで済んでいない前提があると、unknown と出し、列を動かさない', async () => {
      await explains('`board_show` の `develop_branch` が未設定の場合のテストです。`develop_branch` が未設定のリポジトリで済んでいない前提がある場合は、`unknown` と出力し、列は移動しないことを確認します。')
      const result = await info([board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] })], boardConfig([{ owner: 'acme', name: 'demo' }]))
      expectClean(result)
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | unknown (develop_branch is not set for acme/demo) |')
      expect(result.stderr).toBe('')
    })

    it('Issue の依存関係に対応しない GHES では、warning を 1 回出し、Readiness の列が存在しない表を出す', async () => {
      await explains('`board_show` の依存関係に対応しない GHES のテストです。Issue の依存関係に対応しない GHES では、`warning` を 1 回出力し、`Readiness` の列を省略した表を出力することを確認します。')
      const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      const result = await info([board(item('PVTI_1', 1, 'Ready')), unsupported])
      expectClean(result)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: this GitHub Enterprise Server does not support issue dependencies (blockedBy); the Readiness column is omitted\n')
      expect(result.stdout).toContain('### Ready (1)\n| Ref | Title |\n|-----|----------|\n| acme/demo#1 | 課題1 |')
    })

    it('一覧の新しいクエリがスキーマの失敗になると、古いクエリで読み直し、判定を出さない', async () => {
      await explains('`board_show` の依存関係に対応しない GHES のテストです。一覧の新しいクエリがスキーマのエラーになった場合は、古いクエリで取得し直し、判定は出力しないことを確認します。')
      const rejected: ResponseRule = { match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      const legacy = graphqlRule('ListProjectItemsLegacy', { node: { items: { nodes: [item('PVTI_1', 1, 'Ready')], pageInfo: { hasNextPage: false, endCursor: null } } } })
      const result = await info([rejected, legacy])
      expectClean(result)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: this GitHub Enterprise Server does not support issue dependencies (blockedBy); the Readiness column is omitted\n')
      expect(result.stdout).toContain('### Ready (1)\n| Ref | Title |\n|-----|----------|\n| acme/demo#1 | 課題1 |')
      expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
    })

    describe('スタックできる並び', () => {
      // Epic #10 の子 #2 が PR 中で、#3 がその上にスタックできる
      const chain = (): ResponseRule[] => [
        board(item('PVTI_2', 2, 'In Review'), item('PVTI_3', 3, 'Ready')),
        prerequisitesRule({ number: 3, parent: { number: 10 }, blockedBy: [{ number: 2, column: 'In Review', branch: 'feat/2', pullRequests: [{ number: 20, head: 'feat/2' }] }] }),
      ]

      it('json は、各 Issue に readiness を足す', async () => {
        await explains('`board_show` のスタックできる並びのテストです。`json` を指定した場合は、各 Issue に `readiness` を含めることを確認します。')
        const result = await info(chain(), boardConfig(), { json: true })
        expectClean(result)
        expect(boardItems(result)).toMatchObject([
          { readiness: null },
          { readiness: { kind: 'stackable', stackOn: { number: 2, repository: 'acme/demo', branch: 'feat/2' }, reason: null, text: 'stackable on #2' } },
        ])
      })
    })

    it('前提が輪になっている Issue は、cycle の blocked にする', async () => {
      await explains('`board_show` の前提が循環している場合のテストです。前提が輪になっている Issue は、`cycle` を理由とする `blocked` と判定することを確認します。')
      const result = await info([
        board(item('PVTI_1', 1, 'Blocked'), item('PVTI_2', 2, 'Blocked')),
        prerequisitesRule({ number: 1, blockedBy: [{ number: 2 }] }),
        prerequisitesRule({ number: 2, blockedBy: [{ number: 1 }] }),
      ])
      expectClean(result)
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | blocked by #2 (cycle: #1 -> #2 -> #1) |')
      expect(result.stdout).toContain('| acme/demo#2 | 課題2 | blocked by #1 (cycle: #1 -> #2 -> #1) |')
    })

    describe('MCP の呼び出し', () => {
      const infoTool = async (rules: ResponseRule[], config: Json = boardConfig()): ReturnType<typeof runTool> => await tool('board_show', {}, [twoAlerts(), ...rules], { config })
      const itemsOf = (result: Readonly<{ structured: Readonly<Record<string, unknown>> }>): unknown => asJson(result.structured['board'])['items']

      it('Ready と Blocked の Issue の readiness に判定を入れ、判定とずれた列にあっても動かさない', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-14')
        await explains('`board_show` の MCP の結果のテストです。`Ready` と `Blocked` の Issue の `readiness` に判定を含め、判定とずれた列にあっても項目は移動しないことを確認します。')
        const result = await infoTool([
          board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')),
          prerequisitesRule({ number: 1, blockedBy: [notStarted] }),
          prerequisitesRule({ number: 4 }),
        ])
        expectClean(result)
        expect(result.isError).toBe(false)
        expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
        expect(itemsOf(result)).toMatchObject([
          { id: 'PVTI_1', readiness: { kind: 'blocked', reason: 'not-in-review' } },
          { id: 'PVTI_4', readiness: { kind: 'startable' } },
        ])
      })

      it('列と判定の食い違いそうな Issue を数え、件数を mismatches に入れ、warnings に pecot-board-sync のワークフローの案内を入れる', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-33')
        await explains('`board_show` の MCP の結果のテストです。列と判定が食い違っていそうな Issue の件数を `mismatches` に含め、`pecot-board-sync` のワークフローの案内を `warnings` に含めることを確認します。')
        const result = await infoTool([board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked'), item('PVTI_5', 5, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 4, blockedBy: [notStarted] }), prerequisitesRule({ number: 5 })])
        expectClean(result)
        expect(result.structured['mismatches']).toBe(2)
        expect(result.structured['warnings']).toEqual(['2 Ready or Blocked Issues may be in a column or Status that does not match its judgment; run the pecot-board-sync workflow (Run workflow on its page in the Actions tab) to fix'])
      })

      it('Active と In Review の Issue は、前提を読まず、readiness を null にする', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-15')
        await explains('`board_show` の MCP の結果のテストです。`Active` と `In Review` の Issue は、前提を取得せず、`readiness` を `null` にすることを確認します。')
        const result = await infoTool([board(item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review'), item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1 })])
        expectClean(result)
        expect(variableValues(result, 'GetIssuePrerequisites', 'number')).toEqual([1])
        expect(itemsOf(result)).toMatchObject([{ readiness: null }, { readiness: null }, { readiness: { kind: 'startable' } }])
      })

      it('一覧で前提が 0 件の Issue は、前提を個別に読まず、一覧の値で判定する', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-30')
        await explains('`board_show` の MCP の結果のテストです。一覧で前提が 0 件の Issue は、前提を個別に取得せず、一覧の値で判定することを確認します。')
        const result = await infoTool([board(item('PVTI_4', 4, 'Blocked', { progress: { blockedBy: 0 } }), item('PVTI_1', 1, 'Ready', { progress: { blockedBy: 0 } }))])
        expectClean(result)
        expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
        expect(itemsOf(result)).toMatchObject([{ readiness: { kind: 'startable' } }, { readiness: { kind: 'startable' } }])
      })

      it('一覧で前提が 1 件以上の Issue だけ、その件数を下限 8・上限 50 に収めて前提を読む', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-31')
        await explains('`board_show` の MCP の結果のテストです。一覧で前提が 1 件以上の Issue だけ、件数を下限 8・上限 50 に収めて前提を取得することを確認します。')
        const result = await infoTool([
          board(item('PVTI_1', 1, 'Ready', { progress: { blockedBy: 1 } }), item('PVTI_5', 5, 'Ready', { progress: { blockedBy: 0 } }), item('PVTI_6', 6, 'Ready', { progress: { blockedBy: 60 } }), item('PVTI_7', 7, 'Ready', { progress: { blockedBy: 9 } })),
          prerequisitesRule({ number: 1, blockedBy: [notStarted] }),
          prerequisitesRule({ number: 6, blockedBy: [notStarted] }),
          prerequisitesRule({ number: 7, blockedBy: [notStarted] }),
        ])
        expectClean(result)
        expect(variableValues(result, 'GetIssuePrerequisites', 'number')).toEqual([1, 6, 7])
        expect(variableValues(result, 'GetIssuePrerequisites', 'blockedByFirst')).toEqual([8, 50, 9])
      })

      it('前提を読めない Issue は、readiness を unknown にし、stackOn と reason を null にして、列を動かさない', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-18')
        await verifies(context, 'PW-BOARD-SHOW-32')
        await explains('`board_show` の MCP の結果のテストです。前提を取得できない Issue は、`readiness` を `unknown` にし、`stackOn` と `reason` を `null` にして、列は移動しないことを確認します。')
        const result = await infoTool([board(item('PVTI_1', 1, 'Ready')), failedRead()])
        expectClean(result)
        expect(result.isError).toBe(false)
        expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
        expect(itemsOf(result)).toMatchObject([{ readiness: { kind: 'unknown', stackOn: null, reason: null } }])
      })

      it('前提が存在しない Issue だけのボードでは、すべて startable にし、列を動かさない', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-20')
        await explains('`board_show` の MCP の結果のテストです。前提を持たない Issue だけのボードでは、すべて `startable` にし、列は移動しないことを確認します。')
        const result = await infoTool([board(item('PVTI_1', 1, 'Ready'), item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review')), prerequisitesRule({ number: 1 })])
        expectClean(result)
        expect(result.structured['mismatches']).toBe(0)
        expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
        expect(itemsOf(result)).toMatchObject([{ readiness: { kind: 'startable' } }, { readiness: null }, { readiness: null }])
      })

      it('前提の Issue への言及を読まず、Development 欄のマージ済みの PR で、済んだ前提と判定する', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-35')
        await explains('`board_show` の MCP の結果のテストです。前提の Issue への言及は読まず、Development 欄のマージ済みの PR で、済んだ前提と判定することを確認します。')
        const done: IssueSpec = { number: 9, state: 'CLOSED', pullRequests: [{ number: 90, state: 'MERGED' }] }
        const result = await infoTool([board(item('PVTI_1', 1, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [done] })])
        expectClean(result)
        expect(itemsOf(result)).toMatchObject([{ readiness: { kind: 'startable' } }])
      })

      it('PR のカードと Tracker は、前提を読まず、readiness を null にする', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-22')
        await explains('`board_show` の MCP の結果のテストです。PR のカードと Tracker は、前提を取得せず、`readiness` を `null` にすることを確認します。')
        const pullRequest = item('PVTI_5', 5, 'Ready')
        const tracker = item('PVTI_6', 6, 'Ready')
        const result = await infoTool([
          board(
            { ...pullRequest, content: { ...asJson(pullRequest['content']), url: `https://${DEFAULT_HOST}/acme/demo/pull/5` } },
            { ...tracker, content: { ...asJson(tracker['content']), title: '[Tracker] 進め方' } },
            item('PVTI_1', 1, 'Ready'),
          ),
          prerequisitesRule({ number: 1 }),
        ])
        expectClean(result)
        expect(variableValues(result, 'GetIssuePrerequisites', 'number')).toEqual([1])
        expect(itemsOf(result)).toMatchObject([{ readiness: null }, { readiness: null }, { readiness: { kind: 'startable' } }])
      })

      it('Epic は判定をせず、readiness を null にする', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-23')
        await explains('`board_show` の MCP の結果のテストです。Epic は判定せず、`readiness` を `null` にすることを確認します。')
        const result = await infoTool([board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, issueType: 'Epic', subIssues: 2 })])
        expectClean(result)
        expect(itemsOf(result)).toMatchObject([{ readiness: null }])
      })

      it('develop_branch が存在しないリポジトリで済んでいない前提があると、readiness を unknown にする', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-24')
        await explains('`board_show` の MCP の結果のテストです。`develop_branch` が未設定のリポジトリで済んでいない前提がある場合は、`readiness` を `unknown` にすることを確認します。')
        const result = await infoTool([board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] })], boardConfig([{ owner: 'acme', name: 'demo' }]))
        expectClean(result)
        expect(itemsOf(result)).toMatchObject([{ readiness: { kind: 'unknown', text: 'unknown (develop_branch is not set for acme/demo)' } }])
      })

      it.for([
        { name: '前提の読み取りがスキーマの失敗になる', rules: (): ResponseRule[] => [board(item('PVTI_1', 1, 'Ready')), { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }] },
        { name: '一覧の新しいクエリがスキーマの失敗になる', rules: (): ResponseRule[] => [{ match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }, graphqlRule('ListProjectItemsLegacy', { node: { items: { nodes: [item('PVTI_1', 1, 'Ready')], pageInfo: { hasNextPage: false, endCursor: null } } } })] },
      ])('$name とき、warnings に 1 つ入れ、readiness を持たないボードを返す', async (row, context) => {
        await verifies(context, 'PW-BOARD-SHOW-25')
        await explains(`\`board_show\` の MCP の結果のテストです。条件が「${row.name}」の場合に、\`warnings\` に 1 件含め、\`readiness\` を持たないボードを返すことを確認します。`)
        const result = await infoTool(row.rules())
        expectClean(result)
        expect(result.isError).toBe(false)
        expect(result.structured['warnings']).toEqual(['this GitHub Enterprise Server does not support issue dependencies (blockedBy); the Readiness column is omitted'])
        const items = jsonList(itemsOf(result))
        expect(items).toHaveLength(1)
        expect(items[0]).not.toHaveProperty('readiness')
      })

      it('スタックできる並びの Issue は、readiness に stackable とスタック先を入れる', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-27')
        await explains('`board_show` の MCP の結果のテストです。スタックできる並びの Issue は、`readiness` に `stackable` とスタック先を含めることを確認します。')
        const result = await infoTool([
          board(item('PVTI_2', 2, 'In Review'), item('PVTI_3', 3, 'Ready')),
          prerequisitesRule({ number: 3, parent: { number: 10 }, blockedBy: [{ number: 2, column: 'In Review', branch: 'feat/2', pullRequests: [{ number: 20, head: 'feat/2' }] }] }),
        ])
        expectClean(result)
        expect(itemsOf(result)).toMatchObject([
          { readiness: null },
          { readiness: { kind: 'stackable', stackOn: { number: 2, repository: 'acme/demo', branch: 'feat/2' }, reason: null, text: 'stackable on #2' } },
        ])
      })

      it('前提が輪になっている Issue は、readiness を cycle の blocked にする', async (context) => {
        await verifies(context, 'PW-BOARD-SHOW-28')
        await explains('`board_show` の MCP の結果のテストです。前提が輪になっている Issue は、`readiness` を `cycle` を理由とする `blocked` にすることを確認します。')
        const result = await infoTool([
          board(item('PVTI_1', 1, 'Blocked'), item('PVTI_2', 2, 'Blocked')),
          prerequisitesRule({ number: 1, blockedBy: [{ number: 2 }] }),
          prerequisitesRule({ number: 2, blockedBy: [{ number: 1 }] }),
        ])
        expectClean(result)
        expect(itemsOf(result)).toMatchObject([
          { readiness: { kind: 'blocked', reason: 'cycle', text: 'blocked by #2 (cycle: #1 -> #2 -> #1)' } },
          { readiness: { kind: 'blocked', reason: 'cycle', text: 'blocked by #1 (cycle: #1 -> #2 -> #1)' } },
        ])
      })
    })
  })

  describe('MCP の呼び出し', () => {
    const show = async (toolArguments: Record<string, unknown>, rules: readonly ResponseRule[], extra: Partial<CommandRun> = {}): ReturnType<typeof runTool> => await tool('board_show', toolArguments, rules, extra)
    const itemIds = (result: Readonly<{ structured: Readonly<Record<string, unknown>> }>): unknown[] => jsonList(asJson(result.structured['board'])['items']).map(entry => entry['id'])
    const repositoriesOfResult = (result: Readonly<{ structured: Readonly<Record<string, unknown>> }>): Json[] => jsonList(result.structured['repositories'])

    it('repo を付けると、ボードの項目をそのリポジトリに絞る', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-03')
      await explains('`board_show` の `repo` 引数のテストです。`repo` を指定した場合は、ボードの項目をそのリポジトリのものだけに絞って返すことを確認します。')
      const result = await show({ repo: 'acme/other' }, [board(item('PVTI_1', 1, 'Ready'), item('PVTI_9', 9, 'Ready', { repo: 'other' })), twoAlerts(), prerequisitesRule({ number: 9, repo: 'other' })])
      expect(result.isError).toBe(false)
      expect(itemIds(result)).toEqual(['PVTI_9'])
    })

    it('Archived の項目が 20 件を超えていても、ボードから何も削除しない', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-34')
      await explains('`board_show` の Archived の項目のテストです。Archived の項目が 20 件を超えている場合でも、`DeleteProjectItem` を送信せず、ボードから項目を削除しないことを確認します。')
      const result = await show({}, [board(...archivedItems(22), ...olderActive()), twoAlerts(), ...olderRules()])
      expectClean(result)
      expect(requestLabels(result.requests)).not.toContain('DeleteProjectItem')
      expect(itemIds(result)).toEqual(expect.arrayContaining(['PVTI_r1', 'PVTI_r2', 'PVTI_r3']))
    })

    it('aggregation_repo を設定していると、project の aggregation_repo にその値を入れる', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-05')
      await explains('`board_show` の `aggregation_repo` のテストです。設定ファイルに `aggregation_repo` を設定している場合は、結果の `project` にその値を含めることを確認します。')
      const result = await show({}, standardBoard(), { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) })
      expect(asJson(result.structured['project'])['aggregation_repo']).toBe('acme/roadmap')
    })

    it('Dependabot alert を取れたリポジトリの dependabot_alerts に、有効かどうかと open の件数を入れる', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-06')
      await explains('`board_show` の Dependabot alert のテストです。alert を取得できたリポジトリは、`dependabot_alerts` に有効かどうかと open の件数などを含めることを確認します。')
      const rules = [board(), twoAlerts('demo'), alerts('other', { message: 'Forbidden' }, 403), restRule('GET', '/repos/acme/other/vulnerability-alerts', 404, { message: 'Not Found' })]
      const result = await show({}, rules, { config: twoRepositories })
      expect(result.problems).toEqual([])
      expect(repositoriesOfResult(result).map(entry => entry['dependabot_alerts'])).toEqual([
        { enabled: true, open_count: 2, max_severity: 'high', alerts_url: `https://${DEFAULT_HOST}/acme/demo/security/dependabot` },
        { enabled: false, open_count: 0, max_severity: null, alerts_url: `https://${DEFAULT_HOST}/acme/other/security/dependabot` },
      ])
    })

    it('登録したリポジトリの Dependabot alert を取れないと、その dependabot_alerts に失敗の理由を入れる', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-08')
      await explains('`board_show` の Dependabot alert を取得できない場合のテストです。登録したリポジトリの取得に失敗した場合は、`dependabot_alerts` に失敗の理由だけを含めることを確認します。')
      const rules = [board(), twoAlerts('demo'), alerts('other', { message: 'Boom' }, 500)]
      const result = await show({}, rules, { config: twoRepositories })
      expect(result.isError).toBe(false)
      const failure = asJson(repositoriesOfResult(result)[1]?.['dependabot_alerts'])
      expect(Object.keys(failure)).toEqual(['error'])
      expect(failure['error']).toMatch(/^acme\/other: .*Boom/u)
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-10')
      await explains('`board_show` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await show({}, [], { config: false })
      expect(result.isError).toBe(true)
      expect(result.structured).toEqual({ kind: 'no-active-project', detail: 'no active project\n  call project_activate with project: <PROJECT>' })
    })

    it('ボードの取得で GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-11')
      await explains('`board_show` の GitHub API のエラーのテストです。ボードの取得でエラーが返った場合は、`kind` が `github-api` の失敗を返すことを確認します。')
      const result = await show({}, [failing('ListProjectItems')])
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('github-api')
      expect(result.structured['detail']).toMatch(/^could not read project board: GraphQL query error: Server error '500 Internal Server Error'/u)
    })
  })
})

describe('project_activate', () => {
  const reference = (project: string): Readonly<Record<string, unknown>> => ({ project, host: DEFAULT_HOST, owner: 'acme' })
  const NAME = path.parse(CONFIG_FILE).name
  const activateByNumber = async (extra: Partial<CommandRun> = {}, linkedNames: string[] = []): Promise<CommandResult> =>
    await run('project_activate', reference('1'), [projectFields(), ...syncRules(...linkedNames)], { config: false, ...extra })
  const existing = (repositories: Json[], extra: Json = {}): Partial<CommandRun> => ({ config: projectConfig({ repositories, extra }) })

  it('プロジェクトの番号か名前を渡すと、そのプロジェクトの設定ファイルを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-04')
    await explains('`project_activate` の設定ファイルの作成のテストです。プロジェクトの番号か名前を指定した場合は、同じ内容の設定ファイルを作成し、標準エラーに `created` の行を出力することを確認します。')
    const byNumber = await activateByNumber()
    expect(byNumber.code).toBe(0)
    expectClean(byNumber)
    expect(byNumber.stderr).toBe(`created: config file ${configPathOf(byNumber)}\nset: active project to ${NAME}\n`)
    expect(savedConfig(byNumber)).toMatchObject({ host: DEFAULT_HOST, owner: 'acme', project: { number: 1, id: 'PVT_1' } })
    const byName = await run('project_activate', reference('board'), [listProjects(projectNode(1, 'board')), projectFields(), ...syncRules()], { config: false })
    expect(byName.code).toBe(0)
    expectClean(byName)
    expect(byName.read(CONFIG_FILE)).toBe(byNumber.read(CONFIG_FILE))
  })

  it('プロジェクトの番号か名前を渡すと、そのプロジェクトをアクティブにする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-05')
    await explains('`project_activate` のアクティブな設定のテストです。プロジェクトの番号か名前を指定した場合は、そのプロジェクトの設定ファイルをアクティブにすることを確認します。')
    const result = await activateByNumber()
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('設定ファイルのパスかファイル名を渡すと、host を渡さなくても設定ファイルの host で同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-06')
    await explains('`project_activate` の設定ファイルの指定のテストです。設定ファイルのパスかファイル名を指定した場合は、`host` を省略しても設定ファイルの host で同期することを確認します。')
    const result = await run('project_activate', { project: NAME }, [projectFields(), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`updated: config file ${configPathOf(result)}\nset: active project to ${NAME}\n`)
    const filePath = path.join(PROJECTS_DIRECTORY, path.basename(CONFIG_FILE))
    const byPath = await run('project_activate', { project: filePath }, [projectFields(), ...syncRules()])
    expect(byPath.code).toBe(0)
    expectClean(byPath)
  })

  it('同期した中身が既存の設定ファイルと同じだと、書き換えずに change を unchanged にし、アクティブにする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-25')
    await explains('`project_activate` の同期した内容が既存の設定ファイルと同じ場合のテストです。設定ファイルを書き換えず、`change` を `unchanged` にして、アクティブにすることを確認します。')
    const first = await activateByNumber()
    const again = await activateByNumber({ config: savedConfig(first) })
    expect(again.code).toBe(0)
    expectClean(again)
    expect(again.stderr).toBe(`set: active project to ${NAME}\n`)
    expect(again.read(CONFIG_FILE)).toBe(first.read(CONFIG_FILE))
    expect(again.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    const data = await tool('project_activate', { ...owned, project: '1' }, [projectFields(), ...syncRules()], { config: savedConfig(first) })
    expect(data.structured).toMatchObject({ change: 'unchanged', project: NAME })
  })

  it('設定ファイルに fields.priority・fields.size が残っていると、ボードと同じ内容でも update で書き直し、2 つのキーを消す', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-28')
    await explains('`project_activate` の古い `fields.priority` と `fields.size` のテストです。設定ファイルにこの 2 つのキーが残っている場合は、ボードと同じ内容でも `update` で書き直してキーを削除することを確認します。')
    const first = await activateByNumber()
    const again = await activateByNumber({ config: withOldFields(savedConfig(first)) })
    expect(again.code).toBe(0)
    expectClean(again)
    expect(again.stderr).toBe(`updated: config file ${configPathOf(again)}\nset: active project to ${NAME}\n`)
    expect(again.read(CONFIG_FILE)).toBe(first.read(CONFIG_FILE))
    const data = await tool('project_activate', { ...owned, project: '1' }, [projectFields(), ...syncRules()], { config: withOldFields(savedConfig(first)) })
    expect(data.structured).toMatchObject({ change: 'update', project: NAME })
  })

  it('pecot-status と旧い名前の進行の欄が両方あるボードでも、pecot-status の欄で同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-24')
    await explains('`project_activate` の進行の欄のテストです。`pecot-status` と旧い名前の進行の欄が両方ある場合でも、`pecot-status` の欄で同期することを確認します。')
    const legacy = { id: 'PVTSSF_legacy', name: LEGACY_FIELD, options: options(WORKFLOW_NAMES) }
    const [title, ...rest] = standardFields()
    const fields = [title ?? {}, legacy, ...rest]
    const result = await run('project_activate', { project: NAME }, [projectFields(fields), listProjects(projectNode(1, 'board')), projectFields(fields), linked()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(savedConfig(result)).toMatchObject({ project: { fields: { workflow: { id: 'PVTSSF_workflow' } } } })
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('旧い名前の進行の欄だけがあるボードも、初期化済みとして同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-27')
    await explains('`project_activate` の旧い名前の進行の欄のテストです。旧い名前の進行の欄だけがあるボードの場合は、初期化済みとして同期することを確認します。')
    const [title, , ...rest] = standardFields()
    const fields = [title ?? {}, { id: 'PVTSSF_workflow', name: LEGACY_FIELD, options: options(WORKFLOW_NAMES) }, ...rest]
    const result = await run('project_activate', reference('1'), [projectFields(fields), listProjects(projectNode(1, 'board')), projectFields(fields), linked()], { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(savedConfig(result)).toMatchObject({ project: { fields: { workflow: { id: 'PVTSSF_workflow' } } } })
  })

  it('旧い名前の設定ファイルを渡すと、新しい名前に移し、アクティブな設定を新しい名前にする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-26')
    await explains('`project_activate` の旧い名前の設定ファイルのテストです。旧い名前の設定ファイルを指定した場合は、新しい名前へ移動し、アクティブな設定も新しい名前にすることを確認します。')
    const result = await run('project_activate', { project: LEGACY_NAME }, [projectFields(), ...syncRules()], legacyConfig)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`moved: config file ${path.join(result.directory, LEGACY_CONFIG_FILE)} to ${configPathOf(result)}\n${movedNote(NAME)}updated: config file ${configPathOf(result)}\nset: active project to ${NAME}\n`)
    expect(result.read(LEGACY_CONFIG_FILE)).toBeUndefined()
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('owner を省くと、認証したユーザーのプロジェクトを対象にする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-07')
    await explains('`project_activate` の `owner` のテストです。`owner` を省略した場合は、認証したユーザーのプロジェクトを対象にすることを確認します。')
    const result = await run('project_activate', { project: 'board', host: DEFAULT_HOST }, [restRule('GET', '/user', 200, { login: 'acme' }), listProjects(projectNode(1, 'board')), projectFields(), ...syncRules()], { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(savedConfig(result)).toMatchObject({ host: DEFAULT_HOST, owner: 'acme', project: { number: 1 } })
  })

  it('既存の設定ファイルがあるプロジェクトを同期すると、リポジトリごとの branches・changelog_file・packages・release_type を引き継ぐ', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-08')
    await explains('`project_activate` の既存の設定の引き継ぎのテストです。既存の設定ファイルがあるプロジェクトを同期した場合は、リポジトリごとの `branches` や `packages` などを引き継ぐことを確認します。')
    const kept = { owner: 'acme', name: 'demo', develop_branch: 'dev', release_branch: 'rel', packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }], release_type: 'multi' }
    const withLog = { owner: 'acme', name: 'logged', changelog_file: 'docs/CHANGELOG.md', release_type: 'nx' }
    const result = await activateByNumber(existing([kept, withLog]), ['demo', 'logged'])
    expect(result.code).toBe(0)
    expect(repositoriesOf(result)).toEqual([kept, withLog])
  })

  it('既存の設定ファイルがあるプロジェクトを同期すると、aggregation_repo を引き継ぐ', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-09')
    await explains('`project_activate` の `aggregation_repo` の引き継ぎのテストです。既存の設定ファイルがあるプロジェクトを同期した場合は、`aggregation_repo` を引き継ぐことを確認します。')
    const result = await activateByNumber(existing([{ owner: 'acme', name: 'demo' }], { aggregation_repo: 'acme/roadmap' }), ['demo'])
    expect(savedConfig(result)['aggregation_repo']).toBe('acme/roadmap')
  })

  it('リンクを外したリポジトリがあるプロジェクトを同期すると、そのリポジトリを設定ファイルから消す', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-10')
    await explains('`project_activate` のリンクを外したリポジトリのテストです。リンクを外したリポジトリがある場合は、そのリポジトリを設定ファイルから削除することを確認します。')
    const result = await activateByNumber(existing([{ owner: 'acme', name: 'demo' }, { owner: 'acme', name: 'gone' }]), ['demo'])
    expect(repositoriesOf(result)).toEqual([{ owner: 'acme', name: 'demo' }])
  })

  it('新しくリンクしたリポジトリがあるプロジェクトを同期すると、そのリポジトリを設定ファイルの末尾に足す', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-11')
    await explains('`project_activate` の新しくリンクしたリポジトリのテストです。新しくリンクしたリポジトリがある場合は、そのリポジトリを設定ファイルの末尾に追加することを確認します。')
    const result = await activateByNumber(existing([{ owner: 'acme', name: 'demo' }]), ['fresh', 'demo'])
    const names = repositoryEntries(result).map(entry => entry['name'])
    expect(names).toEqual(['demo', 'fresh'])
  })

  it('host が要る場面で渡していないと、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の `host` が不足している場合のテストです。`host` が必要な場面で指定していない場合は、使い方を示すエラーを標準エラーへ出力し、終了コード 1 で終わることを確認します。')
    const result = await run('project_activate', { project: '1' }, [], { config: false })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: host is required\n  example: project_activate with project: "1", host: "github.com", owner: "example-org"\n  example: project_activate with project: "example-project", host: "ghes.example.com", owner: "example-org"\n  example: project_activate with project: "ghes.example.com_example-org_1"\n')
  })

  it('指定したプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の指定したプロジェクトが存在しない場合のテストです。番号と名前のどちらで指定しても存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const byNumber = await run('project_activate', reference('999'), missingProject(), { config: false })
    expect(byNumber.code).toBe(1)
    expect(byNumber.stderr).toBe('error: project #999 not found\n')
    const byName = await run('project_activate', reference('Non Existent'), [listProjects(projectNode(2, 'Other Project'))], { config: false })
    expect(byName.code).toBe(1)
    expect(byName.stderr).toBe('error: project not found: Non Existent\n  available projects:\n  - Other Project\n')
  })

  it('指定したプロジェクトが初期化されていないと、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の初期化されていないプロジェクトのテストです。指定したプロジェクトが初期化されていない場合は、`project_init` の実行を案内して終了コード 1 で終わることを確認します。')
    const result = await run('project_activate', reference('1'), [projectFields(titleOnly, 'Not Initialized Project')], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: project "Not Initialized Project" is not initialized\n  call project_init with owner: "acme", name: "Not Initialized Project", host: "${DEFAULT_HOST}"\n`)
    expect(result.read(CONFIG_FILE)).toBeUndefined()
  })

  it('GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-15')
    await explains('`project_activate` の GitHub API のエラーのテストです。GitHub API がエラーを返した場合は、`could not activate project` のエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('project_activate', reference('board'), [failing('ListProjectsUser'), failing('ListProjectsOrg')], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not activate project: /u)
  })

  it('渡した設定ファイルを読めないと、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の読み込めない設定ファイルのテストです。指定した設定ファイルを読み込めない場合は、エラーを出力して終了コード 1 で終わり、GitHub へ要求を送信しないことを確認します。')
    const result = await run('project_activate', { project: 'broken' }, [], { config: false, files: { [`${PROJECTS_DIRECTORY}/broken.json`]: '{ not json' } })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not load config file broken\.json: /u)
    expect(result.requests).toEqual([])
  })

  it('host が渡した設定ファイルの host と違うと、warning の行を標準エラーに出す', async () => {
    await explains('`project_activate` の `host` が設定ファイルの host と異なる場合のテストです。`host` が設定ファイルの host と異なる場合は、`warning` の行を標準エラーへ出力することを確認します。')
    const result = await run('project_activate', { project: NAME, host: 'github.com' }, [projectFields(), ...syncRules()])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: host: "github.com" differs from the config file host (${DEFAULT_HOST})\n  using the config file host\nupdated: config file ${configPathOf(result)}\nset: active project to ${NAME}\n`)
  })

  it('host が渡した設定ファイルの host と違うと、設定ファイルの host で同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-18')
    await explains('`project_activate` の `host` が設定ファイルの host と異なる場合のテストです。設定ファイルの host を使って同期し、保存する host も設定ファイルの値のままであることを確認します。')
    // github.com 用のトークンは無いので、設定ファイルの host で送れたときだけ成功する
    const result = await run('project_activate', { project: NAME, host: 'github.com' }, [projectFields(), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(savedConfig(result)['host']).toBe(DEFAULT_HOST)
  })

  it('Blocked が存在しないボードでも同期が通り、設定ファイルに blocked のキーを書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-19')
    await explains('`project_activate` の Blocked を持たないボードのテストです。Blocked の選択肢が存在しないボードでも同期が成功し、設定ファイルに `blocked` のキーを書かないことを確認します。')
    const result = await activateByNumber()
    expect(result.code).toBe(0)
    expectClean(result)
    const fields = asJson(asJson(savedConfig(result)['project'])['fields'])
    expect(asJson(fields['workflow'])['options']).not.toHaveProperty('blocked')
    expect(asJson(savedConfig(result)['project'])['board_url']).not.toContain('Blocked')
    expect(fields['status']).toEqual({ id: 'PVTSSF_status', options: { todo: 'o1', in_progress: 'o2' } })
  })

  it('Blocked・In Progress・Needs Attention があるボードを同期すると、その id を設定ファイルに書く', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-20')
    await explains('`project_activate` の Blocked を持つボードのテストです。`Blocked` や `In Progress` や `Needs Attention` の選択肢があるボードを同期した場合は、その id を設定ファイルに書くことを確認します。')
    const fields = [...standardFields(WORKFLOW_NAMES_WITH_BLOCKED).slice(0, 2), statusField([...STATUS_NAMES, 'Needs Attention'])]
    const result = await run('project_activate', reference('1'), [projectFields(fields), listProjects(projectNode(1, 'board')), projectFields(fields), linked()], { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    const saved = asJson(asJson(savedConfig(result)['project'])['fields'])
    expect(asJson(saved['workflow'])['options']).toMatchObject({ blocked: 'o2', ready: 'o4' })
    expect(saved['status']).toEqual({ id: 'PVTSSF_status', options: { todo: 'o1', in_progress: 'o2', needs_attention: 'o4' } })
    expect(asJson(savedConfig(result)['project'])['board_url']).toContain('Blocked')
  })

  it('ボードの値が小文字の blocked でも、設定ファイルに id を書き、board_url の絞り込みに Blocked を含める', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-20')
    await explains('`project_activate` の小文字の `blocked` のテストです。ボードの選択肢が小文字の `blocked` でも、設定ファイルに id を書き、`board_url` の絞り込みに `Blocked` を含めることを確認します。')
    const names = WORKFLOW_NAMES_WITH_BLOCKED.map(name => name === 'Blocked' ? 'blocked' : name)
    const fields = standardFields(names).slice(0, 2)
    const result = await run('project_activate', reference('1'), [projectFields(fields), listProjects(projectNode(1, 'board')), projectFields(fields), linked()], { config: false })
    expect(result.code).toBe(0)
    expect(workflowOptions(result)).toHaveProperty('blocked', 'o2')
    expect(asJson(savedConfig(result)['project'])['board_url']).toContain('Blocked')
  })

  it('Status のフィールドが存在しないボードを同期すると、fields.status を書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-21')
    await explains('`project_activate` の Status のフィールドのテストです。Status のフィールドが存在しないボードを同期した場合は、設定ファイルに `fields.status` を書かないことを確認します。')
    const fields = standardFields().slice(0, 2)
    const result = await run('project_activate', reference('1'), [projectFields(fields), listProjects(projectNode(1, 'board')), projectFields(fields), linked()], { config: false })
    expect(result.code).toBe(0)
    const saved = asJson(savedConfig(result)['project'])
    expect(asJson(saved['fields'])).not.toHaveProperty('status')
  })

  it('必須の値（Blocked を除く 6 つ）が欠けたボードを同期すると、終了コード 1 で終わる', async () => {
    await explains('`project_activate` の必須の選択肢が不足しているボードのテストです。Blocked を除く必須の選択肢が不足している場合は、不足している名前を標準エラーへ出力し、終了コード 1 で終わることを確認します。')
    const result = await run('project_activate', reference('1'), [projectFields(standardFields(['Backlog', 'Blocked'])), listProjects(projectNode(1, 'board')), projectFields(standardFields(['Backlog', 'Blocked']))], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('pecot-status field is missing options: Pending, Ready, Active, In Review, Archived')
    expect(result.read(CONFIG_FILE)).toBeUndefined()
  })

  describe('MCP の data', () => {
    it('アクティブにした設定の名前・パス・change を返す', async () => {
      await explains('`project_activate` の結果のテストです。設定をアクティブにした場合は、結果に設定の名前とパスと `change` を含めることを確認します。')
      const result = await tool('project_activate', { ...owned, project: '1' }, [projectFields(), ...syncRules()], { config: false })
      const configPath = path.join(result.directory, CONFIG_FILE)
      expect(result.structured).toEqual({ project: CONFIG_NAME, configPath, change: 'create', config_moved: null })
    })

    it('旧い名前の設定ファイルを新しい名前に移すと、移した元と先を config_moved に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-26')
      await explains('`project_activate` の旧い名前の設定ファイルのテストです。旧い名前の設定ファイルを新しい名前へ移動した場合は、移動の元と先を `config_moved` に含めることを確認します。')
      const result = await tool('project_activate', { ...owned, project: '1' }, [projectFields(), ...syncRules()], legacyConfig)
      expectClean(result)
      expect(result.structured).toMatchObject({ project: CONFIG_NAME, config_moved: { from: path.basename(LEGACY_CONFIG_FILE), to: path.basename(CONFIG_FILE) } })
      expect(result.read(LEGACY_CONFIG_FILE)).toBeUndefined()
    })

    it('設定ファイルがあると change を update にする', async () => {
      await explains('`project_activate` の `change` のテストです。設定ファイルが既に存在する場合は、`change` を `update` にすることを確認します。')
      const result = await tool('project_activate', { ...owned, project: '1' }, [projectFields(), ...syncRules()])
      expect(result.structured).toMatchObject({ project: CONFIG_NAME, change: 'update' })
    })

    it('host が要る場面で渡していないと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-12')
      await explains('`project_activate` の `host` が不足している場合のテストです。`host` が必要な場面で指定していない場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_activate', { project: '1' }, [], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.structured['detail']).toMatch(/^host is required/u)
    })

    it('指定したプロジェクトが存在しないと、kind が project-not-found の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-13')
      await explains('`project_activate` の指定したプロジェクトが存在しない場合のテストです。指定したプロジェクトが存在しない場合は、`kind` が `project-not-found` の失敗を返すことを確認します。')
      const result = await tool('project_activate', { ...owned, project: '999' }, missingProject(), { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'project-not-found', detail: 'project #999 not found' } })
    })

    it('指定したプロジェクトが初期化されていないと、kind が not-initialized の失敗を返し、project_init を案内する', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-14')
      await explains('`project_activate` の初期化されていないプロジェクトのテストです。プロジェクトが初期化されていない場合は、`kind` が `not-initialized` の失敗を返し、`project_init` を案内することを確認します。')
      const result = await tool('project_activate', { ...owned, project: '1' }, [projectFields(titleOnly, 'Not Initialized Project')], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
      expect(result.structured['detail']).toContain('project_init')
      expect(result.read(CONFIG_FILE)).toBeUndefined()
    })

    it('GitHub API がエラーを返すと、失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-15')
      await explains('`project_activate` の GitHub API のエラーのテストです。GitHub API がエラーを返した場合は、`could not activate project` で始まる失敗を返すことを確認します。')
      const result = await tool('project_activate', { ...owned, project: 'board' }, [failing('ListProjectsUser'), failing('ListProjectsOrg')], { config: false })
      expect(result.isError).toBe(true)
      expect(result.structured['detail']).toMatch(/^could not activate project: /u)
    })

    it('渡した設定ファイルを読めないと、kind が config-invalid の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-16')
      await explains('`project_activate` の読み込めない設定ファイルのテストです。指定した設定ファイルを読み込めない場合は、`kind` が `config-invalid` の失敗を返し、GitHub へ要求を送信しないことを確認します。')
      const result = await tool('project_activate', { project: 'broken' }, [], { config: false, files: { [`${PROJECTS_DIRECTORY}/broken.json`]: '{ not json' } })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'config-invalid' } })
      expect(result.requests).toEqual([])
    })

    it('host が渡した設定ファイルの host と違うと、warnings に 1 つ入れる', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-17')
      await explains('`project_activate` の `host` が設定ファイルの host と異なる場合のテストです。異なる `host` を指定した場合は、`warnings` に警告を 1 件含めることを確認します。')
      const result = await tool('project_activate', { project: CONFIG_NAME, host: 'github.com' }, [projectFields(), ...syncRules()])
      expect(result.isError).toBe(false)
      expect(result.structured['warnings']).toEqual([`host: "github.com" differs from the config file host (${DEFAULT_HOST})\n  using the config file host`])
    })

    it('進行の欄に必須の値が欠けていると、kind が not-initialized の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-ACTIVATE-22')
      await explains('`project_activate` の必須の選択肢が不足しているボードのテストです。進行の欄の必須の選択肢が不足している場合は、`kind` が `not-initialized` の失敗を返すことを確認します。')
      const missing = standardFields(['Backlog', 'Blocked'])
      const result = await tool('project_activate', { ...owned, project: '1' }, [projectFields(missing), listProjects(projectNode(1, 'board')), projectFields(missing)], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'not-initialized' } })
      expect(result.read(CONFIG_FILE)).toBeUndefined()
    })
  })
})

describe('project_link', () => {
  const demo = { owner: 'acme', name: 'demo', develop_branch: 'main' }
  const withRepository = (...repositories: Json[]): Partial<CommandRun> => ({ config: projectConfig({ repositories }) })
  const setRepository = async (input: Readonly<Record<string, unknown>>, extra: Partial<CommandRun> = {}, github: ResponseRule[] = []): Promise<CommandResult> => await run('project_link', input, github, extra)

  it('未登録のリポジトリを渡すと、プロジェクトにリンクする', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-01')
    await explains('`project_link` のリンクのテストです。未登録のリポジトリを指定した場合は、そのリポジトリをプロジェクトへリンクする要求を送信することを確認します。')
    const result = await setRepository({ repo: 'acme/other' }, {}, linkRules())
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetProjectIdUser', 'GetRepositoryId', 'LinkProjectRepository'])
    expect(graphqlVariables(result, 'LinkProjectRepository')).toEqual([{ projectId: 'PVT_1', repositoryId: 'R_2' }])
  })

  it('リンクに成功すると、設定ファイルにリポジトリを足す', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-02')
    await explains('`project_link` の設定ファイルへの追加のテストです。リンクに成功した場合は、設定ファイルにリポジトリを追加し、指定したオプションの値を含めることを確認します。')
    const result = await setRepository({ repo: 'acme/other', develop_branch: 'dev', release_type: 'nx' }, {}, linkRules())
    expect(repositoriesOf(result)).toEqual([demo, { owner: 'acme', name: 'other', develop_branch: 'dev', release_type: 'nx' }])
    expect(result.stderr).toBe(`added: acme/other to project #1\nadded: acme/other to ${configPathOf(result)}\n`)
  })

  it('登録済みのリポジトリを渡すと、渡したオプションの値だけを更新する', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-03')
    await explains('`project_link` の登録済みのリポジトリのテストです。登録済みのリポジトリを指定した場合は、指定したオプションの値だけを更新し、GitHub へ要求を送信しないことを確認します。')
    const result = await setRepository({ repo: 'acme/demo', develop_branch: 'dev' }, withRepository({ ...demo, release_branch: 'release' }))
    expect(result.code).toBe(0)
    expect(result.requests).toEqual([])
    expect(repositoriesOf(result)).toEqual([{ owner: 'acme', name: 'demo', develop_branch: 'dev', release_branch: 'release' }])
    expect(result.stderr).toBe(`updated: acme/demo in ${configPathOf(result)}\n`)
  })

  it('登録済みのリポジトリに package を渡すと、packages を置き換える', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-04')
    await explains('`project_link` の `package` のテストです。登録済みのリポジトリに `package` を指定した場合は、`packages` を指定した内容へ置き換えることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['a:a/CHANGELOG.md', 'b:b/CHANGELOG.md'] }, withRepository({ ...demo, packages: [{ name: 'old', changelog: 'old.md' }] }))
    expect(repositoriesOf(result)).toEqual([{ ...demo, packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }, { name: 'b', changelog: 'b/CHANGELOG.md' }] }])
  })

  it('登録済みのリポジトリに package を渡すと、changelog_file を消す', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-05')
    await explains('`project_link` の `package` のテストです。登録済みのリポジトリに `package` を指定した場合は、`changelog_file` を削除して `packages` を設定することを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['a:a/CHANGELOG.md'] }, withRepository({ ...demo, changelog_file: 'CHANGELOG.md' }))
    const [entry] = repositoryEntries(result)
    expect(entry).not.toHaveProperty('changelog_file')
    expect(entry).toHaveProperty('packages')
  })

  it('登録済みのリポジトリに clear_packages を付けると、packages を消す', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-06')
    await explains('`project_link` の `clear_packages` のテストです。登録済みのリポジトリに `clear_packages` を指定した場合は、`packages` を削除することを確認します。')
    const result = await setRepository({ repo: 'acme/demo', clear_packages: true }, withRepository({ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }))
    expect(result.code).toBe(0)
    expect(repositoriesOf(result)).toEqual([demo])
  })

  it('リンクに失敗すると、設定ファイルを書き換えない', async (context) => {
    await verifies(context, 'PW-PROJECT-LINK-07')
    await explains('`project_link` のリンクに失敗した場合のテストです。リンクに失敗した場合は、設定ファイルを書き換えないことを確認します。')
    const before = JSON.stringify(projectConfig(), undefined, 2)
    const result = await setRepository({ repo: 'acme/other' }, {}, [projectIdRule(), unresolvedRepository()])
    expect(JSON.parse(result.read(CONFIG_FILE) ?? '')).toEqual(JSON.parse(before))
  })

  it('リンクに失敗すると、終了コード 1 で終わる', async () => {
    await explains('`project_link` のリンクに失敗した場合のテストです。リンクに失敗した場合は、エラーを標準エラーへ出力し、終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/other' }, {}, [projectIdRule(), unresolvedRepository()])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: could not link acme/other to project #1: GraphQL query error: {\'type\': \'NOT_FOUND\', \'message\': \'Could not resolve to a Repository with the name acme/other.\'}\n')
  })

  it('package と changelog_file を一緒に渡すと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のオプションの組み合わせのテストです。`package` と `changelog_file` を同時に指定した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['a:a.md'], changelog_file: 'C.md' })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: package and changelog_file cannot be used together\n')
  })

  it('package と clear_packages を一緒に渡すと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のオプションの組み合わせのテストです。`package` と `clear_packages` を同時に指定した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['a:a.md'], clear_packages: true })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: package and clear_packages: true cannot be used together\n')
  })

  it('package が NAME:PATH の形でないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` の `package` の形式のテストです。`package` が `NAME:PATH` の形式でない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['nocolon'] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: give package: <NAME:PATH>: \'nocolon\'\n')
  })

  it('package の NAME が重なると、終了コード 1 で終わる', async () => {
    await explains('`project_link` の `package` の名前のテストです。`package` の `NAME` が重複している場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', package: ['foo:a.md', 'foo:b.md'] })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: package NAME is duplicated: \'foo\'\n')
  })

  it('未登録のリポジトリに不正な package の名前を渡すと、リンクせず終了コード 1 で終わる', async () => {
    await explains('`project_link` の不正な `package` の名前のテストです。未登録のリポジトリに不正な名前を指定した場合は、リンクせず、設定ファイルも書き換えずに終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/new', package: ['bad name:p'] })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: /u)
    expect(requestLabels(result.requests)).not.toContain('LinkProjectRepository')
    expect(JSON.parse(result.read(CONFIG_FILE) ?? '')).toEqual(projectConfig())
  })

  it('リポジトリの所有者がプロジェクトの所有者と違うと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のリポジトリの所有者のテストです。リポジトリの所有者がプロジェクトの所有者と異なる場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'different-owner/repo' })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: repository owner different-owner differs from project owner acme\n  GitHub Projects V2 links only repositories of the project owner\n')
  })

  it('リポジトリが owner/repo の形でないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のリポジトリの指定形式のテストです。リポジトリが `owner/repo` の形式でない場合は、例を添えたエラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'justname' })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: give the repository as owner/repo\n  example: project_link with repo: "example-org/my-repo"\n')
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo' }, { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(NO_ACTIVE)
  })

  it('release_type が single・multi・nx のどれでもないと、終了コード 1 で終わる', async () => {
    await explains('`project_link` の `release_type` のテストです。`single`・`multi`・`nx` のいずれにも該当しない値を指定した場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await setRepository({ repo: 'acme/demo', release_type: 'bogus' })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: release_type must be one of [\'multi\', \'nx\', \'single\'] (got: \'bogus\')\n')
  })

  it('packages を持つリポジトリに changelog_file を渡すと、終了コード 1 で終わる', async () => {
    await explains('`project_link` の `packages` を持つリポジトリのテストです。`packages` を持つリポジトリに `changelog_file` を指定した場合は、エラーを出力して終了コード 1 で終わり、設定ファイルを書き換えないことを確認します。')
    const result = await setRepository({ repo: 'acme/demo', changelog_file: 'C.md' }, withRepository({ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }))
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: this repository has packages set\n  call with clear_packages: true before switching to changelog_file\n')
    expect(repositoriesOf(result)).toEqual([{ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }])
  })

  describe('MCP の data', () => {
    it('リポジトリ・プロジェクト番号・change・設定ファイルのパスを返す', async () => {
      await explains('`project_link` の結果のテストです。リンクに成功した場合は、結果にリポジトリとプロジェクト番号と `change` と設定ファイルのパスを含めることを確認します。')
      const result = await tool('project_link', { repo: 'acme/other' }, linkRules())
      const configPath = path.join(result.directory, CONFIG_FILE)
      expect(result.structured).toEqual({ repository: 'acme/other', projectNumber: 1, change: 'create', configPath })
    })

    it('登録済みのリポジトリだと change を update にする', async () => {
      await explains('`project_link` の `change` のテストです。登録済みのリポジトリを指定した場合は、`change` を `update` にすることを確認します。')
      const result = await tool('project_link', { repo: 'acme/demo', develop_branch: 'dev' })
      expect(result.structured).toMatchObject({ repository: 'acme/demo', change: 'update' })
    })

    it('リンクに失敗すると、kind が github-api の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-08')
      await explains('`project_link` のリンクに失敗した場合のテストです。リンクに失敗した場合は、`kind` が `github-api` の失敗を返すことを確認します。')
      const result = await tool('project_link', { repo: 'acme/other' }, [projectIdRule(), unresolvedRepository()])
      expect(result).toMatchObject({ isError: true, structured: { kind: 'github-api' } })
      expect(result.structured['detail']).toMatch(/^could not link acme\/other to project #1: /u)
    })

    it.for([
      { name: 'package と changelog_file を一緒に渡す', input: { package: ['a:a.md'], changelog_file: 'C.md' }, id: 'PW-PROJECT-LINK-09' },
      { name: 'package と clear_packages を一緒に渡す', input: { package: ['a:a.md'], clear_packages: true }, id: 'PW-PROJECT-LINK-10' },
      { name: 'package の要素が NAME:PATH の形でない', input: { package: ['nocolon'] }, id: 'PW-PROJECT-LINK-11' },
      { name: 'package の NAME が重なる', input: { package: ['foo:a.md', 'foo:b.md'] }, id: 'PW-PROJECT-LINK-12' },
      { name: 'release_type が single・multi・nx のどれでもない', input: { release_type: 'bogus' }, id: 'PW-PROJECT-LINK-16' },
    ])('$name と、kind が invalid-input の失敗を返す', async ({ name, input, id }, context) => {
      await verifies(context, id)
      await explains(`\`project_link\` の不正な入力のテストです。条件が「${name}」の場合は、\`kind\` が \`invalid-input\` の失敗を返し、リンクの要求を送信しないことを確認します。`)
      const result = await tool('project_link', { repo: 'acme/demo', ...input })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(requestLabels(result.requests)).not.toContain('LinkProjectRepository')
    })

    it('リポジトリの所有者がプロジェクトの所有者と違うと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-13')
      await explains('`project_link` のリポジトリの所有者のテストです。リポジトリの所有者がプロジェクトの所有者と異なる場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_link', { repo: 'different-owner/repo' })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(result.structured['detail']).toContain('repository owner different-owner differs from project owner acme')
    })

    it('リポジトリが owner/repo の形でないと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-14')
      await explains('`project_link` のリポジトリの指定形式のテストです。リポジトリが `owner/repo` の形式でない場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_link', { repo: 'justname' })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-15')
      await explains('`project_link` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_link', { repo: 'acme/demo' }, [], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
    })

    it('packages を持つリポジトリに changelog_file を渡すと、kind が invalid-input の失敗を返し、設定ファイルを書き換えない', async (context) => {
      await verifies(context, 'PW-PROJECT-LINK-17')
      await explains('`project_link` の `packages` を持つリポジトリのテストです。`packages` を持つリポジトリに `changelog_file` を指定した場合は、`kind` が `invalid-input` の失敗を返し、設定ファイルを書き換えないことを確認します。')
      const packaged = { ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }
      const result = await tool('project_link', { repo: 'acme/demo', changelog_file: 'C.md' }, [], withRepository(packaged))
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
      expect(repositoriesOf(result)).toEqual([packaged])
    })
  })
})

describe('project_set', () => {
  const withAggregation = (value?: string): Partial<CommandRun> => ({ config: projectConfig(value === undefined ? {} : { extra: { aggregation_repo: value } }) })
  const set = async (input: Readonly<Record<string, unknown>>, extra: Partial<CommandRun> = {}): Promise<CommandResult> => await run('project_set', { key: 'aggregation_repo', ...input }, [], extra)

  it('未設定の状態で値を渡すと、設定ファイルに書く', async (context) => {
    await verifies(context, 'PW-PROJECT-SET-01')
    await explains('`project_set` の `aggregation_repo` のテストです。未設定の状態で値を指定した場合は、設定ファイルに `aggregation_repo` を書くことを確認します。')
    const result = await set({ value: 'acme/roadmap' })
    expect(result.code).toBe(0)
    expect(savedConfig(result)['aggregation_repo']).toBe('acme/roadmap')
  })

  it('未設定の状態で値を渡すと、set の行を標準エラーに出す', async () => {
    await explains('`project_set` の標準エラーのテストです。未設定の状態で値を指定した場合は、標準出力に何も出力せず、`set` の行を標準エラーへ出力することを確認します。')
    const result = await set({ value: 'acme/roadmap' })
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('set: aggregation_repo to acme/roadmap\n')
  })

  it('既にある値と同じ値を渡すと、unchanged の行を標準エラーに出す', async () => {
    await explains('`project_set` の同じ値のテストです。既に設定している値と同じ値を指定した場合は、`unchanged` の行を標準エラーへ出力することを確認します。')
    const result = await set({ value: 'acme/roadmap' }, withAggregation('acme/roadmap'))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('unchanged: aggregation_repo acme/roadmap\n')
  })

  it('既にある値と違う値を渡すと、上書きの warning の行を標準エラーに出す', async () => {
    await explains('`project_set` の上書きのテストです。既に設定している値と異なる値を指定した場合は、上書きの `warning` の行を標準エラーへ出力し、新しい値を書くことを確認します。')
    const result = await set({ value: 'acme/new' }, withAggregation('acme/roadmap'))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('warning: overwriting aggregation_repo: acme/roadmap -> acme/new\n  pass yes: true to omit this hint\nset: aggregation_repo to acme/new\n')
    expect(savedConfig(result)['aggregation_repo']).toBe('acme/new')
  })

  it('yes を付けて上書きすると、warning の行から確認の案内を省く', async () => {
    await explains('`project_set` の `yes` のテストです。`yes` を指定して上書きした場合は、`warning` の行から確認の案内を省略することを確認します。')
    const result = await set({ value: 'acme/new', yes: true }, withAggregation('acme/roadmap'))
    expect(result.stderr).toBe('warning: overwriting aggregation_repo: acme/roadmap -> acme/new\nset: aggregation_repo to acme/new\n')
  })

  it('値が owner/repo の形でないと、終了コード 1 で終わる', async () => {
    await explains('`project_set` の値の形式のテストです。値が `owner/repo` の形式でない場合は、エラーを出力して終了コード 1 で終わり、設定ファイルに書かないことを確認します。')
    const result = await set({ value: 'roadmap' })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: give aggregation_repo as owner/repo: \'roadmap\'\n')
    expect(savedConfig(result)).not.toHaveProperty('aggregation_repo')
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_set` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await set({ value: 'acme/roadmap' }, { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(NO_ACTIVE)
  })

  describe('MCP の data', () => {
    it('未設定のキーに書くと change を create にして、previous を返さず、書いた設定ファイルのパスを configPath に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-02')
      await explains('`project_set` の結果のテストです。未設定のキーに書き込んだ場合は、`change` を `create` にし、`previous` を含めず、`configPath` に設定ファイルのパスを含めることを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/roadmap' })
      const configPath = path.join(result.directory, CONFIG_FILE)
      expect(result.structured).toEqual({ key: 'aggregation_repo', value: 'acme/roadmap', change: 'create', configPath })
    })

    it('別の値に上書きすると、change を update にして previous を返し、上書きの知らせを warnings に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-04')
      await explains('`project_set` の上書きのテストです。別の値で上書きした場合は、`change` を `update` にし、`previous` と上書きの警告を結果に含めることを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/new' }, [], withAggregation('acme/roadmap'))
      expect(result.structured).toMatchObject({ key: 'aggregation_repo', value: 'acme/new', previous: 'acme/roadmap', change: 'update', configPath: path.join(result.directory, CONFIG_FILE) })
      expect(result.structured['warnings']).toEqual(['overwriting aggregation_repo: acme/roadmap -> acme/new\n  pass yes: true to omit this hint'])
    })

    it('yes を付けて上書きすると、上書きの知らせから確認の案内を省く', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-05')
      await explains('`project_set` の `yes` のテストです。`yes` を指定して上書きした場合は、上書きの警告から確認の案内を省略することを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/new', yes: true }, [], withAggregation('acme/roadmap'))
      expect(result.structured['warnings']).toEqual(['overwriting aggregation_repo: acme/roadmap -> acme/new'])
    })

    it('値が owner/repo の形でないと、kind が invalid-input の失敗を返し、設定ファイルを書かない', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-06')
      await explains('`project_set` の値の形式のテストです。値が `owner/repo` の形式でない場合は、`kind` が `invalid-input` の失敗を返し、設定ファイルに書かないことを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'roadmap' })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input', detail: 'give aggregation_repo as owner/repo: \'roadmap\'' } })
      expect(savedConfig(result)).not.toHaveProperty('aggregation_repo')
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-07')
      await explains('`project_set` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/roadmap' }, [], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
    })

    it('aggregation_repo でないキーを渡すと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-08')
      await explains('`project_set` のキーのテストです。`aggregation_repo` 以外のキーを指定した場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_set', { key: 'foo', value: 'acme/roadmap' })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    })

    it('同じ値だと change を unchanged にする', async (context) => {
      await verifies(context, 'PW-PROJECT-SET-03')
      await explains('`project_set` の同じ値のテストです。既に設定している値と同じ値を指定した場合は、`change` を `unchanged` にすることを確認します。')
      const result = await tool('project_set', { key: 'aggregation_repo', value: 'acme/roadmap' }, [], withAggregation('acme/roadmap'))
      expect(result.structured).toEqual({ key: 'aggregation_repo', value: 'acme/roadmap', previous: 'acme/roadmap', change: 'unchanged', configPath: path.join(result.directory, CONFIG_FILE) })
    })
  })
})

describe('project_unset', () => {
  const configured = { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) }

  it('値を設定していると、設定ファイルから消す', async (context) => {
    await verifies(context, 'PW-PROJECT-UNSET-01')
    await explains('`project_unset` の `aggregation_repo` のテストです。値を設定している場合は、設定ファイルから `aggregation_repo` を削除することを確認します。')
    const result = await run('project_unset', { key: 'aggregation_repo' }, [], configured)
    expect(result.code).toBe(0)
    expect(savedConfig(result)).not.toHaveProperty('aggregation_repo')
  })

  it('値を設定していると、removed の行を標準エラーに出す', async () => {
    await explains('`project_unset` の標準エラーのテストです。値を設定している場合は、標準出力に何も出力せず、`removed` の行を標準エラーへ出力することを確認します。')
    const result = await run('project_unset', { key: 'aggregation_repo' }, [], configured)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('removed: aggregation_repo (was acme/roadmap)\n')
  })

  it('未設定だと、unchanged の行を標準エラーに出す', async () => {
    await explains('`project_unset` の未設定の場合のテストです。値が未設定の場合は、`unchanged` の行を標準エラーへ出力することを確認します。')
    const result = await run('project_unset', { key: 'aggregation_repo' })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('unchanged: aggregation_repo (not set)\n')
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_unset` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('project_unset', { key: 'aggregation_repo' }, [], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(NO_ACTIVE)
  })

  describe('MCP の data', () => {
    it('値を消すと change を delete にして、消した値を previous に、書いた設定ファイルのパスを configPath に返す', async (context) => {
      await verifies(context, 'PW-PROJECT-UNSET-02')
      await explains('`project_unset` の結果のテストです。値を削除した場合は、`change` を `delete` にし、削除した値を `previous` に、設定ファイルのパスを `configPath` に含めることを確認します。')
      const result = await tool('project_unset', { key: 'aggregation_repo' }, [], withAggregation('acme/roadmap'))
      expect(result.structured).toEqual({ key: 'aggregation_repo', previous: 'acme/roadmap', change: 'delete', configPath: path.join(result.directory, CONFIG_FILE) })
    })

    it('未設定だと change を unchanged にする', async (context) => {
      await verifies(context, 'PW-PROJECT-UNSET-03')
      await explains('`project_unset` の未設定の場合のテストです。値が未設定の場合は、`change` を `unchanged` にすることを確認します。')
      const result = await tool('project_unset', { key: 'aggregation_repo' })
      expect(result.structured).toEqual({ key: 'aggregation_repo', change: 'unchanged', configPath: path.join(result.directory, CONFIG_FILE) })
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-UNSET-04')
      await explains('`project_unset` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_unset', { key: 'aggregation_repo' }, [], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
    })

    it('aggregation_repo でないキーを渡すと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-UNSET-05')
      await explains('`project_unset` のキーのテストです。`aggregation_repo` 以外のキーを指定した場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_unset', { key: 'foo' })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    })
  })
})

describe('project_get', () => {
  it('値を設定していると、その値を標準出力に出す', async () => {
    await explains('`project_get` の値の出力のテストです。値を設定している場合は、その値を標準出力へ出力することを確認します。')
    const result = await run('project_get', { key: 'aggregation_repo' }, [], { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('acme/roadmap\n')
  })

  it('未設定だと、none を標準出力に出す', async () => {
    await explains('`project_get` の未設定の場合のテストです。値が未設定の場合は、`none` を標準出力へ出力することを確認します。')
    const result = await run('project_get', { key: 'aggregation_repo' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('none\n')
  })

  it('アクティブなプロジェクトが存在しないと、終了コード 1 で終わる', async () => {
    await explains('`project_get` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、エラーを出力して終了コード 1 で終わることを確認します。')
    const result = await run('project_get', { key: 'aggregation_repo' }, [], { config: false })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(NO_ACTIVE)
  })

  describe('MCP の data', () => {
    it('値があると key と value を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-01')
      await explains('`project_get` の結果のテストです。値を設定している場合は、結果に `key` と `value` を含めることを確認します。')
      const result = await tool('project_get', { key: 'aggregation_repo' }, [], withAggregation('acme/roadmap'))
      expect(result.structured).toEqual({ key: 'aggregation_repo', value: 'acme/roadmap' })
    })

    it('値が未設定だと value を返さない', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-02')
      await explains('`project_get` の未設定の場合のテストです。値が未設定の場合は、結果に `value` を含めないことを確認します。')
      const result = await tool('project_get', { key: 'aggregation_repo' })
      expect(result.structured).toEqual({ key: 'aggregation_repo' })
    })

    it('アクティブなプロジェクトが存在しないと、kind が no-active-project の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-03')
      await explains('`project_get` のアクティブなプロジェクトが存在しない場合のテストです。アクティブなプロジェクトが存在しない場合は、`kind` が `no-active-project` の失敗を返すことを確認します。')
      const result = await tool('project_get', { key: 'aggregation_repo' }, [], { config: false })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'no-active-project' } })
    })

    it('aggregation_repo でないキーを渡すと、kind が invalid-input の失敗を返す', async (context) => {
      await verifies(context, 'PW-PROJECT-GET-04')
      await explains('`project_get` のキーのテストです。`aggregation_repo` 以外のキーを指定した場合は、`kind` が `invalid-input` の失敗を返すことを確認します。')
      const result = await tool('project_get', { key: 'foo' })
      expect(result).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    })
  })
})
