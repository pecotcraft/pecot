/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
/* eslint-disable unicorn/consistent-function-scoping -- 補助は、使う describe の近くに置く */
/* eslint-disable unicorn/no-unnecessary-parameters -- 補助の引数を、行ごとにそろえる */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// project の 6 個（PW-PROJECT-*）と、repo set・aggregation の 4 個（PW-REPO-*・PW-AGGREGATION-*）の振る舞いを確かめる。runCli をプロセス内で呼ぶ。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../fake-github/server.js'
import { verifies } from '../_helpers/verifies.js'
import { prerequisitesRule } from '../_helpers/prerequisites.js'
import { CONFIG_FILE, DEFAULT_HOST, graphqlRule, projectConfig, requestLabels, restRule, runCommand } from '../_helpers/command-harness.js'
import type { CommandResult, CommandRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const PROJECTS_DIRECTORY = '.pecot/config/projects'
const ACTIVE_FILE = `${PROJECTS_DIRECTORY}/.active`
const BOARD_URL = `https://${DEFAULT_HOST}/users/acme/projects/1`
const NO_ACTIVE = 'error: no active project\n  run: pecot project activate <PROJECT>\n'
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
    { id: 'PVTSSF_workflow', name: 'pecot-workflow-acme', databaseId: 456, options: options(workflow) },
    { id: 'PVTSSF_priority', name: 'pecot-priority', options: options(['High', 'Medium', 'Low']) },
    { id: 'PVTSSF_size', name: 'pecot-size', options: options(['XS', 'S', 'M', 'L']) },
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
const createFields = (): ResponseRule[] => [createField('pecot-workflow-acme', 'PVTSSF_w'), createField('pecot-priority', 'PVTSSF_p'), createField('pecot-size', 'PVTSSF_s')]

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

function item(id: string, number: number, workflow: string, extra: { state?: string, updatedAt?: string, repo?: string, progress?: ListProgress } = {}): Json {
  const { state = 'OPEN', updatedAt = '2026-01-02T03:04:05Z', repo: repository = 'demo' } = extra
  return {
    id,
    updatedAt,
    fieldValues: { nodes: [{ field: { name: 'pecot-workflow-acme' }, name: workflow }] },
    content: { id: `I_${String(number)}`, number, title: `課題${String(number)}`, state, url: `https://${DEFAULT_HOST}/acme/${repository}/issues/${String(number)}`, labels: { nodes: [] }, repository: { owner: { login: 'acme' }, name: repository }, ...extra.progress !== undefined && progressFields(extra.progress) },
  }
}

const board = (...nodes: Json[]): ResponseRule => graphqlRule('ListProjectItems', { node: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } })
const alerts = (repository: string, body: unknown, status = 200): ResponseRule => restRule('GET', `/repos/acme/${repository}/dependabot/alerts`, status, body)
const twoAlerts = (repository = 'demo'): ResponseRule => alerts(repository, [{ security_vulnerability: { severity: 'high' } }, { security_vulnerability: { severity: 'low' } }])
const deletion = (itemId: string, status = 200): ResponseRule => status === 200
  ? graphqlRule('DeleteProjectItem', { deleteProjectV2Item: { deletedItemId: itemId } }, { projectId: 'PVT_1', itemId })
  : { match: { operation: 'DeleteProjectItem', variables: { projectId: 'PVT_1', itemId } }, respond: { status, body: { message: 'Server Error' } }, times: 1 }

// 動かす補助

const GHES: Partial<CommandRun> = { remote: { host: DEFAULT_HOST } }
const READINESS_HEADER = '| Ref | Title | Readiness |\n|-----|----------|-----------|'
const arguments_ = (...rest: string[]): string[] => ['project', ...rest]
const repositoryArguments = (...rest: string[]): string[] => ['repo', ...rest]
const aggregationArguments = (...rest: string[]): string[] => ['aggregation', ...rest]

async function run(argv: readonly string[], github: readonly ResponseRule[] = [], extra: Partial<CommandRun> = {}): Promise<CommandResult> {
  return await runCommand({ argv, github, ...GHES, ...extra })
}

function expectClean(result: Readonly<CommandResult>): void {
  expect(result.problems).toEqual([])
  expect(result.unused).toEqual([])
}

function asJson(value: unknown): Json {
  if (typeof value !== 'object' || value === null) throw new TypeError('not an object')
  return Object.fromEntries(Object.entries(value))
}

function savedConfig(result: Readonly<CommandResult>, file = CONFIG_FILE): Json {
  const text = result.read(file)
  if (text === undefined) throw new Error(`no such file: ${file}`)
  return asJson(JSON.parse(text))
}

function workflowOptions(result: Readonly<CommandResult>): Json {
  const fields = asJson(asJson(savedConfig(result)['project'])['fields'])
  return asJson(asJson(fields['workflow'])['options'])
}

function repositoryEntries(result: Readonly<CommandResult>): Json[] {
  const entries = savedConfig(result)['repositories']
  return Array.isArray(entries) ? entries.map(entry => asJson(entry)) : []
}

function repositoriesOf(result: Readonly<CommandResult>, file = CONFIG_FILE): unknown {
  return savedConfig(result, file)['repositories']
}

const configPathOf = (result: Readonly<CommandResult>): string => path.join(result.directory, CONFIG_FILE)

function graphqlVariables(result: Readonly<CommandResult>, operation: string): unknown[] {
  return result.requests.filter((request): request is Extract<RecordedRequest, { type: 'graphql' }> => request.type === 'graphql' && request.operation === operation).map(request => request.variables)
}

function variableValues(result: Readonly<CommandResult>, operation: string, key: string): unknown[] {
  return graphqlVariables(result, operation).map(variables => Reflect.get(asJson(variables), key))
}

const sorted = (labels: readonly string[]): string[] => labels.toSorted((first, second) => first.localeCompare(second))

describe('project list', () => {
  const other = { [`${PROJECTS_DIRECTORY}/${DEFAULT_HOST}_acme_other_acme.json`]: `${JSON.stringify(projectConfig(), undefined, 2)}\n` }

  it('設定ファイルがあると、ファイル名の順に 1 行ずつ出す', async (context) => {
    await verifies(context, 'PW-PROJECT-LIST-01')
    const result = await run(arguments_('list'), [], { files: other })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`=== Projects ===\n  ${DEFAULT_HOST}_acme_board_acme [ACTIVE]\n  ${DEFAULT_HOST}_acme_other_acme\n`)
    expect(result.stderr).toBe('')
  })

  it('アクティブなプロジェクトの設定ファイルの行の末尾に、[ACTIVE] を付ける', async (context) => {
    await verifies(context, 'PW-PROJECT-LIST-02')
    const result = await run(arguments_('list'), [], { files: other })
    const lines = result.stdout.split('\n')
    expect(lines.filter(line => line.endsWith('[ACTIVE]'))).toEqual([`  ${DEFAULT_HOST}_acme_board_acme [ACTIVE]`])
  })

  it('設定ファイルが 1 つも無いと、none の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-LIST-03')
    const result = await run(arguments_('list'), [], { config: false })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('=== Projects ===\n  none\n')
  })
})

