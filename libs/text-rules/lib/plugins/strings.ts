import type { TextlintPluginProcessor } from '@textlint/types'
import { BYTE_ORDER_MARK } from '../byte-order-mark.js'
import { documentOf, listMarkerLength, splitString } from './inline-spans.js'
import type { CodeNode, InlineNode, Position, StringNode } from './inline-spans.js'
import { loadCommentsPlugin } from './load.js'
import { frontmatterOf, jsonStrings, pythonStrings, shellStrings, yamlStrings } from './scan.js'
import type { Scanner, Segment } from './scan.js'
import { typescriptStrings } from './typescript.js'
import type { Grammar } from './typescript.js'
import { vueScripts, vueStrings } from './vue.js'

// 文字列リテラルの本文を、日本語を含むものだけ textlint の Paragraph にする plugin。
// kernel は拡張子に先頭一致した plugin を 1 つだけ使って解析する。
// そのため comments plugin を内包し、コメントと文字列の Paragraph を 1 つの Document に併せる。

interface Location {
  readonly start: Position
  readonly end: Position
}
type Range = readonly [number, number]

interface Span {
  readonly raw: string
  readonly range: Range
  readonly loc: Location
}
interface BreakNode extends Span {
  readonly type: 'Break'
}
interface ParagraphNode extends Span {
  readonly type: 'Paragraph'
  readonly children: readonly (StringNode | InlineNode | CodeNode | BreakNode)[]
}

const SCANNERS: ReadonlyMap<string, Scanner> = new Map([
  ['.py', pythonStrings],
  ['.pyi', pythonStrings],
  ['.sh', shellStrings],
  ['.bash', shellStrings],
  ['.json', jsonStrings],
  ['.jsonc', jsonStrings],
  ['.yaml', yamlStrings],
  ['.yml', yamlStrings],
  ['.ts', typescriptStrings('typescript')],
  ['.mts', typescriptStrings('typescript')],
  ['.cts', typescriptStrings('typescript')],
  ['.tsx', typescriptStrings('tsx')],
  ['.js', typescriptStrings('javascript')],
  ['.mjs', typescriptStrings('javascript')],
  ['.cjs', typescriptStrings('javascript')],
  ['.jsx', typescriptStrings('javascript')],
  ['.vue', vueStrings],
])

// .vue の script のコメントを comments plugin に読ませるときの拡張子。
const SCRIPT_EXTENSIONS: ReadonlyMap<Grammar, string> = new Map([
  ['typescript', '.ts'],
  ['tsx', '.tsx'],
  ['javascript', '.js'],
])

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u
// `/* */` の行頭の `*`（前後の空白を含む）。
const BLOCK_COMMENT_PREFIX = /^[\t ]*\*[\t ]*/
// テンプレート文字列の ${} の位置に置く仮の文字。小文字や全角の文字は和欧間の規則を増やす。
const PLACEHOLDER = 'X'

// 行の先頭オフセット表。column は 0 始まり、line は 1 始まり。
function lineStartsOf(text: string): readonly number[] {
  const starts = text.matchAll(/\n/g).map(match => match.index + 1).toArray()
  return [0, ...starts]
}

function spanOf(text: string, lineStarts: readonly number[], start: number, end: number): Span {
  const locate = (offset: number): Position => {
    const line = lineStarts.findLastIndex(lineStart => lineStart <= offset)
    return { line: line + 1, column: offset - (lineStarts.at(line) ?? 0) }
  }
  return { raw: text.slice(start, end), range: [start, end], loc: { start: locate(start), end: locate(end) } }
}

