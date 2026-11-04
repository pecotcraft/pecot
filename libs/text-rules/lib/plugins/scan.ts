import { parseAllDocuments, visit } from 'yaml'

// 文字列リテラルの本文。引用符は含めず、start は先頭、end は直後の位置を指す。
// holes は本文の中で文章として読まない区間（テンプレート文字列の `${}`）。
// blockComment は `/* */` の本文で、行頭の `*` を文章に含めない。
// hasEscapes はバックスラッシュのエスケープを解かずに含む本文で、`\n` を行の区切りとして読む。
export interface Segment {
  readonly start: number
  readonly end: number
  readonly holes?: readonly Segment[]
  readonly blockComment?: boolean
  readonly hasEscapes?: boolean
}

// TypeScript の構文解析は非同期の初期化を要するので、scanner は Promise も返せる。
export type Scanner = (text: string) => readonly Segment[] | Promise<readonly Segment[]>

// 文字を見たときの動作。next は次に読む位置で、必ず index より大きい。
interface Step {
  readonly next: number
  readonly segment?: Segment
}
type Handler = (text: string, index: number) => Step
type HandlerTable = ReadonlyMap<string, Handler>

interface QuoteRule {
  readonly closer: string
  readonly escapable: boolean
  readonly multiline: boolean
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf('\n', index)
  return newline === -1 ? text.length : newline
}

// バックスラッシュと、その直後の 1 文字（CRLF は 2 文字）を飛ばす長さ
function escapeLength(text: string, index: number): number {
  return text.startsWith('\r\n', index + 1) ? 3 : 2
}

// from から closer まで読み、本文の end と次に読む位置を返す。
// 閉じていない文字列は、複数行を許さなければ行末で、許せば入力の末尾で止める。
function readQuoted(text: string, from: number, rule: QuoteRule): { end: number, next: number } {
  let index = from
  while (index < text.length) {
    if (rule.escapable && text.charAt(index) === '\\') {
      index += escapeLength(text, index)
    }
    else if (text.startsWith(rule.closer, index)) {
      return { end: index, next: index + rule.closer.length }
    }
    else if (!rule.multiline && text.charAt(index) === '\n') {
      return { end: index, next: index }
    }
    else {
      index += 1
    }
  }
  return { end: text.length, next: text.length }
}

function quotedStep(text: string, opener: number, rule: QuoteRule): Step {
  const { end, next } = readQuoted(text, opener, rule)
  return { next, segment: rule.escapable ? { start: opener, end, hasEscapes: true } : { start: opener, end } }
}

// 1 文字ずつ表で引き、表に無い文字は 1 文字進める。
function* scanWith(text: string, handlers: HandlerTable): Generator<Segment> {
  let index = 0
  while (index < text.length) {
    const step = handlers.get(text.charAt(index))?.(text, index) ?? { next: index + 1 }
    if (step.segment !== undefined) {
      yield step.segment
    }
    index = step.next
  }
}

const skipLineComment: Handler = (text, index) => ({ next: lineEnd(text, index) })

// Python。接頭辞（r b f u t）は走査に影響しないので見ない。
const pythonQuote: Handler = (text, index) => {
  const quote = text.charAt(index)
  const isTriple = text.startsWith(quote.repeat(3), index)
  const width = isTriple ? 3 : 1
  return quotedStep(text, index + width, { closer: quote.repeat(width), escapable: true, multiline: isTriple })
}

const PYTHON_HANDLERS: HandlerTable = new Map<string, Handler>([
  ['#', skipLineComment],
  ['"', pythonQuote],
  ['\'', pythonQuote],
])

export function pythonStrings(text: string): readonly Segment[] {
  return [...scanWith(text, PYTHON_HANDLERS)]
}

// JSON / JSONC。キーは文字列の直後に `:` が来るもので、値だけを返す。
const KEY_SUFFIX = /\s*:/y

const JSON_QUOTE: QuoteRule = { closer: '"', escapable: true, multiline: false }

const jsonString: Handler = (text, index) => {
  const step = quotedStep(text, index + 1, JSON_QUOTE)
  KEY_SUFFIX.lastIndex = step.next
  return KEY_SUFFIX.test(text) ? { next: step.next } : step
}