describe('project search', () => {
  const search = async (nodes: Json[]): Promise<CommandResult> => await run(arguments_('search', 'acme', '--host', DEFAULT_HOST), [listProjects(...nodes)], { config: false })
  const URL1 = `https://${DEFAULT_HOST}/users/acme/projects/1`

  it('プロジェクトを持つ所有者を渡すと、番号・タイトル・URL の表を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-01')
    const result = await search([projectNode(1, 'board')])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toBe(`=== Projects of acme (${DEFAULT_HOST}) ===\n\n#    Title                                    URL\n${'-'.repeat(80)}\n1    board${' '.repeat(35)} ${URL1}\n`)
  })

  it('タイトルが 38 文字を超えると、35 文字に切り詰めて末尾に ... を付ける', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-02')
    const result = await search([projectNode(1, 'x'.repeat(38)), projectNode(2, 'y'.repeat(39))])
    const rows = result.stdout.split('\n').slice(4, 6)
    expect(rows[0]).toContain(` ${'x'.repeat(38)}  `)
    expect(rows[1]).toContain(` ${'y'.repeat(35)}...  `)
  })

  it('プロジェクトが 1 件も無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-03')
    const result = await search([])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: no projects found for acme\n')
  })

  it('GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-SEARCH-04')
    const result = await run(arguments_('search', 'acme', '--host', DEFAULT_HOST), [failing('ListProjectsUser'), failing('ListProjectsOrg')], { config: false })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: could not list projects: GraphQL query error: Server error '500 Internal Server Error'/u)
  })
})

describe('project init', () => {
  const init = async (rules: ResponseRule[], title = 'board', config: Json | false = false): Promise<CommandResult> => await run(arguments_('init', 'acme', title, '--suffix', 'acme', '--host', DEFAULT_HOST), rules, { config })
  const base = (fields: Json[]): ResponseRule[] => [listProjects(projectNode(1, 'board')), projectFields(fields)]
  const workflowField = (names: readonly string[], name = 'pecot-workflow-acme'): Json => ({ id: 'PVTSSF_old', name, options: options(names) })
  const otherFields = (): Json[] => [{ id: 'PVTSSF_priority', name: 'pecot-priority', options: options(['High', 'Medium', 'Low']) }, { id: 'PVTSSF_size', name: 'pecot-size', options: options(['XS', 'S', 'M', 'L']) }]
  const skippedFields = 'skipped: field pecot-workflow-acme (already exists)\nskipped: field pecot-priority (already exists)\nskipped: field pecot-size (already exists)\n'
  const syncedLines = (result: Readonly<CommandResult>): string => `created: config file ${configPathOf(result)}\nset: active project to ${path.parse(CONFIG_FILE).name}\n`

  it('フィールドの無いプロジェクトに打つと、3 つのフィールドを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-01')
    const result = await init([...base(titleOnly), ...createFields(), updateField('PVTSSF_status'), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(variableValues(result, 'CreateProjectField', 'name')).toEqual(['pecot-workflow-acme', 'pecot-priority', 'pecot-size'])
  })

  it('フィールドを作ると、created の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-02')
    const result = await init([...base(titleWithoutStatus), ...createFields(), ...syncRules()])
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`created: field pecot-workflow-acme (ID: PVTSSF_w)\ncreated: field pecot-priority (ID: PVTSSF_p)\ncreated: field pecot-size (ID: PVTSSF_s)\nskipped: field Status (not found)\n${syncedLines(result)}`)
  })

  it('既にあるフィールドは作らずに、skipped の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-03')
    const existing = [...titleOnly, workflowField([...WORKFLOW_NAMES_WITH_BLOCKED])]
    const result = await init([...base(existing), createField('pecot-priority', 'PVTSSF_p'), createField('pecot-size', 'PVTSSF_s'), updateField('PVTSSF_status'), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`skipped: field pecot-workflow-acme (already exists)\ncreated: field pecot-priority (ID: PVTSSF_p)\ncreated: field pecot-size (ID: PVTSSF_s)\nunchanged: option Blocked in field pecot-workflow-acme\nadded: option Needs Attention to field Status\n${syncedLines(result)}`)
  })

  it('指定したタイトルのプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-04')
    const result = await init([listProjects(projectNode(2, 'Other Project'))], 'Nonexistent')
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: project not found: Nonexistent\n  available projects:\n  - Other Project\n')
  })

  it('フィールドの作成で GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-05')
    const result = await init([...base(titleOnly), failing('CreateProjectField')])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not initialize project fields: /u)
  })

  it('既にあるフィールドに Blocked と Needs Attention が無いと、足して added の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-06')
    const existing = [...titleOnly, workflowField(BOARD_ORDER), ...otherFields()]
    const result = await init([...base(existing), updateField('PVTSSF_old'), updateField('PVTSSF_status'), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`${skippedFields}added: option Blocked to field pecot-workflow-acme\nadded: option Needs Attention to field Status\n${syncedLines(result)}`)
  })

  it('選択肢を足すとき、既存の選択肢は id・name・color・description のまま送り、Blocked は Backlog の直後、Needs Attention は末尾に置く', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-07')
    const existing = [...titleOnly, workflowField(BOARD_ORDER), ...otherFields()]
    const result = await init([...base(existing), updateField('PVTSSF_old'), updateField('PVTSSF_status'), ...syncRules()])
    const kept = (names: readonly string[]): Json[] => options(names)
    const blocked = { name: 'Blocked', color: 'GRAY', description: 'Tasks waiting for prerequisite Issues. pecot moves them to Ready once they can start.' }
    const attention = { name: 'Needs Attention', color: 'RED', description: 'Waiting for a human decision or action.' }
    expect(graphqlVariables(result, 'UpdateProjectField')).toEqual([
      { fieldId: 'PVTSSF_old', options: [...kept(BOARD_ORDER).slice(0, 2), blocked, ...kept(BOARD_ORDER).slice(2)] },
      { fieldId: 'PVTSSF_status', options: [...kept(STATUS_NAMES), attention] },
    ])
  })

  it('値を足すと、設定ファイルを同期して Blocked と Needs Attention の id を書く', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-08')
    const existing = [...titleOnly, workflowField(BOARD_ORDER), ...otherFields()]
    const synced = [
      { id: 'PVTF_title', name: 'Title' },
      { id: 'PVTSSF_workflow', name: 'pecot-workflow-acme', databaseId: 456, options: options(WORKFLOW_NAMES_WITH_BLOCKED) },
      statusField([...STATUS_NAMES, 'Needs Attention']),
    ]
    const result = await init([...base(existing), updateField('PVTSSF_old'), updateField('PVTSSF_status'), listProjects(projectNode(1, 'board')), projectFields(synced), linked()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
    expect(asJson(savedConfig(result)['project'])['fields']).toMatchObject({
      workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', blocked: 'o2' } },
      status: { id: 'PVTSSF_status', options: { todo: 'o1', needs_attention: 'o4' } },
    })
  })

  it('値が既にあると、書き込まずに unchanged の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-09')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...otherFields(), statusField([...STATUS_NAMES, 'needs attention'])]
    const result = await init([...base(existing), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`${skippedFields}unchanged: option Blocked in field pecot-workflow-acme\nunchanged: option Needs Attention in field Status\n${syncedLines(result)}`)
    expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
  })

  it('Status のフィールドが無いボードでは、何も足さずに skipped の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-10')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...otherFields()]
    const result = await init([...base(existing), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`${skippedFields}unchanged: option Blocked in field pecot-workflow-acme\nskipped: field Status (not found)\n${syncedLines(result)}`)
    expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
  })

  it('選択肢を足せなかったときは、warning の行を出して続け、終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-11')
    const existing = [...titleOnly, workflowField(BOARD_ORDER), ...otherFields()]
    const result = await init([...base(existing), failing('UpdateProjectField'), updateField('PVTSSF_status'), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toMatch(/^skipped: field pecot-workflow-acme \(already exists\)\n.*warning: could not add option Blocked to field pecot-workflow-acme: .+\nadded: option Needs Attention to field Status\ncreated: config file /su)
    expect(graphqlVariables(result, 'UpdateProjectField')).toHaveLength(2)
  })

  it('HTTP 200 で GraphQL の errors が返って足せなくても、warning の行を出して続け、終了コード 0 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-11')
    const rejected: ResponseRule = { match: { operation: 'UpdateProjectField' }, respond: { status: 200, body: { errors: [{ message: 'Variable $options of type [ProjectV2SingleSelectFieldOptionInput!]! was provided invalid value for 0.id (Field is not defined on ProjectV2SingleSelectFieldOptionInput)' }] } }, times: 1 }
    const existing = [...titleOnly, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...otherFields()]
    const result = await init([...base(existing), rejected, ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toMatch(/warning: could not add option Needs Attention to field Status: .+invalid value/u)
    expect(result.stderr).toContain('created: config file ')
  })

  it('設定ファイルがあり、内容がボードから作る内容と同じなら、設定ファイルとアクティブのどちらも書き換えない', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-12')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...otherFields(), statusField([...STATUS_NAMES, 'Needs Attention'])]
    const rules = (): ResponseRule[] => [...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()]
    const first = await init(rules())
    expect(first.stderr).toContain('created: config file ')
    const second = await init(rules(), 'board', savedConfig(first))
    expect(second.code).toBe(0)
    expectClean(second)
    expect(second.stderr).toBe(`${skippedFields}unchanged: option Blocked in field pecot-workflow-acme\nunchanged: option Needs Attention in field Status\n`)
    expect(second.read(CONFIG_FILE)).toBe(first.read(CONFIG_FILE))
  })

  it('設定ファイルがあっても内容がボードと違えば（Blocked の id が無い）、同期して Blocked の id を書く', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-08')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...otherFields()]
    const stale = projectConfig()
    const result = await init([...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()], 'board', stale)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toContain(`updated: config file ${configPathOf(result)}`)
    expect(workflowOptions(result)).toHaveProperty('blocked', 'o2')
  })

  it('既にある進行の欄に必須の値が欠けていると、何も書かずに終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-13')
    const existing = [...titleOnly, workflowField(['Backlog', 'Blocked']), ...otherFields()]
    const result = await init(base(existing))
    expect(result.code).toBe(1)
    expectClean(result)
    expect(result.stderr).toContain('pecot-workflow field is missing options: Pending, Ready, Active, In Review, Archived')
    expect(requestLabels(result.requests)).not.toContain('UpdateProjectField')
    expect(requestLabels(result.requests)).not.toContain('CreateProjectField')
    expect(result.read(CONFIG_FILE)).toBeUndefined()
  })

  it('suffix の違う進行の欄が複数あるボードでは、--suffix の欄で設定ファイルを同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-14')
    const other = { ...workflowField(WORKFLOW_NAMES_WITH_BLOCKED, 'pecot-workflow-other'), id: 'PVTSSF_other' }
    const mine = workflowField(WORKFLOW_NAMES_WITH_BLOCKED)
    const existing = [...titleWithoutStatus, other, mine, ...otherFields()]
    const result = await init([...base(existing), listProjects(projectNode(1, 'board')), projectFields(existing), linked()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(savedConfig(result)).toMatchObject({ workflow_suffix: 'acme', project: { fields: { workflow: { id: 'PVTSSF_old' } } } })
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('設定ファイルの同期で GitHub API がエラーを返すと、could not sync project config の行を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INIT-15')
    const existing = [...titleWithoutStatus, workflowField(WORKFLOW_NAMES_WITH_BLOCKED), ...otherFields()]
    const result = await init([...base(existing), listProjects(projectNode(1, 'board')), failing('GetProjectFieldsUser'), failing('GetProjectFieldsOrg')])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/error: could not sync project config: /u)
    expect(result.stderr).not.toContain('could not initialize project fields')
  })
})

