// project のグループのコマンド。Python の cli/commands/project.py の移植。
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { RELEASE_TYPES, findRepository, parsePackage, withAggregationRepository, withRepositoryAppended, withRepositoryReplaced, parseProjectConfig, serializeProjectConfig, WORKFLOW_FIELD_NAME } from '../domain/config.js'
import type { Package, ProjectConfig, Repository } from '../domain/config.js'
import { choosePlacement, insertOption } from '../domain/field-options.js'
import type { FieldOptionInput } from '../domain/field-options.js'
import { JSON_NULL } from '../domain/json-null.js'
import { mergeLaneOptions } from '../domain/lane-options.js'
import { jsonField, parseJsonText } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { compareStrings, pythonStrip, pythonStringRepr, splitCodePoints, truncateCodePoints } from '../domain/python-format.js'
import type { JsonValue } from '../domain/python-format.js'
import { splitOwnerRepository } from '../domain/repository-resolver.js'
import { getActiveConfigPath, loadConfig, projectsDirectory, saveConfig } from '../infra/config-store.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError, GitHubRateLimitError } from '../infra/github/errors.js'
import { asArray, isTruthy, requireNumber, requireString } from '../infra/github/payload.js'
import type { LinkResult, ProjectFieldOption, ProjectViewTarget } from '../infra/github/projects.js'
import { resolveRealPath } from '../infra/paths.js'
import { hasErrorCode } from '../infra/os-error.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { commandHint, hinted, inputHint, inputNameHint, placeholder, RUN, RUN_COLON } from './command-hint.js'
import { requireActiveConfig, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createAuthenticatedGitHubClient, createGitHubClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import type { ConfigPlacement, OptionSpec, SyncedProjectConfig } from './project-sync.js'
import {
  BLOCKED_SPEC,
  LANE_FIELD_NAME,
  LANES_VIEW_NAME,
  NEEDS_ATTENTION_SPEC,
  PRIORITY_FIELD_OPTIONS,
  SIZE_FIELD_OPTIONS,
  STATUS_FIELD_NAME,
  WORKFLOW_FIELD_OPTIONS,
  buildRepository,
  failApi,
  fieldNodesOf,
  findProjectByTitle,
  hasWorkflowField,
  lastFieldNamed,
  missingRequiredOptions,
  stopMissingOptions,
  placeProjectConfig,
  planWorkflowFieldOf,
  reportConfigMove,
  syncProjectConfig,
  textOf,
} from './project-sync.js'

const DEFAULT_HOST = 'github.com'
function linkChange(existing: Repository | undefined): 'create' | 'update' {
  return existing === undefined ? 'create' : 'update'
}

function setChange(hasPrevious: boolean): 'create' | 'update' {
  return hasPrevious ? 'update' : 'create'
}

const dryRunInput = z.boolean().default(false).describe('Show what would change without writing anything')
const lanesInput = z.array(z.string().min(1)).min(1).optional().describe('Values of the pecot-lane field: the areas of work, such as plugins, teams or services. GitHub shows them on the board, so use English names. Values already on the board are kept')
const INIT_PATH: readonly string[] = ['project', 'init']
const CREATE_PATH: readonly string[] = ['project', 'create']
const AGGREGATION_REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/u
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])
const SEARCH_TITLE_LIMIT = 38
const SEARCH_TITLE_WIDTH = 40

/**
GitHub API の失敗を `could not <action>` の行にして、終了コード 1 で止める
*/
async function guarded<T>(out: Readonly<Output>, action: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return failApi(out, action, error)
    throw error
  }
}

// パスが無い・辿れない（ENOENT・ENOTDIR・ELOOP）。Python の Path.exists() が False を返す場合と同じ
function isMissingPath(error: unknown): boolean {
  return hasErrorCode(error) && MISSING_PATH_CODES.has(error.code)
}

// projects/ の *.json のファイル名（名前順）。ディレクトリが無ければ空
function readProjectFiles(directory: string): readonly string[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- プロジェクトルート配下の設定ディレクトリ
    return readdirSync(directory).filter(name => name.endsWith('.json')).toSorted(compareStrings)
  }
  catch (error: unknown) {
    if (isMissingPath(error)) return []
    throw error
  }
}

function isFile(target: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者が渡した設定ファイルのパス
    return statSync(target).isFile()
  }
  catch (error: unknown) {
    if (isMissingPath(error)) return false
    throw error
  }
}

function padEndCodePoints(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - splitCodePoints(text).length))
}

function requireActiveWithPath(out: Readonly<Output>): { readonly config: ProjectConfig, readonly configPath: string } {
  const config = requireActiveConfig(out)
  const configPath = getActiveConfigPath() ?? stopWith(out, 'cannot determine the config file path', 'config-invalid')
  return { config, configPath }
}

// 保存の前に、設定として読み直せる形かを確かめる（読めなければ ValidationFailure）
function validated(config: ProjectConfig): ProjectConfig {
  return parseProjectConfig(parseJsonText(serializeProjectConfig(config)))
}

// project list

const LIST_ROW = z.strictObject({
  name: z.string().describe('Name of the project config (the file name without .json)'),
  active: z.boolean().describe('Whether this config is the active project'),
})

const LIST_OUTPUT = z.strictObject({
  projects: z.array(LIST_ROW).describe('Project configs under the projects directory (an empty array when there is none)'),
})

const listCommand = defineCommand({
  path: ['project', 'list'],
  title: 'List projects',
  description: 'List available projects',
  input: z.strictObject({}),
  output: LIST_OUTPUT,
  positional: [],
  interactive: false,
  run: (_input, io) => {
    const out = createOutput<z.input<typeof LIST_OUTPUT>>(false, io)
    const lines = ['=== Projects ===']
    const directory = projectsDirectory()
    const files = readProjectFiles(directory)
    if (files.length === 0) {
      lines.push('  none')
      out.data(lines.join('\n'))
      out.result({ projects: [] })
      return Promise.resolve(0)
    }
    const active = getActiveConfigPath()
    const projects: { name: string, active: boolean }[] = []
    for (const file of files) {
      const isActive = active !== undefined && resolveRealPath(path.join(directory, file)) === resolveRealPath(active)
      lines.push(`  ${path.parse(file).name}${isActive ? ' [ACTIVE]' : ''}`)
      projects.push({ name: path.parse(file).name, active: isActive })
    }
    out.data(lines.join('\n'))
    out.result({ projects })
    return Promise.resolve(0)
  },
})

// project search

const SEARCH_ROW = z.strictObject({
  number: z.int().optional().describe('Project number (omitted when GitHub did not return it)'),
  title: z.string().optional().describe('Project title (omitted when GitHub did not return it)'),
  url: z.string().optional().describe('Project URL (omitted when GitHub did not return it)'),
  initialized: z.boolean().optional().describe('Whether project init has set up the fields (omitted without a number, or when the fields could not be read)'),
  active: z.boolean().optional().describe('Whether this project is the active one (omitted without a number)'),
})

const SEARCH_OUTPUT = z.strictObject({
  owner: z.string().describe('Project owner that was searched'),
  host: z.string().describe('GitHub host that was searched'),
  projects: z.array(SEARCH_ROW).describe('Projects of the owner'),
})