const jsonSlash: Handler = (text, index) => {
  if (text.startsWith('//', index)) {
    return { next: lineEnd(text, index) }
  }
  if (text.startsWith('/*', index)) {
    const close = text.indexOf('*/', index + 2)
    return { next: close === -1 ? text.length : close + 2 }
  }
  return { next: index + 1 }
}

const JSON_HANDLERS: HandlerTable = new Map<string, Handler>([
  ['"', jsonString],
  ['/', jsonSlash],
])

export function jsonStrings(text: string): readonly Segment[] {
  return [...scanWith(text, JSON_HANDLERS)]
}

// シェル。`<<` で宣言された heredoc の本文は、宣言した行の次の行から終端語の行までを読み飛ばす。
interface Heredoc {
  readonly delimiter: string
  readonly stripTabs: boolean
}

const HEREDOC = /<<(-?)[ \t]*['"\\]?(\w[\w.-]*)['"]?/y
const WORD_START = ' \t\n;|&('

// 終端語の行の直後（改行の位置）を返す。見つからなければ何も飛ばさない。
// `1 << 2` のような算術の左シフトが本文を飲み込まないようにするため。
function skipHeredocBody(text: string, from: number, heredoc: Heredoc): number {
  let line = from
  while (line < text.length) {
    const end = lineEnd(text, line)
    const content = text.slice(line, end).replace(/\r$/, '')
    if ((heredoc.stripTabs ? content.replace(/^\t+/, '') : content) === heredoc.delimiter) {
      return end
    }
    line = end + 1
  }
  return from
}

// heredoc の宣言は行をまたいで持ち越すので、走査ごとに状態を持つ表を作る。
function shellHandlers(): HandlerTable {
  const pending: Heredoc[] = []
  const newline: Handler = (text, index) => {
    let next = index + 1
    for (const heredoc of pending) {
      next = skipHeredocBody(text, next, heredoc)
    }
    pending.length = 0
    return { next }
  }
  const heredoc: Handler = (text, index) => {
    if (text.startsWith('<<<', index)) {
      return { next: index + 3 }
    }
    HEREDOC.lastIndex = index
    const match = HEREDOC.exec(text)
    if (match === null) {
      return { next: index + 1 }
    }
    pending.push({ delimiter: match[2] ?? '', stripTabs: match[1] === '-' })
    return { next: index + match[0].length }
  }
  return new Map<string, Handler>([
    ['#', (text, index) => ({ next: index === 0 || WORD_START.includes(text.charAt(index - 1)) ? lineEnd(text, index) : index + 1 })],
    ['\'', (text, index) => quotedStep(text, index + 1, { closer: '\'', escapable: text.charAt(index - 1) === '$', multiline: true })],
    ['"', (text, index) => quotedStep(text, index + 1, { closer: '"', escapable: true, multiline: true })],
    ['\\', (text, index) => ({ next: index + escapeLength(text, index) })],
    ['<', heredoc],
    ['\n', newline],
  ])
}

export function shellStrings(text: string): readonly Segment[] {
  return [...scanWith(text, shellHandlers())]
}

// YAML。`yaml` の構文木から値のスカラーだけを取り、元テキストの位置で切り出す。
type YamlSegmenter = (text: string, start: number, valueEnd: number) => Segment

const quotedBody: YamlSegmenter = (_text, start, valueEnd) => ({ start: start + 1, end: valueEnd - 1 })
// 二重引用符のスカラーだけが、バックスラッシュのエスケープを持つ。
const escapedQuotedBody: YamlSegmenter = (_text, start, valueEnd) => ({ start: start + 1, end: valueEnd - 1, hasEscapes: true })
const plainBody: YamlSegmenter = (_text, start, valueEnd) => ({ start, end: valueEnd })
// ブロックスカラーは `|` や `>-` の指示子の行を除いた、次の行から。
const blockBody: YamlSegmenter = (text, start, valueEnd) => {
  const newline = text.indexOf('\n', start)
  return { start: newline === -1 ? valueEnd : newline + 1, end: valueEnd }
}

const YAML_SEGMENTERS: ReadonlyMap<string, YamlSegmenter> = new Map([
  ['PLAIN', plainBody],
  ['QUOTE_DOUBLE', escapedQuotedBody],
  ['QUOTE_SINGLE', quotedBody],
  ['BLOCK_LITERAL', blockBody],
  ['BLOCK_FOLDED', blockBody],
])

function yamlSegment(text: string, type: string, range: readonly number[] | null | undefined): Segment | undefined {
  const segmenter = YAML_SEGMENTERS.get(type)
  const [start, valueEnd] = range ?? []
  return segmenter === undefined || start === undefined || valueEnd === undefined ? undefined : segmenter(text, start, valueEnd)
}

interface YamlScalars {
  readonly segments: readonly Segment[]
  readonly isValid: boolean
}

function yamlScalars(text: string): YamlScalars {
  const found: Segment[] = []
  let isValid = true
  for (const document of parseAllDocuments(text)) {
    isValid &&= document.errors.length === 0
    visit(document, {
      Scalar(key, node) {
        const segment = key === 'key' ? undefined : yamlSegment(text, String(node.type), node.range)
        if (segment !== undefined) {
          found.push(segment)
        }
      },
    })
  }
  return { segments: found, isValid }
}

export function yamlStrings(text: string): readonly Segment[] {
  return yamlScalars(text).segments
}

// 文字列の本文の先頭に置いた frontmatter。values は YAML の値ごとの Segment で、rest は閉じた `---` の後ろ。
export interface Frontmatter {
  readonly values: readonly Segment[]
  readonly rest: Segment
}

interface BodyLine {
  readonly start: number
  readonly end: number
}

function bodyLines(text: string, segment: Segment): readonly BodyLine[] {
  const lines: BodyLine[] = []
  let cursor = segment.start
  while (cursor <= segment.end) {
    const newline = text.indexOf('\n', cursor)
    const end = newline === -1 || newline > segment.end ? segment.end : newline
    lines.push({ start: cursor, end })
    cursor = end + 1
  }
  return lines
}

const FRONTMATTER_FENCE = '---'

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length
}

