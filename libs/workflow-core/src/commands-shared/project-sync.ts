// project の各コマンドが共有する部分。失敗の行、フィールドの検証、設定ファイルの同期（Python の project.py の _sync_project_config まわり）。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { parseProjectConfig, serializeProjectConfig, WORKFLOW_FIELD_NAME } from '../domain/config.js'
import type { FieldOptions, ProjectConfig, Repository } from '../domain/config.js'
import type { OptionPlacement } from '../domain/field-options.js'
import { isJsonObject, jsonField, parseJsonText } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { isLegacyWorkflowFieldName, planConfigMove, planWorkflowField } from '../domain/migration.js'
import type { WorkflowFieldPlan } from '../domain/migration.js'
import { pythonRepr } from '../domain/python-format.js'
import type { JsonValue } from '../domain/python-format.js'
import { listProjectConfigEntries, loadConfig, projectsDirectory, removeConfig, saveConfig, setActiveConfig } from '../infra/config-store.js'
import type { GitHubClient } from '../infra/github/index.js'
import type { GitHubAPIError } from '../infra/github/errors.js'
import type { ProjectFieldOption } from '../infra/github/projects.js'
import { asArray, isTruthy, requireNumber, requireString } from '../infra/github/payload.js'
import { commandHint, hinted, RUN_COLON } from './command-hint.js'
import { stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import type { Operation, Output } from './output.js'

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

// 値は利用者が決め、設定ファイルには写さない
export { LANE_FIELD_NAME } from '../domain/lanes.js'

/**
pecot-status を列、pecot-lane を横の分け方にしたビューの名前
*/
export const LANES_VIEW_NAME = 'Lanes'

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

/**
pecot が使わず、project init が confirm_delete で消すフィールド（消す順）
*/
export const UNUSED_FIELD_NAMES: readonly string[] = ['pecot-priority', 'pecot-size']

/**
`could not <action>` に API の失敗の文（と状態コード）を添えて、終了コード 1 で止める
*/
export function failApi(out: Readonly<Output>, action: string, error: Readonly<GitHubAPIError>): never {
  const detail = error.message
  const status = error.statusCode ?? 0
  return stopWith(out, status === 0 ? `could not ${action}: ${detail}` : `could not ${action} (status ${String(status)}): ${detail}`, kindOfFailure(error))
}

/**
Python の str() に当たる文字列。値が無いときは None
*/
export function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return 'None'
  return typeof value === 'string' ? value : pythonRepr(value)
}

// 進行の欄か（今の名前か、改名する前の名前）
function isWorkflowField(name: JsonValue | undefined): boolean {
  return typeof name === 'string' && (name === WORKFLOW_FIELD_NAME || isLegacyWorkflowFieldName(name))
}

/**
選択肢を持つフィールドの名前から、進行の欄の扱いを決める
*/
export function planWorkflowFieldOf(fields: readonly JsonValue[]): WorkflowFieldPlan {
  const names = fields.filter(field => isJsonObject(field) && Object.hasOwn(field, 'options')).map(field => jsonField(field, 'name')).filter(name => typeof name === 'string')
  return planWorkflowField(names)
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
  return stopWith(out, `project not found: ${name}\navailable projects:\n${titles}`, 'project-not-found')
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
  return stopWith(out, `${WORKFLOW_FIELD_NAME} field is missing options: ${missing.join(', ')}\nrequired options: Backlog / Pending / Ready / Active / In Review / Archived`, 'not-initialized')
}

function lowerName(option: JsonValue | undefined): string {
  const name = jsonField(option, 'name')
  return typeof name === 'string' ? name.toLowerCase() : ''
}

// 選択肢を持つ進行の欄。pecot-status を先に、無ければ改名する前の名前のもの
function findWorkflowField(fields: readonly JsonValue[]): JsonObject | undefined {
  const plan = planWorkflowFieldOf(fields)
  const name = plan.kind === 'rename' ? plan.from : plan.use
  return plan.kind === 'create' ? undefined : lastFieldNamed(fields, name)
}