type SearchRow = z.input<typeof SEARCH_ROW>

// 初期化済みかは project activate と同じく workflow のフィールドの有無で決める。読めない行は initialized を省く
async function searchRow(out: Readonly<Output>, client: Readonly<GitHubClient>, owner: string, project: Readonly<Record<string, JsonValue>>, activeNumber: number | undefined): Promise<SearchRow> {
  const { number, title, url } = project
  const row: SearchRow = {
    ...typeof number === 'number' && { number },
    ...typeof title === 'string' && { title },
    ...typeof url === 'string' && { url },
  }
  if (typeof number !== 'number') return row
  const isActive = activeNumber === number
  let info: Readonly<Record<string, JsonValue>> | undefined
  try {
    info = await client.getProjectFields(owner, number)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not read the fields of project #${String(number)}: ${error.message}`)
    return { ...row, active: isActive }
  }
  if (info === undefined || !isTruthy(info)) {
    out.warning(`could not read the fields of project #${String(number)}`)
    return { ...row, active: isActive }
  }
  return { ...row, initialized: hasWorkflowField(fieldNodesOf(info)), active: isActive }
}

const searchCommand = defineCommand({
  path: ['project', 'search'],
  title: 'Search projects',
  description: 'Search projects through the GitHub API, and show which are initialized and which is active',
  input: z.strictObject({
    owner: z.string().describe('Project owner'),
    host: z.string().default(DEFAULT_HOST).describe('GitHub host'),
  }),
  output: SEARCH_OUTPUT,
  positional: ['owner'],
  shortFlags: { host: '-h' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof SEARCH_OUTPUT>>(false, io)
    const { owner, host } = input
    await guarded(out, 'list projects', async () => {
      const client = createGitHubClient(out, host)
      const projects = await client.listProjects(owner)
      if (projects.length === 0) stopWith(out, `no projects found for ${owner}`, 'project-not-found')
      const activeNumber = activeProjectNumber(host, owner)
      const lines = [`=== Projects of ${owner} (${host}) ===`, '', `${padEndCodePoints('#', 4)} ${padEndCodePoints('Title', SEARCH_TITLE_WIDTH)} URL`, '-'.repeat(80)]
      const rows: SearchRow[] = []
      for (const project of projects) {
        const row = await searchRow(out, client, owner, project, activeNumber)
        const number = project['number'] === undefined ? '?' : textOf(project['number'])
        const rawTitle = project['title'] === undefined ? '(untitled)' : textOf(project['title'])
        const title = splitCodePoints(rawTitle).length > SEARCH_TITLE_LIMIT ? `${truncateCodePoints(rawTitle, 35)}...` : rawTitle
        const marks = `${row.initialized === true ? ' [INITIALIZED]' : ''}${row.active === true ? ' [ACTIVE]' : ''}`
        lines.push(`${padEndCodePoints(number, 4)} ${padEndCodePoints(title, SEARCH_TITLE_WIDTH)} ${project['url'] === undefined ? '' : textOf(project['url'])}${marks}`)
        rows.push(row)
      }
      out.data(lines.join('\n'))
      out.result({ owner, host, projects: rows })
    })
    return 0
  },
})

// project init

// 読んだ選択肢を更新の入力にそろえる。color が読めないときは、既存の色を上書きしないよう止める
function optionInputsOf(field: Readonly<JsonObject>): readonly FieldOptionInput[] {
  return asArray(field['options']).map((option) => {
    const description = jsonField(option, 'description')
    return {
      id: requireString(jsonField(option, 'id'), 'option.id'),
      name: requireString(jsonField(option, 'name'), 'option.name'),
      color: requireString(jsonField(option, 'color'), 'option.color'),
      description: typeof description === 'string' ? description : '',
    }
  })
}

interface FieldReport {
  readonly name: string
  change: 'create' | 'update' | 'unchanged' | 'skip' | 'rename'
  addedOptions: string[]
}

type MarkField = (name: string, change: FieldReport['change'], addedOption?: string) => void

// フィールドごとの結果を溜め、進むたびに全体を渡す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- data の型が可変の配列
function fieldReporter(publish: ((fields: FieldReport[]) => void) | undefined): MarkField {
  const entries = new Map<string, FieldReport>()
  return (name, change, addedOption) => {
    const entry = entries.get(name) ?? { name, change, addedOptions: [] }
    // 改名した欄は、選択肢を足しても rename のまま残す
    if (change !== 'unchanged' && entry.change !== 'rename') entry.change = change
    if (addedOption !== undefined) entry.addedOptions.push(addedOption)
    entries.set(name, entry)
    publish?.(Array.from(entries.values(), report => ({ ...report, addedOptions: [...report.addedOptions] })))
  }
}

// 既にあるフィールドに選択肢を 1 つ足す。足した（予行では、足す予定の）数（0 か 1）を返す
async function addFieldOption(out: Readonly<Output>, client: Readonly<GitHubClient>, field: Readonly<JsonObject>, spec: OptionSpec, run: Readonly<{ isDryRun: boolean, mark: MarkField }>): Promise<number> {
  const { isDryRun, mark } = run
  const { option } = spec
  const fieldName = textOf(field['name'])
  const existing = optionInputsOf(field)
  const merged = insertOption(existing, option, choosePlacement(existing, spec.placement ?? [{ end: true }]))
  if (merged === undefined) {
    const unchanged: Operation = { verb: 'unchanged', target: `option ${option.name} in field ${fieldName}` }
    out.planned(unchanged)
    out.done(unchanged)
    mark(fieldName, 'unchanged')
    return 0
  }
  const added: Operation = { verb: 'add', target: `option ${option.name} to field ${fieldName}` }
  if (isDryRun) {
    out.planned(added)
    mark(fieldName, 'update', option.name)
    return 1
  }
  try {
    await client.updateProjectFieldOptions(requireString(field['id'], 'field.id'), merged)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    // 選択肢の id を拒む GHES などで足せなくても、作ったフィールドと設定ファイルの同期は進める
    out.warning(`could not add option ${option.name} to field ${fieldName}: ${error.message}`)
    mark(fieldName, 'unchanged')
    return 0
  }
  out.done(added)
  mark(fieldName, 'update', option.name)
  return 1
}

// 既にあるフィールドに足す選択肢。作ったばかりの進行の欄は workflowField が無く、何も出さない（created の行が出ている）
// 足した（予行では、足す予定の）選択肢の数を返す
async function addMissingOptions(out: Readonly<Output>, client: Readonly<GitHubClient>, fields: readonly JsonValue[], workflowField: Readonly<JsonObject> | undefined, run: Readonly<{ isDryRun: boolean, mark: MarkField }>): Promise<number> {
  const blocked = workflowField === undefined ? 0 : await addFieldOption(out, client, workflowField, BLOCKED_SPEC, run)
  const statusField = lastFieldNamed(fields, STATUS_FIELD_NAME)
  if (statusField === undefined) {
    skipped(out, `field ${STATUS_FIELD_NAME} (not found)`)
    run.mark(STATUS_FIELD_NAME, 'skip')
    return blocked
  }
  return blocked + await addFieldOption(out, client, statusField, NEEDS_ATTENTION_SPEC, run)
}

