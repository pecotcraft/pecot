/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// issue 系のコマンドが共有する関数と定数。cli/commands/issue.py の移植。
// typer.Exit(n) に当たるのは throwExit(n)（CommandExit）。BadParameter は、run の本体を包む runWithExit が受ける。
import path from 'node:path'

import { z } from 'zod'

import { aggregationRepositoryReference, isRepositoryInProject } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { BaseError } from '../domain/errors.js'
import { CommandExit } from './command-definition.js'
import type { IssueFrontmatter } from '../domain/frontmatter.js'
import { pythonStrip } from '../domain/python-format.js'
import { issueReferenceToCliReference, parseIssueReference, ReferenceParseError } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { AmbiguousRepositoryError, createRepositoryReference, resolveRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import {
  CLOSED_HEADINGS_BY_TEMPLATE,
  FOLD_SUMMARY_BY_TEMPLATE,
  validateBodyStyle,
  validateClosedHeadings,
  validateFoldBalance,
  validateFoldSummaries,
  validateHeadingSummaries,
  validateSections,
} from '../domain/sections.js'
import type { JsonObject } from '../domain/json.js'
import { loadActiveConfig } from '../infra/config-store.js'
import { gitRunnerFor } from '../infra/git.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { GitHubClient } from '../infra/github/index.js'
import { requireNumber, requireString } from '../infra/github/payload.js'
import { readTemplateSections, templateFile } from '../infra/template-store.js'
import { addIssueToBoard, createIssue, setIssueField } from './issue-board.js'
import type { BoardItem } from './issue-board.js'
import type { Output } from './output.js'
import { USAGE_EXIT_CODE, UsageError } from './usage-error.js'

export type IssueType = IssueFrontmatter['type']

/**
issue comment のテンプレ検証失敗の終了コード。通信失敗・設定なし・引数不足の 1 と区別し、hooks がこの値で分岐する
*/
export const COMMENT_VALIDATION_EXIT_CODE = 3

/**
Issue 種別の入力。issue create と issue quick が共有する
*/
export const ISSUE_TYPE_SCHEMA = z.enum(['task', 'bug', 'epic', 'tracker']).default('task').describe('Issue type (task/bug/epic/tracker)')

export const PARENT_EPIC_DESCRIPTION = 'Parent Epic reference: an integer (relative to aggregation_repo) or the primary form \'owner/repo/N\''

export const ISSUE_REF_DESCRIPTION = 'Issue reference (`owner/repo/N`, or the short form `N` in the repository of `--repo`, or else of the git remote of the current directory)'

export const VALID_STATUSES: ReadonlySet<string> = new Set(['backlog', 'pending', 'ready', 'active', 'in_review', 'archived'])

/**
Issue 種別 → タイトルの接頭辞
*/
const TYPE_PREFIX_MAP: ReadonlyMap<string, string> = new Map([
  ['task', '[Task]'],
  ['bug', '[Bug]'],
  ['epic', '[Epic]'],
  ['tracker', '[Tracker]'],
])

/**
起票時の status は、型対応テンプレートの既定値だけを受ける。pending / archived への配置はボード上の手動操作
*/
export const TYPE_DEFAULT_STATUS: Readonly<Record<IssueType, string>> = { epic: 'backlog', tracker: 'backlog', task: 'ready', bug: 'ready' }

/**
Backlog に置く型（quick の status / size / quick フラグの扱いが Epic と同じ）
*/
export const BACKLOG_TYPES: ReadonlySet<string> = new Set(['epic', 'tracker'])

// --- 終了の表し方 ---

/**
引数の値が不正。Python の typer.BadParameter。呼ぶ側が受けない場合は、runWithExit が使い方の誤り（終了コード 2）にする
*/
class BadParameterError extends BaseError {}

/**
終了コード code で、コマンドを終える。error の行は先に出しておく
*/
export function throwExit(code: number): never {
  throw new CommandExit(code)
}

/**
run の本体を包む。終わったら 0 を返す。BadParameterError は使い方の誤りにして伝える。
それ以外の例外はそのまま伝える。CommandExit は defineCommand が受けて終了コードにする
*/
export async function runWithExit(body: () => Promise<void>): Promise<number> {
  try {
    await body()
    return 0
  }
  catch (error: unknown) {
    if (error instanceof BadParameterError) throw new UsageError(`Invalid value: ${error.message}`)
    throw error
  }
}

// --- 設定・クライアント ---

/**
アクティブなプロジェクトの設定。無ければ `no active project` を出して終了コード 1
*/
export function loadConfigOrExit(output: Output): ProjectConfig {
  const config = loadActiveConfig()
  if (config === undefined) {
    output.error('no active project')
    throwExit(1)
  }
  return config
}

/**
設定のホストへつなぐ GitHub クライアント。トークンの切り替えの案内は output に出る
*/
export function createClient(config: ProjectConfig, output: Output): GitHubClient {
  return new GitHubClient({ host: config.host, diagnostics: output })
}

// --- Issue 参照 ---

/**
`owner/repo/N` の表記。エラー文と done の行の対象に使う
*/
export function issuePath(owner: string, repository: string, number: number): string {
  return `${owner}/${repository}/${String(number)}`
}

export interface IssueTarget {
  readonly owner: string
  readonly repository: string
  readonly number: number
}

/**
グローバルの --repo（run の入力の repo）か、カレントの git から base のリポジトリを決める。
曖昧なら undefined（`owner/repo/N` の主軸形を使う利用者のため）。--repo の形式が不正なら InvalidValueError を伝える
*/
function resolveBaseRepository(repository: string | undefined): RepositoryReference | undefined {
  try {
    return resolveRepository(repository, gitRunnerFor()).repository
  }
  catch (error: unknown) {
    if (error instanceof AmbiguousRepositoryError) return undefined
    throw error
  }
}

/**
Issue 参照（`owner/repo/N` または短縮形 `N`）を分ける。不正、または base が決まらない短縮形なら BadParameterError
*/
function parseIssueReferenceFromContext(repository: string | undefined, raw: string): IssueTarget {
  const base = resolveBaseRepository(repository)
  try {
    const reference = parseIssueReference(raw, base, { repositoryFlag: true })
    return { owner: reference.repository.owner, repository: reference.repository.repository, number: reference.number }
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) throw new BadParameterError(error.message)
    throw error
  }
}

