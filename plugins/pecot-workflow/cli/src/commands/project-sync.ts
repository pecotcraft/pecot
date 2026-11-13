// project の各コマンドが共有する部分。失敗の行、フィールドの検証、設定ファイルの同期（Python の project.py の _sync_project_config まわり）。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { parseProjectConfig, serializeProjectConfig } from '../domain/config.js'
import type { FieldOptions, ProjectConfig, Repository } from '../domain/config.js'
import type { OptionPlacement } from '../domain/field-options.js'
import { isJsonObject, jsonField, parseJsonText } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { pythonRepr } from '../domain/python-format.js'
import type { JsonValue } from '../domain/python-format.js'
import { loadConfig, projectsDirectory, saveConfig, setActiveConfig } from '../infra/config-store.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { GitHubAPIError } from '../infra/github/errors.js'
import type { ProjectFieldOption } from '../infra/github/projects.js'
import { asArray, isTruthy, requireNumber, requireString } from '../infra/github/payload.js'
import { stopWith } from './command-stop.js'
import type { Output } from './output.js'

const WORKFLOW_FIELD_PREFIX = 'pecot-workflow-'

/**
選択肢の定義。isOptional は無くても同期を止めない。placement は足すときの差し込み先の候補（先から使い、無ければ末尾）
*/
export interface OptionSpec {
  readonly option: ProjectFieldOption
  readonly isOptional?: true
  readonly placement?: readonly OptionPlacement[]
}

/**
前提を待つ Issue を pecot が置く列
*/
export const BLOCKED_SPEC: OptionSpec = {
  option: { name: 'Blocked', color: 'GRAY', description: 'Tasks waiting for prerequisite Issues. pecot moves them to Ready once they can start.' },
  isOptional: true,
  placement: [{ after: 'Backlog' }, { before: 'Ready' }],
}

/**
人の判断を待つ Issue の札。既定の Status の末尾に足す
*/
export const NEEDS_ATTENTION_SPEC: OptionSpec = {
  option: { name: 'Needs Attention', color: 'RED', description: 'Waiting for a human decision or action.' },
  isOptional: true,
}

/**
既定の Status のフィールド名
*/
export const STATUS_FIELD_NAME = 'Status'

/**
workflow フィールドの選択肢の定義。作る順でもある
*/
const WORKFLOW_FIELD_SPECS: readonly OptionSpec[] = [
  { option: { name: 'Pending', color: 'GRAY', description: 'Items on hold (Epic or Task). Moved here from Ready or Backlog when deprioritized.' } },
  { option: { name: 'Backlog', color: 'RED', description: 'Items waiting to be planned. Not for direct work - break down into smaller tasks first.' } },
  BLOCKED_SPEC,
  { option: { name: 'Ready', color: 'GREEN', description: 'Tasks ready for implementation. AI agent picks from here and moves to Active on start.' } },
  { option: { name: 'Active', color: 'BLUE', description: 'Currently being worked on. One active task per worktree - track progress and updates here.' } },
  { option: { name: 'In Review', color: 'YELLOW', description: 'Pull request created and waiting for review. Moves to Archived after merge is completed.' } },
  { option: { name: 'Archived', color: 'PURPLE', description: 'Completed or cancelled items. Moved here after the issue is closed or no longer needed.' } },
]

/**
workflow フィールドに作る選択肢
*/
export const WORKFLOW_FIELD_OPTIONS: readonly ProjectFieldOption[] = WORKFLOW_FIELD_SPECS.map(spec => spec.option)

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
`could not <action>` に API の失敗の文（と状態コード）を添えて、終了コード 1 で止める
*/
export function failApi(out: Readonly<Output>, action: string, error: Readonly<GitHubAPIError>): never {
  const detail = error.message
  const status = error.statusCode ?? 0
  return stopWith(out, status === 0 ? `could not ${action}: ${detail}` : `could not ${action} (status ${String(status)}): ${detail}`)
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
  return stopWith(out, `project not found: ${name}\navailable projects:\n${titles}`)
}

interface ValidatedFields {
  readonly workflowField: JsonObject
  readonly fields: readonly JsonValue[]
  readonly viewNumber: JsonValue | undefined
}

