// project の各コマンドが共有する部分。失敗の行、フィールドの検証、設定ファイルの同期（Python の project.py の _sync_project_config まわり）。
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { FieldOptions, ProjectConfig, Repository } from '../domain/config.js'
import { isJsonObject, jsonField } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { pythonRepr } from '../domain/python-format.js'
import type { JsonValue } from '../domain/python-format.js'
import { loadConfig, projectsDirectory, saveConfig, setActiveConfig } from '../infra/config-store.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { GitHubAPIError } from '../infra/github/errors.js'
import type { ProjectFieldOption } from '../infra/github/projects.js'
import { asArray, isTruthy, requireNumber, requireString } from '../infra/github/payload.js'
import { apiErrorDetail } from './api-error.js'
import { CommandExit } from './command-definition.js'
import type { Output } from './output.js'

const WORKFLOW_FIELD_PREFIX = 'pecot-workflow-'

/**
workflow フィールドに要る選択肢。作る順でもある
*/
export const WORKFLOW_FIELD_OPTIONS: readonly ProjectFieldOption[] = [
  { name: 'Pending', color: 'GRAY', description: 'Items on hold (Epic or Task). Moved from Ready/Backlog when deprioritized or blocked.' },
  { name: 'Backlog', color: 'RED', description: 'Items waiting to be planned. Not for direct work - break down into smaller tasks first.' },
  { name: 'Ready', color: 'GREEN', description: 'Tasks ready for implementation. AI agent picks from here and moves to Active on start.' },
  { name: 'Active', color: 'BLUE', description: 'Currently being worked on. One active task per worktree - track progress and updates here.' },
  { name: 'In Review', color: 'YELLOW', description: 'Pull request created and waiting for review. Moves to Archived after merge is completed.' },
  { name: 'Archived', color: 'PURPLE', description: 'Storage for completed or cancelled items. Moved here after issue is closed or no longer needed.' },
]

export const PRIORITY_FIELD_OPTIONS: readonly ProjectFieldOption[] = [
  { name: 'High', color: 'RED', description: 'Priority: high' },
  { name: 'Medium', color: 'YELLOW', description: 'Priority: medium' },
  { name: 'Low', color: 'GREEN', description: 'Priority: low' },
]

export const SIZE_FIELD_OPTIONS: readonly ProjectFieldOption[] = [
  { name: 'XS', color: 'GREEN', description: 'Size: extra small' },
  { name: 'S', color: 'BLUE', description: 'Size: small' },
  { name: 'M', color: 'YELLOW', description: 'Size: medium' },
  { name: 'L', color: 'RED', description: 'Size: large' },
]

/**
error の行を出して終了コード 1 で止める
*/
export function fail(out: Readonly<Output>, message: string): never {
  out.error(message)
  throw new CommandExit(1)
}

/**
`could not <action>` に API の失敗の文（と状態コード）を添えて、終了コード 1 で止める
*/
export function failApi(out: Readonly<Output>, action: string, error: Readonly<GitHubAPIError>): never {
  const detail = apiErrorDetail(error)
  const status = error.statusCode ?? 0
  return fail(out, status === 0 ? `could not ${action}: ${detail}` : `could not ${action} (status ${String(status)}): ${detail}`)
}

export function failNoActiveProject(out: Readonly<Output>): never {
  return fail(out, 'no active project\nrun: pecot project activate <PROJECT>')
}

/**
Python の str() に当たる文字列。値が無いときは None
*/
export function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return 'None'
  return typeof value === 'string' ? value : pythonRepr(value)
}

export function isWorkflowField(name: JsonValue | undefined): boolean {
  return typeof name === 'string' && name.startsWith(WORKFLOW_FIELD_PREFIX)
}

export function hasWorkflowField(fields: readonly JsonValue[]): boolean {
  return fields.some(field => isWorkflowField(jsonField(field, 'name')))
}

/**
プロジェクトの情報から fields.nodes を取る
*/
export function fieldNodesOf(projectInfo: JsonObject): readonly JsonValue[] {
  return asArray(jsonField(jsonField(projectInfo, 'fields'), 'nodes'))
}

/**
タイトルが一致するプロジェクトを一覧から探す。無ければ、選べるタイトルを並べて止める
*/
export async function findProjectByTitle(out: Readonly<Output>, client: Readonly<GitHubClient>, owner: string, name: string): Promise<JsonObject> {
  const projects = await client.listProjects(owner)
  const found = projects.find(project => jsonField(project, 'title') === name)
  if (found !== undefined) return found
  const titles = projects.map(project => `- ${textOf(jsonField(project, 'title'))}`).join('\n')
  return fail(out, `project not found: ${name}\navailable projects:\n${titles}`)
}