/**
parseIssueReferenceFromContext の失敗を、error の行と終了コード 2 にしたもの
*/
export function parseIssueReferenceOrExit(output: Output, repository: string | undefined, raw: string): IssueTarget {
  try {
    return parseIssueReferenceFromContext(repository, raw)
  }
  catch (error: unknown) {
    if (!(error instanceof BadParameterError)) throw error
    output.error(error.message)
    return throwExit(USAGE_EXIT_CODE)
  }
}

// --- status ---

/**
不正な status と、有効な値を出して終了コード 1
*/
export function exitInvalidStatus(output: Output, status: string): never {
  output.error(`invalid status: ${status}\nvalid values: backlog/pending/ready/active/in_review/archived`)
  return throwExit(1)
}

/**
起票時の status が、型対応テンプレートの既定値と一致するか確かめる。違えば終了コード 1。
enum 外の値（`--status foo`）と、型に合わない別テンプレートの既定値（`--type bug --status backlog`）は文を分ける
*/
export function validateStatusForType(output: Output, issueType: IssueType, status: string): void {
  if (!VALID_STATUSES.has(status)) exitInvalidStatus(output, status)
  // eslint-disable-next-line security/detect-object-injection -- issueType は列挙型
  const expected = TYPE_DEFAULT_STATUS[issueType]
  if (status === expected) return
  output.error(`the status at creation for type '${issueType}' is only '${expected}' (given: ${status})\nhint: move it to pending or another status on the board after creation`)
  throwExit(1)
}