describe('project create', () => {
  const create = async (rules: ResponseRule[]): Promise<CommandResult> => await run(arguments_('create', 'acme', 'board', '--suffix', 'acme', '--host', DEFAULT_HOST), rules, { config: false })

  it('新しいタイトルを渡すと、GitHub にプロジェクトを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-01')
    const result = await create(createRules())
    expect(result.code).toBe(0)
    expectClean(result)
    expect(graphqlVariables(result, 'CreateProject')).toEqual([{ ownerId: 'U_1', title: 'board' }])
  })

  it('プロジェクトを作ると、続けて 3 つのフィールドを足す', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-02')
    const result = await create(createRules())
    expect(variableValues(result, 'CreateProjectField', 'name')).toEqual(['pecot-workflow-acme', 'pecot-priority', 'pecot-size'])
  })

  it('フィールドを足すと、設定ファイルを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-03')
    const result = await create(createRules())
    expect(asJson(savedConfig(result)['project'])['board_url']).toContain(`${BOARD_URL}/views/1`)
    expect(savedConfig(result)).toMatchObject({
      host: DEFAULT_HOST,
      owner: 'acme',
      workflow_suffix: 'acme',
      project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', archived: 'o6' } } } },
      repositories: [],
    })
  })

  it('設定ファイルを作ると、そのプロジェクトをアクティブにする', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-04')
    const result = await create(createRules())
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('プロジェクトを作ると、created の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-05')
    const result = await create(createRules())
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`created: project #1 ${BOARD_URL}\ncreated: field pecot-workflow-acme (ID: PVTSSF_w)\ncreated: field pecot-priority (ID: PVTSSF_p)\ncreated: field pecot-size (ID: PVTSSF_s)\nadded: option Needs Attention to field Status\ncreated: config file ${configPathOf(result)}\nset: active project to ${path.parse(CONFIG_FILE).name}\n`)
  })

  it('Status に Needs Attention を足せなくても、warning の行を出して設定ファイルを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-10')
    const rules = createRules().map(rule => rule.match.operation === 'UpdateProjectField' ? failing('UpdateProjectField') : rule)
    const result = await create(rules)
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toMatch(/warning: could not add option Needs Attention to field Status: [\s\S]+\ncreated: config file /u)
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('同じタイトルのプロジェクトが既にあると、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-06')
    const result = await create([graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }), listProjects(projectNode(1, 'board'))])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: project already exists: board\n  url: ${BOARD_URL}\n`)
    expect(requestLabels(result.requests)).not.toContain('CreateProject')
  })

  it('所有者が見つからないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-07')
    const result = await create([graphqlRule('GetUserNodeId', { user: null }), graphqlRule('GetOrgNodeId', { organization: null })])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: owner not found: acme\n')
  })

  it('プロジェクトの作成で GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-08')
    const result = await create([graphqlRule('GetUserNodeId', { user: { id: 'U_1' } }), listProjects(), failing('CreateProject')])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not create project: /u)
  })

  it('作ったプロジェクトの workflow フィールドに選択肢が足りないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-CREATE-09')
    const result = await create(createRules(standardFields(['Backlog'])))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('required options: Backlog / Pending / Ready / Active / In Review / Archived')
    // 準拠しないとわかった時点で止まり、設定ファイルも .active も作らない
    expect(result.read(CONFIG_FILE)).toBeUndefined()
    expect(result.read(ACTIVE_FILE)).toBeUndefined()
  })
})

describe('project info', () => {
  // 前提の無い Issue の読み取り。Active・In Review の Issue は読まれない
  const quietReady = (...numbers: number[]): ResponseRule[] => numbers.map(number => prerequisitesRule({ number }))
  const standardBoard = (): ResponseRule[] => [board(item('PVTI_1', 1, 'Ready'), item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'Archived', { state: 'CLOSED' })), twoAlerts(), ...quietReady(1)]
  const MARKDOWN = [
    '# Project info', '', '## Overview', `- Project: ${DEFAULT_HOST}_acme_board_acme`, `- Host: ${DEFAULT_HOST}`, '- Owner: acme', '- Roadmap repo: none', '',
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

  it('引数なしで打つと、概要・登録リポジトリ・ボードの状態を Markdown で出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-01')
    const result = await run(arguments_('info'), standardBoard())
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toBe(MARKDOWN)
    expect(result.stderr).toBe('')
  })

  it('Blocked の項目があると、Blocked の節を Ready の節の上に出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-13')
    const result = await run(arguments_('info'), [board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked')), twoAlerts(), ...quietReady(1), prerequisitesRule({ number: 4, blockedBy: [{ number: 9 }] })])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toContain([
      '### Blocked (1)',
      READINESS_HEADER,
      '| acme/demo#4 | 課題4 | blocked by #9 (not in review: #9 (not started)) |',
      '',
      '### Ready (1)',
    ].join('\n'))
  })

  it('--json を付けて打つと、同じ内容を JSON で出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-02')
    const result = await run(arguments_('info', '--json'), standardBoard())
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      project: { name: `${DEFAULT_HOST}_acme_board_acme`, host: DEFAULT_HOST, owner: 'acme', number: 1, aggregation_repo: null },
      repositories: [{
        full_name: 'acme/demo',
        owner: 'acme',
        name: 'demo',
        develop_branch: 'main',
        release_branch: null,
        dependabot_alerts: { enabled: true, open_count: 2, max_severity: 'high', alerts_url: `https://${DEFAULT_HOST}/acme/demo/security/dependabot` },
      }],
      board: { items: [
        { id: 'PVTI_1', workflow: 'Ready', title: '課題1', updatedAt: '2026-01-02T03:04:05Z', content: { number: 1, state: 'OPEN', url: `https://${DEFAULT_HOST}/acme/demo/issues/1`, labels: [], repository: 'acme/demo' }, readiness: { kind: 'startable', stackOn: null, reason: null, text: 'startable' } },
        { id: 'PVTI_2', workflow: 'Active', title: '課題2', updatedAt: '2026-01-02T03:04:05Z', content: { number: 2, state: 'OPEN', url: `https://${DEFAULT_HOST}/acme/demo/issues/2`, labels: [], repository: 'acme/demo' }, readiness: null },
      ] },
    })
  })

  it.for<[string, string[]]>([
    ['サブコマンドの側', ['project', 'info', '--repo', 'acme/other']],
    ['グローバルの側', ['--repo', 'acme/other', 'project', 'info']],
    ['両方（サブコマンドの側が勝つ）', ['--repo', 'acme/demo', 'project', 'info', '--repo', 'acme/other']],
  ])('--repo を付けて打つと、ボードの項目をそのリポジトリに絞る（%s）', async ([, argv], context) => {
    await verifies(context, 'PW-PROJECT-INFO-03')
    const rules = [board(item('PVTI_1', 1, 'Ready'), item('PVTI_9', 9, 'Ready', { repo: 'other' })), twoAlerts(), prerequisitesRule({ number: 9, repo: 'other' })]
    const result = await run(argv, rules)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('## Board status (filter: acme/other)')
    expect(result.stdout).toContain('| acme/other#9 | 課題9 |')
    expect(result.stdout).not.toContain('acme/demo#1')
  })

  it('更新の新しい 20 件を超える Archived の項目があると、超えた分だけをボードから削除する', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-04')
    const result = await run(arguments_('info'), [board(...archivedItems(22), ...olderActive()), twoAlerts(), deletion('PVTI_a01'), deletion('PVTI_a02'), ...olderRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    const deleted = variableValues(result, 'DeleteProjectItem', 'itemId')
    expect(deleted.toSorted((first, second) => String(first).localeCompare(String(second)))).toEqual(['PVTI_a01', 'PVTI_a02'])
    // 古い updatedAt の Ready・Active は削除せず、ボードの状態に残る
    expect(result.stdout).toContain('| acme/demo#12 | 課題12 |')
    expect(result.stdout).toContain('| acme/demo#11 | 課題11 |')
    expect(result.stdout).toContain('| acme/demo#13 | 課題13 |')
  })

  it('Archived の項目がちょうど 20 件なら、ボードから何も削除しない', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-04')
    const result = await run(arguments_('info'), [board(...archivedItems(20), ...olderActive()), twoAlerts(), ...olderRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).not.toContain('DeleteProjectItem')
    expect(result.stderr).toBe('')
  })

  it('aggregation_repo を設定していると、概要に Roadmap repo として出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-05')
    const result = await run(arguments_('info'), standardBoard(), { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) })
    expect(result.stdout).toContain('- Roadmap repo: `acme/roadmap`\n')
  })

  it('Dependabot alert を取れたリポジトリの行に、open の件数か disabled を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-06')
    const rules = [board(), twoAlerts('demo'), alerts('other', { message: 'Forbidden' }, 403), restRule('GET', '/repos/acme/other/vulnerability-alerts', 404, { message: 'Not Found' })]
    const result = await run(arguments_('info'), rules, { config: twoRepositories })
    expect(result.code).toBe(0)
    expect(result.problems).toEqual([])
    expect(result.stdout).toContain('- acme/demo (develop: main)\n    release_type: single\n    dependabot_alerts: open 2\n')
    expect(result.stdout).toContain('- acme/other\n    release_type: single\n    dependabot_alerts: disabled\n')
  })

  it('Archived の項目を削除すると、deleted の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-07')
    const result = await run(arguments_('info'), [board(...archivedItems(22), ...olderActive()), twoAlerts(), deletion('PVTI_a01'), deletion('PVTI_a02'), ...olderRules()])
    expect(result.stderr).toBe('deleted: 2 archived items\n')
  })

  it('登録したリポジトリの Dependabot alert を取れないと、その行に失敗の理由を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-08')
    const rules = [board(), twoAlerts('demo'), alerts('other', { message: 'Boom' }, 500)]
    const result = await run(arguments_('info'), rules, { config: twoRepositories })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('    dependabot_alerts: open 2\n')
    expect(result.stdout).toMatch(/- acme\/other\n {4}release_type: single\n {4}dependabot_alerts: fetch failed \(acme\/other: .*Boom\)\n/u)
    // 取得は並行して送るので、受けた順は問わない
    expect(sorted(requestLabels(result.requests))).toEqual(sorted(['ListProjectItems', 'GET /repos/acme/demo/dependabot/alerts', 'GET /repos/acme/other/dependabot/alerts']))
  })

  it('Archived の項目を削除できなかったなら、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-09')
    const result = await run(arguments_('info'), [board(...archivedItems(22), ...olderActive()), twoAlerts(), deletion('PVTI_a01', 500), deletion('PVTI_a02'), ...olderRules()])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('deleted: 1 archived items\nwarning: failed to delete 1 archived items\n')
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-10')
    const result = await run(arguments_('info'), [], { config: false })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(NO_ACTIVE)
  })

  it('ボードの取得で GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-INFO-11')
    const result = await run(arguments_('info'), [failing('ListProjectItems')])
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

    const info = async (rules: ResponseRule[], config: Json = boardConfig(), ...rest: string[]): Promise<CommandResult> => await run(arguments_('info', ...rest), [twoAlerts(), ...rules], { config })
    const boardItems = (result: Readonly<CommandResult>): unknown => asJson(asJson(JSON.parse(result.stdout))['board'])['items']
    const notStarted = { number: 9 }
    const NOTE_ONE = 'warning: 1 Ready or Blocked Issue may be in a column or Status that does not match its judgment; run pecot board sync (--dry-run to preview) to fix'
    const NOTE_TWO = NOTE_ONE.replace('1 Ready or Blocked Issue may be', '2 Ready or Blocked Issues may be')
    const failedRead = (): ResponseRule => ({ match: { operation: 'GetIssuePrerequisites' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 })

    it('Ready と Blocked の表に Readiness の列を出し、判定とずれた列にあっても動かさない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-14')
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

    it('列と判定の食い違いそうな Issue を見つけると、件数と pecot board sync の案内を 1 行、標準エラーに出す', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-33')
      const result = await info([board(item('PVTI_1', 1, 'Ready'), item('PVTI_4', 4, 'Blocked'), item('PVTI_5', 5, 'Blocked')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 4, blockedBy: [notStarted] }), prerequisitesRule({ number: 5 })])
      expectClean(result)
      expect(result.stderr).toBe(`${NOTE_TWO}\n`)
    })

    it('board sync と同じ規則で数え、札の食い違いを数え、動かす先の値がボードに無い Issue は数えない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-33')
      const withoutBlocked = boardConfig()
      const project = asJson(withoutBlocked['project'])
      const fields = asJson(project['fields'])
      const workflow = asJson(fields['workflow'])
      const options = Object.fromEntries(Object.entries(asJson(workflow['options'])).filter(([name]) => name !== 'blocked'))
      const config = { ...withoutBlocked, project: { ...project, fields: { ...fields, workflow: { ...workflow, options } } } }
      const result = await info([board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] }), prerequisitesRule({ number: 3, label: 'Needs Attention', blockedBy: [{ number: 5, state: 'CLOSED', pullRequests: [{ number: 50, state: 'MERGED' }] }] })], config)
      expectClean(result)
      expect(result.stderr).toBe(`${NOTE_ONE}\n`)
    })

    it('Active と In Review の Issue は、前提を読まず、Readiness の列も出さない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-15')
      const result = await info([board(item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review'), item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1 })], boardConfig(), '--json')
      expectClean(result)
      expect(variableValues(result, 'GetIssuePrerequisites', 'number')).toEqual([1])
      expect(boardItems(result)).toMatchObject([{ readiness: null }, { readiness: null }, { readiness: { kind: 'startable' } }])
    })

    it('一覧で前提が 0 件の Issue は、前提を個別に読まず、一覧の値で判定する', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-30')
      const result = await info([board(item('PVTI_4', 4, 'Blocked', { progress: { blockedBy: 0 } }), item('PVTI_1', 1, 'Ready', { progress: { blockedBy: 0 } }))])
      expectClean(result)
      expect(result.stderr).toBe(`${NOTE_ONE}\n`)
      expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
      expect(result.stdout).toContain('| acme/demo#4 | 課題4 | startable |')
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | startable |')
    })

    it('一覧で前提が 0 件の Epic は、判定を出さず、前提を個別に読まない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-30')
      const result = await info([board(item('PVTI_1', 1, 'Ready', { progress: { blockedBy: 0, issueType: 'Epic' } }))], boardConfig(), '--json')
      expectClean(result)
      expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
      expect(boardItems(result)).toMatchObject([{ readiness: null }])
    })

    it('一覧で前提が 1 件以上の Issue だけ、その件数で前提を読む', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-31')
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

    it('読み取りに失敗した Issue は unknown と出し、列を動かさない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-18')
      const result = await info([board(item('PVTI_1', 1, 'Ready')), failedRead()])
      expectClean(result)
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/\| acme\/demo#1 \| 課題1 \| unknown \(GraphQL query error: Server error '500 Internal Server Error' for url '[^']+' For more information check: [^)]+\) \|/u)
      expect(result.stderr).toBe('')
    })

    it('読み取りに失敗した Issue の JSON の readiness は、stackOn と reason を null で持つ', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-32')
      const result = await info([board(item('PVTI_1', 1, 'Ready')), failedRead()], boardConfig(), '--json')
      expectClean(result)
      expect(boardItems(result)).toMatchObject([{ readiness: { kind: 'unknown', stackOn: null, reason: null } }])
    })

    it('前提の無い Issue だけのボードでは、すべて startable で、列を動かさない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-20')
      const result = await info([board(item('PVTI_1', 1, 'Ready'), item('PVTI_2', 2, 'Active'), item('PVTI_3', 3, 'In Review')), prerequisitesRule({ number: 1 })])
      expectClean(result)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | startable |')
      expect(result.stdout).not.toContain('## Stackable chains')
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
    })

    it('PR のカードと Tracker は、前提を読まない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-22')
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

    it('Epic は判定を出さず、JSON の readiness は null', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-23')
      const result = await info([board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, issueType: 'Epic', subIssues: 2 })], boardConfig(), '--json')
      expectClean(result)
      expect(requestLabels(result.requests)).not.toContain('UpdateProjectItemField')
      expect(boardItems(result)).toMatchObject([{ readiness: null }])
    })

    it('develop_branch の無いリポジトリで済んでいない前提があると、unknown と出し、列を動かさない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-24')
      const result = await info([board(item('PVTI_1', 1, 'Ready')), prerequisitesRule({ number: 1, blockedBy: [notStarted] })], boardConfig([{ owner: 'acme', name: 'demo' }]))
      expectClean(result)
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | unknown (develop_branch is not set for acme/demo) |')
      expect(result.stderr).toBe('')
    })

    it('Issue の依存関係に対応しない GHES では、warning を 1 回出し、Readiness の列の無い表を出す', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-25')
      const unsupported: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      const result = await info([board(item('PVTI_1', 1, 'Ready')), unsupported])
      expectClean(result)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: this GitHub Enterprise Server does not support issue dependencies (blockedBy); the Readiness column is omitted\n')
      expect(result.stdout).toContain('### Ready (1)\n| Ref | Title |\n|-----|----------|\n| acme/demo#1 | 課題1 |')
    })

    it('一覧の新しいクエリがスキーマの失敗になると、古いクエリで読み直し、判定を出さない', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-25')
      const rejected: ResponseRule = { match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }
      const legacy = graphqlRule('ListProjectItemsLegacy', { node: { items: { nodes: [item('PVTI_1', 1, 'Ready')], pageInfo: { hasNextPage: false, endCursor: null } } } })
      const result = await info([rejected, legacy])
      expectClean(result)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('warning: this GitHub Enterprise Server does not support issue dependencies (blockedBy); the Readiness column is omitted\n')
      expect(result.stdout).toContain('### Ready (1)\n| Ref | Title |\n|-----|----------|\n| acme/demo#1 | 課題1 |')
      expect(requestLabels(result.requests)).not.toContain('GetIssuePrerequisites')
    })

    describe('積める並び', () => {
      // Epic #10 の子 #2 が PR 中で、#3 がその上に積める
      const chain = (): ResponseRule[] => [
        board(item('PVTI_2', 2, 'In Review'), item('PVTI_3', 3, 'Ready')),
        prerequisitesRule({ number: 3, parent: { number: 10 }, blockedBy: [{ number: 2, column: 'In Review', branch: 'feat/2', pullRequests: [{ number: 20, head: 'feat/2' }] }] }),
      ]

      it('積める並びを、Epic ごとに ## Stackable chains の節へ出す', async (context) => {
        await verifies(context, 'PW-PROJECT-INFO-26')
        const result = await info(chain())
        expectClean(result)
        expect(result.stderr).toBe('')
        expect(result.stdout).toContain('| acme/demo#3 | 課題3 | stackable on #2 |')
        expect(result.stdout).toContain('\n\n## Stackable chains\n\n- #10: #2 -> #3')
      })

      it('--json は、各 Issue に readiness を足す', async (context) => {
        await verifies(context, 'PW-PROJECT-INFO-27')
        const result = await info(chain(), boardConfig(), '--json')
        expectClean(result)
        expect(boardItems(result)).toMatchObject([
          { readiness: null },
          { readiness: { kind: 'stackable', stackOn: { number: 2, repository: 'acme/demo', branch: 'feat/2' }, reason: null, text: 'stackable on #2' } },
        ])
      })
    })

    it('前提が輪になっている Issue は、cycle の blocked にする', async (context) => {
      await verifies(context, 'PW-PROJECT-INFO-28')
      const result = await info([
        board(item('PVTI_1', 1, 'Blocked'), item('PVTI_2', 2, 'Blocked')),
        prerequisitesRule({ number: 1, blockedBy: [{ number: 2 }] }),
        prerequisitesRule({ number: 2, blockedBy: [{ number: 1 }] }),
      ])
      expectClean(result)
      expect(result.stdout).toContain('| acme/demo#1 | 課題1 | blocked by #2 (cycle: #1 -> #2 -> #1) |')
      expect(result.stdout).toContain('| acme/demo#2 | 課題2 | blocked by #1 (cycle: #1 -> #2 -> #1) |')
    })
  })
})

