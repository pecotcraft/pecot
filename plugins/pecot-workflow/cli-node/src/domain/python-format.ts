// Python の CLI が出していた文言を作る関数。
// 前後比較で文言を揃えるため、Python と同じ書式を写す。
//
// 持つもの:
//   - JSON 値の repr は pythonRepr。
//   - str のメソッドに当たる関数は pythonStrip と parsePythonInteger。
//   - HTTP クライアントの状態の文は formatHttpStatusError。
//   - 検証ライブラリの ValidationError の文は formatValidationError。
//   - OSError の文は formatOsError。
//
// JSON.parse は整数と実数を区別しない。そのため 2.0 は「2」と出る（Python は 2.0）。
// オブジェクトのキーは JS の順序（整数風のキーが先頭）になり、Python の挿入順とは違うことがある。

import { InvalidValueError } from './errors.js'

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

// Python の str.isspace() が真の文字。JS の trim() が落とす文字から U+FEFF を除き、U+001C〜U+001F と U+0085 を足したもの
function isPythonWhitespace(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (character.trim() === '' && code !== 0xFE_FF) || (code >= 0x1C && code <= 0x1F) || code === 0x85
}

/**
universal newlines と同じ。`\r\n` と `\r` を `\n` に揃える（Python の text=True・read_text()）
*/
export function normalizeNewlines(text: string): string {
  return text.replaceAll(/\r\n?/gu, '\n')
}

/**
sorted() の str の並べ方に使う比較。UTF-16 の単位順で比べる（BMP 内では Python のコードポイント順と同じ）
*/
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
str.rstrip() と同じ
*/
export function pythonRightStrip(text: string): string {
  let end = text.length
  while (end > 0 && isPythonWhitespace(text.charAt(end - 1))) end -= 1
  return text.slice(0, end)
}

/**
文字列をコードポイントに分ける。Python の len・スライスと同じ単位（UTF-16 の単位ではない）
*/
export function splitCodePoints(text: string): readonly string[] {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- Python の len と同じコードポイント単位で数えるため
  return [...text]
}

/**
text[:limit] と同じ。コードポイント単位で切る
*/
export function truncateCodePoints(text: string, limit: number): string {
  return splitCodePoints(text).slice(0, limit).join('')
}

/**
str.strip() と同じ
*/
export function pythonStrip(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && isPythonWhitespace(text.charAt(start))) start += 1
  while (end > start && isPythonWhitespace(text.charAt(end - 1))) end -= 1
  return text.slice(start, end)
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u

function escapeCodePoint(character: string): string {
  const code = character.codePointAt(0) ?? 0
  if (code < 0x1_00) return String.raw`\x${code.toString(16).padStart(2, '0')}`
  if (code < 0x1_00_00) return String.raw`\u${code.toString(16).padStart(4, '0')}`
  return String.raw`\U${code.toString(16).padStart(8, '0')}`
}

function escapeCharacter(character: string, quote: string): string {
  switch (character) {
    case quote:
    case '\\': { return `\\${character}` }
    case '\n': { return String.raw`\n` }
    case '\r': { return String.raw`\r` }
    case '\t': { return String.raw`\t` }
    case ' ': { return character }
    default: { return NON_PRINTABLE.test(character) ? escapeCodePoint(character) : character }
  }
}

/**
repr(str) と同じ。引用符は、' を含み " を含まないときだけ "
*/
export function pythonStringRepr(text: string): string {
  const quote = text.includes('\'') && !text.includes('"') ? '"' : '\''
  let result = ''
  for (const character of splitCodePoints(text)) {
    result += escapeCharacter(character, quote)
  }
  return `${quote}${result}${quote}`
}

/**
repr(float) と同じ。指数表記になるのは、10 進の小数点位置が 16 を超える・-3 未満のとき
*/
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
  const sign = value < 0 ? '-' : ''
  const [mantissa = '', exponentText = '0'] = Math.abs(value).toExponential().split('e', 2)
  const digits = mantissa.replace('.', '')
  const exponent = Number(exponentText)
  const pointPosition = exponent + 1
  if (pointPosition > -4 && pointPosition <= 16) {
    if (pointPosition <= 0) return `${sign}0.${'0'.repeat(-pointPosition)}${digits}`
    if (digits.length <= pointPosition) return `${sign}${digits}${'0'.repeat(pointPosition - digits.length)}.0`
    return `${sign}${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`
  }
  const fraction = digits.length > 1 ? `.${digits.slice(1)}` : ''
  const exponentSign = exponent < 0 ? '-' : '+'
  return `${sign}${digits.slice(0, 1)}${fraction}e${exponentSign}${String(Math.abs(exponent)).padStart(2, '0')}`
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value)
}