interface ValidatedFields {
  readonly workflowField: JsonObject
  readonly fields: readonly JsonValue[]
  readonly viewNumber: JsonValue | undefined
}

// workflow フィールドと、足りない選択肢（要る順）。フィールドが無ければ undefined
function validateWorkflowField(fields: readonly JsonValue[]): { readonly field: JsonObject, readonly missing: readonly string[] } | undefined {
  for (const field of fields) {
    if (!isJsonObject(field) || !isWorkflowField(field['name']) || !Object.hasOwn(field, 'options')) continue
    const existing = new Set(asArray(field['options']).map(option => jsonField(option, 'name')))
    return { field, missing: WORKFLOW_FIELD_OPTIONS.map(option => option.name).filter(name => !existing.has(name)) }
  }
  return undefined
}

async function fetchValidatedFields(out: Readonly<Output>, client: Readonly<GitHubClient>, target: Readonly<{ owner: string, name: string, host: string, number: number }>): Promise<ValidatedFields> {
  const { owner, name, host, number } = target
  const projectInfo = await client.getProjectFields(owner, number)
  if (projectInfo === undefined || !isTruthy(projectInfo)) return fail(out, `could not read project fields: ${name}`)
  const fields = fieldNodesOf(projectInfo)
  const validated = validateWorkflowField(fields)
  if (validated === undefined) {
    return fail(
      out,
      `project "${name}" has no pecot-workflow-* field\n`
      + 'required field: pecot-workflow-<suffix> (Backlog/Pending/Ready/Active/In Review/Archived)\n'
      + `run: pecot project init --host ${host} --suffix <suffix> ${owner} "${name}"`,
    )
  }
  if (validated.missing.length > 0) {
    return fail(out, `pecot-workflow field is missing options: ${validated.missing.join(', ')}\nrequired options: Backlog / Pending / Ready / Active / In Review / Archived`)
  }
  const views = asArray(jsonField(jsonField(projectInfo, 'views'), 'nodes'))
  const viewNumber = jsonField(views.at(0), 'number')
  return { workflowField: validated.field, fields, viewNumber }
}

/**
ファイル名に使う slug。小文字にして空白を `-` にし、`a-z0-9-` 以外を落とす
*/
export function slugify(text: string): string {
  return text.toLowerCase().replaceAll(' ', '-').replaceAll(/[^a-z0-9-]/gu, '')
}