describe('project activate', () => {
  const reference = (...rest: string[]): string[] => arguments_('activate', ...rest, '--host', DEFAULT_HOST, '--owner', 'acme')
  const NAME = path.parse(CONFIG_FILE).name
  const activateByNumber = async (extra: Partial<CommandRun> = {}, linkedNames: string[] = []): Promise<CommandResult> =>
    await run(reference('1'), [projectFields(), ...syncRules(...linkedNames)], { config: false, ...extra })
  const existing = (repositories: Json[], extra: Json = {}): Partial<CommandRun> => ({ config: projectConfig({ repositories, extra }) })

  it('--host を付けてプロジェクトを渡さずに打つと、初期化済みのプロジェクトを一覧する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-01')
    const result = await run(reference(), [listProjects(projectNode(1, 'board'), projectNode(2, 'plain')), projectFields(), projectFields(titleOnly, 'plain')], { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toBe(`=== Initialized projects (${DEFAULT_HOST}/acme) ===\n  #1: board\n`)
  })

  it('一覧にアクティブなプロジェクトがあると、その行に [ACTIVE] を付ける', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-02')
    const result = await run(reference(), [listProjects(projectNode(1, 'board')), projectFields()])
    expect(result.stdout).toBe(`=== Initialized projects (${DEFAULT_HOST}/acme) ===\n  #1: board [ACTIVE]\n`)
  })

  it('初期化済みのプロジェクトが 1 つも無い所有者を一覧すると、none の行を出す', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-03')
    const result = await run(reference(), [listProjects(projectNode(1, 'plain')), projectFields(titleOnly, 'plain')], { config: false })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`=== Initialized projects (${DEFAULT_HOST}/acme) ===\n  none\n`)
  })

  it('プロジェクトの番号か名前を渡すと、そのプロジェクトの設定ファイルを作る', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-04')
    const byNumber = await activateByNumber()
    expect(byNumber.code).toBe(0)
    expectClean(byNumber)
    expect(byNumber.stderr).toBe(`created: config file ${configPathOf(byNumber)}\nset: active project to ${NAME}\n`)
    expect(savedConfig(byNumber)).toMatchObject({ host: DEFAULT_HOST, owner: 'acme', project: { number: 1, id: 'PVT_1' } })
    const byName = await run(reference('board'), [listProjects(projectNode(1, 'board')), projectFields(), ...syncRules()], { config: false })
    expect(byName.code).toBe(0)
    expectClean(byName)
    expect(byName.read(CONFIG_FILE)).toBe(byNumber.read(CONFIG_FILE))
  })

  it('プロジェクトの番号か名前を渡すと、そのプロジェクトをアクティブにする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-05')
    const result = await activateByNumber()
    expect(result.read(ACTIVE_FILE)?.trim()).toBe(path.basename(CONFIG_FILE))
  })

  it('設定ファイルのパスかファイル名を渡すと、--host を渡さなくても設定ファイルの host で同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-06')
    const result = await run(arguments_('activate', NAME), [projectFields(), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stderr).toBe(`updated: config file ${configPathOf(result)}\nset: active project to ${NAME}\n`)
    const filePath = path.join(PROJECTS_DIRECTORY, path.basename(CONFIG_FILE))
    const byPath = await run(arguments_('activate', filePath), [projectFields(), ...syncRules()])
    expect(byPath.code).toBe(0)
    expectClean(byPath)
  })

  it('--owner を省くと、認証したユーザーのプロジェクトを対象にする', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-07')
    const result = await run(arguments_('activate', '--host', DEFAULT_HOST), [restRule('GET', '/user', 200, { login: 'acme' }), listProjects(projectNode(1, 'board')), projectFields()], { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    expect(result.stdout).toBe(`=== Initialized projects (${DEFAULT_HOST}/acme) ===\n  #1: board\n`)
  })

  it('既存の設定ファイルがあるプロジェクトを同期すると、リポジトリごとの branches・changelog_file・packages・release_type を引き継ぐ', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-08')
    const kept = { owner: 'acme', name: 'demo', develop_branch: 'dev', release_branch: 'rel', packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }], release_type: 'multi' }
    const withLog = { owner: 'acme', name: 'logged', changelog_file: 'docs/CHANGELOG.md', release_type: 'nx' }
    const result = await activateByNumber(existing([kept, withLog]), ['demo', 'logged'])
    expect(result.code).toBe(0)
    expect(repositoriesOf(result)).toEqual([kept, withLog])
  })

  it('既存の設定ファイルがあるプロジェクトを同期すると、aggregation_repo を引き継ぐ', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-09')
    const result = await activateByNumber(existing([{ owner: 'acme', name: 'demo' }], { aggregation_repo: 'acme/roadmap' }), ['demo'])
    expect(savedConfig(result)['aggregation_repo']).toBe('acme/roadmap')
  })

  it('リンクを外したリポジトリがあるプロジェクトを同期すると、そのリポジトリを設定ファイルから消す', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-10')
    const result = await activateByNumber(existing([{ owner: 'acme', name: 'demo' }, { owner: 'acme', name: 'gone' }]), ['demo'])
    expect(repositoriesOf(result)).toEqual([{ owner: 'acme', name: 'demo' }])
  })

  it('新しくリンクしたリポジトリがあるプロジェクトを同期すると、そのリポジトリを設定ファイルの末尾に足す', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-11')
    const result = await activateByNumber(existing([{ owner: 'acme', name: 'demo' }]), ['fresh', 'demo'])
    const names = repositoryEntries(result).map(entry => entry['name'])
    expect(names).toEqual(['demo', 'fresh'])
  })

  it('--host が要る場面で渡していないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-12')
    const result = await run(arguments_('activate', '1'), [], { config: false })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: --host is required\n  example: pecot project activate --host github.com --owner example-org\n  example: pecot project activate --host ghes.example.com --owner example-org\n  example: pecot project activate ghes.example.com_example-org_example-project_example-org\n')
  })

  it('指定したプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-13')
    const byNumber = await run(reference('999'), missingProject(), { config: false })
    expect(byNumber.code).toBe(1)
    expect(byNumber.stderr).toBe('error: project #999 not found\n')
    const byName = await run(reference('Non Existent'), [listProjects(projectNode(2, 'Other Project'))], { config: false })
    expect(byName.code).toBe(1)
    expect(byName.stderr).toBe('error: project not found: Non Existent\n  available projects:\n  - Other Project\n')
  })

  it('指定したプロジェクトが初期化されていないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-14')
    const result = await run(reference('1'), [projectFields(titleOnly, 'Not Initialized Project')], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`error: project "Not Initialized Project" is not initialized\n  run: pecot project init --host ${DEFAULT_HOST} --suffix <suffix> acme "Not Initialized Project"\n`)
    expect(result.read(CONFIG_FILE)).toBeUndefined()
  })

  it('GitHub API がエラーを返すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-15')
    const result = await run(reference(), [failing('ListProjectsUser'), failing('ListProjectsOrg')], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not activate project: /u)
  })

  it('渡した設定ファイルを読めないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-16')
    const result = await run(arguments_('activate', 'broken'), [], { config: false, files: { [`${PROJECTS_DIRECTORY}/broken.json`]: '{ not json' } })
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^error: could not load config file broken\.json: /u)
    expect(result.requests).toEqual([])
  })

  it('--host が渡した設定ファイルの host と違うと、warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-17')
    const result = await run(arguments_('activate', NAME, '--host', 'github.com'), [projectFields(), ...syncRules()])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(`warning: --host (github.com) differs from the config file host (${DEFAULT_HOST})\n  using the config file host\nupdated: config file ${configPathOf(result)}\nset: active project to ${NAME}\n`)
  })

  it('--host が渡した設定ファイルの host と違うと、設定ファイルの host で同期する', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-18')
    // github.com 用のトークンは無いので、設定ファイルの host で送れたときだけ成功する
    const result = await run(arguments_('activate', NAME, '--host', 'github.com'), [projectFields(), ...syncRules()])
    expect(result.code).toBe(0)
    expectClean(result)
    expect(savedConfig(result)['host']).toBe(DEFAULT_HOST)
  })

  it('Blocked の無いボードでも同期が通り、設定ファイルに blocked のキーを書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-19')
    const result = await activateByNumber()
    expect(result.code).toBe(0)
    expectClean(result)
    const fields = asJson(asJson(savedConfig(result)['project'])['fields'])
    expect(asJson(fields['workflow'])['options']).not.toHaveProperty('blocked')
    expect(asJson(savedConfig(result)['project'])['board_url']).not.toContain('Blocked')
    expect(fields['status']).toEqual({ id: 'PVTSSF_status', options: { todo: 'o1' } })
  })

  it('Blocked と Needs Attention があるボードを同期すると、その id を設定ファイルに書く', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-20')
    const fields = [...standardFields(WORKFLOW_NAMES_WITH_BLOCKED).slice(0, 4), statusField([...STATUS_NAMES, 'Needs Attention'])]
    const result = await run(reference('1'), [projectFields(fields), listProjects(projectNode(1, 'board')), projectFields(fields), linked()], { config: false })
    expect(result.code).toBe(0)
    expectClean(result)
    const saved = asJson(asJson(savedConfig(result)['project'])['fields'])
    expect(asJson(saved['workflow'])['options']).toMatchObject({ blocked: 'o2', ready: 'o4' })
    expect(saved['status']).toEqual({ id: 'PVTSSF_status', options: { todo: 'o1', needs_attention: 'o4' } })
    expect(asJson(savedConfig(result)['project'])['board_url']).toContain('Blocked')
  })

  it('ボードの値が小文字の blocked でも、設定ファイルに id を書き、board_url の絞り込みに Blocked を含める', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-20')
    const names = WORKFLOW_NAMES_WITH_BLOCKED.map(name => name === 'Blocked' ? 'blocked' : name)
    const fields = standardFields(names).slice(0, 4)
    const result = await run(reference('1'), [projectFields(fields), listProjects(projectNode(1, 'board')), projectFields(fields), linked()], { config: false })
    expect(result.code).toBe(0)
    expect(workflowOptions(result)).toHaveProperty('blocked', 'o2')
    expect(asJson(savedConfig(result)['project'])['board_url']).toContain('Blocked')
  })

  it('Status のフィールドが無いボードを同期すると、fields.status を書かない', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-21')
    const fields = standardFields().slice(0, 4)
    const result = await run(reference('1'), [projectFields(fields), listProjects(projectNode(1, 'board')), projectFields(fields), linked()], { config: false })
    expect(result.code).toBe(0)
    const saved = asJson(savedConfig(result)['project'])
    expect(asJson(saved['fields'])).not.toHaveProperty('status')
  })

  it('必須の値（Blocked を除く 6 つ）が欠けたボードを同期すると、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-PROJECT-ACTIVATE-22')
    const result = await run(reference('1'), [projectFields(standardFields(['Backlog', 'Blocked'])), listProjects(projectNode(1, 'board')), projectFields(standardFields(['Backlog', 'Blocked']))], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('pecot-workflow field is missing options: Pending, Ready, Active, In Review, Archived')
    expect(result.read(CONFIG_FILE)).toBeUndefined()
  })
})