function skipped(out: Readonly<Output>, target: string): void {
  out.planned({ verb: 'skip', target })
  out.done({ verb: 'skip', target })
}

// 旧い名前の進行の欄を pecot-status に改名する。選択肢を渡さないので、選択肢の ID と各 Item の値は残る
async function renameWorkflowField(out: Readonly<Output>, client: Readonly<GitHubClient>, field: Readonly<JsonObject>, run: Readonly<{ isDryRun: boolean, mark: MarkField }>): Promise<void> {
  const operation: Operation = { verb: 'rename', target: `field ${textOf(field['name'])} to ${WORKFLOW_FIELD_NAME}` }
  if (run.isDryRun) out.planned(operation)
  else {
    await client.renameProjectField(requireString(field['id'], 'field.id'), WORKFLOW_FIELD_NAME)
    out.done(operation)
  }
  run.mark(WORKFLOW_FIELD_NAME, 'rename')
}

/**
pecot-lane の扱いの入力。command は案内に出すコマンド（project init か project create）
*/
interface LaneRequest {
  readonly lanes?: readonly string[] | undefined
  readonly command: readonly string[]
}

// pecot-lane を作るか、足りない値を足す。足した（予行では、足す予定の）数と、ビューを用意できる欄があるかを返す
async function prepareLaneField(out: Readonly<Output>, client: Readonly<GitHubClient>, board: Readonly<{ projectId: string, fields: readonly JsonValue[] }>, request: Readonly<LaneRequest>, run: Readonly<{ isDryRun: boolean, mark: MarkField }>): Promise<Readonly<{ count: number, hasField: boolean }>> {
  const { lanes, command } = request
  const field = lastFieldNamed(board.fields, LANE_FIELD_NAME)
  if (field === undefined) {
    if (board.fields.some(node => jsonField(node, 'name') === LANE_FIELD_NAME)) {
      skipped(out, `field ${LANE_FIELD_NAME} (not a single select field)`)
      out.warning(`field ${LANE_FIELD_NAME} is not a single select field, so no lanes were added and view ${LANES_VIEW_NAME} was not created\ndelete or rename that field on the board, then run again`)
      run.mark(LANE_FIELD_NAME, 'skip')
      return { count: 0, hasField: false }
    }
    if (lanes === undefined) {
      skipped(out, `field ${LANE_FIELD_NAME} (no lanes given)`)
      out.warning(hinted`field ${LANE_FIELD_NAME} was not created because no lanes were given\nchoose the lanes (the areas of work, such as plugins, teams or services) and pass them with ${inputNameHint(command, 'lanes')}`)
      run.mark(LANE_FIELD_NAME, 'skip')
      return { count: 0, hasField: false }
    }
    if (run.isDryRun) out.planned({ verb: 'create', target: `field ${LANE_FIELD_NAME}` })
    else {
      const created = await client.createProjectField(board.projectId, LANE_FIELD_NAME, mergeLaneOptions([], lanes).options)
      out.done({ verb: 'create', target: `field ${LANE_FIELD_NAME} (ID: ${requireString(created['id'], 'field.id')})` })
    }
    run.mark(LANE_FIELD_NAME, 'create')
    return { count: 1, hasField: true }
  }
  skipped(out, `field ${LANE_FIELD_NAME} (already exists)`)
  run.mark(LANE_FIELD_NAME, 'unchanged')
  return { count: lanes === undefined ? 0 : await addLaneOptions(out, client, field, lanes, run), hasField: true }
}

// 既にある pecot-lane に無い値を末尾に足す。足した（予行では、足す予定の）数を返す
async function addLaneOptions(out: Readonly<Output>, client: Readonly<GitHubClient>, field: Readonly<JsonObject>, lanes: readonly string[], run: Readonly<{ isDryRun: boolean, mark: MarkField }>): Promise<number> {
  const { options, added } = mergeLaneOptions(optionInputsOf(field), lanes)
  const given = new Set(lanes)
  for (const lane of given) {
    if (added.includes(lane)) continue
    const unchanged: Operation = { verb: 'unchanged', target: `option ${lane} in field ${LANE_FIELD_NAME}` }
    out.planned(unchanged)
    out.done(unchanged)
  }
  if (added.length === 0) return 0
  if (!run.isDryRun) {
    try {
      await client.updateProjectFieldOptions(requireString(field['id'], 'field.id'), options)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
      out.warning(`could not add options ${added.join(', ')} to field ${LANE_FIELD_NAME}: ${error.message}`)
      return 0
    }
  }
  for (const lane of added) {
    const operation: Operation = { verb: 'add', target: `option ${lane} to field ${LANE_FIELD_NAME}` }
    if (run.isDryRun) out.planned(operation)
    else out.done(operation)
    run.mark(LANE_FIELD_NAME, 'update', lane)
  }
  return added.length
}

const VIEW = z.strictObject({
  created: z.boolean().describe('Whether the view was created (with dry_run: whether it would be created); false when a view of that name already exists or it has to be created by hand'),
  name: z.string().describe('Name of the view (Lanes)'),
  url: z.string().optional().describe('URL of the view (omitted with dry_run, and when it has to be created by hand)'),
  manual_steps: z.array(z.string()).optional().describe('Steps to create the view on the board, when GitHub refused to create it (omitted otherwise)'),
}).describe('The Lanes view, with pecot-status as the columns and pecot-lane as the groups (omitted when the board has no single select pecot-lane field)')

type LanesView = z.input<typeof VIEW>

function manualStepsOf(projectUrl: string): readonly string[] {
  return [
    `open the project: ${projectUrl}`,
    `add a view named ${LANES_VIEW_NAME} with the Board layout`,
    `set Column by to ${WORKFLOW_FIELD_NAME}`,
    `set Group by to ${LANE_FIELD_NAME}`,
  ]
}

// 権限の足りないトークン・views の API の無い GHES・GitHub App のトークンでの個人のボードは、画面で作る道に回す
function isViewCreationRefused(error: unknown): error is GitHubAPIError {
  return error instanceof GitHubNotFoundError || (error instanceof GitHubAPIError && !(error instanceof GitHubRateLimitError) && error.statusCode === 403)
}

function viewBodyOf(target: Readonly<ProjectViewTarget>): Readonly<{ name: string, layout: 'board', vertical_group_by: readonly [number], group_by: readonly [number] }> {
  const status = target.fieldDatabaseIds.get(WORKFLOW_FIELD_NAME)
  const lane = target.fieldDatabaseIds.get(LANE_FIELD_NAME)
  if (status === undefined || lane === undefined) throw new GitHubAPIError(`could not read the database ids of fields ${WORKFLOW_FIELD_NAME} and ${LANE_FIELD_NAME}`)
  return { name: LANES_VIEW_NAME, layout: 'board', vertical_group_by: [status], group_by: [lane] }
}

