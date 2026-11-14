// project の 9 個のコマンドと board show。Python の cli/commands/project.py の移植。
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { RELEASE_TYPES, findRepository, parsePackage, withAggregationRepository, withRepositoryAppended, withRepositoryReplaced, parseProjectConfig, serializeProjectConfig } from '../domain/config.js'
import type { Package, ProjectConfig, Repository } from '../domain/config.js'
import { choosePlacement, insertOption } from '../domain/field-options.js'
import type { FieldOptionInput } from '../domain/field-options.js'
import { formatBoardOutput, formatStackableChains } from '../domain/format.js'
import type { BoardItem } from '../domain/format.js'
import { jsonField, parseJsonText } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { compareStrings, pythonStrip, pythonStringRepr, splitCodePoints, truncateCodePoints } from '../domain/python-format.js'
import type { JsonValue } from '../domain/python-format.js'
import { parseOwnerRepository, splitOwnerRepository } from '../domain/repository-resolver.js'
import { InvalidValueError } from '../domain/errors.js'
import { getActiveConfigPath, loadConfig, projectsDirectory, saveConfig } from '../infra/config-store.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError } from '../infra/github/errors.js'
import { asArray, isTruthy, requireNumber, requireString } from '../infra/github/payload.js'
import type { LinkResult, ProjectFieldOption } from '../infra/github/projects.js'
import { resolveRealPath } from '../infra/paths.js'
import { hasErrorCode } from '../infra/os-error.js'
import { CommandExit, defineCommand } from './command-definition.js'
import { requireActiveConfig, stopWith } from './command-stop.js'
import { createGitHubClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { readBoardReadiness, readinessOf, skipBoardReadiness } from './project-readiness.js'
import { collectAlertStatuses, infoJson, infoMarkdown, pruneArchivedItems, readBoard } from './project-info.js'
import type { OptionSpec } from './project-sync.js'
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
  const configPath = getActiveConfigPath() ?? stopWith(out, 'cannot determine the config file path')
  return { config, configPath }
}

// 保存の前に、設定として読み直せる形かを確かめる（読めなければ ValidationFailure）
function validated(config: ProjectConfig): ProjectConfig {
  return parseProjectConfig(parseJsonText(serializeProjectConfig(config)))
}

// project list

const listCommand = defineCommand({
  path: ['project', 'list'],
  description: 'List available projects',
  input: z.strictObject({}),
  positional: [],
  interactive: false,
  run: (_input, io) => {
    const out = createOutput(false, io)
    const lines = ['=== Projects ===']
    const directory = projectsDirectory()
    const files = readProjectFiles(directory)
    if (files.length === 0) {
      lines.push('  none')
      out.data(lines.join('\n'))
      return Promise.resolve(0)
    }
    const active = getActiveConfigPath()
    for (const file of files) {
      const isActive = active !== undefined && resolveRealPath(path.join(directory, file)) === resolveRealPath(active)
      lines.push(`  ${path.parse(file).name}${isActive ? ' [ACTIVE]' : ''}`)
    }
    out.data(lines.join('\n'))
    return Promise.resolve(0)
  },
})

// project search