describe('repo set', () => {
  const demo = { owner: 'acme', name: 'demo', develop_branch: 'main' }
  const withRepository = (...repositories: Json[]): Partial<CommandRun> => ({ config: projectConfig({ repositories }) })
  const setRepository = async (argv: string[], extra: Partial<CommandRun> = {}, github: ResponseRule[] = []): Promise<CommandResult> => await run(repositoryArguments('set', ...argv), github, extra)

  it('未登録のリポジトリを渡すと、プロジェクトにリンクする', async (context) => {
    await verifies(context, 'PW-REPO-SET-01')
    const result = await setRepository(['acme/other'], {}, linkRules())
    expect(result.code).toBe(0)
    expectClean(result)
    expect(requestLabels(result.requests)).toEqual(['GetProjectIdUser', 'GetRepositoryId', 'LinkProjectRepository'])
    expect(graphqlVariables(result, 'LinkProjectRepository')).toEqual([{ projectId: 'PVT_1', repositoryId: 'R_2' }])
  })

  it('リンクに成功すると、設定ファイルにリポジトリを足す', async (context) => {
    await verifies(context, 'PW-REPO-SET-02')
    const result = await setRepository(['acme/other', '-b', 'dev', '--release-type', 'nx'], {}, linkRules())
    expect(repositoriesOf(result)).toEqual([demo, { owner: 'acme', name: 'other', develop_branch: 'dev', release_type: 'nx' }])
    expect(result.stderr).toBe(`added: acme/other to project #1\nadded: acme/other to ${configPathOf(result)}\n`)
  })

  it('登録済みのリポジトリを渡すと、渡したオプションの値だけを更新する', async (context) => {
    await verifies(context, 'PW-REPO-SET-03')
    const result = await setRepository(['acme/demo', '-b', 'dev'], withRepository({ ...demo, release_branch: 'release' }))
    expect(result.code).toBe(0)
    expect(result.requests).toEqual([])
    expect(repositoriesOf(result)).toEqual([{ owner: 'acme', name: 'demo', develop_branch: 'dev', release_branch: 'release' }])
    expect(result.stderr).toBe(`updated: acme/demo in ${configPathOf(result)}\n`)
  })

  it('登録済みのリポジトリに --package を渡すと、packages を置き換える', async (context) => {
    await verifies(context, 'PW-REPO-SET-04')
    const result = await setRepository(['acme/demo', '--package', 'a:a/CHANGELOG.md', '--package', 'b:b/CHANGELOG.md'], withRepository({ ...demo, packages: [{ name: 'old', changelog: 'old.md' }] }))
    expect(repositoriesOf(result)).toEqual([{ ...demo, packages: [{ name: 'a', changelog: 'a/CHANGELOG.md' }, { name: 'b', changelog: 'b/CHANGELOG.md' }] }])
  })

  it('登録済みのリポジトリに --package を渡すと、changelog_file を消す', async (context) => {
    await verifies(context, 'PW-REPO-SET-05')
    const result = await setRepository(['acme/demo', '--package', 'a:a/CHANGELOG.md'], withRepository({ ...demo, changelog_file: 'CHANGELOG.md' }))
    const [entry] = repositoryEntries(result)
    expect(entry).not.toHaveProperty('changelog_file')
    expect(entry).toHaveProperty('packages')
  })

  it('登録済みのリポジトリに --clear-packages を付けると、packages を消す', async (context) => {
    await verifies(context, 'PW-REPO-SET-06')
    const result = await setRepository(['acme/demo', '--clear-packages'], withRepository({ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }))
    expect(result.code).toBe(0)
    expect(repositoriesOf(result)).toEqual([demo])
  })

  it('リンクに失敗すると、設定ファイルを書き換えない', async (context) => {
    await verifies(context, 'PW-REPO-SET-07')
    const before = JSON.stringify(projectConfig(), undefined, 2)
    const result = await setRepository(['acme/other'], {}, [projectIdRule(), unresolvedRepository()])
    expect(JSON.parse(result.read(CONFIG_FILE) ?? '')).toEqual(JSON.parse(before))
  })

  it('リンクに失敗すると、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-08')
    const result = await setRepository(['acme/other'], {}, [projectIdRule(), unresolvedRepository()])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: could not link acme/other to project #1: GraphQL query error: {\'type\': \'NOT_FOUND\', \'message\': \'Could not resolve to a Repository with the name acme/other.\'}\n')
  })

  it('--package と --changelog-file を一緒に渡すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-09')
    const result = await setRepository(['acme/demo', '--package', 'a:a.md', '--changelog-file', 'C.md'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: --package and --changelog-file cannot be used together\n')
  })

  it('--package と --clear-packages を一緒に渡すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-10')
    const result = await setRepository(['acme/demo', '--package', 'a:a.md', '--clear-packages'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: --package and --clear-packages cannot be used together\n')
  })

  it('--package が NAME:PATH の形でないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-11')
    const result = await setRepository(['acme/demo', '--package', 'nocolon'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: give --package as NAME:PATH: \'nocolon\'\n')
  })

  it('--package の NAME が重なると、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-12')
    const result = await setRepository(['acme/demo', '--package', 'foo:a.md', '--package', 'foo:b.md'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: --package NAME is duplicated: \'foo\'\n')
  })

  it('未登録のリポジトリに不正な --package の名前を渡すと、リンクせず終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-11')
    const result = await setRepository(['acme/new', '--package', 'bad name:p'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: /u)
    expect(requestLabels(result.requests)).not.toContain('LinkProjectRepository')
    expect(JSON.parse(result.read(CONFIG_FILE) ?? '')).toEqual(projectConfig())
  })

  it('リポジトリの所有者がプロジェクトの所有者と違うと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-13')
    const result = await setRepository(['different-owner/repo'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: repository owner different-owner differs from project owner acme\n  GitHub Projects V2 links only repositories of the project owner\n')
  })

  it('リポジトリが owner/repo の形でないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-14')
    const result = await setRepository(['justname'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: give the repository as owner/repo\n  example: pecot repo set example-org/my-repo\n')
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-15')
    const result = await setRepository(['acme/demo'], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(NO_ACTIVE)
  })

  it('--release-type が single・multi・nx のどれでもないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-16')
    const result = await setRepository(['acme/demo', '--release-type', 'bogus'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: --release-type must be one of [\'multi\', \'nx\', \'single\'] (got: \'bogus\')\n')
  })

  it('packages を持つリポジトリに --changelog-file を渡すと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-REPO-SET-17')
    const result = await setRepository(['acme/demo', '--changelog-file', 'C.md'], withRepository({ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }))
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: this repository has packages set\n  run with --clear-packages before switching to --changelog-file\n')
    expect(repositoriesOf(result)).toEqual([{ ...demo, packages: [{ name: 'a', changelog: 'a.md' }] }])
  })
})