// Lanes のビューを用意する。同じ名前のビューがあれば作らない。403・404 では作らずに、画面で作る手順を返して続ける
async function ensureLanesView(out: Readonly<Output>, client: Readonly<GitHubClient>, board: Readonly<{ owner: string, number: number }>, isDryRun: boolean): Promise<LanesView> {
  const target = await client.getProjectViewTarget(board.owner, board.number)
  const existing = target.views.find(view => view.name === LANES_VIEW_NAME)
  if (existing !== undefined) {
    skipped(out, `view ${LANES_VIEW_NAME} (already exists)`)
    return { created: false, name: LANES_VIEW_NAME, url: `${target.url}/views/${String(existing.number)}` }
  }
  if (isDryRun) {
    out.planned({ verb: 'create', target: `view ${LANES_VIEW_NAME}` })
    return { created: true, name: LANES_VIEW_NAME }
  }
  let view: JsonObject
  try {
    view = await client.createProjectView(target, viewBodyOf(target))
  }
  catch (error: unknown) {
    if (!isViewCreationRefused(error)) throw error
    const steps = manualStepsOf(target.url)
    out.warning(`could not create view ${LANES_VIEW_NAME} (status ${String(error.statusCode ?? 0)}): ${error.message}\ncreate it on the board:\n${steps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n')}`)
    return { created: false, name: LANES_VIEW_NAME, manual_steps: [...steps] }
  }
  const url = view['html_url']
  out.done({ verb: 'create', target: typeof url === 'string' ? `view ${LANES_VIEW_NAME} (${url})` : `view ${LANES_VIEW_NAME}` })
  return { created: true, name: LANES_VIEW_NAME, ...typeof url === 'string' && { url } }
}

interface InitializedFields {
  /**
  作る・足す・改名する（予行では、その予定の）フィールドと選択肢の数
  */
  readonly changeCount: number
  readonly projectNumber: number
  /**
  改名した（予行では、する）旧い名前
  */
  readonly renamed: string | undefined
  /**
  Lanes のビュー。pecot-lane が無ければ undefined
  */
  readonly view: LanesView | undefined
}

// フィールドを作り、既にあるフィールドには足りない選択肢を足す。進行の欄が旧い名前なら改名する。
// 既にある進行の欄の必須の値が欠けていれば、何も書かずに止める
async function initializeFields(out: Readonly<Output>, client: Readonly<GitHubClient>, target: Readonly<{ owner: string, name: string, host: string } & LaneRequest>, run: Readonly<{ isDryRun: boolean, mark: MarkField }>): Promise<InitializedFields> {
  const { owner, name, host } = target
  const { isDryRun, mark } = run
  const project = await findProjectByTitle(out, client, owner, name)
  const projectId = requireString(project['id'], 'project.id')
  const projectNumber = requireNumber(project['number'], 'project.number')
  // 設定ファイルが選べないときは、ボードを書き換える前に止める
  placeProjectConfig(out, { host, owner, number: projectNumber })
  const projectInfo = await client.getProjectFields(owner, projectNumber)
  if (projectInfo === undefined || !isTruthy(projectInfo)) stopWith(out, `could not read project fields: ${name}`, 'not-initialized')
  const fields = fieldNodesOf(projectInfo)
  const plan = planWorkflowFieldOf(fields)
  const existingWorkflow = plan.kind === 'create' ? undefined : lastFieldNamed(fields, plan.kind === 'rename' ? plan.from : plan.use)
  if (existingWorkflow !== undefined) {
    const missing = missingRequiredOptions(existingWorkflow)
    if (missing.length > 0) stopMissingOptions(out, missing)
  }
  let renameCount = 0
  if (existingWorkflow !== undefined && plan.kind === 'rename') {
    await renameWorkflowField(out, client, existingWorkflow, run)
    renameCount = 1
  }
  const created: readonly (readonly [string, readonly ProjectFieldOption[]])[] = plan.kind === 'create' ? [[WORKFLOW_FIELD_NAME, WORKFLOW_FIELD_OPTIONS]] : []
  const wanted: readonly (readonly [string, readonly ProjectFieldOption[]])[] = [
    ...created,
    ['pecot-priority', PRIORITY_FIELD_OPTIONS],
    ['pecot-size', SIZE_FIELD_OPTIONS],
  ]
  if (plan.kind === 'current' || plan.kind === 'both') {
    skipped(out, `field ${WORKFLOW_FIELD_NAME} (already exists)`)
    mark(WORKFLOW_FIELD_NAME, 'unchanged')
  }
  let newFieldCount = 0
  for (const [fieldName, options] of wanted) {
    if (fields.some(field => jsonField(field, 'name') === fieldName)) {
      skipped(out, `field ${fieldName} (already exists)`)
      mark(fieldName, 'unchanged')
      continue
    }
    newFieldCount += 1
    if (isDryRun) {
      out.planned({ verb: 'create', target: `field ${fieldName}` })
      mark(fieldName, 'create')
      continue
    }
    const created = await client.createProjectField(projectId, fieldName, options)
    out.done({ verb: 'create', target: `field ${fieldName} (ID: ${requireString(created['id'], 'field.id')})` })
    mark(fieldName, 'create')
  }
  const lane = await prepareLaneField(out, client, { projectId, fields }, target, run)
  // 改名した進行の欄は、改名の後の名前で選択肢の行を出す
  const workflowField = existingWorkflow === undefined ? undefined : { ...existingWorkflow, name: WORKFLOW_FIELD_NAME }
  const optionCount = await addMissingOptions(out, client, fields, workflowField, run)
  const view = lane.hasField ? await ensureLanesView(out, client, { owner, number: projectNumber }, isDryRun) : undefined
  return { changeCount: renameCount + newFieldCount + lane.count + optionCount, projectNumber, renamed: renameCount > 0 && plan.kind === 'rename' ? plan.from : undefined, view }
}

const FIELD_CHANGES = z.enum(['create', 'update', 'unchanged', 'skip', 'rename'])

const INIT_ROW = z.strictObject({
  name: z.string().describe('Name of the project field'),
  change: FIELD_CHANGES.describe('create: the field was created; update: options were added to it; unchanged: nothing to do; skip: the field was not found, pecot-lane was not created because no lanes were given, or pecot-lane is not a single select field; rename: the old pecot-workflow-<suffix> field was renamed to pecot-status'),
  addedOptions: z.array(z.string()).describe('Names of the options added to the field (empty when none)'),
})

const CONFIG_MOVED = z.strictObject({
  from: z.string().describe('File name of the old project config'),
  to: z.string().describe('File name the project config was moved to'),
}).nullable().describe('The old project config file that was moved to the new name (null when none)')

const MIGRATION = z.strictObject({
  renamed: z.string().nullable().describe('Old name of the workflow field that was renamed to pecot-status (null when none)'),
  config_moved: CONFIG_MOVED,
})

const INIT_OUTPUT = z.strictObject({
  fields: z.array(INIT_ROW).describe('The workflow, priority, size and pecot-lane fields, plus the Status field when its options were looked at'),
  migration: MIGRATION.optional().describe('What was moved from the old form (omitted when the command stopped before the project config)'),
  view: VIEW.optional(),
})