// --- parent_epic・タイトル・order ---

/**
CLI のオプションで来た parent_epic。空・空白だけなら undefined、数字だけなら整数（安全な整数を超えるなら数字の文字列）、それ以外は文字列
*/
export function normalizeParentEpicCli(raw: string | undefined): number | string | undefined {
  if (raw === undefined) return undefined
  const stripped = pythonStrip(raw)
  if (stripped === '') return undefined
  if (!/^\d+$/u.test(stripped)) return stripped
  const value = Number(stripped)
  // 安全な整数に収まらない数字は、丸めずに文字列のまま返す（先頭の 0 は Python の int() と同じく落とす）
  return Number.isSafeInteger(value) ? value : stripped.replace(/^0+(?=\d)/u, '')
}

/**
parent_epic を Issue 参照にする。整数は aggregation_repo の Issue（未設定なら task のリポジトリ）、`owner/repo/N` はそのまま。
解決できなければ BadParameterError。番号が安全な整数を超える参照は、丸めずに解決できない参照として扱う
*/
export function resolveParentEpicReference(raw: number | string, config: ProjectConfig, taskOwner: string, taskRepository: string): IssueReference {
  const base = aggregationRepositoryReference(config) ?? createRepositoryReference(taskOwner, taskRepository)
  try {
    if (typeof raw === 'string' && /^\d+$/u.test(raw) && !Number.isSafeInteger(Number(raw))) {
      throw new ReferenceParseError(`the number is too large: ${raw}`, raw)
    }
    return parseIssueReference(String(raw), base)
  }
  catch (error: unknown) {
    if (!(error instanceof ReferenceParseError)) throw error
    throw new BadParameterError(`could not resolve parent_epic: ${error.message}\naccepted forms: an integer (Issue number in aggregation_repo) or the primary form 'owner/repo/N'`)
  }
}

export interface EpicTarget {
  readonly repository: string
  /**
  --repo が aggregation_repo と違う例外なので、warnEpicRepositoryException を出す
  */
  readonly needsWarning: boolean
}

/**
Epic を作るリポジトリを、aggregation_repo の方針で決める。
repository が空で aggregation_repo も未設定なら、決められないので終了コード 2
*/
export function resolveEpicTargetRepository(output: Output, repository: string | undefined, config: ProjectConfig): EpicTarget {
  const stripped = repository === undefined ? '' : pythonStrip(repository)
  const explicit = stripped === '' ? undefined : stripped
  const aggregation = config.aggregation_repo
  if (explicit === undefined) {
    if (aggregation === undefined) {
      output.error('cannot decide where to create the Epic\ndeclare aggregation_repo in the project config, or pass --repo')
      throwExit(USAGE_EXIT_CODE)
    }
    return { repository: aggregation, needsWarning: false }
  }
  return { repository: explicit, needsWarning: aggregation !== undefined && explicit !== aggregation }
}

/**
Epic の作成先が aggregation_repo と違うときの警告
*/
export function warnEpicRepositoryException(output: Output, resolvedRepository: string, config: ProjectConfig): void {
  output.warning(`--repo ${resolvedRepository} differs from aggregation_repo (${String(config.aggregation_repo)})\ncontinuing as an exception for an Epic in an implementation repo`)
}

export interface IssueTitleOptions {
  readonly parentEpic?: number | undefined
  readonly order?: number | undefined
  /**
  同じ段の中の枝の文字（a-z）。order が無ければ使わない
  */
  readonly parallel?: string | undefined
}