describe('aggregation set', () => {
  const withAggregation = (value?: string): Partial<CommandRun> => ({ config: projectConfig(value === undefined ? {} : { extra: { aggregation_repo: value } }) })
  const set = async (argv: string[], extra: Partial<CommandRun> = {}): Promise<CommandResult> => await run(aggregationArguments('set', ...argv), [], extra)

  it('未設定の状態で値を渡すと、設定ファイルに書く', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SET-01')
    const result = await set(['acme/roadmap'])
    expect(result.code).toBe(0)
    expect(savedConfig(result)['aggregation_repo']).toBe('acme/roadmap')
  })

  it('未設定の状態で値を渡すと、set の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SET-02')
    const result = await set(['acme/roadmap'])
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('set: aggregation_repo to acme/roadmap\n')
  })

  it('既にある値と同じ値を渡すと、unchanged の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SET-03')
    const result = await set(['acme/roadmap'], withAggregation('acme/roadmap'))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('unchanged: aggregation_repo acme/roadmap\n')
  })

  it('既にある値と違う値を渡すと、上書きの warning の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SET-04')
    const result = await set(['acme/new'], withAggregation('acme/roadmap'))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('warning: overwriting aggregation_repo: acme/roadmap -> acme/new\n  pass --yes to omit this hint\nset: aggregation_repo to acme/new\n')
    expect(savedConfig(result)['aggregation_repo']).toBe('acme/new')
  })

  it('--yes を付けて上書きすると、warning の行から確認の案内を省く', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SET-05')
    const result = await set(['acme/new', '--yes'], withAggregation('acme/roadmap'))
    expect(result.stderr).toBe('warning: overwriting aggregation_repo: acme/roadmap -> acme/new\nset: aggregation_repo to acme/new\n')
  })

  it('値が owner/repo の形でないと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SET-06')
    const result = await set(['roadmap'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('error: give aggregation_repo as owner/repo: \'roadmap\'\n')
    expect(savedConfig(result)).not.toHaveProperty('aggregation_repo')
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SET-07')
    const result = await set(['acme/roadmap'], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(NO_ACTIVE)
  })
})