// 移した設定ファイルの、名前だけの組
function configMovedOf(placement: Readonly<ConfigPlacement>): z.input<typeof CONFIG_MOVED> {
  return placement.movedFrom === undefined ? JSON_NULL : { from: path.basename(placement.movedFrom), to: path.basename(placement.configPath) }
}

const initCommand = defineCommand({
  path: INIT_PATH,
  title: 'Initialize project fields',
  description: 'Add the pecot-status field and the other pecot-workflow fields to an existing project, rename the old suffixed workflow field to pecot-status, add the Blocked and Needs Attention options to the fields that already exist, and add the lanes to the pecot-lane field with a Lanes view',
  input: z.strictObject({
    owner: z.string().describe('Project owner'),
    name: z.string().describe('Project title'),
    host: z.string().default(DEFAULT_HOST).describe('GitHub host'),
    lanes: lanesInput,
    dry_run: dryRunInput,
  }),
  output: INIT_OUTPUT,
  positional: ['owner', 'name'],
  shortFlags: { host: '-h', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof INIT_OUTPUT>>(input.dry_run, io)
    const { owner, name, host } = input
    // 認証の失敗を、フィールドの初期化の失敗に包まないため
    const client = await createAuthenticatedGitHubClient(out, host)
    const mark = fieldReporter((fields) => {
      out.result({ fields })
    })
    const initialized = await guarded(out, 'initialize project fields', async () => await initializeFields(out, client, { ...input, command: INIT_PATH }, { isDryRun: input.dry_run, mark }))
    if (initialized.view !== undefined) out.result({ view: initialized.view })
    const renamed = initialized.renamed ?? JSON_NULL
    // 設定ファイルは作るフィールドと選択肢の ID を書くので、予行では作る前の設定を出さない。移す予定は ID に依らないので出す
    if (initialized.changeCount > 0 && input.dry_run) {
      const placement = placeProjectConfig(out, { host, owner, number: initialized.projectNumber })
      reportConfigMove(out, placement, true)
      out.result({ migration: { renamed, config_moved: configMovedOf(placement) } })
      return 0
    }
    await guarded(out, 'sync project config', async () => {
      const synced = await syncProjectConfig(out, client, { owner, name, host, skipIfUnchanged: true, isDryRun: input.dry_run })
      out.result({ migration: { renamed, config_moved: configMovedOf(synced) } })
    })
    return 0
  },
})

// project create

const CREATE_OUTPUT = z.strictObject({
  number: z.int().optional().describe('Number of the created project (omitted when the response has none)'),
  url: z.string().optional().describe('URL of the created project (omitted when the response has none)'),
  title: z.string().describe('Title of the project'),
  owner: z.string().describe('Project owner'),
  fields: z.array(INIT_ROW).optional().describe('The fields of the created project, in the same rows as project init (omitted with dry_run, and when the command stopped before the fields)'),
  view: VIEW.optional(),
})

const projectCreationCommand = defineCommand({
  path: CREATE_PATH,
  title: 'Create project',
  description: 'Create a new project with the pecot-workflow fields, and the pecot-lane field and the Lanes view from lanes (to add the fields to an existing project, use project init)',
  input: z.strictObject({
    owner: z.string().describe('Project owner'),
    title: z.string().describe('Project title'),
    host: z.string().default(DEFAULT_HOST).describe('GitHub host'),
    lanes: lanesInput,
    dry_run: dryRunInput,
  }),
  output: CREATE_OUTPUT,
  positional: ['owner', 'title'],
  shortFlags: { host: '-h', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof CREATE_OUTPUT>>(input.dry_run, io)
    const { owner, title, host } = input
    await guarded(out, 'create project', async () => {
      const client = createGitHubClient(out, host)
      let ownerId: string
      try {
        ownerId = await client.getOwnerNodeId(owner)
      }
      catch (error: unknown) {
        if (error instanceof GitHubNotFoundError) stopWith(out, `owner not found: ${owner}`, 'github-not-found')
        throw error
      }
      const owned = await client.listProjects(owner)
      const existing = owned.find(project => jsonField(project, 'title') === title)
      if (existing !== undefined) stopWith(out, `project already exists: ${title}\nurl: ${textOf(existing['url'])}`, 'already-exists')
      // フィールドと設定ファイルは作ったプロジェクトの ID を使うので、予行ではプロジェクトの行だけ出す
      if (input.dry_run) {
        out.planned({ verb: 'create', target: `project ${title} for ${owner}` })
        out.result({ title, owner })
        return
      }

      const created = await client.createProject(ownerId, title)
      out.done({ verb: 'create', target: `project #${textOf(created['number'])} ${textOf(created['url'])}` })
      out.result({
        title,
        owner,
        ...typeof created['number'] === 'number' && { number: created['number'] },
        ...typeof created['url'] === 'string' && { url: created['url'] },
      })
      await guarded(out, 'initialize project fields', async () => {
        const fieldsReported = fieldReporter((fields) => {
          out.result({ fields })
        })
        const { view } = await initializeFields(out, client, { owner, name: title, host, lanes: input.lanes, command: CREATE_PATH }, { isDryRun: false, mark: fieldsReported })
        if (view !== undefined) out.result({ view })
      })
      await guarded(out, 'sync project config', async () => {
        await syncProjectConfig(out, client, { owner, name: title, host })
      })
    })
    return 0
  },
})

// project activate

// 設定ファイルのパスか、projects/ にあるファイル名か
function findConfigFileArgument(project: string): string | undefined {
  if (isFile(path.resolve(project))) return resolveRealPath(path.resolve(project))
  const named = path.join(projectsDirectory(), project.endsWith('.json') ? project : `${project}.json`)
  return isFile(named) ? named : undefined
}

async function activateFromConfigFile(out: Readonly<Output<ActivateData>>, configPath: string, host: string | undefined, isDryRun: boolean): Promise<void> {
  let config: ProjectConfig
  try {
    config = loadConfig(configPath)
  }
  catch (error: unknown) {
    // Python の `except Exception` と同じ範囲（あらゆる Error）で捕まえる
    if (!(error instanceof Error) || error instanceof CommandExit) throw error
    return stopWith(out, `could not load config file ${path.basename(configPath)}: ${error.message}`, 'config-invalid')
  }
  await guarded(out, 'sync project', async () => {
    if (host !== undefined && config.host !== host) {
      out.warning(hinted`${inputHint(ACTIVATE_PATH, 'host', host)} differs from the config file host (${config.host})\nusing the config file host`)
    }
    const client = createGitHubClient(out, config.host)
    const projectInfo = await client.getProjectFields(config.owner, config.project.number)
    if (projectInfo === undefined || !isTruthy(projectInfo)) stopWith(out, `project #${String(config.project.number)} not found`, 'project-not-found')
    const title = projectInfo['title']
    if (typeof title !== 'string' || title === '') stopWith(out, `could not read the title of project #${String(config.project.number)}`, 'project-not-found')
    reportSynced(out, await syncProjectConfig(out, client, { owner: config.owner, name: title, host: config.host, ...SYNC_FOR_ACTIVATE, isDryRun }))
  })
}

