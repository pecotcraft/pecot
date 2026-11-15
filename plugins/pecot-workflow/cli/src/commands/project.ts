// project のグループのコマンド。Python の cli/commands/project.py の移植。
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { RELEASE_TYPES, findRepository, parsePackage, withAggregationRepository, withRepositoryAppended, withRepositoryReplaced, parseProjectConfig, serializeProjectConfig } from '../domain/config.js'
import type { Package, ProjectConfig, Repository } from '../domain/config.js'
import { choosePlacement, insertOption } from '../domain/field-options.js'
import type { FieldOptionInput } from '../domain/field-options.js'
import { jsonField, parseJsonText } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { compareStrings, pythonStrip, pythonStringRepr, splitCodePoints, truncateCodePoints } from '../domain/python-format.js'
import type { JsonValue } from '../domain/python-format.js'
import { splitOwnerRepository } from '../domain/repository-resolver.js'
import { getActiveConfigPath, loadConfig, projectsDirectory, saveConfig } from '../infra/config-store.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError } from '../infra/github/errors.js'
import { asArray, isTruthy, requireNumber, requireString } from '../infra/github/payload.js'
import type { LinkResult, ProjectFieldOption } from '../infra/github/projects.js'
import { resolveRealPath } from '../infra/paths.js'
import { hasErrorCode } from '../infra/os-error.js'
import { CommandExit, defineCommand } from './command-definition.js'
import type { CommandDefinition } from './command-definition.js'
import { commandHint, hinted, inputHint, inputNameHint, placeholder } from './command-hint.js'
import { requireActiveConfig, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Operation, Output } from './output.js'
import type { OptionSpec, SyncedProjectConfig } from './project-sync.js'
import {
  BLOCKED_SPEC,
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
})

const SEARCH_OUTPUT = z.strictObject({
  owner: z.string().describe('Project owner that was searched'),
  host: z.string().describe('GitHub host that was searched'),
  projects: z.array(SEARCH_ROW).describe('Projects of the owner'),
})

