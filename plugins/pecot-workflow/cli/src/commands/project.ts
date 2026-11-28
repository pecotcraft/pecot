// project のグループのツール。ボードは公式の GitHub MCP で読み書きし、ここは設定ファイルと、書く前のチェックを持つ。
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { effectiveReleaseType, RELEASE_TYPES, findRepository, parsePackage, withAggregationRepository, withRepositoryAppended, withRepositoryReplaced, parseProjectConfig, serializeProjectConfig } from '@pecot/workflow-core/domain/config.js'
import type { Package, ProjectConfig, Repository } from '@pecot/workflow-core/domain/config.js'
import { JSON_NULL } from '@pecot/workflow-core/domain/json-null.js'
import { parseJsonText } from '@pecot/workflow-core/domain/json.js'
import type { JsonObject } from '@pecot/workflow-core/domain/json.js'
import { compareStrings, pythonStrip, pythonStringRepr } from '@pecot/workflow-core/domain/python-format.js'
import { splitOwnerRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import { getActiveConfigPath, loadConfig, projectsDirectory, saveConfig } from '@pecot/workflow-core/infra/config-store.js'
import { resolveRealPath } from '@pecot/workflow-core/infra/paths.js'
import { hasErrorCode } from '@pecot/workflow-core/infra/os-error.js'
import { CommandExit, defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { commandHint, hinted, inputHint, inputNameHint, placeholder, RUN } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { requireActiveConfig, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import type { BoardSnapshot, ConfigPlacement, SyncedProjectConfig } from '@pecot/workflow-core/commands-shared/project-sync.js'
import { buildRepository, syncProjectConfig } from '@pecot/workflow-core/commands-shared/project-sync.js'
import { parseOfficial, PROJECTS_LIST_FIELDS, projectFieldsOf } from './official-reads.js'
import type { ReadProjectField } from './official-reads.js'
import { GET_PROJECT, LIST_PROJECT_VIEWS, LIST_PROJECTS, PROJECT_FIELDS_PAGE, projectOf, projectsPageOf, viewNumbersOf } from './official-reads-project.js'
import type { ReadProject } from './official-reads-project.js'
import { PROJECT_CHECK } from './project-check.js'

function linkChange(existing: Repository | undefined): 'create' | 'update' {
  return existing === undefined ? 'create' : 'update'
}

function setChange(hasPrevious: boolean): 'create' | 'update' {
  return hasPrevious ? 'update' : 'create'
}

const AGGREGATION_REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/u
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])

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
  owner: z.string().optional().describe('Owner of the board, for projects_list and projects_write (omitted when the config cannot be read)'),
  project_number: z.int().optional().describe('Number of the board, for projects_list and projects_write (omitted when the config cannot be read)'),
})

// 公式の MCP でボードを読み書きするための owner と番号。読めない設定は名前だけを出す
function boardOf(file: string): { readonly owner?: string, readonly project_number?: number } {
  try {
    const config = loadConfig(file)
    return { owner: config.owner, project_number: config.project.number }
  }
  catch {
    return {}
  }
}

const LIST_OUTPUT = z.strictObject({
  projects: z.array(LIST_ROW).describe('Project configs under the projects directory (an empty array when there is none)'),
})

const listCommand = defineTool({
  name: 'project_list',
  title: 'List projects',
  description: 'List available projects',
  input: z.strictObject({}),
  output: LIST_OUTPUT,
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
    const projects: z.input<typeof LIST_ROW>[] = []
    for (const file of files) {
      const isActive = active !== undefined && resolveRealPath(path.join(directory, file)) === resolveRealPath(active)
      lines.push(`  ${path.parse(file).name}${isActive ? ' [ACTIVE]' : ''}`)
      projects.push({ name: path.parse(file).name, active: isActive, ...boardOf(path.join(directory, file)) })
    }
    out.data(lines.join('\n'))
    out.result({ projects })
    return Promise.resolve(0)
  },
})

// project activate

const ACTIVATE_PATH = ['project', 'activate']