// 本文の最初の空でない行が `---` だけで、後にもう 1 本 `---` だけの行があるとき、その間を YAML として読む。
// インデントを除いた本文を読み、行ごとの表で元ファイルのオフセットへ戻す。
// frontmatter でないときと、間が YAML として読めない（構文エラー）ときは undefined を返す。
export function frontmatterOf(text: string, segment: Segment): Frontmatter | undefined {
  const lines = bodyLines(text, segment)
  const isFence = (line: BodyLine): boolean => text.slice(line.start, line.end).trim() === FRONTMATTER_FENCE
  const firstIndex = lines.findIndex(line => text.slice(line.start, line.end).trim() !== '')
  const first = lines.at(firstIndex)
  const closerIndex = lines.findIndex((line, index) => index > firstIndex && isFence(line))
  const closer = lines.at(closerIndex)
  if (first === undefined || closer === undefined || firstIndex === -1 || closerIndex === -1 || !isFence(first)) {
    return undefined
  }
  const rows = lines.slice(firstIndex + 1, closerIndex).map((line) => {
    const raw = text.slice(line.start, line.end)
    return { line, raw, leading: leadingSpaces(raw) }
  })
  const indent = Math.min(...rows.filter(row => row.raw.trim() !== '').map(row => row.leading))
  // 空行は indent より短いことがあるので、除く長さは行の先頭の空白までにとどめる。
  const pieces = rows.map(({ line, raw, leading }) => ({ origin: line.start + Math.min(indent, leading), body: raw.slice(Math.min(indent, leading)) }))
  const pieceStarts = pieces.map((_piece, index) => pieces.slice(0, index).reduce((sum, piece) => sum + piece.body.length + 1, 0))
  const scalars = yamlScalars(pieces.map(piece => piece.body).join('\n'))
  if (!scalars.isValid) {
    return undefined
  }
  const locate = (offset: number): number => {
    const index = pieceStarts.findLastIndex(start => start <= offset)
    return (pieces.at(index)?.origin ?? 0) + offset - (pieceStarts.at(index) ?? 0)
  }
  const values = scalars.segments.map(({ start, end }) => {
    const mapped = locate(start)
    return { start: mapped, end: end > start ? locate(end - 1) + 1 : mapped }
  })
  const rest = { start: Math.min(closer.end + 1, segment.end), end: segment.end }
  return { values, rest: segment.hasEscapes === true ? { ...rest, hasEscapes: true } : rest }
}
