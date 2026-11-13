// 出力フォーマット関数。ボード表示や Issue 一覧の整形を担当する。
//
// 入力は GitHub の GraphQL 応答（JSON）をそのまま受ける。
// 入力の読み取りでは、キーが無いことと null を同じ「無い」として扱う。
// transformItems の出力では、無い値を JSON_NULL にする。Python の CLI の JSON と同じ null が出る。

import { JSON_NULL } from './json-null.js'
import { isJsonObject, jsonField } from './json.js'
import type { JsonObject } from './json.js'
import { isJsonArray, pythonRepr } from './python-format.js'
import type { JsonValue } from './python-format.js'

// ステータスマッピング（表示ラベル → マッチパターン）
const STATUS_PATTERNS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Active', ['Active']],
  ['In Review', ['In Review']],
  ['Blocked', ['Blocked']],
  ['Ready', ['Ready']],
  ['Pending', ['Pending']],
  ['Backlog', ['Backlog']],
  ['Archived', ['Archived']],
])

// 表示順序
const STATUS_ORDER: readonly string[] = ['Active', 'In Review', 'Blocked', 'Ready', 'Pending', 'Backlog', 'Archived']

// Archived は直近これだけ表示する
const ARCHIVED_DISPLAY_LIMIT = 5

/**
transformItems の出力。formatBoardOutput は、欠けたキーを既定値で補って読む
*/
export interface BoardItem {
  readonly id?: JsonValue | undefined
  readonly workflow?: string | null | undefined
  readonly title?: JsonValue | undefined
  readonly updatedAt?: JsonValue | undefined
  readonly content: {
    readonly number?: JsonValue | undefined
    readonly state?: JsonValue | undefined
    readonly url?: JsonValue | undefined
    readonly labels?: readonly string[] | undefined
    readonly repository?: string | undefined
  }
}

/**
一覧の応答から読む、着手の判定の軽い入力。JSON の出力には出さない
*/
export interface BoardProgress {
  readonly issueType: string | undefined
  readonly subIssues: number
  /**
  親の Issue。無ければ undefined
  */
  readonly parent: { readonly repository: string, readonly number: number } | undefined
  /**
  前提の件数。応答に無ければ undefined
  */
  readonly blockedBy: number | undefined
  /**
  Status の値（札）
  */
  readonly label: string | undefined
}

// 辞書の値を取る（辞書でなければ undefined）。null は無いものとして扱う
function member(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return jsonField(value, key) ?? undefined
}

// `nodes` の配列を取る（無ければ空）
function nodesMember(value: JsonValue | undefined): readonly JsonValue[] {
  const found = member(value, 'nodes')
  return isJsonArray(found) ? found : []
}

function stringMember(value: JsonValue | undefined, key: string): string {
  const found = member(value, key)
  return typeof found === 'string' ? found : ''
}

// Python の真偽判定で偽になる値（null・false・0・空文字・空の配列・空の辞書）
function isEmptyValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return isJsonObject(value) && Object.keys(value).length === 0
}

/**
GraphQL の戻り値から Workflow ステータスを抽出する。
フィールド名は大文字小文字を区別しない。見つからなければ undefined。
名前が一致したノードを最初に見つけた時点で、その値（無ければ undefined）を返す
*/
export function extractWorkflowStatus(item: JsonObject, workflowFieldName: string): string | undefined {
  const nodes = nodesMember(member(item, 'fieldValues'))
  for (const node of nodes) {
    if (isEmptyValue(node)) continue
    if (stringMember(member(node, 'field'), 'name').toLowerCase() === workflowFieldName.toLowerCase()) {
      const name = member(node, 'name')
      return typeof name === 'string' ? name : undefined
    }
  }
  return undefined
}

// ラベルを抽出する（名前があり、空でないものだけ）
function extractLabels(content: JsonValue | undefined): readonly string[] {
  const labels: string[] = []
  const nodes = nodesMember(member(content, 'labels'))
  for (const node of nodes) {
    const name = isEmptyValue(node) ? undefined : member(node, 'name')
    if (typeof name === 'string' && name !== '') labels.push(name)
  }
  return labels
}