/**
workflow フィールドに足りない必須の選択肢（要る順。optional は数えない。名前は大文字と小文字を区別しない）
*/
export function missingRequiredOptions(field: Readonly<JsonObject>): readonly string[] {
  const existing = new Set(asArray(field['options']).map(option => lowerName(option)))
  return WORKFLOW_FIELD_SPECS.filter(spec => spec.isOptional !== true && !existing.has(spec.option.name.toLowerCase())).map(spec => spec.option.name)
}

/**
必須の選択肢が欠けたときの、終了コード 1 の止め方
*/
export function stopMissingOptions(out: Readonly<Output>, missing: readonly string[]): never {
  return stopWith(out, `pecot-workflow field is missing options: ${missing.join(', ')}\nrequired options: Backlog / Pending / Ready / Active / In Review / Archived`)
}

function lowerName(option: JsonValue | undefined): string {
  const name = jsonField(option, 'name')
  return typeof name === 'string' ? name.toLowerCase() : ''
}

// 選択肢を持つ workflow フィールド。suffix があればその名前のもの、無ければ最初の pecot-workflow-*
function findWorkflowField(fields: readonly JsonValue[], suffix: string | undefined): JsonObject | undefined {
  return fields.find((field): field is JsonObject => isJsonObject(field) && Object.hasOwn(field, 'options') && (suffix === undefined ? isWorkflowField(field['name']) : field['name'] === `${WORKFLOW_FIELD_PREFIX}${suffix}`))
}

async function fetchValidatedFields(out: Readonly<Output>, client: Readonly<GitHubClient>, target: Readonly<{ owner: string, name: string, host: string, number: number, suffix?: string | undefined }>): Promise<ValidatedFields> {
  const { owner, name, host, number, suffix } = target
  const projectInfo = await client.getProjectFields(owner, number)
  if (projectInfo === undefined || !isTruthy(projectInfo)) return stopWith(out, `could not read project fields: ${name}`)
  const fields = fieldNodesOf(projectInfo)
  const workflowField = findWorkflowField(fields, suffix)
  if (workflowField === undefined) {
    return stopWith(
      out,
      `project "${name}" has no pecot-workflow-* field\n`
      + 'required field: pecot-workflow-<suffix> (Backlog/Pending/Ready/Active/In Review/Archived)\n'
      + `run: pecot project init --host ${host} --suffix <suffix> ${owner} "${name}"`,
    )
  }
  const missing = missingRequiredOptions(workflowField)
  if (missing.length > 0) return stopMissingOptions(out, missing)
  const views = asArray(jsonField(jsonField(projectInfo, 'views'), 'nodes'))
  const viewNumber = jsonField(views.at(0), 'number')
  return { workflowField, fields, viewNumber }
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
  const present = new Set(asArray(workflowField['options']).map(option => lowerName(option)))
  const names = WORKFLOW_FIELD_SPECS.filter(spec => spec.isOptional !== true || present.has(spec.option.name.toLowerCase())).map(spec => spec.option.name)
  const plain = names.filter(name => !name.includes(' '))
  const spaced = names.filter(name => name.includes(' '))
  const values = [...plain, ...spaced]
  const statusValues = values.map(value => value.includes(' ') ? `"${value}"` : value).join(',')
  const filterQuery = quote(` ${textOf(workflowField['name'])}:${statusValues}`)
  return isTruthy(databaseId) && isTruthy(viewNumber) ? `${projectUrl}/views/${textOf(viewNumber)}?layout=board&verticalGroupedBy%5BcolumnId%5D=${textOf(databaseId)}&filterQuery=${filterQuery}` : `${projectUrl}?filterQuery=${filterQuery}`
}

interface KeyEntry {
  readonly key: string
  readonly label: string
  readonly isOptional: boolean
}

function keyEntry(name: string, isOptional: boolean): KeyEntry {
  return { key: name.toLowerCase().replaceAll(' ', '_'), label: name.toLowerCase(), isOptional }
}

// 設定ファイルのキーの順（保存の JSON のキーの順になる）。isOptional は選択肢の定義の値を使う
const WORKFLOW_KEY_ORDER = ['Backlog', 'Pending', 'Blocked', 'Ready', 'Active', 'In Review', 'Archived']
const WORKFLOW_KEYS: readonly KeyEntry[] = WORKFLOW_KEY_ORDER.map(name => keyEntry(name, WORKFLOW_FIELD_SPECS.some(spec => spec.option.name === name && spec.isOptional === true)))
const STATUS_KEYS: readonly KeyEntry[] = [keyEntry('Todo', true), keyEntry(NEEDS_ATTENTION_SPEC.option.name, NEEDS_ATTENTION_SPEC.isOptional === true)]
const PRIORITY_KEYS: readonly KeyEntry[] = ['High', 'Medium', 'Low'].map(name => keyEntry(name, false))
const SIZE_KEYS: readonly KeyEntry[] = ['XS', 'S', 'M', 'L'].map(name => keyEntry(name, false))