async function resolveActivationOwner(out: Readonly<Output>, client: Readonly<GitHubClient>, owner: string | undefined): Promise<string> {
  if (owner !== undefined) return owner
  let login: JsonValue | undefined
  try {
    login = jsonField(await client.getAuthenticatedUser(), 'login')
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return stopWith(out, hinted`could not read the authenticated user: ${error.message}\npass ${inputNameHint(ACTIVATE_PATH, 'owner')} to give the owner explicitly`, kindOfFailure(error))
    throw error
  }
  return typeof login === 'string' && login !== '' ? login : stopWith(out, 'could not read the authenticated user', 'github-api')
}

function activeProjectNumber(host: string, owner: string): number | undefined {
  const activePath = getActiveConfigPath()
  if (activePath === undefined) return undefined
  try {
    const active = loadConfig(activePath)
    return active.host === host && active.owner === owner ? active.project.number : undefined
  }
  catch (error: unknown) {
    // 読めない設定は、アクティブの印を付けないだけにする。Python の `except Exception` と同じ範囲で捕まえる
    if (error instanceof Error) return undefined
    throw error
  }
}

// 番号か名前でプロジェクトの情報を取る
async function fetchProjectInfoByReference(out: Readonly<Output>, client: Readonly<GitHubClient>, owner: string, project: string): Promise<Readonly<Record<string, JsonValue>>> {
  if (/^\d+$/u.test(project)) {
    const number = Number(project)
    return await client.getProjectFields(owner, number) ?? stopWith(out, `project #${String(number)} not found`, 'project-not-found')
  }
  const found = await findProjectByTitle(out, client, owner, project)
  const info = await client.getProjectFields(owner, requireNumber(found['number'], 'project.number'))
  return info !== undefined && isTruthy(info) ? info : stopWith(out, `could not read project fields: ${project}`, 'not-initialized')
}

async function activateByReference(out: Readonly<Output<ActivateData>>, client: Readonly<GitHubClient>, target: Readonly<{ host: string, owner: string, project: string, isDryRun: boolean }>): Promise<void> {
  const { host, owner, project, isDryRun } = target
  const info = await fetchProjectInfoByReference(out, client, owner, project)
  const title = textOf(info['title'] ?? '')
  if (!hasWorkflowField(asArray(jsonField(info['fields'], 'nodes')))) {
    stopWith(out, hinted`project "${title}" is not initialized\n${RUN_COLON}${commandHint(['project', 'init'], { owner, name: title, host })}`, 'not-initialized')
  }
  reportSynced(out, await syncProjectConfig(out, client, { owner, name: title, host, ...SYNC_FOR_ACTIVATE, isDryRun }))
}

const ACTIVATE_PATH = ['project', 'activate']
// 中身が同じ設定ファイルは書かず、change を unchanged にしたうえでアクティブにする
const SYNC_FOR_ACTIVATE = { skipIfUnchanged: true, activateIfUnchanged: true }
const LINK_PATH = ['project', 'link']

const ACTIVATE_OUTPUT = z.strictObject({
  project: z.string().optional().describe('Name of the project config that was made active'),
  configPath: z.string().describe('Path of the project config file'),
  change: z.enum(['create', 'update', 'unchanged']).describe('What happened to the config file'),
  config_moved: CONFIG_MOVED,
})

type ActivateData = z.input<typeof ACTIVATE_OUTPUT>

// 設定ファイルの結果を data に渡す
function reportSynced(out: Readonly<Output<ActivateData>>, synced: Readonly<SyncedProjectConfig>): void {
  out.result({ ...synced.activeProject !== undefined && { project: synced.activeProject }, configPath: synced.configPath, change: synced.change, config_moved: configMovedOf(synced) })
}

const activateCommand = defineCommand({
  path: ['project', 'activate'],
  title: 'Activate project',
  description: 'Activate an initialized project',
  input: z.strictObject({
    project: z.string().describe('Project number or name, or config file path/file name (list the candidates with project search)'),
    owner: z.string().optional().describe('Project owner (defaults to the authenticated user)'),
    host: z.string().optional().describe('GitHub host'),
    dry_run: dryRunInput,
  }),
  output: ACTIVATE_OUTPUT,
  positional: ['project'],
  shortFlags: { owner: '-o', host: '-h', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<ActivateData>(input.dry_run, io)
    const { project, host } = input
    // --host の要らない形（設定ファイルのパスか名前）を先に見る
    const configPath = findConfigFileArgument(project)
    if (configPath !== undefined) {
      await activateFromConfigFile(out, configPath, host, input.dry_run)
      return 0
    }
    await guarded(out, 'activate project', async () => {
      if (host === undefined) {
        stopWith(
          out,
          hinted`${inputNameHint(ACTIVATE_PATH, 'host')} is required
example: ${commandHint(ACTIVATE_PATH, { project: '1', host: 'github.com', owner: 'example-org' })}
example: ${commandHint(ACTIVATE_PATH, { project: 'example-project', host: 'ghes.example.com', owner: 'example-org' })}
example: ${commandHint(ACTIVATE_PATH, { project: 'ghes.example.com_example-org_1' })}`,
          'invalid-input',
        )
      }
      // 認証の失敗に、--owner を渡す案内を添えないため
      const client = await createAuthenticatedGitHubClient(out, host)
      const owner = await resolveActivationOwner(out, client, input.owner)
      await activateByReference(out, client, { host, owner, project, isDryRun: input.dry_run })
    })
    return 0
  },
})

// project link

const packageList = z.array(z.string())

function parsePackages(out: Readonly<Output>, input: Readonly<{ package?: readonly string[] | undefined, changelog_file?: string | undefined, clear_packages: boolean }>): readonly Package[] | undefined {
  const specs = input.package
  if (specs === undefined || specs.length === 0) return undefined
  const packageFlag = inputNameHint(LINK_PATH, 'package')
  if (input.changelog_file !== undefined) stopWith(out, hinted`${packageFlag} and ${inputNameHint(LINK_PATH, 'changelog_file')} cannot be used together`, 'invalid-input')
  if (input.clear_packages) stopWith(out, hinted`${packageFlag} and ${inputHint(LINK_PATH, 'clear_packages')} cannot be used together`, 'invalid-input')
  const parsed: Package[] = []
  const seen = new Set<string>()
  for (const spec of specs) {
    const separator = spec.indexOf(':')
    if (separator === -1) stopWith(out, hinted`give ${inputHint(LINK_PATH, 'package', placeholder('NAME:PATH'))}: ${pythonStringRepr(spec)}`, 'invalid-input')
    const name = pythonStrip(spec.slice(0, separator))
    const changelog = pythonStrip(spec.slice(separator + 1))
    if (name === '' || changelog === '') stopWith(out, hinted`${packageFlag} NAME and PATH must not be empty: ${pythonStringRepr(spec)}`, 'invalid-input')
    if (seen.has(name)) stopWith(out, hinted`${packageFlag} NAME is duplicated: ${pythonStringRepr(name)}`, 'invalid-input')
    seen.add(name)
    // Python も Package(...) の作成で NAME の形を確かめるので、設定を読む前に止まる
    parsed.push(parsePackage({ name, changelog }))
  }
  return parsed
}