/**
タイトルに接頭辞と、Epic 番号・order（・枝の文字）を付ける。例は `[Task] #353-04a: タイトル`
*/
export function buildIssueTitle(issueType: string, title: string, options: Readonly<IssueTitleOptions> = {}): string {
  const prefix = TYPE_PREFIX_MAP.get(issueType) ?? ''
  const hasPrefix = prefix !== '' && title.startsWith(prefix)
  const baseTitle = hasPrefix ? pythonStrip(title.slice(prefix.length)) : title
  if (options.parentEpic !== undefined && options.order !== undefined) {
    const number = `#${String(options.parentEpic)}-${orderLabel(options.order, options.parallel)}`
    return prefix === '' ? `${number}: ${baseTitle}` : `${prefix} ${number}: ${baseTitle}`
  }
  return prefix === '' || hasPrefix ? title : `${prefix} ${title}`
}

/**
エラー文に出す番号。2 桁の order に、枝の文字を続ける
*/
function orderLabel(order: number, parallel = ''): string {
  return `${String(order).padStart(2, '0')}${parallel}`
}

// タイトルの `#123-01:` と `#123-01a:` から、Epic 番号・段・枝を取る
const ORDER_PATTERN = /#(\d+)-(\d+)([a-z])?:/u

const LOWERCASE_LETTERS: readonly string[] = Array.from({ length: 26 }, (_, index) => String.fromCodePoint(97 + index))

interface UsedOrder {
  readonly number: number
  readonly stage: number
  readonly title: string
  readonly state: string
  readonly parallel: string | undefined
}

function usedOrdersOf(subIssues: readonly { readonly number: number, readonly state: string, readonly title: string }[], parentEpic: number): { readonly orders: readonly UsedOrder[], readonly values: readonly number[] } {
  const orders: UsedOrder[] = []
  const values: number[] = []
  for (const sub of subIssues) {
    const [, epic, stage, letter] = ORDER_PATTERN.exec(sub.title) ?? []
    if (epic === undefined || stage === undefined || Number(epic) !== parentEpic) continue
    values.push(Number(stage))
    orders.push({ ...sub, stage: Number(stage), parallel: letter })
  }
  return { orders, values }
}

/**
同じ Epic に、同じ（段, 枝の文字）の Issue が無いことを確かめる。OPEN でも CLOSED でも、一度使った番号は再利用できない。
同じ段では、枝ありと枝なしも重複。最初の一致を error にして終了コード 1。Epic を取れなければ warning だけで続ける
*/
export async function checkDuplicateOrder(
  output: Output,
  client: GitHubClient,
  owner: string,
  repository: string,
  parentEpic: number,
  order: number,
  parallel?: string,
): Promise<void> {
  let subIssues
  try {
    const slim = await client.getIssueSlim(owner, repository, parentEpic, 0)
    subIssues = slim.sub_issues
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(`could not fetch the parent Epic #${String(parentEpic)}: ${error.message}`)
    return
  }
  const used = usedOrdersOf(subIssues, parentEpic)
  const sameOrder = used.orders.filter(sub => sub.stage === order)
  const duplicate = sameOrder.find(sub => sub.parallel === undefined || parallel === undefined || sub.parallel === parallel)
  if (duplicate === undefined) return

  const usedValues = new Set(used.values)
  let nextOrder = 1
  while (usedValues.has(nextOrder)) nextOrder += 1
  let conflict: string
  let suggestion: string
  if (parallel === undefined && duplicate.parallel === undefined) {
    conflict = `an Issue with order=${String(order)}`
    suggestion = `next available order: ${String(nextOrder)}`
  }
  else {
    const usedLetters = new Set(sameOrder.map(sub => sub.parallel))
    const letter = LOWERCASE_LETTERS.find(candidate => !usedLetters.has(candidate))
    suggestion = letter === undefined || usedLetters.has(undefined)
      ? `next available order: ${String(Math.max(...usedValues) + 1)}`
      : `next available number: ${orderLabel(order, letter)}`
    conflict = `an Issue (${orderLabel(order, duplicate.parallel)}) that conflicts with order=${orderLabel(order, parallel)}`
  }
  const stateLabel = duplicate.state === 'OPEN' ? 'OPEN' : 'CLOSED'
  output.error(`Epic #${String(parentEpic)} already has ${conflict} (${stateLabel})\n#${String(duplicate.number)} ${duplicate.title}\n${suggestion}`)
  throwExit(1)
}

