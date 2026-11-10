// evidence-xlsx domain の入力契約 (EvidenceSpec) の型定義と検証。
// ワイヤ形式の正は specs/010-evidence-xlsx/contracts/evidence-cli.md §2。
// 検証規則の正は specs/010-evidence-xlsx/data-model.md §1。
//
// スキルが対話から組み立てた JSON を受けるため、検証は「スキル側のバグを早期に
// 顕在化させる」向きに倒す: 未知キーは拒否し、エラーは全件集めて一度に返す。

import path from 'node:path'

import { isRecord } from '../_shared/json.js'

// ワイヤ形式 (JSON がそのまま満たす形)

export interface HeaderField {
  // 空文字不可。
  readonly label: string
  // 空文字可 (明示的な空欄を許す)。
  readonly value: string
}

/**
対象画像に対する相対座標 (0.0–1.0、原点は画像左上)。
*/
export interface Point {
  readonly x: number
  readonly y: number
}

/**
対象画像に対する相対の矩形。`x + w ≤ 1 && y + h ≤ 1` を満たす必要がある。
*/
export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface CalloutAnnotation {
  readonly type: 'callout'
  // 空文字不可。
  readonly text: string
  readonly box: Rect
  // 引き出し線の指し先。
  readonly anchor: Point
}

export interface HighlightAnnotation {
  readonly type: 'highlight'
  // w > 0 かつ h > 0。
  readonly box: Rect
}

export interface ArrowAnnotation {
  readonly type: 'arrow'
  readonly from: Point
  readonly to: Point
}

export type Annotation = CalloutAnnotation | HighlightAnnotation | ArrowAnnotation

export interface EvidenceItem {
  readonly imagePath: string
  readonly caption?: string
  readonly annotations?: readonly Annotation[]
}

export interface EvidenceSpec {
  // 非空文字列。ヘッダーのタイトル行に出す。
  readonly title: string
  // YYYY-MM-DD 形式かつ暦に存在する日付。
  readonly createdDate: string
  // 作成者・環境などの任意追加ヘッダー。0 件可。
  readonly extraHeaders?: readonly HeaderField[]
  // 配列順がそのまま通し番号 (1 始まり) と縦並び順になる。
  readonly items: readonly EvidenceItem[]
}

// 正規化後の形 (省略可能フィールドを埋めた形)

// ワイヤ形式の省略可能フィールドを parseEvidenceSpec が必ず埋めた形。
// 下流 (workbook-writer / layout) は、空配列の既定値を補う処理を書かなくてよい。
// そのため、ワイヤ形式とは別型にして、CLI 境界から先はこちらだけを流す。
// 必須フィールドはワイヤ形式から Omit で引き継ぎ、二重定義がずれないようにする。

export interface NormalizedEvidenceItem extends Omit<EvidenceItem, 'caption' | 'annotations'> {
  // 省略時はファイル名 (拡張子除く) から補完済み (FR-004)。
  readonly caption: string
  readonly annotations: readonly Annotation[]
}

export interface NormalizedEvidenceSpec extends Omit<EvidenceSpec, 'extraHeaders' | 'items'> {
  readonly extraHeaders: readonly HeaderField[]
  readonly items: readonly NormalizedEvidenceItem[]
}

/**
検証エラー 1 件。`path` は contracts §2 の例示に合わせた JSON Pointer 風表記
(`items[0].annotations[1].box.x`)。RFC 6901 準拠ではないのでフィールド名は `path` に
とどめ、ルート自身に対するエラーは空文字にする。
*/
export interface SpecValidationError {
  readonly path: string
  readonly message: string
}

export type EvidenceSpecParseResult
  = | { readonly ok: true, readonly spec: NormalizedEvidenceSpec, readonly written: EvidenceSpec }
    | { readonly ok: false, readonly errors: readonly SpecValidationError[] }

// 検証

type ErrorSink = (pointer: string, message: string) => void

const SPEC_KEYS: ReadonlySet<string> = new Set(['title', 'createdDate', 'extraHeaders', 'items'])
const HEADER_FIELD_KEYS: ReadonlySet<string> = new Set(['label', 'value'])
const ITEM_KEYS: ReadonlySet<string> = new Set(['imagePath', 'caption', 'annotations'])
const CALLOUT_KEYS: ReadonlySet<string> = new Set(['type', 'text', 'box', 'anchor'])
const HIGHLIGHT_KEYS: ReadonlySet<string> = new Set(['type', 'box'])
const ARROW_KEYS: ReadonlySet<string> = new Set(['type', 'from', 'to'])
const POINT_KEYS: ReadonlySet<string> = new Set(['x', 'y'])
const RECT_KEYS: ReadonlySet<string> = new Set(['x', 'y', 'w', 'h'])