// isOptional のキーは、ボードに選択肢が無ければ書かない。それ以外は無ければ空文字列で書く
function fieldOptionsConfig(field: JsonObject, keys: readonly KeyEntry[]): FieldOptions {
  const idsByName = new Map<string, string>()
  const optionNodes = asArray(field['options'])
  for (const option of optionNodes) {
    const name = jsonField(option, 'name')
    const id = jsonField(option, 'id')
    if (typeof name === 'string' && typeof id === 'string') idsByName.set(name.toLowerCase(), id)
  }
  const entries = keys
    .filter(entry => idsByName.has(entry.label) || !entry.isOptional)
    .map((entry): readonly [string, string] => [entry.key, idsByName.get(entry.label) ?? ''])
  return { id: requireString(field['id'], 'field.id'), options: Object.fromEntries(entries) }
}

// 同じ名前のフィールドが複数あれば、後のものを使う
export function lastFieldNamed(fields: readonly JsonValue[], name: string): JsonObject | undefined {
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
  const keys: (readonly [string, Readonly<{ owner: string, name: string }>])[] = []
  for (const key of previous.keys()) {
    const entry = linkedKeys.get(key)
    if (entry !== undefined) keys.push([key, entry])
  }
  for (const [key, entry] of linkedKeys) {
    if (!previous.has(key)) keys.push([key, entry])
  }
  return keys.map(([key, entry]) => buildRepository({ ...previous.get(key), owner: entry.owner, name: entry.name }))
}

function loadExistingConfig(configPath: string): ProjectConfig | undefined {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 設定ディレクトリ配下のパス
  return existsSync(configPath) ? loadConfig(configPath) : undefined
}

/**
GitHub Projects V2 の情報から設定ファイルを作るか更新し、アクティブにする。作った設定ファイルのパスを返す。
pecot-workflow に合うプロジェクトだけを扱う。suffix はその名前の workflow フィールドを使う。
skipIfUnchanged は、設定ファイルの内容が同じなら何も書かない
*/
export async function syncProjectConfig(
  out: Readonly<Output>,
  client: Readonly<GitHubClient>,
  target: Readonly<{ owner: string, name: string, host: string, suffix?: string | undefined, skipIfUnchanged?: boolean | undefined }>,
): Promise<string> {
  const { owner, name, host, skipIfUnchanged = false } = target
  const project = await findProjectByTitle(out, client, owner, name)
  const number = requireNumber(project['number'], 'project.number')
  const { workflowField, fields, viewNumber } = await fetchValidatedFields(out, client, { owner, name, host, number, suffix: target.suffix })

  const suffix = textOf(workflowField['name']).slice(WORKFLOW_FIELD_PREFIX.length)
  const configPath = path.join(projectsDirectory(), `${host}_${owner}_${slugify(name)}_${suffix}.json`)
  const existing = loadExistingConfig(configPath)

  const linked = await client.getLinkedRepositories(owner, number)
  const priorityField = lastFieldNamed(fields, 'pecot-priority')
  const sizeField = lastFieldNamed(fields, 'pecot-size')
  const statusField = lastFieldNamed(fields, STATUS_FIELD_NAME)
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
        status: statusField === undefined ? undefined : fieldOptionsConfig(statusField, STATUS_KEYS),
      },
    },
    repositories: buildRepositories(linked, existing?.repositories ?? []),
    aggregation_repo: existing?.aggregation_repo,
  }

  // 読み直して保存と同じ形にそろえてから比べる
  const normalized = parseProjectConfig(parseJsonText(serializeProjectConfig(config)))
  if (skipIfUnchanged && existing !== undefined && serializeProjectConfig(existing) === serializeProjectConfig(normalized)) return configPath
  const verb = existing === undefined ? 'create' : 'update'
  saveConfig(config, configPath)
  out.done({ verb, target: `config file ${configPath}` })
  setActiveConfig(configPath)
  out.done({ verb: 'set', target: `active project to ${path.parse(configPath).name}` })
  return configPath
}