// --- Issue の作成・ボード・親 Epic ---

/**
Issue を作り、`created:` の行を出して API の応答を返す。失敗は error の行と終了コード 1。
source は作成元のファイル名（`from <source>` として行の末尾に付く）
*/
export async function createIssueOrExit(
  output: Output,
  client: GitHubClient,
  owner: string,
  repository: string,
  title: string,
  body: string,
  labels: readonly string[] | undefined,
  source?: string,
): Promise<JsonObject> {
  let issue: JsonObject
  try {
    issue = await createIssue(client, owner, repository, title, body, labels)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.error(`could not create an Issue in ${owner}/${repository}: ${error.message}`)
    return throwExit(1)
  }
  const target = `Issue ${issuePath(owner, repository, requireNumber(issue['number'], 'number'))}`
  output.done({ verb: 'create', target: source === undefined || source === '' ? target : `${target} from ${source}` })
  return issue
}

export interface IssueSummary {
  readonly number: number
  readonly url: string
  /**
  作成の応答に node_id が無ければ undefined
  */
  readonly nodeId: string | undefined
}

/**
Issue の作成の応答から、番号・URL・node id を取る
*/
export function summarizeCreatedIssue(issue: JsonObject): IssueSummary {
  const nodeId = issue['node_id']
  return {
    number: requireNumber(issue['number'], 'number'),
    url: requireString(issue['html_url'], 'html_url'),
    nodeId: typeof nodeId === 'string' ? nodeId : undefined,
  }
}

/**
Issue をボードへ追加する。失敗は warning と Issue の URL を出して undefined
*/
export async function addToBoardOrWarn(
  output: Output,
  client: GitHubClient,
  config: ProjectConfig,
  owner: string,
  repository: string,
  issueNumber: number,
  issueNodeId: string | undefined,
  issueUrl: string,
): Promise<BoardItem | undefined> {
  let added: BoardItem
  try {
    added = await addIssueToBoard(client, config, owner, repository, issueNumber, issueNodeId)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.warning(`could not add Issue ${issuePath(owner, repository, issueNumber)} to project: ${error.message}`)
    output.data(issueUrl)
    return undefined
  }
  output.done({ verb: 'add', target: `Issue ${issuePath(owner, repository, issueNumber)} to project` })
  return added
}

export interface IssueField {
  readonly fieldName: string
  readonly optionName: string
  /**
  `set:` の行に出す名前
  */
  readonly label: string
}

/**
カスタムフィールドを順に設定し、設定できた分を 1 行の set にする。失敗したフィールドは、何も出さずに飛ばす
*/
export async function setIssueFields(
  output: Output,
  client: GitHubClient,
  config: ProjectConfig,
  itemId: string,
  target: string,
  fields: readonly IssueField[],
): Promise<void> {
  const labels: string[] = []
  for (const { fieldName, optionName, label } of fields) {
    try {
      if (await setIssueField(client, config, itemId, fieldName, optionName)) labels.push(label)
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
    }
  }
  if (labels.length > 0) output.done({ verb: 'set', target: `${target} ${labels.join(', ')}` })
}

/**
親 Epic のサブ Issue にする。失敗は Issue の URL、error の行の順に出して終了コード 1
*/
export async function linkToParentEpic(
  output: Output,
  client: GitHubClient,
  target: string,
  parentReference: IssueReference,
  issueNodeId: string,
  issueUrl: string,
): Promise<void> {
  const parent = issueReferenceToCliReference(parentReference)
  try {
    const parentNodeId = await client.getIssueNodeId(parentReference.repository.owner, parentReference.repository.repository, parentReference.number)
    await client.addSubIssue(parentNodeId, issueNodeId)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    output.data(issueUrl)
    output.error(`could not add ${target} as sub-issue of ${parent}: ${error.message}`)
    throwExit(1)
  }
  output.done({ verb: 'add', target: `${target} as sub-issue of ${parent}` })
}