// 本文を行ごとに分け、Markdown（CommonMark）のブロックの規則で、空行で区切った段落ごとに返す。
// 前後の空白（インデントと CR）を除いた行を返し、段落には空でない行だけが入る。
// 共通の字下げを除いてから読む。1 行目は引用符の直後から始まるので、字下げを数えない。
// 空行（空白だけの行を含む）とリストの記号で始まる行の前は段落の切れ目で、リストの記号の無い続きの行は直前の項目の段落に残す。
// 字下げ 4 以上のコード、フェンスのコード、HTML ブロックは、Markdown と同じく規則の対象から外す。
// blockComment の本文は、行頭の `*` も除き、ブロックの規則は掛けない。
interface IndentedLine {
  readonly start: number
  readonly end: number
  readonly indent: number
}

const TAB_WIDTH = 4
const CODE_INDENT = 4
const FENCE_OPEN = /^(`{3,}|~{3,})/
const HTML_BLOCK_STARTS: readonly { readonly start: RegExp, readonly end: RegExp }[] = [
  { start: /^<(?:pre|script|style|textarea)(?:[\s>]|$)/i, end: /<\/(?:pre|script|style|textarea)>/i },
  { start: /^<!--/, end: /-->/ },
  { start: /^<\?/, end: /\?>/ },
  { start: /^<![a-z]/i, end: />/ },
  { start: /^<!\[CDATA\[/, end: /\]\]>/ },
]
// type 6 は CommonMark が挙げるブロック要素の名前。基準は、.md を読む textlint の Markdown plugin（micromark 2.11.4）が使う CommonMark 0.29 の一覧。
// 0.31 で足された search と、外された source は、この一覧に従う。
// type 7 は行に他の文字を続けない単独のタグ（名前の後ろは空白・`/`・`>`）。
const HTML_TYPE_6 = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s>]|\/>|$)/i
const HTML_TYPE_7 = /^(?:<[a-z][\w-]*(?=[\s/>])[^<>]*|<\/[a-z][\w-]*\s*)>$/i

// 前後の空白。エスケープを解かない本文では、エスケープの `\t` も空白として読む。
const ESCAPED_LEADING = /^(?:\s|\\t)*/
const ESCAPED_TRAILING = /(?:\s|\\t)*$/
const ESCAPED_LINE_BREAK = /^\\(?:r\\n|n)/

function indentOf(line: string, hasEscapes: boolean): number {
  let width = 0
  let index = 0
  while (index < line.length) {
    if (hasEscapes && line.startsWith('\\t', index)) {
      width += TAB_WIDTH
      index += 2
    }
    else if (line.charAt(index) === ' ') {
      width += 1
      index += 1
    }
    else if (line.charAt(index) === '\t') {
      width += TAB_WIDTH
      index += 1
    }
    else {
      break
    }
  }
  return width
}

// from から limit までで最初の行の区切りと、次の行の始まりを返す。区切りが無ければ limit で終わる。
// エスケープを解かない本文では、エスケープの `\n` と `\r\n` も区切りにする（`\\` は対で飛ばす）。
function lineBreakIn(text: string, from: number, limit: number, hasEscapes: boolean): { end: number, next: number } {
  for (let index = from; index < limit; index += 1) {
    if (text.charAt(index) === '\n') {
      return { end: index, next: index + 1 }
    }
    if (!hasEscapes || text.charAt(index) !== '\\') {
      continue
    }
    const escape = ESCAPED_LINE_BREAK.exec(text.slice(index, index + 4))?.[0]
    if (escape !== undefined) {
      return { end: index, next: index + escape.length }
    }
    index += text.charAt(index + 1) === '\\' ? 1 : 0
  }
  return { end: limit, next: limit + 1 }
}

function bodyLinesOf(text: string, segment: Segment): readonly IndentedLine[] {
  const hasEscapes = segment.hasEscapes === true
  const lines: IndentedLine[] = []
  let cursor = segment.start
  while (cursor < segment.end) {
    const { end, next } = lineBreakIn(text, cursor, segment.end, hasEscapes)
    const line = text.slice(cursor, end)
    const prefix = segment.blockComment === true ? BLOCK_COMMENT_PREFIX : (hasEscapes ? ESCAPED_LEADING : undefined)
    const leading = prefix?.exec(line)?.[0].length ?? line.length - line.trimStart().length
    const trimmedLength = hasEscapes ? line.length - (ESCAPED_TRAILING.exec(line)?.[0].length ?? 0) : line.trimEnd().length
    lines.push({ start: cursor + leading, end: cursor + trimmedLength, indent: segment.blockComment === true ? 0 : indentOf(line, hasEscapes) })
    cursor = next
  }
  return lines
}

// 1 行目を除いた、空でない行の字下げの最小値。
function commonIndent(lines: readonly IndentedLine[]): number {
  const indents = lines.slice(1).filter(line => line.start < line.end).map(line => line.indent)
  return indents.length === 0 ? 0 : Math.min(...indents)
}

// 行が HTML ブロックを始めるかを返す。
// kind が single のときは同じ行で閉じ、open のときは end の行まで（end が無ければ次の空行まで）続く。
// type 7 は段落を中断できないので、段落の途中（canStartSingleTag が false）では始まらない。
interface HtmlStart {
  readonly kind: 'none' | 'single' | 'open'
  readonly end?: RegExp
}

const NO_HTML_BLOCK: HtmlStart = { kind: 'none' }

function htmlBlockOf(content: string, canStartSingleTag: boolean): HtmlStart {
  const typed = HTML_BLOCK_STARTS.find(candidate => candidate.start.test(content))
  if (typed === undefined) {
    return HTML_TYPE_6.test(content) || (canStartSingleTag && HTML_TYPE_7.test(content)) ? { kind: 'open' } : NO_HTML_BLOCK
  }
  return typed.end.test(content) ? { kind: 'single' } : { kind: 'open', end: typed.end }
}

function isFenceClose(content: string, marker: string): boolean {
  const run = /^(`+|~+)\s*$/.exec(content)?.[1]
  return run !== undefined && run.startsWith(marker.charAt(0)) && run.length >= marker.length
}