// リポジトリ情報を `owner/name` にする（どちらかが欠ければ空文字）
function extractRepository(content: JsonValue | undefined): string {
  const repository = member(content, 'repository')
  const owner = stringMember(member(repository, 'owner'), 'login')
  const name = stringMember(repository, 'name')
  return owner === '' || name === '' ? '' : `${owner}/${name}`
}

// キーが無いとき空文字になる値を取る
function memberOrEmpty(value: JsonValue | undefined, key: string): JsonValue {
  return member(value, key) ?? ''
}

// 表に出す文字列（文字列はそのまま、他の値は Python の str と同じ書き方）
function displayText(value: JsonValue): string {
  return typeof value === 'string' ? value : pythonRepr(value)
}

/**
GraphQL の戻り値をフォーマット用の形式に変換する。
Draft Issue など content が無いアイテムは除く
*/
export function transformItems(rawItems: readonly JsonObject[], workflowFieldName: string): readonly BoardItem[] {
  const transformed: BoardItem[] = []
  for (const item of rawItems) {
    const content = member(item, 'content')
    if (isEmptyValue(content)) continue
    transformed.push({
      id: memberOrEmpty(item, 'id'),
      workflow: extractWorkflowStatus(item, workflowFieldName) ?? JSON_NULL,
      title: memberOrEmpty(content, 'title'),
      updatedAt: memberOrEmpty(item, 'updatedAt'),
      content: {
        number: member(content, 'number') ?? JSON_NULL,
        state: member(content, 'state') ?? JSON_NULL,
        url: member(content, 'url') ?? JSON_NULL,
        labels: extractLabels(content),
        repository: extractRepository(content),
      },
    })
  }
  return transformed
}

function countMember(value: JsonValue | undefined, key: string): number | undefined {
  const found = member(member(value, key), 'totalCount')
  return typeof found === 'number' ? found : undefined
}

function parentOf(content: JsonValue | undefined): BoardProgress['parent'] {
  const parent = member(content, 'parent')
  const repository = extractRepository(parent)
  const number = member(parent, 'number')
  return repository === '' || typeof number !== 'number' ? undefined : { repository, number }
}

/**
一覧の応答から、Issue ごとの着手の判定の入力を取る。キーは boardItemKey と同じ。Issue 以外と、番号の無いものは含めない
*/
export function readBoardProgress(rawItems: readonly JsonObject[], labelFieldName: string): ReadonlyMap<string, BoardProgress> {
  const progress = new Map<string, BoardProgress>()
  for (const item of rawItems) {
    const content = member(item, 'content')
    if (isEmptyValue(content) || member(content, 'blockedBy') === undefined) continue
    const key = boardItemKey({ content: { number: member(content, 'number'), repository: extractRepository(content) } })
    if (key === undefined) continue
    const issueType = member(member(content, 'issueType'), 'name')
    const blockedBy = member(member(content, 'blockedBy'), 'totalCount')
    progress.set(key, {
      issueType: typeof issueType === 'string' ? issueType : undefined,
      subIssues: countMember(content, 'subIssues') ?? 0,
      parent: parentOf(content),
      blockedBy: typeof blockedBy === 'number' ? blockedBy : undefined,
      label: extractWorkflowStatus(item, labelFieldName),
    })
  }
  return progress
}

/**
1 アイテムを Markdown 表の行 `| Ref | Title |` にする。extraCells は、Title の後ろに足すセル。
Ref は GitHub 慣習に倣い `owner/repo#N` で合成する。
リポジトリ情報または番号が欠落している場合は可能な範囲で埋め、両方欠落しているときは `-` を表示する
*/
export function formatTableRow(item: BoardItem, extraCells: readonly string[] = []): string {
  const { number } = item.content
  const repository = item.content.repository ?? ''
  const numberText = number === undefined || number === null ? '' : displayText(number)
  let reference = '-'
  if (repository !== '' && numberText !== '') reference = `${repository}#${numberText}`
  else if (repository !== '') reference = repository
  else if (numberText !== '') reference = `#${numberText}`
  const { title } = item
  const titleText = title === undefined || isEmptyValue(title) ? '-' : displayText(title)
  return `| ${[reference, titleText, ...extraCells].join(' | ')} |`
}