// urllib.parse.quote(text) と同じ。`/` と `_.-~` は残し、それ以外は %XX にする
function quote(text: string): string {
  return encodeURIComponent(text)
    .replaceAll(/[!'()*]/gu, character => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`)
    .replaceAll('%2F', '/')
}

function buildBoardUrl(projectUrl: string, workflowField: JsonObject, viewNumber: JsonValue | undefined): string {
  const databaseId = workflowField['databaseId']
  // 空白入りの値（In Review）を末尾に置く（URL の解析の誤りを避ける）
  const names = WORKFLOW_FIELD_OPTIONS.map(option => option.name)
  const plain = names.filter(name => !name.includes(' '))
  const spaced = names.filter(name => name.includes(' '))
  const values = [...plain, ...spaced]
  const statusValues = values.map(value => value.includes(' ') ? `"${value}"` : value).join(',')
  const filterQuery = quote(` ${textOf(workflowField['name'])}:${statusValues}`)
  return isTruthy(databaseId) && isTruthy(viewNumber) ? `${projectUrl}/views/${textOf(viewNumber)}?layout=board&verticalGroupedBy%5BcolumnId%5D=${textOf(databaseId)}&filterQuery=${filterQuery}` : `${projectUrl}?filterQuery=${filterQuery}`
}

function fieldOptionsConfig(field: JsonObject, keys: readonly (readonly [string, string])[]): FieldOptions {
  const idsByName = new Map<string, string>()
  const optionNodes = asArray(field['options'])
  for (const option of optionNodes) {
    const name = jsonField(option, 'name')
    const id = jsonField(option, 'id')
    if (typeof name === 'string' && typeof id === 'string') idsByName.set(name.toLowerCase(), id)
  }
  return { id: requireString(field['id'], 'field.id'), options: Object.fromEntries(keys.map(([key, label]) => [key, idsByName.get(label) ?? ''])) }
}

type KeyTable = readonly (readonly [string, string])[]
const WORKFLOW_KEYS: KeyTable = [['backlog', 'backlog'], ['pending', 'pending'], ['ready', 'ready'], ['active', 'active'], ['in_review', 'in review'], ['archived', 'archived']]
const PRIORITY_KEYS: KeyTable = [['high', 'high'], ['medium', 'medium'], ['low', 'low']]
const SIZE_KEYS: KeyTable = [['xs', 'xs'], ['s', 's'], ['m', 'm'], ['l', 'l']]

// 同じ名前のフィールドが複数あれば、後のものを使う
function lastFieldNamed(fields: readonly JsonValue[], name: string): JsonObject | undefined {
  return fields.findLast((field): field is JsonObject => isJsonObject(field) && field['name'] === name && Object.hasOwn(field, 'options'))
}

export interface RepositoryParts {
  readonly owner: string
  readonly name: string
  readonly develop_branch?: string | undefined
  readonly release_branch?: string | undefined
  readonly changelog_file?: string | undefined
  readonly packages?: Repository['packages']
  readonly release_type?: Repository['release_type']
}

/**
リポジトリを、モデルの定義順のキーで作る（保存の JSON のキーの順になる）
*/
export function buildRepository(parts: Readonly<RepositoryParts>): Repository {
  return {
    owner: parts.owner,
    name: parts.name,
    develop_branch: parts.develop_branch,
    release_branch: parts.release_branch,
    changelog_file: parts.changelog_file,
    packages: parts.packages,
    release_type: parts.release_type,
  }
}

// 既存の設定の順を先にし、リンクの外れたものを落として、新しいものをリンクの順に足す
function buildRepositories(linked: readonly Readonly<{ owner: string, name: string }>[], existing: readonly Repository[]): readonly Repository[] {
  const linkedKeys = new Map<string, Readonly<{ owner: string, name: string }>>()
  for (const entry of linked) {
    const key = `${entry.owner}/${entry.name}`
    if (!linkedKeys.has(key)) linkedKeys.set(key, entry)
  }
  const previous = new Map(existing.map(repository => [`${repository.owner}/${repository.name}`, repository]))
  const keys: string[] = []
  for (const key of previous.keys()) {
    if (linkedKeys.has(key)) keys.push(key)
  }
  for (const key of linkedKeys.keys()) {
    if (!previous.has(key)) keys.push(key)
  }
  return keys.map((key) => {
    const entry = linkedKeys.get(key)
    const before = previous.get(key)
    return buildRepository({ ...before, owner: entry?.owner ?? '', name: entry?.name ?? '' })
  })
}

function loadExistingConfig(configPath: string): ProjectConfig | undefined {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 設定ディレクトリ配下のパス
  return existsSync(configPath) ? loadConfig(configPath) : undefined
}

/**
GitHub Projects V2 の情報から設定ファイルを作るか更新し、アクティブにする。作った設定ファイルのパスを返す。
pecot-workflow に合うプロジェクト（workflow フィールドを持つもの）だけを扱う
*/
export async function syncProjectConfig(out: Readonly<Output>, client: Readonly<GitHubClient>, target: Readonly<{ owner: string, name: string, host: string }>): Promise<string> {
  const { owner, name, host } = target
  const project = await findProjectByTitle(out, client, owner, name)
  const number = requireNumber(project['number'], 'project.number')
  const { workflowField, fields, viewNumber } = await fetchValidatedFields(out, client, { owner, name, host, number })

  const suffix = textOf(workflowField['name']).slice(WORKFLOW_FIELD_PREFIX.length)
  const configPath = path.join(projectsDirectory(), `${host}_${owner}_${slugify(name)}_${suffix}.json`)
  const existing = loadExistingConfig(configPath)

  const linked = await client.getLinkedRepositories(owner, number)
  const priorityField = lastFieldNamed(fields, 'pecot-priority')
  const sizeField = lastFieldNamed(fields, 'pecot-size')
  const config: ProjectConfig = {
    host,
    owner,
    workflow_suffix: suffix,
    project: {
      number,
      id: requireString(project['id'], 'project.id'),
      board_url: buildBoardUrl(typeof project['url'] === 'string' ? project['url'] : '', workflowField, viewNumber),
      fields: {
        workflow: fieldOptionsConfig(workflowField, WORKFLOW_KEYS),
        priority: priorityField === undefined ? undefined : fieldOptionsConfig(priorityField, PRIORITY_KEYS),
        size: sizeField === undefined ? undefined : fieldOptionsConfig(sizeField, SIZE_KEYS),
      },
    },
    repositories: buildRepositories(linked, existing?.repositories ?? []),
    aggregation_repo: existing?.aggregation_repo,
  }

  const verb = existing === undefined ? 'create' : 'update'
  saveConfig(config, configPath)
  out.done({ verb, target: `config file ${configPath}` })
  setActiveConfig(configPath)
  out.done({ verb: 'set', target: `active project to ${path.parse(configPath).name}` })
  return configPath
}