function trimmedParagraphs(text: string, segment: Segment): readonly (readonly Segment[])[] {
  const lines = bodyLinesOf(text, segment)
  const common = commonIndent(lines)
  const isMarkdown = segment.blockComment !== true
  const paragraphs: Segment[][] = []
  let current: Segment[] = []
  // 直前のリスト項目の内容の字下げ。コードの字下げは、これに 4 を足した幅から。
  let itemIndent = 0
  type OpenBlock
    = | { readonly kind: 'fence', readonly marker: string }
      | { readonly kind: 'html', readonly end?: RegExp }
      | { readonly kind: 'code' }
  let block: OpenBlock | undefined
  const flush = (): void => {
    if (current.length === 0) {
      return
    }
    paragraphs.push(current)
    current = []
  }
  for (const [index, line] of lines.entries()) {
    const content = text.slice(line.start, line.end)
    const isBlank = line.start >= line.end
    const indent = index === 0 ? 0 : Math.max(line.indent - common, 0)
    if (!isBlank && current.length === 0 && indent < itemIndent) {
      itemIndent = 0
    }
    const codeIndent = itemIndent + CODE_INDENT
    if (block?.kind === 'fence') {
      block = isMarkdown && indent < codeIndent && isFenceClose(content, block.marker) ? undefined : block
      continue
    }
    if (block?.kind === 'html') {
      block = block.end === undefined ? (isBlank ? undefined : block) : (block.end.test(content) ? undefined : block)
      continue
    }
    if (block?.kind === 'code') {
      if (isBlank || indent >= codeIndent) {
        continue
      }
      block = undefined
    }
    if (isBlank) {
      flush()
      continue
    }
    if (isMarkdown) {
      const opening = indent < codeIndent ? FENCE_OPEN.exec(content)?.[1] : undefined
      const html = indent < codeIndent ? htmlBlockOf(content, current.length === 0) : NO_HTML_BLOCK
      if (indent >= codeIndent && current.length === 0) {
        block = { kind: 'code' }
        continue
      }
      if (opening !== undefined && !(opening.startsWith('`') && content.slice(opening.length).includes('`'))) {
        flush()
        block = { kind: 'fence', marker: opening }
        continue
      }
      if (html.kind !== 'none') {
        flush()
        block = html.kind === 'single' ? undefined : (html.end === undefined ? { kind: 'html' } : { kind: 'html', end: html.end })
        continue
      }
    }
    // リストの記号で始まる行は新しい段落の始まりで、Str には記号を含めない。
    const marker = listMarkerLength(content)
    if (marker !== undefined) {
      flush()
      itemIndent = indent + marker
    }
    current.push({ start: line.start + (marker ?? 0), end: line.end })
  }
  flush()
  return paragraphs
}