/**
JSON 値の repr。整数値の数は int、それ以外は float の書式にする
*/
export function pythonRepr(value: JsonValue): string {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : pythonFloatRepr(value)
  if (typeof value === 'string') return pythonStringRepr(value)
  if (isJsonArray(value)) return `[${value.map(item => pythonRepr(item)).join(', ')}]`
  return `{${Object.entries(value).map(([key, item]) => `${pythonStringRepr(key)}: ${pythonRepr(item)}`).join(', ')}}`
}

/**
type(value).__name__ に当たる名前
*/
export function pythonTypeName(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return 'NoneType'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'int' : 'float'
  if (typeof value === 'string') return 'str'
  return isJsonArray(value) ? 'list' : 'dict'
}

// Unicode の Nd は 10 文字ずつの連続した並びで、先頭が 0。並びの先頭からの距離の 10 の剰余が数字の値になる
function decimalDigitValue(character: string): number {
  let distance = 0
  let code = (character.codePointAt(0) ?? 0) - 1
  while (code >= 0 && /^\p{Nd}$/u.test(String.fromCodePoint(code))) {
    distance += 1
    code -= 1
  }
  return distance % 10
}

/**
int(text) と同じ。前後の空白・符号・数字の間の `_`・Unicode の 10 進数字を受ける。
不正なら Python と同じ文の InvalidValueError ではなく undefined を返す（呼び出し側が文言を作る）
*/
export function parsePythonInteger(text: string): number | undefined {
  const stripped = pythonStrip(text)
  const isNegative = stripped.startsWith('-')
  const body = isNegative || stripped.startsWith('+') ? stripped.slice(1) : stripped
  // 数字の間の `_` は 1 つだけ受ける。先頭・末尾・連続は不可
  const groups = body.split('_')
  if (groups.some(group => !/^\p{Nd}+$/u.test(group))) return undefined
  const value = Number(groups.map(group => splitCodePoints(group).map(character => decimalDigitValue(character)).join('')).join(''))
  return isNegative ? -value : value
}

export interface HttpStatusFailure {
  readonly statusCode: number
  /**
  応答の statusText。空ならそのまま空で出す（HTTP/1.1 の空の reason を空のまま出す Python の挙動）
  */
  readonly statusText: string
  readonly url: string
  /**
  Location ヘッダ。リダイレクトの状態（301・302・303・307・308）で、あるときだけ出る
  */
  readonly location: string | undefined
}

const STATUS_CLASS_LABELS: ReadonlyMap<number, string> = new Map([
  [1, 'Informational response'],
  [3, 'Redirect response'],
  [4, 'Client error'],
  [5, 'Server error'],
])

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/**
2xx 以外の応答に対する、HTTP クライアントの raise_for_status の文
*/
export function formatHttpStatusError(failure: HttpStatusFailure): string {
  const { statusCode, url, location } = failure
  const reason = failure.statusText
  const label = STATUS_CLASS_LABELS.get(Math.trunc(statusCode / 100)) ?? 'Invalid status code'
  const lines = [`${label} '${String(statusCode)} ${reason}' for url '${url}'`]
  if (location !== undefined && REDIRECT_STATUSES.has(statusCode)) lines.push(`Redirect location: '${location}'`)
  lines.push(`For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${String(statusCode)}`)
  return lines.join('\n')
}

const ERRNO_TABLE: ReadonlyMap<string, readonly [number, string]> = new Map([
  ['EPERM', [1, 'Operation not permitted']],
  ['ENOENT', [2, 'No such file or directory']],
  ['EIO', [5, 'Input/output error']],
  ['EBADF', [9, 'Bad file descriptor']],
  ['EACCES', [13, 'Permission denied']],
  ['EBUSY', [16, 'Device or resource busy']],
  ['EEXIST', [17, 'File exists']],
  ['EXDEV', [18, 'Invalid cross-device link']],
  ['ENOTDIR', [20, 'Not a directory']],
  ['EISDIR', [21, 'Is a directory']],
  ['EINVAL', [22, 'Invalid argument']],
  ['EMFILE', [24, 'Too many open files']],
  ['ENOSPC', [28, 'No space left on device']],
  ['EROFS', [30, 'Read-only file system']],
  ['ENAMETOOLONG', [36, 'File name too long']],
  ['ENOTEMPTY', [39, 'Directory not empty']],
  ['ELOOP', [40, 'Too many levels of symbolic links']],
])