const CONFIG_MOVED = z.strictObject({
  from: z.string().describe('File name of the old project config'),
  to: z.string().describe('File name the project config was moved to'),
}).nullable().describe('The old project config file that was moved to the new name (null when none)')

// 移した設定ファイルの、名前だけの組
function configMovedOf(placement: Readonly<ConfigPlacement>): z.input<typeof CONFIG_MOVED> {
  return placement.movedFrom === undefined ? JSON_NULL : { from: path.basename(placement.movedFrom), to: path.basename(placement.configPath) }
}

const ACTIVATE_OUTPUT = z.strictObject({
  project: z.string().optional().describe('Name of the project config that was made active'),
  configPath: z.string().describe('Path of the project config file'),
  change: z.enum(['create', 'update', 'unchanged']).describe('What happened to the config file'),
  config_moved: CONFIG_MOVED,
})

type ActivateData = z.input<typeof ACTIVATE_OUTPUT>

const PAGES = z.array(z.unknown())

const ACTIVATE_INPUT = z.strictObject({
  project: z.string().describe('Board number or title, or config file path/file name'),
  owner: z.string().optional().describe('Owner of the board (required unless project is a config file)'),
  owner_type: z.enum(['user', 'org']).optional().describe('Whether the owner is a user or an organization, as passed to projects_get (required unless list_projects or the config gives it)'),
  host: z.string().optional().describe('GitHub host (required unless project is a config file)'),
  reads: z.object({
    project: z.unknown().optional().describe('Result of projects_get with method get_project for the board (when project is a number or a config file)'),
    projects: PAGES.optional().describe('Results of projects_list with method list_projects for the owner, every page (when project is a title)'),
    fields: z.unknown().optional().describe('Result of projects_list with method list_project_fields for the board'),
    views: z.unknown().optional().describe('Result of projects_list with method list_project_views for the board; the board URL in the config opens its first view (omit it for a URL without a view)'),
  }).optional().describe('Results of the official GitHub MCP reads of the board'),
})

type ActivateInput = z.output<typeof ACTIVATE_INPUT>

// 設定ファイルの結果を data に渡す
function reportSynced(out: Readonly<Output<ActivateData>>, synced: Readonly<SyncedProjectConfig>): void {
  out.result({ ...synced.activeProject !== undefined && { project: synced.activeProject }, configPath: synced.configPath, change: synced.change, config_moved: configMovedOf(synced) })
}

// 設定ファイルのパスか、projects/ にあるファイル名か
function findConfigFileArgument(project: string): string | undefined {
  if (isFile(path.resolve(project))) return resolveRealPath(path.resolve(project))
  const named = path.join(projectsDirectory(), project.endsWith('.json') ? project : `${project}.json`)
  return isFile(named) ? named : undefined
}

function loadConfigFile(out: Readonly<Output>, configPath: string): ProjectConfig {
  try {
    return loadConfig(configPath)
  }
  catch (error: unknown) {
    // Python の `except Exception` と同じ範囲（あらゆる Error）で捕まえる
    if (!(error instanceof Error) || error instanceof CommandExit) throw error
    return stopWith(out, `could not load config file ${path.basename(configPath)}: ${error.message}`, 'config-invalid')
  }
}