/**
リポジトリがプロジェクトにリンクされていなければ、message を error に出して終了コード 1
*/
export async function ensureRepositoryInProject(output: Output, config: ProjectConfig, client: GitHubClient, owner: string, repository: string, message: string): Promise<void> {
  if (await isRepositoryInProject(config, owner, repository, client)) return
  output.error(message)
  throwExit(1)
}

/**
起票用のクライアントを作り、リポジトリのリンクと、親 Epic のリポジトリでの order の重複を確かめる
*/
export async function clientForIssueCreate(
  output: Output,
  config: ProjectConfig,
  owner: string,
  repository: string,
  display: string,
  parentReference: IssueReference | undefined,
  order: number | undefined,
  parallel?: string,
): Promise<GitHubClient> {
  const client = createClient(config, output)
  await ensureRepositoryInProject(output, config, client, owner, repository, `${display} is not linked to the project`)
  if (parentReference !== undefined && order !== undefined) {
    await checkDuplicateOrder(output, client, parentReference.repository.owner, parentReference.repository.repository, parentReference.number, order, parallel)
  }
  return client
}

// --- テンプレートの検証 ---

/**
本文をテンプレートと比べ、違反を 1 つの error にして出す。違反があれば true。
1 行目はテンプレートのパス。続く行に、違反のある種類だけを並べる
*/
export function hasReportedTemplateViolations(output: Output, body: string, templatePath: string, options: { readonly emDashHint?: boolean } = {}): boolean {
  const required = readTemplateSections(templatePath)
  const missing = required.length > 0 ? validateSections(body, required) : []
  const summaryErrors = required.length > 0 ? validateHeadingSummaries(body, required) : []
  const styleErrors = validateBodyStyle(body)
  const stem = path.basename(templatePath, path.extname(templatePath))
  const closedGuidance = CLOSED_HEADINGS_BY_TEMPLATE.get(stem)
  const foldErrors = closedGuidance === undefined ? [] : [...validateFoldBalance(body)]
  const extraHeadings = closedGuidance !== undefined && required.length > 0 ? validateClosedHeadings(body, required) : []
  const foldSummary = FOLD_SUMMARY_BY_TEMPLATE.get(stem)
  if (foldSummary !== undefined) foldErrors.push(...validateFoldSummaries(body, foldSummary))
  if (missing.length === 0 && summaryErrors.length === 0 && styleErrors.length === 0 && foldErrors.length === 0 && extraHeadings.length === 0) return false

  const lines = [`the body does not follow the template ${templatePath}`]
  if (missing.length > 0) {
    lines.push(`missing sections: ${missing.join(', ')}`)
    if (options.emDashHint === true && missing.some(section => section.includes(' — <'))) {
      lines.push('hint: the em dash must be U+2014; hyphen-minus (-) and EN DASH (U+2013) are not allowed')
    }
  }
  if (summaryErrors.length > 0) lines.push(`heading summary rule violations: ${summaryErrors.join(', ')}`)
  if (styleErrors.length > 0) lines.push(`unusable notation: ${styleErrors.join(', ')}`)
  if (foldErrors.length > 0) lines.push(`collapse rule violations: ${foldErrors.join(', ')}`)
  if (extraHeadings.length > 0) lines.push(`headings not in the template: ${extraHeadings.join(', ')} (${String(closedGuidance)})`)
  output.error(lines.join('\n'))
  return true
}

/**
Issue 本文を種別のテンプレートと比べる。違反があれば error を出して終了コード 1
*/
export function validateIssueTemplate(output: Output, templateType: NonNullable<IssueFrontmatter['template']>, body: string): void {
  if (hasReportedTemplateViolations(output, body, templateFile('issue', templateType), { emDashHint: true })) throwExit(1)
}