interface RepositoryEdit {
  readonly develop_branch?: string | undefined
  readonly release_branch?: string | undefined
  readonly changelog_file?: string | undefined
  readonly packages: readonly Package[] | undefined
  readonly clear_packages: boolean
  readonly release_type?: string | undefined
}

// 登録済みのエントリを、指定されたオプションの分だけ更新する
function updatedRepository(out: Readonly<Output>, existing: Repository, edit: Readonly<RepositoryEdit>): Repository {
  let { packages, changelog_file: changelogFile } = existing
  if (edit.packages === undefined) {
    if (edit.clear_packages) packages = undefined
  }
  else {
    packages = edit.packages
    changelogFile = undefined
  }
  if (edit.changelog_file !== undefined) {
    if (packages !== undefined && packages.length > 0) {
      stopWith(out, hinted`this repository has packages set\n${RUN} with ${inputHint(['project', 'link'], 'clear_packages')} before switching to ${inputNameHint(['project', 'link'], 'changelog_file')}`, 'invalid-input')
    }
    changelogFile = edit.changelog_file
  }
  return buildRepository({
    ...existing,
    develop_branch: edit.develop_branch ?? existing.develop_branch,
    release_branch: edit.release_branch ?? existing.release_branch,
    changelog_file: changelogFile,
    packages,
    release_type: toReleaseType(edit.release_type) ?? existing.release_type,
  })
}

function toReleaseType(value: string | undefined): Repository['release_type'] {
  return RELEASE_TYPES.find(type => type === value)
}

async function linkRepository(out: Readonly<Output>, config: ProjectConfig, repositoryOwner: string, repositoryName: string): Promise<LinkResult> {
  try {
    return await createGitHubClient(out, config.host).linkRepositoryToProject(config.owner, config.project.number, repositoryOwner, repositoryName)
  }
  catch (error: unknown) {
    // API の失敗の文は、Python と同じく message をそのまま使う
    if (error instanceof GitHubAPIError) return { status: 'failed', detail: error.message }
    throw error
  }
}

// 予行。リンクの有無を読むだけで、リンクしない
async function plannedLink(out: Readonly<Output>, config: ProjectConfig, repositoryOwner: string, repositoryName: string): Promise<LinkResult> {
  try {
    const linked = await createGitHubClient(out, config.host).getLinkedRepositories(config.owner, config.project.number)
    const isLinked = linked.some(entry => entry.owner === repositoryOwner && entry.name === repositoryName)
    return { status: isLinked ? 'already_linked' : 'linked', detail: '' }
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return { status: 'failed', detail: error.message }
    throw error
  }
}

const LINK_OUTPUT = z.strictObject({
  repository: z.string().describe('Repository in owner/repo form'),
  projectNumber: z.int().describe('Number of the active project'),
  change: z.enum(['create', 'update']).describe('create: the repository was added to the config; update: its entry was changed'),
  configPath: z.string().describe('Path of the project config file'),
})

const projectLinkCommand = defineCommand({
  path: ['project', 'link'],
  title: 'Link repository to project',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  description: 'Add or update a repository in the project config',
  input: z.strictObject({
    repo: z.string().describe('Repository name in owner/repo form'),
    develop_branch: z.string().optional().describe('Development branch name'),
    release_branch: z.string().optional().describe('Release branch name'),
    changelog_file: z.string().optional().describe('CHANGELOG file name'),
    package: packageList.optional().describe('Monorepo package to register, as NAME:PATH. Example: pecot:plugins/pecot-workflow/CHANGELOG.md'),
    clear_packages: z.boolean().default(false).describe('Clear the existing packages setting. After clearing, the CHANGELOG falls back to `changelog_file` or the default CHANGELOG.md'),
    release_type: z.string().optional().describe('Declare the release method explicitly; the w-release skill picks its procedure from it. single (1 CHANGELOG) / multi (packages) / nx (Nx Release). When omitted, it is inferred from the packages (with packages: multi, without: single)'),
    dry_run: dryRunInput,
  }),
  output: LINK_OUTPUT,
  positional: ['repo'],
  shortFlags: { develop_branch: '-b', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof LINK_OUTPUT>>(input.dry_run, io)
    if (input.release_type !== undefined && toReleaseType(input.release_type) === undefined) {
      // Python は sorted() の順（multi, nx, single）で見せる
      stopWith(out, hinted`${inputNameHint(LINK_PATH, 'release_type')} must be one of [${RELEASE_TYPES.toSorted(compareStrings).map(type => pythonStringRepr(type)).join(', ')}] (got: ${pythonStringRepr(input.release_type)})`, 'invalid-input')
    }
    const packages = parsePackages(out, input)
    const { config, configPath } = requireActiveWithPath(out)

    const parts = splitOwnerRepository(input.repo)
    if (parts === undefined) stopWith(out, hinted`give the repository as owner/repo\nexample: ${commandHint(['project', 'link'], { repo: 'example-org/my-repo' })}`, 'invalid-input')
    const { owner, repository: name } = parts
    if (owner !== config.owner) {
      stopWith(out, `repository owner ${owner} differs from project owner ${config.owner}\nGitHub Projects V2 links only repositories of the project owner`, 'invalid-input')
    }

    const existing = findRepository(config, owner, name)
    let next: ProjectConfig
    let saved: Operation
    if (existing === undefined) {
      const projectNumber = String(config.project.number)
      const outcome = input.dry_run ? await plannedLink(out, config, owner, name) : await linkRepository(out, config, owner, name)
      if (outcome.status === 'failed') stopWith(out, `could not link ${input.repo} to project #${projectNumber}: ${outcome.detail}`, 'github-api')
      const linked: Operation = outcome.status === 'already_linked'
        ? { verb: 'unchanged', target: `${input.repo} in project #${projectNumber}` }
        : { verb: 'add', target: `${input.repo} to project #${projectNumber}` }
      out.planned(linked)
      out.done(linked)
      next = withRepositoryAppended(config, buildRepository({
        owner,
        name,
        develop_branch: input.develop_branch,
        release_branch: input.release_branch,
        changelog_file: packages === undefined ? input.changelog_file : undefined,
        packages,
        release_type: toReleaseType(input.release_type),
      }))
      saved = { verb: 'add', target: `${owner}/${name} to ${configPath}` }
    }
    else {
      next = withRepositoryReplaced(config, updatedRepository(out, existing, { ...input, packages }))
      saved = { verb: 'update', target: `${owner}/${name} in ${configPath}` }
    }
    const checked = validated(next)
    out.planned(saved)
    const reported = { repository: `${owner}/${name}`, projectNumber: config.project.number, change: linkChange(existing), configPath }
    if (input.dry_run) {
      out.result(reported)
      return 0
    }
    saveConfig(checked, configPath)
    out.done(saved)
    out.result(reported)
    return 0
  },
})

// 設定のキーの管理。今のキーは aggregation_repo だけ

const CONFIG_KEY = z.enum(['aggregation_repo']).describe('Key of the project config (aggregation_repo: the Epic aggregation repository)')

type ConfigKey = z.infer<typeof CONFIG_KEY>