describe('aggregation unset', () => {
  const configured = { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) }

  it('値を設定していると、設定ファイルから消す', async (context) => {
    await verifies(context, 'PW-AGGREGATION-UNSET-01')
    const result = await run(aggregationArguments('unset'), [], configured)
    expect(result.code).toBe(0)
    expect(savedConfig(result)).not.toHaveProperty('aggregation_repo')
  })

  it('値を設定していると、removed の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-AGGREGATION-UNSET-02')
    const result = await run(aggregationArguments('unset'), [], configured)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('removed: aggregation_repo (was acme/roadmap)\n')
  })

  it('未設定だと、unchanged の行を標準エラーに出す', async (context) => {
    await verifies(context, 'PW-AGGREGATION-UNSET-03')
    const result = await run(aggregationArguments('unset'))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('unchanged: aggregation_repo (not set)\n')
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-AGGREGATION-UNSET-04')
    const result = await run(aggregationArguments('unset'), [], { config: false })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(NO_ACTIVE)
  })
})

describe('aggregation show', () => {
  it('値を設定していると、その値を標準出力に出す', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SHOW-01')
    const result = await run(aggregationArguments('show'), [], { config: projectConfig({ extra: { aggregation_repo: 'acme/roadmap' } }) })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('acme/roadmap\n')
  })

  it('未設定だと、none を標準出力に出す', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SHOW-02')
    const result = await run(aggregationArguments('show'))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('none\n')
  })

  it('アクティブなプロジェクトが無いと、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-AGGREGATION-SHOW-03')
    const result = await run(aggregationArguments('show'), [], { config: false })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(NO_ACTIVE)
  })
})