// 行の中の ${} は 1 文字の X として読む（lintText の断片と同じ）。
// code span・インライン HTML・URL は ${} を X に置き換えた本文で見つけるので、${} をまたいでも 1 つにまとまる。
// Str に含まれる ${} は value が X の Code にして切り出し、Code・Html・Link に含まれる ${} は、その中に残す。
function lineNodes(text: string, view: string, lineStarts: readonly number[], line: Segment, holes: readonly Segment[]): readonly (StringNode | InlineNode | CodeNode)[] {
  const inside = holes.filter(candidate => candidate.start >= line.start && candidate.end <= line.end)
  const body = view.slice(line.start, line.end)
  const pieces = splitString({ type: 'Str', value: body, ...spanOf(view, lineStarts, line.start, line.end) })
  const originalOf = (node: InlineNode): InlineNode => {
    const raw = text.slice(node.range[0], node.range[1])
    return node.type === 'Link'
      ? { ...node, raw, children: node.children.map(child => ({ ...child, raw: text.slice(child.range[0], child.range[1]) })) }
      : { ...node, raw }
  }
  return pieces.flatMap((piece): (StringNode | InlineNode | CodeNode)[] => {
    if (piece.type !== 'Str') {
      return [originalOf(piece)]
    }
    const nodes: (StringNode | CodeNode)[] = []
    let cursor = piece.range[0]
    const addString = (end: number): void => {
      if (cursor < end) {
        nodes.push({ type: 'Str', value: text.slice(cursor, end), ...spanOf(text, lineStarts, cursor, end) })
      }
    }
    const holesInPiece = inside.filter(candidate => candidate.start >= piece.range[0] && candidate.end <= piece.range[1])
    for (const hole of holesInPiece) {
      addString(hole.start)
      nodes.push({ type: 'Code', value: PLACEHOLDER, ...spanOf(text, lineStarts, hole.start, hole.end) })
      cursor = hole.end
    }
    addString(piece.range[1])
    return nodes
  })
}

// 行ごとの Str と、行の間の Break で段落を組む。Str の range は引用符を含めない。
function paragraphOf(text: string, view: string, lineStarts: readonly number[], lines: readonly Segment[], holes: readonly Segment[]): ParagraphNode | undefined {
  const first = lines[0]
  const last = lines.at(-1)
  if (first === undefined || last === undefined) {
    return undefined
  }
  const children = lines.flatMap((line, index): (StringNode | InlineNode | CodeNode | BreakNode)[] => {
    const previous = lines[index - 1]
    const nodes = lineNodes(text, view, lineStarts, line, holes)
    return previous === undefined ? [...nodes] : [{ type: 'Break', ...spanOf(text, lineStarts, previous.end, line.start) }, ...nodes]
  })
  return { type: 'Paragraph', children, ...spanOf(text, lineStarts, first.start, last.end) }
}