/**
読むボード。number が無ければ title で list_projects から探す
*/
interface BoardTarget {
  readonly host: string
  readonly owner: string
  readonly ownerType: 'user' | 'org' | undefined
  readonly number: number | undefined
  readonly title: string | undefined
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の出力の型
function targetOf(out: Readonly<Output>, input: Readonly<ActivateInput>): BoardTarget {
  const configPath = findConfigFileArgument(input.project)
  if (configPath !== undefined) {
    const config = loadConfigFile(out, configPath)
    if (input.host !== undefined && config.host !== input.host) {
      out.warning(hinted`${inputHint(ACTIVATE_PATH, 'host', input.host)} differs from the config file host (${config.host})\nusing the config file host`)
    }
    const fromUrl = config.project.board_url?.includes('/orgs/') === true ? 'org' : (config.project.board_url?.includes('/users/') === true ? 'user' : undefined)
    return { host: config.host, owner: config.owner, ownerType: input.owner_type ?? fromUrl, number: config.project.number, title: undefined }
  }
  const { host, owner } = input
  if (host === undefined || owner === undefined) {
    stopWith(
      out,
      hinted`${inputNameHint(ACTIVATE_PATH, host === undefined ? 'host' : 'owner')} is required
example: ${commandHint(ACTIVATE_PATH, { project: '1', host: 'github.com', owner: 'example-org', owner_type: 'org' })}
example: ${commandHint(ACTIVATE_PATH, { project: 'ghes.example.com_example-org_1' })}`,
      'invalid-input',
    )
  }
  const isNumber = /^\d+$/u.test(input.project)
  return { host, owner, ownerType: input.owner_type, number: isNumber ? Number(input.project) : undefined, title: isNumber ? undefined : input.project }
}

function requireRead<T>(out: Readonly<Output>, value: T | undefined, message: string): T {
  return value ?? stopWith(out, message, 'invalid-input')
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の出力の型
function readProject(out: Readonly<Output>, target: Readonly<BoardTarget>, reads: ActivateInput['reads']): ReadProject {
  if (target.number !== undefined) {
    const read = requireRead(out, reads?.project, `read the board with projects_get (method get_project, owner ${target.owner}, project_number ${String(target.number)}) and pass its result as reads.project`)
    return projectOf(parseOfficial(out, 'projects_get', GET_PROJECT, read, 'reads.project'))
  }
  const pages = requireRead(out, reads?.projects, `read the boards of ${target.owner} with projects_list (method list_projects, every page) and pass the results as reads.projects`)
  const read = pages.map((page, index) => projectsPageOf(parseOfficial(out, 'projects_list', LIST_PROJECTS, page, `reads.projects[${String(index)}]`)))
  const projects = read.flatMap(page => page.projects)
  const found = projects.find(project => project.title === target.title)
  if (found !== undefined) return found
  const more = read.at(-1)?.hasNextPage === true ? '\nthe last page of list_projects has a next page; read it with after and add it to reads.projects' : ''
  return stopWith(out, `project not found: ${String(target.title)}\navailable projects:\n${projects.map(project => `- ${project.title ?? '(untitled)'}`).join('\n')}${more}`, 'project-not-found')
}

// 設定に写す欄の ID は GraphQL の node ID。選択肢の ID は REST と GraphQL で同じ
function fieldNodeOf(out: Readonly<Output>, field: Readonly<ReadProjectField>): JsonObject {
  if (field.nodeId === undefined && field.dataType === 'SINGLE_SELECT') stopWith(out, `the result of projects_list in reads.fields has no node_id for field ${field.name}`, 'github-mcp-shape')
  return {
    id: field.nodeId ?? field.id,
    name: field.name,
    databaseId: Number(field.id),
    ...field.dataType === 'SINGLE_SELECT' && { options: field.options.map(option => ({ id: option.id ?? stopWith(out, `the result of projects_list in reads.fields has no id for option ${option.name} of field ${field.name}`, 'github-mcp-shape'), name: option.name })) },
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の出力の型
function readBoard(out: Readonly<Output>, target: Readonly<BoardTarget>, reads: ActivateInput['reads']): BoardSnapshot {
  const project = readProject(out, target, reads)
  const number = project.number ?? target.number ?? stopWith(out, 'the board read has no number', 'github-mcp-shape')
  const id = project.node_id ?? stopWith(out, `the board read for project #${String(number)} has no node_id`, 'github-mcp-shape')
  const ownerType = target.ownerType ?? (project.owner_type === 'org' || project.owner_type === 'user' ? project.owner_type : undefined)
  if (ownerType === undefined) stopWith(out, hinted`cannot tell whether ${target.owner} is a user or an organization\npass ${inputNameHint(ACTIVATE_PATH, 'owner_type')}, the value given to projects_get`, 'invalid-input')
  const fieldsRead = requireRead(out, reads?.fields, `read the fields of project #${String(number)} with projects_list (method list_project_fields) and pass its result as reads.fields`)
  if (parseOfficial(out, 'projects_list', PROJECT_FIELDS_PAGE, fieldsRead, 'reads.fields').fields.pageInfo?.hasNextPage === true) {
    stopWith(out, 'list_project_fields in reads.fields has a next page; read it with per_page 50, or with after, and pass all the fields', 'invalid-input')
  }
  const fields = projectFieldsOf(parseOfficial(out, 'projects_list', PROJECTS_LIST_FIELDS, fieldsRead, 'reads.fields')).map(field => fieldNodeOf(out, field))
  const views = reads?.views === undefined ? [] : viewNumbersOf(parseOfficial(out, 'projects_list', LIST_PROJECT_VIEWS, reads.views, 'reads.views'))
  return {
    id,
    number,
    title: project.title ?? target.title ?? `#${String(number)}`,
    url: `https://${target.host}/${ownerType === 'org' ? 'orgs' : 'users'}/${target.owner}/projects/${String(number)}`,
    fields,
    viewNumber: views.at(0),
  }
}

const activateCommand = defineTool({
  name: 'project_activate',
  title: 'Activate project',
  description: 'Write the project config of an initialized board from the official GitHub MCP reads in reads, and make it the active project. The registered repositories are kept from the existing config',
  input: ACTIVATE_INPUT,
  output: ACTIVATE_OUTPUT,
  run: (input, io) => {
    const out = createOutput<ActivateData>(false, io)
    const target = targetOf(out, input)
    const board = readBoard(out, target, input.reads)
    // 中身が同じ設定ファイルは書かず、change を unchanged にしたうえでアクティブにする
    reportSynced(out, syncProjectConfig(out, board, { owner: target.owner, host: target.host, skipIfUnchanged: true, activateIfUnchanged: true, isDryRun: false }))
    return Promise.resolve(0)
  },
})

// project link

const LINK_PATH = ['project', 'link']
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
      stopWith(out, hinted`this repository has packages set\n${RUN} with ${inputHint(LINK_PATH, 'clear_packages')} before switching to ${inputNameHint(LINK_PATH, 'changelog_file')}`, 'invalid-input')
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

const LINK_OUTPUT = z.strictObject({
  repository: z.string().describe('Repository in owner/repo form'),
  projectNumber: z.int().describe('Number of the active project'),
  change: z.enum(['create', 'update']).describe('create: the repository was added to the config; update: its entry was changed'),
  configPath: z.string().describe('Path of the project config file'),
})

const projectLinkCommand = defineTool({
  name: 'project_link',
  title: 'Link repository to project',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  description: 'Add or update a repository in the project config. It does not link the repository to the board on GitHub; do that with the project-link operation of github-ops',
  input: z.strictObject({
    repo: z.string().describe('Repository name in owner/repo form'),
    develop_branch: z.string().optional().describe('Development branch name'),
    release_branch: z.string().optional().describe('Release branch name'),
    changelog_file: z.string().optional().describe('CHANGELOG file name'),
    package: packageList.optional().describe('Monorepo package to register, as NAME:PATH. Example: pecot:plugins/pecot-workflow/CHANGELOG.md'),
    clear_packages: z.boolean().default(false).describe('Clear the existing packages setting. After clearing, the CHANGELOG falls back to `changelog_file` or the default CHANGELOG.md'),
    release_type: z.string().optional().describe('Declare the release method explicitly; the w-release skill picks its procedure from it. single (1 CHANGELOG) / multi (packages) / nx (Nx Release). When omitted, it is inferred from the packages (with packages: multi, without: single)'),
  }),
  output: LINK_OUTPUT,
  run: (input, io) => {
    const out = createOutput<z.input<typeof LINK_OUTPUT>>(false, io)
    if (input.release_type !== undefined && toReleaseType(input.release_type) === undefined) {
      // Python は sorted() の順（multi, nx, single）で見せる
      stopWith(out, hinted`${inputNameHint(LINK_PATH, 'release_type')} must be one of [${RELEASE_TYPES.toSorted(compareStrings).map(type => pythonStringRepr(type)).join(', ')}] (got: ${pythonStringRepr(input.release_type)})`, 'invalid-input')
    }
    const packages = parsePackages(out, input)
    const { config, configPath } = requireActiveWithPath(out)

    const parts = splitOwnerRepository(input.repo)
    if (parts === undefined) stopWith(out, hinted`give the repository as owner/repo\nexample: ${commandHint(LINK_PATH, { repo: 'example-org/my-repo' })}`, 'invalid-input')
    const { owner, repository: name } = parts
    if (owner !== config.owner) {
      stopWith(out, `repository owner ${owner} differs from project owner ${config.owner}\nGitHub Projects V2 links only repositories of the project owner`, 'invalid-input')
    }

    const existing = findRepository(config, owner, name)
    const next = existing === undefined
      ? withRepositoryAppended(config, buildRepository({
          owner,
          name,
          develop_branch: input.develop_branch,
          release_branch: input.release_branch,
          changelog_file: packages === undefined ? input.changelog_file : undefined,
          packages,
          release_type: toReleaseType(input.release_type),
        }))
      : withRepositoryReplaced(config, updatedRepository(out, existing, { ...input, packages }))
    const saved: Operation = existing === undefined ? { verb: 'add', target: `${owner}/${name} to ${configPath}` } : { verb: 'update', target: `${owner}/${name} in ${configPath}` }
    const checked = validated(next)
    out.planned(saved)
    const reported = { repository: `${owner}/${name}`, projectNumber: config.project.number, change: linkChange(existing), configPath }
    saveConfig(checked, configPath)
    out.done(saved)
    out.result(reported)
    return Promise.resolve(0)
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
  readonly set: (out: Readonly<Output<SetData>>, value: string, options: Readonly<{ isConfirmed: boolean }>) => void
  readonly unset: (out: Readonly<Output<UnsetData>>) => void
}

const CONFIG_KEY_FIELD = z.enum(['aggregation_repo']).describe('Key of the project config')

const SUMMARY_PACKAGE = z.strictObject({
  name: z.string().describe('Name of the package (the tag prefix)'),
  changelog: z.string().describe('Path of the CHANGELOG of the package'),
})

const SUMMARY_REPOSITORY = z.strictObject({
  full_name: z.string().describe('Repository (owner/repo)'),
  develop_branch: z.string().nullable().describe('Develop branch (null when not set)'),
  release_branch: z.string().nullable().describe('Release branch (null when not set)'),
  release_type: z.enum(['single', 'multi', 'nx']).describe('Release type in effect'),
  packages: z.array(SUMMARY_PACKAGE).describe('Packages of a monorepo (empty when none)'),
  changelog_file: z.string().optional().describe('CHANGELOG path set for a repository without packages (omitted when not set)'),
})

const GET_OUTPUT = z.strictObject({
  key: CONFIG_KEY_FIELD.optional().describe('Key that was read (omitted when key was not given)'),
  value: z.string().optional().describe('Value of the key (omitted when it is not set, or when key was not given)'),
  project: z.strictObject({
    name: z.string().describe('Name of the project config'),
    host: z.string().describe('GitHub host'),
    owner: z.string().describe('Owner of the board'),
    number: z.int().describe('Number of the board'),
    aggregation_repo: z.string().nullable().describe('Epic aggregation repository (null when not set)'),
  }).optional().describe('Overview of the active project (only when key was not given)'),
  repositories: z.array(SUMMARY_REPOSITORY).optional().describe('Registered repositories, in registration order (only when key was not given)'),
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

function setAggregationRepository(out: Readonly<Output<SetData>>, value: string, options: Readonly<{ isConfirmed: boolean }>): void {
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
  if (current !== undefined && current !== '') {
    out.warning(options.isConfirmed ? `overwriting aggregation_repo: ${current} -> ${value}` : hinted`overwriting aggregation_repo: ${current} -> ${value}\npass ${inputHint(['project', 'set'], 'yes')} to omit this hint`)
  }
  saveConfig(withAggregationRepository(config, value), configPath)
  out.done(operation)
  out.result(reported)
}

function unsetAggregationRepository(out: Readonly<Output<UnsetData>>): void {
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

function summaryRepository(entry: Repository): z.input<typeof SUMMARY_REPOSITORY> {
  return {
    full_name: `${entry.owner}/${entry.name}`,
    develop_branch: entry.develop_branch ?? JSON_NULL,
    release_branch: entry.release_branch ?? JSON_NULL,
    release_type: effectiveReleaseType(entry),
    packages: (entry.packages ?? []).map(item => ({ name: item.name, changelog: item.changelog })),
    ...entry.changelog_file !== undefined && entry.changelog_file !== '' && { changelog_file: entry.changelog_file },
  }
}

function repositoryLine(entry: Repository): string {
  const branches = [
    ...entry.develop_branch === undefined || entry.develop_branch === '' ? [] : [`develop: ${entry.develop_branch}`],
    ...entry.release_branch === undefined || entry.release_branch === '' ? [] : [`release: ${entry.release_branch}`],
  ]
  return `- ${entry.owner}/${entry.name}${branches.length > 0 ? ` (${branches.join(', ')})` : ''}, release_type: ${effectiveReleaseType(entry)}`
}

// key を省いたときの、アクティブな設定の要約
function showSummary(out: Readonly<Output<GetData>>): void {
  const { config, configPath } = requireActiveWithPath(out)
  const name = path.parse(configPath).name
  out.data([
    `project: ${name} (${config.host}, ${config.owner} #${String(config.project.number)})`,
    `aggregation_repo: ${config.aggregation_repo ?? 'none'}`,
    'repositories:',
    ...config.repositories.length === 0 ? ['- none'] : config.repositories.map(entry => repositoryLine(entry)),
  ].join('\n'))
  out.result({
    project: { name, host: config.host, owner: config.owner, number: config.project.number, aggregation_repo: config.aggregation_repo ?? JSON_NULL },
    repositories: config.repositories.map(entry => summaryRepository(entry)),
  })
}

const projectSetCommand = defineTool({
  name: 'project_set',
  title: 'Set project config',
  description: 'Set a key of the project config (aggregation_repo: the Epic aggregation repository)',
  input: z.strictObject({
    key: CONFIG_KEY,
    value: z.string().describe('Aggregation repository (owner/repo form)'),
    yes: z.boolean().default(false).describe('Overwrite an existing value without confirmation (a warning goes to stderr)'),
  }),
  output: SET_OUTPUT,
  run: (input, io) => {
    CONFIG_KEY_OPERATIONS[input.key].set(createOutput<SetData>(false, io), input.value, { isConfirmed: input.yes })
    return Promise.resolve(0)
  },
})

const projectUnsetCommand = defineTool({
  name: 'project_unset',
  title: 'Clear project config',
  description: 'Clear a key of the project config; without aggregation_repo, creating an Epic needs the target repository given explicitly',
  input: z.strictObject({ key: CONFIG_KEY }),
  output: UNSET_OUTPUT,
  run: (input, io) => {
    CONFIG_KEY_OPERATIONS[input.key].unset(createOutput<UnsetData>(false, io))
    return Promise.resolve(0)
  },
})

const projectGetCommand = defineTool({
  name: 'project_get',
  title: 'Get project config',
  description: 'Show the value of a key of the project config (aggregation_repo: the Epic aggregation repository), or without key, the overview of the active project and its registered repositories with their branches and release type',
  input: z.strictObject({ key: CONFIG_KEY.optional() }),
  output: GET_OUTPUT,
  run: (input, io) => {
    const out = createOutput<GetData>(false, io)
    if (input.key === undefined) showSummary(out)
    else CONFIG_KEY_OPERATIONS[input.key].get(out)
    return Promise.resolve(0)
  },
})

/**
project のグループのツール。並びは tools/list に出る順
*/
export const PROJECT_TOOLS: readonly ToolDefinition[] = [
  listCommand,
  PROJECT_CHECK,
  activateCommand,
  projectLinkCommand,
  projectGetCommand,
  projectSetCommand,
  projectUnsetCommand,
]