/**
設定の 1 つのキーへの get・set・unset。どれも stdout・stderr に結果を出し、失敗なら止まる
*/
interface ConfigKeyOperations {
  readonly get: (out: Readonly<Output<GetData>>) => void
  readonly set: (out: Readonly<Output<SetData>>, value: string, options: Readonly<{ isConfirmed: boolean, isDryRun: boolean }>) => void
  readonly unset: (out: Readonly<Output<UnsetData>>, isDryRun: boolean) => void
}

const CONFIG_KEY_FIELD = z.enum(['aggregation_repo']).describe('Key of the project config')

const GET_OUTPUT = z.strictObject({
  key: CONFIG_KEY_FIELD,
  value: z.string().optional().describe('Value of the key (omitted when it is not set)'),
})

const SET_OUTPUT = z.strictObject({
  key: CONFIG_KEY_FIELD,
  value: z.string().describe('Value of the key after the command'),
  previous: z.string().optional().describe('Value before the command (omitted when the key was not set)'),
  change: z.enum(['create', 'update', 'unchanged']).describe('create: the key was not set; update: its value was replaced; unchanged: it already had the value'),
  configPath: z.string().describe('Path of the project config file'),
})

const UNSET_OUTPUT = z.strictObject({
  key: CONFIG_KEY_FIELD,
  previous: z.string().optional().describe('Value before the command (omitted when the key was not set)'),
  change: z.enum(['delete', 'unchanged']).describe('delete: the key was cleared; unchanged: it was not set'),
  configPath: z.string().describe('Path of the project config file'),
})

type GetData = z.input<typeof GET_OUTPUT>
type SetData = z.input<typeof SET_OUTPUT>
type UnsetData = z.input<typeof UNSET_OUTPUT>

function setAggregationRepository(out: Readonly<Output<SetData>>, value: string, options: Readonly<{ isConfirmed: boolean, isDryRun: boolean }>): void {
  if (!AGGREGATION_REPOSITORY_PATTERN.test(value)) stopWith(out, `give aggregation_repo as owner/repo: ${pythonStringRepr(value)}`, 'invalid-input')
  const { config, configPath } = requireActiveWithPath(out)
  const current = config.aggregation_repo
  if (current === value) {
    const unchanged: Operation = { verb: 'unchanged', target: `aggregation_repo ${value}` }
    out.planned(unchanged)
    out.done(unchanged)
    out.result({ key: 'aggregation_repo', value, previous: value, change: 'unchanged', configPath })
    return
  }
  const operation: Operation = { verb: 'set', target: `aggregation_repo to ${value}` }
  const hasPrevious = current !== undefined && current !== ''
  const reported = { key: 'aggregation_repo', value, ...hasPrevious && { previous: current }, change: setChange(hasPrevious), configPath } satisfies SetData
  if (options.isDryRun) {
    out.planned(current === undefined || current === '' ? operation : { ...operation, target: `${operation.target} (was ${current})` })
    out.result(reported)
    return
  }
  if (current !== undefined && current !== '') {
    out.warning(options.isConfirmed ? `overwriting aggregation_repo: ${current} -> ${value}` : hinted`overwriting aggregation_repo: ${current} -> ${value}\npass ${inputHint(['project', 'set'], 'yes')} to omit this hint`)
  }
  saveConfig(withAggregationRepository(config, value), configPath)
  out.done(operation)
  out.result(reported)
}

function unsetAggregationRepository(out: Readonly<Output<UnsetData>>, isDryRun: boolean): void {
  const { config, configPath } = requireActiveWithPath(out)
  const previous = config.aggregation_repo
  if (previous === undefined) {
    const unchanged: Operation = { verb: 'unchanged', target: 'aggregation_repo (not set)' }
    out.planned(unchanged)
    out.done(unchanged)
    out.result({ key: 'aggregation_repo', change: 'unchanged', configPath })
    return
  }
  const operation: Operation = { verb: 'remove', target: `aggregation_repo (was ${previous})` }
  out.planned(operation)
  if (isDryRun) {
    out.result({ key: 'aggregation_repo', previous, change: 'delete', configPath })
    return
  }
  saveConfig(withAggregationRepository(config, undefined), configPath)
  out.done(operation)
  out.result({ key: 'aggregation_repo', previous, change: 'delete', configPath })
}

// キーを足したら、ここに操作を足さないと型の確認で止まる
const CONFIG_KEY_OPERATIONS: Readonly<Record<ConfigKey, ConfigKeyOperations>> = {
  aggregation_repo: {
    get: (out) => {
      const value = requireActiveConfig(out).aggregation_repo
      out.data(value ?? 'none')
      out.result({ key: 'aggregation_repo', ...value !== undefined && { value } })
    },
    set: setAggregationRepository,
    unset: unsetAggregationRepository,
  },
}

const projectSetCommand = defineCommand({
  path: ['project', 'set'],
  title: 'Set project config',
  description: 'Set a key of the project config (aggregation_repo: the Epic aggregation repository)',
  input: z.strictObject({
    key: CONFIG_KEY,
    value: z.string().describe('Aggregation repository (owner/repo form)'),
    yes: z.boolean().default(false).describe('Overwrite an existing value without confirmation (a warning goes to stderr)'),
    dry_run: dryRunInput,
  }),
  output: SET_OUTPUT,
  positional: ['key', 'value'],
  shortFlags: { yes: '-y', dry_run: '-n' },
  interactive: false,
  run: (input, io) => {
    CONFIG_KEY_OPERATIONS[input.key].set(createOutput<SetData>(input.dry_run, io), input.value, { isConfirmed: input.yes, isDryRun: input.dry_run })
    return Promise.resolve(0)
  },
})

const projectUnsetCommand = defineCommand({
  path: ['project', 'unset'],
  title: 'Clear project config',
  description: 'Clear a key of the project config; without aggregation_repo, creating an Epic needs the target repository given explicitly',
  input: z.strictObject({ key: CONFIG_KEY, dry_run: dryRunInput }),
  output: UNSET_OUTPUT,
  positional: ['key'],
  shortFlags: { dry_run: '-n' },
  interactive: false,
  run: (input, io) => {
    CONFIG_KEY_OPERATIONS[input.key].unset(createOutput<UnsetData>(input.dry_run, io), input.dry_run)
    return Promise.resolve(0)
  },
})

const projectGetCommand = defineCommand({
  path: ['project', 'get'],
  title: 'Get project config',
  description: 'Show the value of a key of the project config (aggregation_repo: the Epic aggregation repository)',
  input: z.strictObject({ key: CONFIG_KEY }),
  output: GET_OUTPUT,
  positional: ['key'],
  interactive: false,
  run: (input, io) => {
    CONFIG_KEY_OPERATIONS[input.key].get(createOutput<GetData>(false, io))
    return Promise.resolve(0)
  },
})

/**
project のグループのコマンド。並びは help の一覧の順
*/
export const PROJECT_COMMANDS: readonly CommandDefinition[] = [
  listCommand,
  searchCommand,
  initCommand,
  projectCreationCommand,
  activateCommand,
  projectLinkCommand,
  projectGetCommand,
  projectSetCommand,
  projectUnsetCommand,
]