async function fetchValidatedFields(out: Readonly<Output>, client: Readonly<GitHubClient>, target: Readonly<{ owner: string, name: string, host: string, number: number }>): Promise<ValidatedFields> {
  const { owner, name, host, number } = target
  const projectInfo = await client.getProjectFields(owner, number)
  if (projectInfo === undefined || !isTruthy(projectInfo)) return stopWith(out, `could not read project fields: ${name}`, 'not-initialized')
  const fields = fieldNodesOf(projectInfo)
  const workflowField = findWorkflowField(fields)
  if (workflowField === undefined) {
    return stopWith(
      out,
      hinted`project "${name}" has no ${WORKFLOW_FIELD_NAME} field
required field: ${WORKFLOW_FIELD_NAME} (Backlog/Pending/Ready/Active/In Review/Archived)
${RUN_COLON}${commandHint(['project', 'init'], { owner, name, host })}`,
      'not-initialized',
    )
  }
  const missing = missingRequiredOptions(workflowField)
  if (missing.length > 0) return stopMissingOptions(out, missing)
  const views = asArray(jsonField(jsonField(projectInfo, 'views'), 'nodes'))
  const viewNumber = jsonField(views.at(0), 'number')
  return { workflowField, fields, viewNumber }
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
const STATUS_KEYS: readonly KeyEntry[] = [keyEntry('Todo', true), keyEntry('In Progress', true), keyEntry(NEEDS_ATTENTION_SPEC.option.name, NEEDS_ATTENTION_SPEC.isOptional === true)]

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

function readConfigText(configPath: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 設定ディレクトリ配下のパス
  return readFileSync(configPath, 'utf8')
}

/**
設定ファイルの置き場所。movedFrom は新しい名前に移す、同じボードの旧い名前のファイル
*/
export interface ConfigPlacement {
  readonly configPath: string
  readonly movedFrom: string | undefined
}

/**
ボードの設定ファイルのパスと、移す元を決める。同じボードの旧いファイルが 2 つ以上あれば、何も書かずに止める
*/
export function placeProjectConfig(out: Readonly<Output>, board: Readonly<{ host: string, owner: string, number: number }>): ConfigPlacement {
  const directory = projectsDirectory()
  const { to, from } = planConfigMove(board, listProjectConfigEntries())
  if (from.length > 1) {
    const names = from.map(fileName => `- ${fileName}`).join('\n')
    return stopWith(out, `several config files point to project #${String(board.number)}:\n${names}\nremove all but one, then run again; it is moved to ${to}`, 'config-invalid')
  }
  const [only] = from
  return { configPath: path.join(directory, to), movedFrom: only === undefined ? undefined : path.join(directory, only) }
}

/**
旧い名前の設定ファイルを移す行。新しい名前は、`project` の入力と Actions の変数 PECOT_REVIEW_PROJECT にも使う
*/
export function reportConfigMove(out: Readonly<Output>, placement: Readonly<ConfigPlacement>, isDryRun: boolean): void {
  if (placement.movedFrom === undefined) return
  const operation: Operation = { verb: 'move', target: `config file ${placement.movedFrom} to ${placement.configPath}` }
  if (isDryRun) out.planned(operation)
  else out.done(operation)
  const name = path.parse(placement.configPath).name
  out.warning(`the project config is now named ${name}\nuse this name for the project input and the PECOT_REVIEW_PROJECT variable`)
}

/**
syncProjectConfig の結果。行に出した値と同じ。change は設定ファイルの扱い、activeProject はアクティブにした（dry-run では、する）設定の名前で、unchanged なら undefined。
movedFrom は、新しい名前に移した（dry-run では、移す）旧い名前の設定ファイル
*/
export interface SyncedProjectConfig {
  readonly configPath: string
  readonly change: 'create' | 'update' | 'unchanged'
  readonly activeProject: string | undefined
  readonly movedFrom: string | undefined
}

/**
GitHub Projects V2 の情報から設定ファイルを作るか更新し、アクティブにする。設定ファイルのパスと、行に出した扱いを返す。
pecot-workflow に合うプロジェクトだけを扱う。同じボードの旧い名前の設定ファイルは、新しい名前に移す。
skipIfUnchanged は、設定ファイルの内容が同じなら書かない。activateIfUnchanged を足すと、そのときもアクティブにする。isDryRun は読むだけで、書く操作を planned で出す
*/
export async function syncProjectConfig(
  out: Readonly<Output>,
  client: Readonly<GitHubClient>,
  target: Readonly<{ owner: string, name: string, host: string, skipIfUnchanged?: boolean | undefined, activateIfUnchanged?: boolean | undefined, isDryRun?: boolean | undefined }>,
): Promise<SyncedProjectConfig> {
  const { owner, name, host, skipIfUnchanged = false } = target
  const project = await findProjectByTitle(out, client, owner, name)
  const number = requireNumber(project['number'], 'project.number')
  const { workflowField, fields, viewNumber } = await fetchValidatedFields(out, client, { owner, name, host, number })

  const placement = placeProjectConfig(out, { host, owner, number })
  const { configPath, movedFrom } = placement
  const existing = loadExistingConfig(configPath) ?? (movedFrom === undefined ? undefined : loadConfig(movedFrom))

  const linked = await client.getLinkedRepositories(owner, number)
  const statusField = lastFieldNamed(fields, STATUS_FIELD_NAME)
  const config: ProjectConfig = {
    host,
    owner,
    project: {
      number,
      id: requireString(project['id'], 'project.id'),
      board_url: buildBoardUrl(typeof project['url'] === 'string' ? project['url'] : '', workflowField, viewNumber),
      fields: {
        workflow: fieldOptionsConfig(workflowField, WORKFLOW_KEYS),
        status: statusField === undefined ? undefined : fieldOptionsConfig(statusField, STATUS_KEYS),
      },
    },
    repositories: buildRepositories(linked, existing?.repositories ?? []),
    aggregation_repo: existing?.aggregation_repo,
  }

  // 読み直して保存と同じ形にそろえ、ファイルの生の文字列と比べる。読み捨てたキーが残るファイルは書き直す
  const normalized = parseProjectConfig(parseJsonText(serializeProjectConfig(config)))
  const activeProject = path.parse(configPath).name
  if (skipIfUnchanged && movedFrom === undefined && existing !== undefined && readConfigText(configPath) === serializeProjectConfig(normalized)) {
    out.planned({ verb: 'unchanged', target: `config file ${configPath}` })
    if (target.activateIfUnchanged !== true) return { configPath, change: 'unchanged', activeProject: undefined, movedFrom }
    if (target.isDryRun === true) out.planned({ verb: 'set', target: `active project to ${activeProject}` })
    else {
      setActiveConfig(configPath)
      out.done({ verb: 'set', target: `active project to ${activeProject}` })
    }
    return { configPath, change: 'unchanged', activeProject, movedFrom }
  }
  const verb = existing === undefined ? 'create' : 'update'
  if (target.isDryRun === true) {
    reportConfigMove(out, placement, true)
    out.planned({ verb, target: `config file ${configPath}` })
    out.planned({ verb: 'set', target: `active project to ${activeProject}` })
    return { configPath, change: verb, activeProject, movedFrom }
  }
  saveConfig(config, configPath)
  if (movedFrom !== undefined) removeConfig(movedFrom)
  reportConfigMove(out, placement, false)
  out.done({ verb, target: `config file ${configPath}` })
  setActiveConfig(configPath)
  out.done({ verb: 'set', target: `active project to ${activeProject}` })
  return { configPath, change: verb, activeProject, movedFrom }
}