export interface SystemFailure {
  readonly code?: string | undefined
  readonly path?: string | undefined
  readonly dest?: string | undefined
}

/**
OSError の文（`[Errno 2] No such file or directory: 'x'`）。errno の code が表に無いときは undefined
*/
export function formatOsError(failure: SystemFailure): string | undefined {
  const entry = failure.code === undefined ? undefined : ERRNO_TABLE.get(failure.code)
  if (entry === undefined) return undefined
  const [errno, text] = entry
  const head = `[Errno ${String(errno)}] ${text}`
  if (failure.path === undefined) return head
  const destination = failure.dest === undefined ? '' : ` -> ${pythonStringRepr(failure.dest)}`
  return `${head}: ${pythonStringRepr(failure.path)}${destination}`
}

export interface ValidationIssue {
  /**
  エラーの種類（`missing`・`string_type`・`value_error` など）
  */
  readonly type: string
  readonly location: readonly (string | number)[]
  /**
  `Field required` のような本文
  */
  readonly message: string
  /**
  エラーになった値。無いこと（undefined）も区別して持つ
  */
  readonly input: JsonValue | undefined
}

// 検証ライブラリの案内 URL に入る版。Python の CLI が使っていた版（cli/uv.lock）に合わせる
const VALIDATION_DOCS_VERSION = '2.14'
// 入力値の repr の省略。UTF-8 のバイト長が 50 を超えたら、前 25 バイト・後ろ 24 バイトまでを文字単位で残す。
// 文字の途中でバイトが切れる位置では、入りきる文字だけを残す（どちらも内側へ寄せる）。
const REPRESENTATION_LIMIT_BYTES = 50
const HEAD_BYTES = 25
const TAIL_BYTES = 24

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

interface SizedCharacter {
  readonly character: string
  readonly bytes: number
}

// 先頭から、バイト数の合計が limit に収まる文字までを取る
function takeWithinBytes(characters: readonly SizedCharacter[], limit: number): readonly SizedCharacter[] {
  const taken: SizedCharacter[] = []
  let total = 0
  for (const item of characters) {
    if (total + item.bytes > limit) break
    taken.push(item)
    total += item.bytes
  }
  return taken
}

function truncatedRepresentation(value: JsonValue | undefined): string {
  const text = value === undefined ? 'None' : pythonRepr(value)
  if (byteLength(text) <= REPRESENTATION_LIMIT_BYTES) return text
  const characters = splitCodePoints(text).map(character => ({ character, bytes: byteLength(character) }))
  const head = takeWithinBytes(characters, HEAD_BYTES)
  const tail = takeWithinBytes(characters.slice(head.length).toReversed(), TAIL_BYTES).toReversed()
  return `${head.map(item => item.character).join('')}...${tail.map(item => item.character).join('')}`
}

/**
ValidationError の文。表題（モデル名）の後に、エラーごとに 3 行（場所・本文・案内 URL）が続く。
入力値の repr は、UTF-8 のバイト長が 50 を超えると省略する。
前 25 バイトと後ろ 24 バイトに収まる文字だけを残し、間を `...` でつなぐ
*/
export function formatValidationError(title: string, issues: readonly ValidationIssue[]): string {
  const lines = [`${String(issues.length)} validation error${issues.length === 1 ? '' : 's'} for ${title}`]
  for (const issue of issues) {
    if (issue.location.length > 0) lines.push(issue.location.map(String).join('.'))
    lines.push(
      `  ${issue.message} [type=${issue.type}, input_value=${truncatedRepresentation(issue.input)}, input_type=${pythonTypeName(issue.input)}]`,
      `    For further information visit https://errors.pydantic.dev/${VALIDATION_DOCS_VERSION}/v/${issue.type}`,
    )
  }
  return lines.join('\n')
}

/**
ValidationError に当たる例外。メッセージは formatValidationError の文
*/
export class ValidationFailure extends InvalidValueError {
  readonly title: string
  readonly issues: readonly ValidationIssue[]

  constructor(title: string, issues: readonly ValidationIssue[]) {
    super(formatValidationError(title, issues))
    this.title = title
    this.issues = issues
  }
}