const searchCommand = defineCommand({
  path: ['project', 'search'],
  description: 'Search projects through the GitHub API',
  input: z.strictObject({
    owner: z.string().describe('Project owner'),
    host: z.string().default(DEFAULT_HOST).describe('GitHub host'),
  }),
  positional: ['owner'],
  shortFlags: { host: '-h' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(false, io)
    const { owner, host } = input
    await guarded(out, 'list projects', async () => {
      const projects = await createGitHubClient(out, host).listProjects(owner)
      if (projects.length === 0) stopWith(out, `no projects found for ${owner}`)
      const lines = [`=== Projects of ${owner} (${host}) ===`, '', `${padEndCodePoints('#', 4)} ${padEndCodePoints('Title', SEARCH_TITLE_WIDTH)} URL`, '-'.repeat(80)]
      for (const project of projects) {
        const number = project['number'] === undefined ? '?' : textOf(project['number'])
        const rawTitle = project['title'] === undefined ? '(untitled)' : textOf(project['title'])
        const title = splitCodePoints(rawTitle).length > SEARCH_TITLE_LIMIT ? `${truncateCodePoints(rawTitle, 35)}...` : rawTitle
        lines.push(`${padEndCodePoints(number, 4)} ${padEndCodePoints(title, SEARCH_TITLE_WIDTH)} ${project['url'] === undefined ? '' : textOf(project['url'])}`)
      }
      out.data(lines.join('\n'))
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

// 既にあるフィールドに選択肢を 1 つ足す
async function addFieldOption(out: Readonly<Output>, client: Readonly<GitHubClient>, field: Readonly<JsonObject>, spec: OptionSpec): Promise<void> {
  const { option } = spec
  const fieldName = textOf(field['name'])
  const existing = optionInputsOf(field)
  const merged = insertOption(existing, option, choosePlacement(existing, spec.placement ?? [{ end: true }]))
  if (merged === undefined) {
    out.done({ verb: 'unchanged', target: `option ${option.name} in field ${fieldName}` })
    return
  }
  try {
    await client.updateProjectFieldOptions(requireString(field['id'], 'field.id'), merged)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    // 選択肢の id を拒む GHES などで足せなくても、作ったフィールドと設定ファイルの同期は進める
    out.warning(`could not add option ${option.name} to field ${fieldName}: ${error.message}`)
    return
  }
  out.done({ verb: 'add', target: `option ${option.name} to field ${fieldName}` })
}

// 既にあるフィールドに足す選択肢。fields は作る前の状態なので、作ったばかりの進行の欄は「無い」扱いで何も出さない（created の行が出ている）
async function addMissingOptions(out: Readonly<Output>, client: Readonly<GitHubClient>, fields: readonly JsonValue[], workflowFieldName: string): Promise<void> {
  const workflowField = lastFieldNamed(fields, workflowFieldName)
  if (workflowField !== undefined) await addFieldOption(out, client, workflowField, BLOCKED_SPEC)
  const statusField = lastFieldNamed(fields, STATUS_FIELD_NAME)
  if (statusField === undefined) out.done({ verb: 'skip', target: `field ${STATUS_FIELD_NAME} (not found)` })
  else await addFieldOption(out, client, statusField, NEEDS_ATTENTION_SPEC)
}

// フィールドを作り、既にあるフィールドには足りない選択肢を足す。既にある進行の欄の必須の値が欠けていれば、何も書かずに止める
async function initializeFields(out: Readonly<Output>, client: Readonly<GitHubClient>, target: Readonly<{ owner: string, name: string, suffix: string }>): Promise<void> {
  const { owner, name, suffix } = target
  const project = await findProjectByTitle(out, client, owner, name)
  const projectId = requireString(project['id'], 'project.id')
  const projectInfo = await client.getProjectFields(owner, requireNumber(project['number'], 'project.number'))
  if (projectInfo === undefined || !isTruthy(projectInfo)) stopWith(out, `could not read project fields: ${name}`)
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
  for (const [fieldName, options] of wanted) {
    if (fields.some(field => jsonField(field, 'name') === fieldName)) {
      out.done({ verb: 'skip', target: `field ${fieldName} (already exists)` })
      continue
    }
    const created = await client.createProjectField(projectId, fieldName, options)
    out.done({ verb: 'create', target: `field ${fieldName} (ID: ${requireString(created['id'], 'field.id')})` })
  }
  await addMissingOptions(out, client, fields, workflowFieldName)
}

const initCommand = defineCommand({
  path: ['project', 'init'],
  description: 'Add pecot-workflow fields to an existing project, and add the Blocked and Needs Attention options to the fields that already exist',
  input: z.strictObject({
    owner: z.string().describe('Project owner'),
    name: z.string().describe('Project title'),
    host: z.string().default(DEFAULT_HOST).describe('GitHub host'),
    suffix: z.string().describe('Suffix of the workflow field'),
  }),
  positional: ['owner', 'name'],
  shortFlags: { host: '-h', suffix: '-s' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(false, io)
    const { owner, name, host, suffix } = input
    const client = createGitHubClient(out, host)
    await guarded(out, 'initialize project fields', async () => {
      await initializeFields(out, client, input)
    })
    await guarded(out, 'sync project config', async () => {
      await syncProjectConfig(out, client, { owner, name, host, suffix, skipIfUnchanged: true })
    })
    return 0
  },
})

// project create

const projectCreationCommand = defineCommand({
  path: ['project', 'create'],
  description: 'Create a new project (to add the fields to an existing project, use project init)',
  input: z.strictObject({
    owner: z.string().describe('Project owner'),
    title: z.string().describe('Project title'),
    host: z.string().default(DEFAULT_HOST).describe('GitHub host'),
    suffix: z.string().describe('Suffix of the workflow field'),
  }),
  positional: ['owner', 'title'],
  shortFlags: { host: '-h', suffix: '-s' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(false, io)
    const { owner, title, host, suffix } = input
    await guarded(out, 'create project', async () => {
      const client = createGitHubClient(out, host)
      let ownerId: string
      try {
        ownerId = await client.getOwnerNodeId(owner)
      }
      catch (error: unknown) {
        if (error instanceof GitHubNotFoundError) stopWith(out, `owner not found: ${owner}`)
        throw error
      }
      const owned = await client.listProjects(owner)
      const existing = owned.find(project => jsonField(project, 'title') === title)
      if (existing !== undefined) stopWith(out, `project already exists: ${title}\nurl: ${textOf(existing['url'])}`)

      const created = await client.createProject(ownerId, title)
      out.done({ verb: 'create', target: `project #${textOf(created['number'])} ${textOf(created['url'])}` })
      await guarded(out, 'initialize project fields', async () => {
        await initializeFields(out, client, { owner, name: title, suffix })
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

async function activateFromConfigFile(out: Readonly<Output>, configPath: string, host: string | undefined): Promise<void> {
  let config: ProjectConfig
  try {
    config = loadConfig(configPath)
  }
  catch (error: unknown) {
    // Python の `except Exception` と同じ範囲（あらゆる Error）で捕まえる
    if (!(error instanceof Error) || error instanceof CommandExit) throw error
    return stopWith(out, `could not load config file ${path.basename(configPath)}: ${error.message}`)
  }
  await guarded(out, 'sync project', async () => {
    if (host !== undefined && config.host !== host) {
      out.warning(`--host (${host}) differs from the config file host (${config.host})\nusing the config file host`)
    }
    const client = createGitHubClient(out, config.host)
    const projectInfo = await client.getProjectFields(config.owner, config.project.number)
    if (projectInfo === undefined || !isTruthy(projectInfo)) stopWith(out, `project #${String(config.project.number)} not found`)
    const title = projectInfo['title']
    if (typeof title !== 'string' || title === '') stopWith(out, `could not read the title of project #${String(config.project.number)}`)
    await syncProjectConfig(out, client, { owner: config.owner, name: title, host: config.host })
  })
}

async function resolveActivationOwner(out: Readonly<Output>, client: Readonly<GitHubClient>, owner: string | undefined): Promise<string> {
  if (owner !== undefined) return owner
  let login: JsonValue | undefined
  try {
    login = jsonField(await client.getAuthenticatedUser(), 'login')
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return stopWith(out, `could not read the authenticated user: ${error.message}\npass --owner to give the owner explicitly`)
    throw error
  }
  return typeof login === 'string' && login !== '' ? login : stopWith(out, 'could not read the authenticated user')
}

// 一覧の表示モード。初期化済みのプロジェクトに [ACTIVE] を付ける
async function echoInitializedProjects(out: Readonly<Output>, client: Readonly<GitHubClient>, host: string, owner: string): Promise<void> {
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
    return
  }
  const activeNumber = activeProjectNumber(host, owner)
  for (const project of initialized) {
    const number = jsonField(project, 'number')
    const title = jsonField(project, 'title')
    lines.push(`  #${textOf(number)}: ${title === undefined ? '(untitled)' : textOf(title)}${activeNumber === number ? ' [ACTIVE]' : ''}`)
  }
  out.data(lines.join('\n'))
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
    return await client.getProjectFields(owner, number) ?? stopWith(out, `project #${String(number)} not found`)
  }
  const found = await findProjectByTitle(out, client, owner, project)
  const info = await client.getProjectFields(owner, requireNumber(found['number'], 'project.number'))
  return info !== undefined && isTruthy(info) ? info : stopWith(out, `could not read project fields: ${project}`)
}

async function activateByReference(out: Readonly<Output>, client: Readonly<GitHubClient>, target: Readonly<{ host: string, owner: string, project: string }>): Promise<void> {
  const { host, owner, project } = target
  const info = await fetchProjectInfoByReference(out, client, owner, project)
  const title = textOf(info['title'] ?? '')
  if (!hasWorkflowField(asArray(jsonField(info['fields'], 'nodes')))) {
    stopWith(out, `project "${title}" is not initialized\nrun: pecot project init --host ${host} --suffix <suffix> ${owner} "${title}"`)
  }
  await syncProjectConfig(out, client, { owner, name: title, host })
}

const activateCommand = defineCommand({
  path: ['project', 'activate'],
  description: 'Activate an initialized project',
  input: z.strictObject({
    project: z.string().optional().describe('Project number or name, or config file path/file name'),
    owner: z.string().optional().describe('Project owner (defaults to the authenticated user)'),
    host: z.string().optional().describe('GitHub host'),
  }),
  positional: ['project'],
  shortFlags: { owner: '-o', host: '-h' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(false, io)
    const { project, host } = input
    // --host の要らない形（設定ファイルのパスか名前）を先に見る
    const configPath = project === undefined ? undefined : findConfigFileArgument(project)
    if (configPath !== undefined) {
      await activateFromConfigFile(out, configPath, host)
      return 0
    }
    await guarded(out, 'activate project', async () => {
      if (host === undefined) {
        stopWith(
          out,
          '--host is required\n'
          + 'example: pecot project activate --host github.com --owner example-org\n'
          + 'example: pecot project activate --host ghes.example.com --owner example-org\n'
          + 'example: pecot project activate ghes.example.com_example-org_example-project_example-org',
        )
      }
      const client = createGitHubClient(out, host)
      const owner = await resolveActivationOwner(out, client, input.owner)
      if (project === undefined) await echoInitializedProjects(out, client, host, owner)
      else await activateByReference(out, client, { host, owner, project })
    })
    return 0
  },
})

// board show

function mismatchNote(count: number): string {
  const subject = count === 1 ? '1 Ready or Blocked Issue may be' : `${String(count)} Ready or Blocked Issues may be`
  return `${subject} in a column or Status that does not match its judgment; run pecot board sync (--dry-run to preview) to fix`
}

const infoCommand = defineCommand({
  path: ['board', 'show'],
  description: 'Show the dashboard of the project board',
  input: z.strictObject({
    json: z.boolean().default(false).describe('Output as JSON'),
    repo: z.string().superRefine((value, context) => {
      try {
        parseOwnerRepository(value)
      }
      catch (error: unknown) {
        if (!(error instanceof InvalidValueError)) throw error
        context.addIssue({ code: 'custom', message: `must be in 'owner/repo' form: ${error.message}` })
      }
    }).optional().describe('Target repository, given explicitly as \'owner/repo\''),
  }),
  hasOwnRepo: true,
  positional: [],
  shortFlags: { json: '-j' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(false, io)
    const config = requireActiveConfig(out)
    const configPath = getActiveConfigPath()
    const projectName = configPath === undefined ? `${config.host}_${config.owner}_${String(config.project.number)}` : path.parse(configPath).name
    try {
      const client = createGitHubClient(out, config.host)
      const { allItems, items, progress, isLegacy } = await readBoard(client, config, input.repo)
      const statuses = await collectAlertStatuses(client, config)
      await pruneArchivedItems(out, client, config, allItems)
      const view = { config, projectName, statuses }
      const readiness = isLegacy ? skipBoardReadiness(out) : await readBoardReadiness(out, client, config, items, input.repo, progress)
      if (readiness.mismatches > 0) out.warning(mismatchNote(readiness.mismatches))
      const json = readiness.json === undefined ? undefined : (item: BoardItem) => readinessOf(readiness, item)
      out.data(input.json
        ? infoJson(view, items, json)
        : infoMarkdown(view, input.repo, formatBoardOutput(items, readiness.texts), formatStackableChains(readiness.chains)))
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return failApi(out, 'read project board', error)
      // Python の `except Exception` と同じ範囲（あらゆる Error）で捕まえる
      if (error instanceof Error && !(error instanceof CommandExit)) return stopWith(out, `unexpected error: ${error.message}`)
      throw error
    }
    return 0
  },
})

// project link

const packageList = z.array(z.string())

function parsePackages(out: Readonly<Output>, input: Readonly<{ package?: readonly string[] | undefined, changelog_file?: string | undefined, clear_packages: boolean }>): readonly Package[] | undefined {
  const specs = input.package
  if (specs === undefined || specs.length === 0) return undefined
  if (input.changelog_file !== undefined) stopWith(out, '--package and --changelog-file cannot be used together')
  if (input.clear_packages) stopWith(out, '--package and --clear-packages cannot be used together')
  const parsed: Package[] = []
  const seen = new Set<string>()
  for (const spec of specs) {
    const separator = spec.indexOf(':')
    if (separator === -1) stopWith(out, `give --package as NAME:PATH: ${pythonStringRepr(spec)}`)
    const name = pythonStrip(spec.slice(0, separator))
    const changelog = pythonStrip(spec.slice(separator + 1))
    if (name === '' || changelog === '') stopWith(out, `--package NAME and PATH must not be empty: ${pythonStringRepr(spec)}`)
    if (seen.has(name)) stopWith(out, `--package NAME is duplicated: ${pythonStringRepr(name)}`)
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
      stopWith(out, 'this repository has packages set\nrun with --clear-packages before switching to --changelog-file')
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

const repositorySettingCommand = defineCommand({
  path: ['project', 'link'],
  description: 'Add or update a repository in the project config',
  input: z.strictObject({
    owner_repo: z.string().describe('Repository name in owner/repo form'),
    develop_branch: z.string().optional().describe('Development branch name'),
    release_branch: z.string().optional().describe('Release branch name'),
    changelog_file: z.string().optional().describe('CHANGELOG file name'),
    package: packageList.optional().describe('Register a monorepo package as NAME:PATH. Can be repeated. Example: --package pecot:plugins/pecot-workflow/CHANGELOG.md'),
    clear_packages: z.boolean().default(false).describe('Clear the existing packages setting. After clearing, the CHANGELOG falls back to --changelog-file or the default CHANGELOG.md'),
    release_type: z.string().optional().describe('Declare the release method explicitly; the w-release skill picks its procedure from it. single (1 CHANGELOG) / multi (packages) / nx (Nx Release). When omitted, it is inferred from the packages (with packages: multi, without: single)'),
  }),
  positional: ['owner_repo'],
  shortFlags: { develop_branch: '-b' },
  interactive: false,
  run: async (input, io) => {
    const out = createOutput(false, io)
    if (input.release_type !== undefined && toReleaseType(input.release_type) === undefined) {
      // Python は sorted() の順（multi, nx, single）で見せる
      stopWith(out, `--release-type must be one of [${RELEASE_TYPES.toSorted(compareStrings).map(type => pythonStringRepr(type)).join(', ')}] (got: ${pythonStringRepr(input.release_type)})`)
    }
    const packages = parsePackages(out, input)
    const { config, configPath } = requireActiveWithPath(out)

    const parts = splitOwnerRepository(input.owner_repo)
    if (parts === undefined) stopWith(out, 'give the repository as owner/repo\nexample: pecot project link example-org/my-repo')
    const { owner, repository: name } = parts
    if (owner !== config.owner) {
      stopWith(out, `repository owner ${owner} differs from project owner ${config.owner}\nGitHub Projects V2 links only repositories of the project owner`)
    }

    const existing = findRepository(config, owner, name)
    let next: ProjectConfig
    let saved: Operation
    if (existing === undefined) {
      const outcome = await linkRepository(out, config, owner, name)
      const projectNumber = String(config.project.number)
      if (outcome.status === 'failed') stopWith(out, `could not link ${input.owner_repo} to project #${projectNumber}: ${outcome.detail}`)
      out.done(outcome.status === 'already_linked'
        ? { verb: 'unchanged', target: `${input.owner_repo} in project #${projectNumber}` }
        : { verb: 'add', target: `${input.owner_repo} to project #${projectNumber}` })
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
    saveConfig(validated(next), configPath)
    out.done(saved)
    return 0
  },
})

// 設定のキーの管理。今のキーは aggregation_repo だけ

const CONFIG_KEY = z.enum(['aggregation_repo']).describe('Key of the project config (aggregation_repo: the Epic aggregation repository)')

const aggregationSettingCommand = defineCommand({
  path: ['project', 'set'],
  description: 'Set a key of the project config (aggregation_repo: the Epic aggregation repository)',
  input: z.strictObject({
    key: CONFIG_KEY,
    value: z.string().describe('Aggregation repository (owner/repo form)'),
    yes: z.boolean().default(false).describe('Overwrite an existing value without confirmation (a warning goes to stderr)'),
  }),
  positional: ['key', 'value'],
  shortFlags: { yes: '-y' },
  interactive: false,
  run: (input, io) => {
    const out = createOutput(false, io)
    const { value, yes } = input
    if (!AGGREGATION_REPOSITORY_PATTERN.test(value)) stopWith(out, `give aggregation_repo as owner/repo: ${pythonStringRepr(value)}`)
    const { config, configPath } = requireActiveWithPath(out)
    const current = config.aggregation_repo
    if (current !== undefined && current !== '' && current !== value) {
      out.warning(`overwriting aggregation_repo: ${current} -> ${value}${yes ? '' : '\npass --yes to omit this hint'}`)
    }
    else if (current === value) {
      out.done({ verb: 'unchanged', target: `aggregation_repo ${value}` })
      return Promise.resolve(0)
    }
    saveConfig(withAggregationRepository(config, value), configPath)
    out.done({ verb: 'set', target: `aggregation_repo to ${value}` })
    return Promise.resolve(0)
  },
})

const aggregationClearCommand = defineCommand({
  path: ['project', 'unset'],
  description: 'Clear a key of the project config; without aggregation_repo, creating an Epic needs --repo',
  input: z.strictObject({ key: CONFIG_KEY }),
  positional: ['key'],
  interactive: false,
  run: (_input, io) => {
    const out = createOutput(false, io)
    const { config, configPath } = requireActiveWithPath(out)
    const previous = config.aggregation_repo
    if (previous === undefined) {
      out.done({ verb: 'unchanged', target: 'aggregation_repo (not set)' })
      return Promise.resolve(0)
    }
    saveConfig(withAggregationRepository(config, undefined), configPath)
    out.done({ verb: 'remove', target: `aggregation_repo (was ${previous})` })
    return Promise.resolve(0)
  },
})

const showAggregationCommand = defineCommand({
  path: ['project', 'get'],
  description: 'Show the value of a key of the project config (aggregation_repo: the Epic aggregation repository)',
  input: z.strictObject({ key: CONFIG_KEY }),
  positional: ['key'],
  interactive: false,
  run: (_input, io) => {
    const out = createOutput(false, io)
    out.data(requireActiveConfig(out).aggregation_repo ?? 'none')
    return Promise.resolve(0)
  },
})

/**
project のコマンドと board show。並びは help の一覧の順
*/
export const PROJECT_COMMANDS = [
  listCommand,
  searchCommand,
  initCommand,
  projectCreationCommand,
  infoCommand,
  activateCommand,
  repositorySettingCommand,
  showAggregationCommand,
  aggregationSettingCommand,
  aggregationClearCommand,
]