function updatedAtOf(item: BoardItem): string {
  return typeof item.updatedAt === 'string' ? item.updatedAt : ''
}

// updatedAt の新しい順。同じ値は元の順序を保つ
function newestFirst(first: BoardItem, second: BoardItem): number {
  const [a, b] = [updatedAtOf(first), updatedAtOf(second)]
  if (a === b) return 0
  return a < b ? 1 : -1
}

/**
判定の文の表（readiness 引数）を引くキー。`owner/repo#N` の小文字で、issueReferenceKey と同じ形になる。
リポジトリか番号が欠けたアイテムは undefined
*/
export function boardItemKey(item: BoardItem): string | undefined {
  const { number } = item.content
  const repository = item.content.repository ?? ''
  return repository === '' || number === undefined || number === null ? undefined : `${repository}#${displayText(number)}`.toLowerCase()
}

// 判定の列を足す節（Ready・Blocked）
const READINESS_STATUSES: ReadonlySet<string> = new Set(['Ready', 'Blocked'])

function readinessCell(item: BoardItem, readiness: ReadonlyMap<string, string>): string {
  const key = boardItemKey(item)
  return (key === undefined ? undefined : readiness.get(key)) ?? '-'
}

/**
プロジェクトボードを Markdown 形式で出力する。件数が 0 のステータスは出さない。
Archived は 6 件以上あるとき、更新が新しい直近 5 件だけを出す。
readiness（boardItemKey → 判定の文）を渡したときだけ、Ready と Blocked の節に Readiness の列を足す。
表に無いアイテムのセルは `-`
*/
export function formatBoardOutput(items: readonly BoardItem[], readiness?: ReadonlyMap<string, string>): string {
  const sections: (readonly string[])[] = []

  for (const status of STATUS_ORDER) {
    const patterns = STATUS_PATTERNS.get(status) ?? []
    const statusItems = items.filter(item => typeof item.workflow === 'string' && patterns.includes(item.workflow))
    const totalCount = statusItems.length
    if (totalCount === 0) continue

    const isTruncated = status === 'Archived' && totalCount > ARCHIVED_DISPLAY_LIMIT
    const displayItems = isTruncated ? statusItems.toSorted(newestFirst).slice(0, ARCHIVED_DISPLAY_LIMIT) : statusItems
    const heading = isTruncated ? `### ${status} (latest ${String(ARCHIVED_DISPLAY_LIMIT)} of ${String(totalCount)})` : `### ${status} (${String(totalCount)})`
    if (readiness !== undefined && READINESS_STATUSES.has(status)) {
      const rows = displayItems.map(item => formatTableRow(item, [readinessCell(item, readiness)]))
      sections.push([heading, '| Ref | Title | Readiness |', '|-----|----------|-----------|', ...rows])
    }
    else {
      sections.push([heading, '| Ref | Title |', '|-----|----------|', ...displayItems.map(item => formatTableRow(item))])
    }
  }

  return sections.length === 0 ? '_No items_' : sections.map(section => section.join('\n')).join('\n\n')
}

export interface StackableChain {
  /**
  並びの一番上の Issue の親（表示用の `#N`）。親が無ければ undefined
  */
  readonly epic: string | undefined
  /**
  下から並べた Issue（表示用の `#N`）
  */
  readonly chain: readonly string[]
}

/**
`## Stackable chains` の節を作る。1 行が 1 つの並びで、並びが無ければ undefined
*/
export function formatStackableChains(chains: readonly StackableChain[]): string | undefined {
  if (chains.length === 0) return undefined
  const lines = chains.map(({ epic = '(no epic)', chain }) => `- ${epic}: ${chain.join(' -> ')}`)
  return ['## Stackable chains', '', ...lines].join('\n')
}

/**
アイテムリストを JSON 出力用の辞書にする
*/
export function formatItemsJson(items: readonly BoardItem[]): { readonly items: readonly BoardItem[] } {
  return { items }
}