const searchCommand = defineCommand({
  path: ['project', 'search'],
  description: 'Search projects through the GitHub API',
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
      const projects = await createGitHubClient(out, host).listProjects(owner)
      if (projects.length === 0) stopWith(out, `no projects found for ${owner}`, 'project-not-found')
      const lines = [`=== Projects of ${owner} (${host}) ===`, '', `${padEndCodePoints('#', 4)} ${padEndCodePoints('Title', SEARCH_TITLE_WIDTH)} URL`, '-'.repeat(80)]
      for (const project of projects) {
        const number = project['number'] === undefined ? '?' : textOf(project['number'])
        const rawTitle = project['title'] === undefined ? '(untitled)' : textOf(project['title'])
        const title = splitCodePoints(rawTitle).length > SEARCH_TITLE_LIMIT ? `${truncateCodePoints(rawTitle, 35)}...` : rawTitle
        lines.push(`${padEndCodePoints(number, 4)} ${padEndCodePoints(title, SEARCH_TITLE_WIDTH)} ${project['url'] === undefined ? '' : textOf(project['url'])}`)
      }
      out.data(lines.join('\n'))
      out.result({ owner, host, projects: projects.map(project => ({
        ...typeof project['number'] === 'number' && { number: project['number'] },
        ...typeof project['title'] === 'string' && { title: project['title'] },
        ...typeof project['url'] === 'string' && { url: project['url'] },
      })) })
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
  change: 'create' | 'update' | 'unchanged' | 'skip'
  addedOptions: string[]
}

type MarkField = (name: string, change: FieldReport['change'], addedOption?: string) => void

// フィールドごとの結果を溜め、進むたびに全体を渡す。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- data の型が可変の配列
function fieldReporter(publish: ((fields: FieldReport[]) => void) | undefined): MarkField {
  const entries = new Map<string, FieldReport>()
  return (name, change, addedOption) => {
    const entry = entries.get(name) ?? { name, change, addedOptions: [] }
    entry.change = change
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

// 既にあるフィールドに足す選択肢。fields は作る前の状態なので、作ったばかりの進行の欄は「無い」扱いで何も出さない（created の行が出ている）
// 足した（予行では、足す予定の）選択肢の数を返す
async function addMissingOptions(out: Readonly<Output>, client: Readonly<GitHubClient>, fields: readonly JsonValue[], workflowFieldName: string, run: Readonly<{ isDryRun: boolean, mark: MarkField }>): Promise<number> {
  const workflowField = lastFieldNamed(fields, workflowFieldName)
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

// フィールドを作り、既にあるフィールドには足りない選択肢を足す。既にある進行の欄の必須の値が欠けていれば、何も書かずに止める。
// 作る・足す（予行では、その予定の）フィールドと選択肢の数を返す
async function initializeFields(out: Readonly<Output>, client: Readonly<GitHubClient>, target: Readonly<{ owner: string, name: string, suffix: string }>, run: Readonly<{ isDryRun: boolean, mark: MarkField }>): Promise<number> {
  const { owner, name, suffix } = target
  const { isDryRun, mark } = run
  const project = await findProjectByTitle(out, client, owner, name)
  const projectId = requireString(project['id'], 'project.id')
  const projectInfo = await client.getProjectFields(owner, requireNumber(project['number'], 'project.number'))
  if (projectInfo === undefined || !isTruthy(projectInfo)) stopWith(out, `could not read project fields: ${name}`, 'not-initialized')
  const fields = fieldNodesOf(projectInfo)
  const workflowFieldName = `pecot-workflow-${suffix}`
  const existingWorkflow = lastFieldNamed(fields, workflowFieldName)
  if (existingWorkflow !== undefined) {
    const missing = missingRequiredOptions(existingWorkflow)
    if (missing.length > 0) stopMissingOptions(out, missing)
  }
  const wanted: readonly (readonly [string, readonly ProjectFieldOption[]])[] = [
    [workflowFieldName, WORKFLOW_FIELD_OPTIONS],
    ['pecot-priority', PRIORITY_FIELD_OPTIONS],
    ['pecot-size', SIZE_FIELD_OPTIONS],
  ]
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
  return newFieldCount + await addMissingOptions(out, client, fields, workflowFieldName, run)
}

const FIELD_CHANGES = z.enum(['create', 'update', 'unchanged', 'skip'])

const INIT_ROW = z.strictObject({
  name: z.string().describe('Name of the project field'),
  change: FIELD_CHANGES.describe('create: the field was created; update: options were added to it; unchanged: nothing to do; skip: the field was not found'),
  addedOptions: z.array(z.string()).describe('Names of the options added to the field (empty when none)'),
})

const INIT_OUTPUT = z.strictObject({
  fields: z.array(INIT_ROW).describe('The workflow, priority and size fields, plus the Status field when its options were looked at'),
  dryRun: DRY_RUN_FIELD,
})

const initCommand = defineCommand({
  path: ['project', 'init'],
  description: 'Add pecot-workflow fields to an existing project, and add the Blocked and Needs Attention options to the fields that already exist',
  input: z.strictObject({
    owner: z.string().describe('Project owner'),
    name: z.string().describe('Project title'),
    host: z.string().default(DEFAULT_HOST).describe('GitHub host'),
    suffix: z.string().describe('Suffix of the workflow field'),
    dry_run: dryRunInput,
  }),
  output: INIT_OUTPUT,
  positional: ['owner', 'name'],
  shortFlags: { host: '-h', suffix: '-s', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof INIT_OUTPUT>>(input.dry_run, io)
    const { owner, name, host, suffix } = input
    const client = createGitHubClient(out, host)
    if (input.dry_run) out.result({})
    const mark = fieldReporter((fields) => {
      out.result({ fields })
    })
    const changeCount = await guarded(out, 'initialize project fields', async () => await initializeFields(out, client, input, { isDryRun: input.dry_run, mark }))
    // 設定ファイルは作るフィールドと選択肢の ID を書くので、予行では作る前の設定を出さない
    if (changeCount > 0 && input.dry_run) return 0
    await guarded(out, 'sync project config', async () => {
      await syncProjectConfig(out, client, { owner, name, host, suffix, skipIfUnchanged: true, isDryRun: input.dry_run })
    })
    return 0
  },
})

// project create

const CREATE_OUTPUT = z.strictObject({
  number: z.int().optional().describe('Number of the created project (omitted on dry_run)'),
  url: z.string().optional().describe('URL of the created project (omitted on dry_run)'),
  title: z.string().describe('Title of the project'),
  owner: z.string().describe('Project owner'),
  dryRun: DRY_RUN_FIELD,
})

const projectCreationCommand = defineCommand({
  path: ['project', 'create'],
  description: 'Create a new project (to add the fields to an existing project, use project init)',
  input: z.strictObject({
    owner: z.string().describe('Project owner'),
    title: z.string().describe('Project title'),
    host: z.string().default(DEFAULT_HOST).describe('GitHub host'),
    suffix: z.string().describe('Suffix of the workflow field'),
    dry_run: dryRunInput,
  }),
  output: CREATE_OUTPUT,
  positional: ['owner', 'title'],
  shortFlags: { host: '-h', suffix: '-s', dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput<z.input<typeof CREATE_OUTPUT>>(input.dry_run, io)
    const { owner, title, host, suffix } = input
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
        await initializeFields(out, client, { owner, name: title, suffix }, { isDryRun: false, mark: fieldReporter(undefined) })
      })
      await guarded(out, 'sync project config', async () => {
        await syncProjectConfig(out, client, { owner, name: title, host, suffix })
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
    reportSynced(out, await syncProjectConfig(out, client, { owner: config.owner, name: title, host: config.host, isDryRun }))
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

// 一覧の表示モード。初期化済みのプロジェクトに [ACTIVE] を付ける
async function echoInitializedProjects(out: Readonly<Output<ActivateData>>, client: Readonly<GitHubClient>, host: string, owner: string): Promise<void> {
  const lines = [`=== Initialized projects (${host}/${owner}) ===`]
  const initialized: JsonValue[] = []
  const owned = await client.listProjects(owner)
  for (const project of owned) {
    const number = project['number']
    if (number === undefined || number === null) continue
    const projectInfo = await client.getProjectFields(owner, requireNumber(number, 'project.number'))
    if (projectInfo === undefined || !isTruthy(projectInfo)) continue
    if (hasWorkflowField(fieldNodesOf(projectInfo))) initialized.push(project)
  }
  if (initialized.length === 0) {
    lines.push('  none')
    out.data(lines.join('\n'))
    out.result({ candidates: [] })
    return
  }
  const activeNumber = activeProjectNumber(host, owner)
  const candidates: { number?: number, title?: string, active: boolean }[] = []
  for (const project of initialized) {
    const number = jsonField(project, 'number')
    const title = jsonField(project, 'title')
    const isActive = activeNumber === number
    lines.push(`  #${textOf(number)}: ${title === undefined ? '(untitled)' : textOf(title)}${isActive ? ' [ACTIVE]' : ''}`)
    candidates.push({ ...typeof number === 'number' && { number }, ...typeof title === 'string' && { title }, active: isActive })
  }
  out.data(lines.join('\n'))
  out.result({ candidates })
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
    stopWith(out, hinted`project "${title}" is not initialized\nrun: ${commandHint(['project', 'init'], { owner, name: title, host, suffix: placeholder('suffix') })}`, 'not-initialized')
  }
  reportSynced(out, await syncProjectConfig(out, client, { owner, name: title, host, isDryRun }))
}

const ACTIVATE_PATH = ['project', 'activate']
const LINK_PATH = ['project', 'link']

const CANDIDATE_ROW = z.strictObject({
  number: z.int().optional().describe('Project number'),
  title: z.string().optional().describe('Project title'),
  active: z.boolean().describe('Whether this project is the active one'),
})

const ACTIVATE_OUTPUT = z.strictObject({
  project: z.string().optional().describe('Name of the project config that was (on dry_run, would be) made active'),
  configPath: z.string().optional().describe('Path of the project config file'),
  change: z.enum(['create', 'update', 'unchanged']).optional().describe('What happened to the config file'),
  candidates: z.array(CANDIDATE_ROW).optional().describe('Initialized projects of the owner, given only when no project was named (nothing was activated)'),
  dryRun: DRY_RUN_FIELD,
})

type ActivateData = z.input<typeof ACTIVATE_OUTPUT>

// 設定ファイルの結果を data に渡す
function reportSynced(out: Readonly<Output<ActivateData>>, synced: Readonly<SyncedProjectConfig>): void {
  out.result({ ...synced.activeProject !== undefined && { project: synced.activeProject }, configPath: synced.configPath, change: synced.change })
}

const activateCommand = defineCommand({
  path: ['project', 'activate'],
  description: 'Activate an initialized project',
  input: z.strictObject({
    project: z.string().optional().describe('Project number or name, or config file path/file name'),
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
    const configPath = project === undefined ? undefined : findConfigFileArgument(project)
    if (configPath !== undefined) {
      await activateFromConfigFile(out, configPath, host, input.dry_run)
      return 0
    }
    await guarded(out, 'activate project', async () => {
      if (host === undefined) {
        stopWith(
          out,
          hinted`${inputNameHint(ACTIVATE_PATH, 'host')} is required
example: ${commandHint(ACTIVATE_PATH, { host: 'github.com', owner: 'example-org' })}
example: ${commandHint(ACTIVATE_PATH, { host: 'ghes.example.com', owner: 'example-org' })}
example: ${commandHint(ACTIVATE_PATH, { project: 'ghes.example.com_example-org_example-project_example-org' })}`,
          'invalid-input',
        )
      }
      const client = createGitHubClient(out, host)
      const owner = await resolveActivationOwner(out, client, input.owner)
      // 一覧は書き込まないので、dry_run でも data に dryRun を足さない
      if (project === undefined) await echoInitializedProjects(createOutput<ActivateData>(false, io), client, host, owner)
      else await activateByReference(out, client, { host, owner, project, isDryRun: input.dry_run })
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
      stopWith(out, hinted`this repository has packages set\nrun with ${inputHint(['project', 'link'], 'clear_packages')} before switching to ${inputNameHint(['project', 'link'], 'changelog_file')}`, 'invalid-input')
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
    // API の失敗の文は、Python と同じく message をそのまま使う（応答の本文の詳細は、wip ブランチの削除の警告だけが足す）
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
  dryRun: DRY_RUN_FIELD,
})

const projectLinkCommand = defineCommand({
  path: ['project', 'link'],
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  description: 'Add or update a repository in the project config',
  input: z.strictObject({
    repo: z.string().describe('Repository name in owner/repo form'),
    develop_branch: z.string().optional().describe('Development branch name'),
    release_branch: z.string().optional().describe('Release branch name'),
    changelog_file: z.string().optional().describe('CHANGELOG file name'),
    package: packageList.optional().describe('Register a monorepo package as NAME:PATH. Can be repeated. Example: --package pecot:plugins/pecot-workflow/CHANGELOG.md'),
    clear_packages: z.boolean().default(false).describe('Clear the existing packages setting. After clearing, the CHANGELOG falls back to --changelog-file or the default CHANGELOG.md'),
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
  value: z.string().describe('Value of the key after the command (on dry_run, after it would run)'),
  previous: z.string().optional().describe('Value before the command (omitted when the key was not set)'),
  change: z.enum(['create', 'update', 'unchanged']).describe('create: the key was not set; update: its value was replaced; unchanged: it already had the value'),
  configPath: z.string().describe('Path of the project config file'),
  dryRun: DRY_RUN_FIELD,
})

const UNSET_OUTPUT = z.strictObject({
  key: CONFIG_KEY_FIELD,
  previous: z.string().optional().describe('Value before the command (omitted when the key was not set)'),
  change: z.enum(['delete', 'unchanged']).describe('delete: the key was cleared; unchanged: it was not set'),
  configPath: z.string().describe('Path of the project config file'),
  dryRun: DRY_RUN_FIELD,
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
  description: 'Clear a key of the project config; without aggregation_repo, creating an Epic needs --repo',
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