const CREATED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const NEWLINE_PATTERN = /[\n\r]/

/**
JSON.parse 済みの unknown を検証し、正規化済みの EvidenceSpec を返す。
失敗時はエラーを全件返す (最初の 1 件で打ち切らない)。
*/
export function parseEvidenceSpec(value: unknown): EvidenceSpecParseResult {
  const errors: SpecValidationError[] = []
  const addError: ErrorSink = (pointer, message) => {
    errors.push({ path: pointer, message })
  }

  if (!isRecord(value)) {
    addError('', 'EvidenceSpec must be an object')
    return { ok: false, errors }
  }

  collectUnknownKeys(value, SPEC_KEYS, '', addError)
  const title = parseNonEmptyString(value['title'], 'title', addError)
  const createdDate = parseCreatedDate(value['createdDate'], addError)
  const extraHeaders = parseExtraHeaders(value['extraHeaders'], addError)
  const parsedItems = parseItems(value['items'], addError)

  if (title === undefined || createdDate === undefined
    || extraHeaders === undefined || parsedItems === undefined || (errors.length > 0)) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    spec: { title, createdDate, extraHeaders, items: parsedItems.map(parsed => parsed.normalized) },
    // caption を補う前の、利用者が書いた形（文面の確認に使う）
    written: { title, createdDate, extraHeaders, items: parsedItems.map(parsed => parsed.written) },
  }
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function joinPointer(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`
}

function collectUnknownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  pointer: string,
  addError: ErrorSink,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      addError(joinPointer(pointer, key), 'unknown key')
    }
  }
}

function parseString(value: unknown, pointer: string, addError: ErrorSink): string | undefined {
  if (typeof value !== 'string') {
    addError(pointer, 'must be a string')
    return undefined
  }
  return value
}

function parseNonEmptyString(
  value: unknown,
  pointer: string,
  addError: ErrorSink,
): string | undefined {
  const text = parseString(value, pointer, addError)
  if (text === undefined) {
    return undefined
  }
  if (text === '') {
    addError(pointer, 'must not be empty')
    return undefined
  }
  return text
}

function parseCreatedDate(value: unknown, addError: ErrorSink): string | undefined {
  const text = parseNonEmptyString(value, 'createdDate', addError)
  if (text === undefined) {
    return undefined
  }
  if (!CREATED_DATE_PATTERN.test(text)) {
    addError('createdDate', `must be in YYYY-MM-DD format: ${text}`)
    return undefined
  }
  if (!isCalendarDate(text)) {
    addError('createdDate', `not a valid calendar date: ${text}`)
    return undefined
  }
  return text
}

/**
`YYYY-MM-DD` が暦に存在するかを判定する。Date は 2026-02-31 を 2026-03-03 へ
繰り上げるので、UTC で往復させて元の 3 値と一致するかで見る。
0–99 年は Date.UTC が 1900 年台へ写すため往復に失敗して拒否になるが、
作業エビデンスの作成日としては実害がない。
*/
function isCalendarDate(text: string): boolean {
  const year = Math.trunc(Number(text.slice(0, 4)))
  const month = Math.trunc(Number(text.slice(5, 7)))
  const day = Math.trunc(Number(text.slice(8, 10)))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function parseExtraHeaders(
  value: unknown,
  addError: ErrorSink,
): readonly HeaderField[] | undefined {
  if (value === undefined) {
    return []
  }
  if (!isUnknownArray(value)) {
    addError('extraHeaders', 'must be an array')
    return undefined
  }
  const result: HeaderField[] = []
  let isFailed = false
  for (const [index, entry] of value.entries()) {
    const pointer = `extraHeaders[${index.toString()}]`
    const field = parseHeaderField(entry, pointer, addError)
    if (field === undefined) {
      isFailed = true
      continue
    }
    result.push(field)
  }
  return isFailed ? undefined : result
}

function parseHeaderField(
  value: unknown,
  pointer: string,
  addError: ErrorSink,
): HeaderField | undefined {
  if (!isRecord(value)) {
    addError(pointer, 'must be an object')
    return undefined
  }
  collectUnknownKeys(value, HEADER_FIELD_KEYS, pointer, addError)
  const label = parseNonEmptyString(value['label'], `${pointer}.label`, addError)
  // value は空文字可 (data-model §1 HeaderField)。
  const text = parseString(value['value'], `${pointer}.value`, addError)
  return label === undefined || text === undefined ? undefined : { label, value: text }
}

interface ParsedItem {
  readonly normalized: NormalizedEvidenceItem
  // caption を補う前の、利用者が書いた形
  readonly written: EvidenceItem
}

function parseItems(
  value: unknown,
  addError: ErrorSink,
): readonly ParsedItem[] | undefined {
  // 欠落と型不一致は原因が別 (スキル側で項目を組み立て忘れたか、値を作り間違えたか) なので
  // メッセージを分ける。
  if (value === undefined) {
    addError('items', 'is required')
    return undefined
  }
  if (!isUnknownArray(value)) {
    addError('items', 'must be an array')
    return undefined
  }
  if (value.length === 0) {
    addError('items', 'must have at least one item')
    return undefined
  }
  const result: ParsedItem[] = []
  let isFailed = false
  for (const [index, entry] of value.entries()) {
    const item = parseItem(entry, `items[${index.toString()}]`, addError)
    if (item === undefined) {
      isFailed = true
      continue
    }
    result.push(item)
  }
  return isFailed ? undefined : result
}

function parseItem(
  value: unknown,
  pointer: string,
  addError: ErrorSink,
): ParsedItem | undefined {
  if (!isRecord(value)) {
    addError(pointer, 'must be an object')
    return undefined
  }
  collectUnknownKeys(value, ITEM_KEYS, pointer, addError)
  const imagePath = parseNonEmptyString(value['imagePath'], `${pointer}.imagePath`, addError)
  // caption はキー自体を省略したときだけファイル名から補完する (FR-004)。
  // 明示された空文字は data-model が禁じていないのでそのまま通す。
  const rawCaption = value['caption']
  const caption = rawCaption === undefined
    ? undefined
    : parseString(rawCaption, `${pointer}.caption`, addError)
  const annotations = parseAnnotations(value['annotations'], pointer, addError)

  if (imagePath === undefined || annotations === undefined) {
    return undefined
  }
  if (rawCaption !== undefined && caption === undefined) {
    return undefined
  }
  return {
    normalized: {
      imagePath,
      caption: caption ?? captionFromImagePath(imagePath),
      annotations,
    },
    written: {
      imagePath,
      ...(caption !== undefined && { caption }),
      annotations,
    },
  }
}

/**
画像ファイル名 (拡張子除く) をキャプションに使う (FR-004)。
merge.ts が zip エントリ名に path.posix を使うのと違い、ここは実 OS 上の
ファイルパスを分解するのでプラットフォーム依存版を使う。
*/
function captionFromImagePath(imagePath: string): string {
  return path.basename(imagePath, path.extname(imagePath))
}

function parseAnnotations(
  value: unknown,
  itemPointer: string,
  addError: ErrorSink,
): readonly Annotation[] | undefined {
  if (value === undefined) {
    return []
  }
  const pointer = `${itemPointer}.annotations`
  if (!isUnknownArray(value)) {
    addError(pointer, 'must be an array')
    return undefined
  }
  const result: Annotation[] = []
  let isFailed = false
  for (const [index, entry] of value.entries()) {
    const annotation = parseAnnotation(entry, `${pointer}[${index.toString()}]`, addError)
    if (annotation === undefined) {
      isFailed = true
      continue
    }
    result.push(annotation)
  }
  return isFailed ? undefined : result
}

function parseAnnotation(
  value: unknown,
  pointer: string,
  addError: ErrorSink,
): Annotation | undefined {
  if (!isRecord(value)) {
    addError(pointer, 'must be an object')
    return undefined
  }
  const type = value['type']
  if (typeof type !== 'string') {
    addError(`${pointer}.type`, 'must be a string')
    return undefined
  }
  switch (type) {
    case 'callout': {
      return parseCallout(value, pointer, addError)
    }
    case 'highlight': {
      return parseHighlight(value, pointer, addError)
    }
    case 'arrow': {
      return parseArrow(value, pointer, addError)
    }
    default: {
      addError(`${pointer}.type`, `unknown annotation type: ${type}`)
      return undefined
    }
  }
}

function parseCallout(
  record: Readonly<Record<string, unknown>>,
  pointer: string,
  addError: ErrorSink,
): CalloutAnnotation | undefined {
  collectUnknownKeys(record, CALLOUT_KEYS, pointer, addError)
  const text = parseCalloutText(record['text'], `${pointer}.text`, addError)
  const box = parseRect(record['box'], `${pointer}.box`, addError)
  const anchor = parsePoint(record['anchor'], `${pointer}.anchor`, addError)
  return text === undefined || box === undefined || anchor === undefined ? undefined : { type: 'callout', text, box, anchor }
}

/**
吹き出しの文言。図形の txBody は単一段落で組むため改行を表現できない。
折り返しは描画側が box 幅で行うので、改行はクランプせず拒否する
(はみ出し座標と同じくスキル側が文言を組み直して再実行する)。
*/
function parseCalloutText(
  value: unknown,
  pointer: string,
  addError: ErrorSink,
): string | undefined {
  const text = parseNonEmptyString(value, pointer, addError)
  if (text === undefined) {
    return undefined
  }
  if (NEWLINE_PATTERN.test(text)) {
    addError(pointer, 'callout text must not contain a line break')
    return undefined
  }
  return text
}

function parseHighlight(
  record: Readonly<Record<string, unknown>>,
  pointer: string,
  addError: ErrorSink,
): HighlightAnnotation | undefined {
  collectUnknownKeys(record, HIGHLIGHT_KEYS, pointer, addError)
  const box = parseRect(record['box'], `${pointer}.box`, addError)
  if (box === undefined) {
    return undefined
  }
  // 面積 0 の枠は描画されないので、どちらの辺が潰れているかをフィールド粒度で返す。
  let isDegenerate = false
  if (box.w <= 0) {
    addError(`${pointer}.box.w`, `highlight box w must be > 0: ${box.w.toString()}`)
    isDegenerate = true
  }
  if (box.h <= 0) {
    addError(`${pointer}.box.h`, `highlight box h must be > 0: ${box.h.toString()}`)
    isDegenerate = true
  }
  return isDegenerate ? undefined : { type: 'highlight', box }
}

function parseArrow(
  record: Readonly<Record<string, unknown>>,
  pointer: string,
  addError: ErrorSink,
): ArrowAnnotation | undefined {
  collectUnknownKeys(record, ARROW_KEYS, pointer, addError)
  const from = parsePoint(record['from'], `${pointer}.from`, addError)
  const to = parsePoint(record['to'], `${pointer}.to`, addError)
  if (from === undefined || to === undefined) {
    return undefined
  }
  if (from.x === to.x && from.y === to.y) {
    addError(pointer, 'arrow from and to must not be the same point')
    return undefined
  }
  return { type: 'arrow', from, to }
}

function parsePoint(value: unknown, pointer: string, addError: ErrorSink): Point | undefined {
  if (!isRecord(value)) {
    addError(pointer, 'must be an object')
    return undefined
  }
  collectUnknownKeys(value, POINT_KEYS, pointer, addError)
  const x = parseRelativeCoordinate(value['x'], `${pointer}.x`, addError)
  const y = parseRelativeCoordinate(value['y'], `${pointer}.y`, addError)
  return x === undefined || y === undefined ? undefined : { x, y }
}

function parseRect(value: unknown, pointer: string, addError: ErrorSink): Rect | undefined {
  if (!isRecord(value)) {
    addError(pointer, 'must be an object')
    return undefined
  }
  collectUnknownKeys(value, RECT_KEYS, pointer, addError)
  const x = parseRelativeCoordinate(value['x'], `${pointer}.x`, addError)
  const y = parseRelativeCoordinate(value['y'], `${pointer}.y`, addError)
  const w = parseRelativeCoordinate(value['w'], `${pointer}.w`, addError)
  const h = parseRelativeCoordinate(value['h'], `${pointer}.h`, addError)
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    return undefined
  }
  // 画像の表示領域からのはみ出しは拒否する (クランプしない — スキル側が座標を
  // 再計算して再実行する)。等号は受理。epsilon 許容は入れない: 実際に来る
  // 2〜4 桁小数では偽陽性が出ず、入れると真のはみ出しを通してしまう。
  let isOverflow = false
  if (x + w > 1) {
    addError(`${pointer}.w`, `x + w exceeds 1 (x: ${x.toString()}, w: ${w.toString()})`)
    isOverflow = true
  }
  if (y + h > 1) {
    addError(`${pointer}.h`, `y + h exceeds 1 (y: ${y.toString()}, h: ${h.toString()})`)
    isOverflow = true
  }
  return isOverflow ? undefined : { x, y, w, h }
}

/**
0.0–1.0 の相対座標 / 相対サイズ。
*/
function parseRelativeCoordinate(
  value: unknown,
  pointer: string,
  addError: ErrorSink,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addError(pointer, 'must be a finite number')
    return undefined
  }
  if (value < 0 || value > 1) {
    addError(pointer, `out of range 0.0-1.0: ${value.toString()}`)
    return undefined
  }
  return value
}
