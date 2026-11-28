// project の各コマンドが共有する部分。失敗の行、フィールドの検証、読んだボードからの設定ファイルの同期。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { parseProjectConfig, serializeProjectConfig, WORKFLOW_FIELD_NAME } from '../domain/config.js'
import type { FieldOptions, ProjectConfig, Repository } from '../domain/config.js'
import { isJsonObject, jsonField, parseJsonText } from '../domain/json.js'
import type { JsonObject } from '../domain/json.js'
import { planConfigMove, planWorkflowField } from '../domain/migration.js'
import type { WorkflowFieldPlan } from '../domain/migration.js'
import { pythonRepr } from '../domain/python-format.js'
import type { JsonValue } from '../domain/python-format.js'
import { listProjectConfigEntries, loadConfig, projectsDirectory, removeConfig, saveConfig, setActiveConfig } from '../infra/config-store.js'
import type { GitHubAPIError } from '../infra/github/errors.js'
import { asArray, isTruthy, requireString } from '../infra/github/payload.js'
import { commandHint, hinted, RUN_COLON } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import type { Operation, Output } from './output.js'
import { NEEDS_ATTENTION_SPEC, STATUS_FIELD_NAME, WORKFLOW_FIELD_SPECS } from './workflow-fields.js'

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

/**
選択肢を持つフィールドの名前から、進行の欄の扱いを決める
*/
export function planWorkflowFieldOf(fields: readonly JsonValue[]): WorkflowFieldPlan {
  const names = fields.filter(field => isJsonObject(field) && Object.hasOwn(field, 'options')).map(field => jsonField(field, 'name')).filter(name => typeof name === 'string')
  return planWorkflowField(names)
}

/**
プロジェクトの情報から fields.nodes を取る
*/
export function fieldNodesOf(projectInfo: JsonObject): readonly JsonValue[] {
  return asArray(jsonField(jsonField(projectInfo, 'fields'), 'nodes'))
}

/**
読んだボード。fields は GraphQL の形（id は node ID、databaseId は数の ID、options は {id, name}）
*/
export interface BoardSnapshot {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly url: string
  readonly fields: readonly JsonValue[]
  /**
  最初のビューの番号。読めなければ undefined
  */
  readonly viewNumber: number | undefined
}

/**
workflow フィールドに足りない必須の選択肢（要る順。optional は数えない。名前は大文字と小文字を区別しない）
*/
export function missingRequiredOptions(field: Readonly<JsonObject>): readonly string[] {
  const existing = new Set(asArray(field['options']).map(option => lowerName(option)))
  return WORKFLOW_FIELD_SPECS.filter(spec => spec.isOptional !== true && !existing.has(spec.option.name.toLowerCase())).map(spec => spec.option.name)
}

function stopMissingOptions(out: Readonly<Output>, missing: readonly string[]): never {
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

/**
ボードの欄を直し、設定ファイルに読み直す手順の案内。owner と number が分かれば添える
*/
export function boardFieldsHint(board?: Readonly<{ owner: string, number: number }>): HintedText {
  const check = board === undefined ? { method: 'fields' } : { method: 'fields', owner: board.owner, project: board.number }
  const activate = board === undefined ? {} : { project: String(board.number), owner: board.owner }
  return hinted`${commandHint(['project', 'check'], check)} and apply the changes it asks for with the project-fields operation of github-ops, then ${commandHint(['project', 'activate'], activate)} to read the board into the project config`
}

/**
ボードの進行の欄が pecot の決まりに合うかを確かめ、合えばその欄を返す。合わなければ、直し方を添えて止める
*/
export function requireWorkflowField(out: Readonly<Output>, board: Readonly<BoardSnapshot>, owner: string): JsonObject {
  const workflowField = findWorkflowField(board.fields)
  if (workflowField === undefined) {
    return stopWith(
      out,
      hinted`project "${board.title}" has no ${WORKFLOW_FIELD_NAME} field
required field: ${WORKFLOW_FIELD_NAME} (Backlog/Pending/Ready/Active/In Review/Archived)
${RUN_COLON}${boardFieldsHint({ owner, number: board.number })}`,
      'not-initialized',
    )
  }
  const missing = missingRequiredOptions(workflowField)
  return missing.length > 0 ? stopMissingOptions(out, missing) : workflowField
}

// urllib.parse.quote(text) と同じ。`/` と `_.-~` は残し、それ以外は %XX にする
function quote(text: string): string {
  return encodeURIComponent(text)
    .replaceAll(/[!'()*]/gu, character => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`)
    .replaceAll('%2F', '/')
}

function buildBoardUrl(projectUrl: string, workflowField: JsonObject, viewNumber: number | undefined): string {
  const databaseId = workflowField['databaseId']
  // 空白入りの値（In Review）を末尾に置く（URL の解析の誤りを避ける）
  const present = new Set(asArray(workflowField['options']).map(option => lowerName(option)))
  const names = WORKFLOW_FIELD_SPECS.filter(spec => spec.isOptional !== true || present.has(spec.option.name.toLowerCase())).map(spec => spec.option.name)
  const plain = names.filter(name => !name.includes(' '))
  const spaced = names.filter(name => name.includes(' '))
  const values = [...plain, ...spaced]
  const statusValues = values.map(value => value.includes(' ') ? `"${value}"` : value).join(',')
  const filterQuery = quote(` ${textOf(workflowField['name'])}:${statusValues}`)
  return viewNumber !== undefined && viewNumber !== 0 && isTruthy(databaseId) ? `${projectUrl}/views/${String(viewNumber)}?layout=board&verticalGroupedBy%5BcolumnId%5D=${textOf(databaseId)}&filterQuery=${filterQuery}` : `${projectUrl}?filterQuery=${filterQuery}`
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
読んだボードから設定ファイルを作るか更新し、アクティブにする。設定ファイルのパスと、行に出した扱いを返す。
pecot-workflow に合うボードだけを扱う。リポジトリの一覧は既存の設定から引き継ぐ（公式の MCP はボードにリンクしたリポを読めない）。
同じボードの旧い名前の設定ファイルは、新しい名前に移す。
skipIfUnchanged は、設定ファイルの内容が同じなら書かない。activateIfUnchanged を足すと、そのときもアクティブにする。isDryRun は読むだけで、書く操作を planned で出す
*/
export function syncProjectConfig(
  out: Readonly<Output>,
  board: Readonly<BoardSnapshot>,
  target: Readonly<{ owner: string, host: string, skipIfUnchanged?: boolean | undefined, activateIfUnchanged?: boolean | undefined, isDryRun?: boolean | undefined }>,
): SyncedProjectConfig {
  const { owner, host, skipIfUnchanged = false } = target
  const { number } = board
  const workflowField = requireWorkflowField(out, board, owner)

  const placement = placeProjectConfig(out, { host, owner, number })
  const { configPath, movedFrom } = placement
  const existing = loadExistingConfig(configPath) ?? (movedFrom === undefined ? undefined : loadConfig(movedFrom))

  const statusField = lastFieldNamed(board.fields, STATUS_FIELD_NAME)
  const config: ProjectConfig = {
    host,
    owner,
    project: {
      number,
      id: board.id,
      board_url: buildBoardUrl(board.url, workflowField, board.viewNumber),
      fields: {
        workflow: fieldOptionsConfig(workflowField, WORKFLOW_KEYS),
        status: statusField === undefined ? undefined : fieldOptionsConfig(statusField, STATUS_KEYS),
      },
    },
    repositories: (existing?.repositories ?? []).map(repository => buildRepository(repository)),
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