// 本文が frontmatter で始まるときは、値ごとの Segment と、閉じた `---` より後の本文に分ける。
// 読めない frontmatter は分けず、全体を 1 つの本文として扱う。${} を持つ本文は holes を保つため分けない。
function bodiesOf(text: string, segment: Segment): readonly Segment[] {
  const frontmatter = segment.holes === undefined ? frontmatterOf(text, segment) : undefined
  return frontmatter === undefined ? [segment] : [...frontmatter.values.flatMap(value => bodiesOf(text, value)), frontmatter.rest]
}

// ${} を X に置き換えた、同じ長さの本文。行の分け方と日本語の判定は、${} の中身を見ずにこの本文で行う。
// ${} ごとに全体を切り直さず、holes の間の断片を積んで 1 回だけつなぐ。
function viewOf(text: string, segment: Segment): string {
  const holes = segment.holes ?? []
  if (holes.length === 0) {
    return text
  }
  const pieces: string[] = []
  let cursor = 0
  for (const hole of holes) {
    pieces.push(text.slice(cursor, hole.start), PLACEHOLDER.repeat(hole.end - hole.start))
    cursor = hole.end
  }
  pieces.push(text.slice(cursor))
  return pieces.join('')
}

// 日本語を含む文字列だけを対象にし、段落ごとの Paragraph にする。
function paragraphsOf(text: string, lineStarts: readonly number[], segment: Segment): readonly ParagraphNode[] {
  const view = viewOf(text, segment)
  const paragraphs = trimmedParagraphs(view, segment)
  const first = paragraphs[0]?.[0]
  const last = paragraphs.at(-1)?.at(-1)
  return first === undefined || last === undefined || !JAPANESE.test(view.slice(first.start, last.end))
    ? []
    : paragraphs.flatMap(lines => paragraphOf(text, view, lineStarts, lines, segment.holes ?? []) ?? [])
}

export async function stringParagraphs(text: string, extension: string, lineStarts: readonly number[] = lineStartsOf(text)): Promise<readonly ParagraphNode[]> {
  const scanner = SCANNERS.get(extension)
  if (scanner === undefined) {
    throw new RangeError(`${extension} は strings plugin の対象外の拡張子です`)
  }
  const segments = await scanner(text)
  return segments.flatMap(segment => bodiesOf(text, segment)).flatMap(body => paragraphsOf(text, lineStarts, body))
}

export { documentOf } from './inline-spans.js'

const EXTENSIONS: readonly string[] = SCANNERS.keys().toArray()

// 文字列の外にあるコメントの Paragraph。.vue は comments plugin が読めないので、script の中身だけを残した本文を拡張子ごとに読ませる。
async function commentNodes(text: string, extension: string): Promise<ReturnType<typeof documentOf>['children']> {
  const Processor = loadCommentsPlugin().Processor
  if (extension !== '.vue') {
    return documentOf(await new Processor().processor(extension).preProcess(text)).children
  }
  const documents = await Promise.all(vueScripts(text).map(async ({ grammar, masked }) => documentOf(await new Processor().processor(SCRIPT_EXTENSIONS.get(grammar) ?? '.js').preProcess(masked)).children))
  return documents.flat()
}

class StringsProcessor {
  availableExtensions(): string[] {
    return [...EXTENSIONS]
  }

  processor(extension: string): ReturnType<TextlintPluginProcessor['processor']> {
    return {
      // kernel は本文から BOM を落として数えるので、ここでも落として同じ位置にそろえる。
      async preProcess(original) {
        const text = original.replace(BYTE_ORDER_MARK, '')
        const lineStarts = lineStartsOf(text)
        const children = [...await commentNodes(text, extension), ...await stringParagraphs(text, extension, lineStarts)].toSorted((a, b) => a.range[0] - b.range[0])
        return { type: 'Document', children, ...spanOf(text, lineStarts, 0, text.length) }
      },
      postProcess(messages, filePath = '') {
        return { messages, filePath }
      },
    }
  }
}

export default { Processor: StringsProcessor }
