import type { TextlintPluginCreator, TextlintPluginPreProcessResult, TextlintPluginProcessor } from '@textlint/types'

// コメントや文字列に含まれるインラインコード（バッククォート）、インライン HTML、素の URL を、Markdown に倣って Code・Html・Link のノードにする。
// 規則は Str だけを見るので、Code と Html にした区間は規則の対象から外れる。
// Link の URL は、文の長さの規則（skipUrlStringLink）が長さから外す。
// リストの記号で始まる行は、Markdown の ListItem と同じく新しい段落の始まりにする。
// 文字列を Markdown として読む lintText（断片）と、同じ区間が外れて判定が揃う。

type DocumentResult = Exclude<TextlintPluginPreProcessResult, { readonly ast: unknown }>
type Paragraph = Extract<DocumentResult['children'][number], { readonly type: 'Paragraph' }>
type Phrasing = Paragraph['children'][number]
export type StringNode = Extract<Phrasing, { readonly type: 'Str' }>
export type CodeNode = Extract<Phrasing, { readonly type: 'Code' }>
type HtmlNode = Extract<Phrasing, { readonly type: 'Html' }>
type LinkNode = Extract<Phrasing, { readonly type: 'Link' }>
export type InlineNode = StringNode | CodeNode | HtmlNode | LinkNode

// 変換後の text を返す形式の plugin もあるので、Document だけを取り出す。
export function documentOf(result: Readonly<TextlintPluginPreProcessResult>): DocumentResult {
  return 'ast' in result ? result.ast : result
}

type SpanKind = 'Code' | 'Html' | 'Link'

interface Span {
  readonly kind: SpanKind
  readonly start: number
  readonly end: number
  // Code のバッククォートの数、`<https://…>` の `<` と `>` の幅。それ以外は 0。
  readonly width: number
}

// 位置 index から読んだ結果。next は次に読む位置で、必ず index より大きい。
interface InlineStep {
  readonly next: number
  readonly span?: Span
}

const BACKTICKS = /`+/y
const ANY_BACKTICKS = /`+/g
// CommonMark のインライン HTML のうち、コメントと開始・終了タグ。属性は `<` と `>` を含まない範囲を 1 まとまりで読む。
const HTML_COMMENT = /<!--[\s\S]*?-->/y
const AUTOLINK = /<https?:\/\/[^\s<>]+>/y
const URL_START = /https?:\/\//y
const TRAILING_MARK = /^[!"'*,.:;?_~。、，．」』）】！？]$/
const HTML_TAG = /<\/?[a-z][\da-z-]*(?=[\s/>])[^<>]*>/iy

function isTrailing(url: string): boolean {
  const last = url.slice(-1)
  return TRAILING_MARK.test(last) || (last === ')' && url.split(')').length > url.split('(').length)
}

// 素の URL は、空白か `<` までを読み、末尾の句読点と、対応する `(` の無い `)` を含めない（GFM の autolink literal に倣う）。
function urlStep(raw: string, index: number): InlineStep {
  URL_START.lastIndex = index
  const scheme = URL_START.exec(raw)?.[0]
  if (scheme === undefined) {
    return { next: index + 1 }
  }
  const stop = raw.slice(index).search(/[\s<]/)
  const limit = stop === -1 ? raw.length : index + stop
  let end = limit
  while (end > index + scheme.length && isTrailing(raw.slice(index, end))) {
    end -= 1
  }
  return end === index + scheme.length ? { next: limit } : { next: end, span: { kind: 'Link', start: index, end, width: 0 } }
}

// 同じ数のバッククォートで閉じる区間（CommonMark の code span）。閉じないバッククォートは文字として読み飛ばす。
function codeStep(raw: string, index: number): InlineStep {
  BACKTICKS.lastIndex = index
  const opener = BACKTICKS.exec(raw)?.[0] ?? '`'
  const from = index + opener.length
  ANY_BACKTICKS.lastIndex = from
  for (let run = ANY_BACKTICKS.exec(raw); run !== null; run = ANY_BACKTICKS.exec(raw)) {
    if (run[0].length === opener.length) {
      const end = run.index + run[0].length
      return { next: end, span: { kind: 'Code', start: index, end, width: opener.length } }
    }
  }
  return { next: from }
}

function htmlStep(raw: string, index: number): InlineStep {
  AUTOLINK.lastIndex = index
  const autolink = AUTOLINK.exec(raw)?.[0]
  if (autolink !== undefined) {
    return { next: index + autolink.length, span: { kind: 'Link', start: index, end: index + autolink.length, width: 1 } }
  }
  const [comment, tag] = [HTML_COMMENT, HTML_TAG].map((pattern) => {
    pattern.lastIndex = index
    return pattern.exec(raw)?.[0]
  })
  const matched = comment ?? tag
  return matched === undefined
    ? { next: index + 1 }
    : { next: index + matched.length, span: { kind: 'Html', start: index, end: index + matched.length, width: 0 } }
}

function stepAt(raw: string, index: number): InlineStep {
  const char = raw.charAt(index)
  if (char === '`') {
    return codeStep(raw, index)
  }
  if (char === '<') {
    return htmlStep(raw, index)
  }
  return char === 'h' ? urlStep(raw, index) : { next: index + 1 }
}

// Markdown と同じく、Code（バッククォート）と Html（コメントと開始・終了タグ）の区間を左から順に返す。
function inlineSpansOf(raw: string): readonly Span[] {
  const spans: Span[] = []
  let index = 0
  while (index < raw.length) {
    const step = stepAt(raw, index)
    if (step.span !== undefined) {
      spans.push(step.span)
    }
    index = step.next
  }
  return spans
}

export interface Position {
  readonly line: number
  readonly column: number
}

// Str の raw 内のオフセットを、元ファイルの位置にする。raw は元ファイルの切り出しなので、改行は raw を数える。
function positionAt(node: StringNode, offset: number): Position {
  const before = node.raw.slice(0, offset)
  const lastBreak = before.lastIndexOf('\n')
  return lastBreak === -1
    ? { line: node.loc.start.line, column: node.loc.start.column + offset }
    : { line: node.loc.start.line + before.split('\n').length - 1, column: offset - lastBreak - 1 }
}

function pieceOf(node: StringNode, start: number, end: number): StringNode {
  const raw = node.raw.slice(start, end)
  return {
    type: 'Str',
    value: raw,
    raw,
    range: [node.range[0] + start, node.range[0] + end],
    loc: { start: positionAt(node, start), end: positionAt(node, end) },
  }
}

function inlineOf(node: StringNode, span: Span): CodeNode | HtmlNode | LinkNode {
  const piece = pieceOf(node, span.start, span.end)
  const inner = piece.raw.slice(span.width, piece.raw.length - span.width)
  if (span.kind === 'Html') {
    return { ...piece, type: 'Html' }
  }
  if (span.kind === 'Code') {
    return { ...piece, type: 'Code', value: inner }
  }
  // Markdown の autolink と同じく、子は URL そのものの Str で、url 属性に URL を入れる。
  const { type: _type, value: _value, ...position } = piece
  return { ...position, type: 'Link', url: inner, children: [pieceOf(node, span.start + span.width, span.end - span.width)] }
}

// Str を、Code・Html・Link の前後の Str と、Code・Html・Link に分ける。value と raw がずれる Str は位置を保てないので分けない。
export function splitString(node: StringNode): readonly InlineNode[] {
  const spans = node.value === node.raw ? inlineSpansOf(node.raw) : []
  const pieces: InlineNode[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) {
      pieces.push(pieceOf(node, cursor, span.start))
    }
    pieces.push(inlineOf(node, span))
    cursor = span.end
  }
  if (spans.length === 0) {
    return [node]
  }
  return cursor < node.raw.length ? [...pieces, pieceOf(node, cursor, node.raw.length)] : pieces
}

// 行頭のリストの記号（`- ` `* ` `+ ` `1. ` `1) `）と、その後ろの空白の長さ。記号が無ければ undefined。
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])[\t ]+(?=\S)/

export function listMarkerLength(line: string): number | undefined {
  return LIST_MARKER.exec(line)?.[0].length
}

function withoutMarker(node: StringNode): StringNode | undefined {
  const length = node.value === node.raw ? listMarkerLength(node.raw) : undefined
  return length === undefined ? undefined : pieceOf(node, length, node.raw.length)
}

function paragraphOf(paragraph: Paragraph, children: readonly Phrasing[]): Paragraph {
  const first = children.at(0) ?? paragraph
  const last = children.at(-1) ?? paragraph
  return {
    ...paragraph,
    children,
    raw: children.map(child => child.raw).join(''),
    range: [first.range[0], last.range[1]],
    loc: { start: first.loc.start, end: last.loc.end },
  }
}

// リストの記号で始まる行の前で Paragraph を分け、記号を Str から除く。
// 記号の無い続きの行は、直前の項目の段落に残す（Markdown の lazy continuation）。
function splitLists(paragraph: Paragraph): readonly Paragraph[] {
  const groups: Phrasing[][] = [[]]
  let isChanged = false
  for (const child of paragraph.children) {
    const stripped = child.type === 'Str' ? withoutMarker(child) : undefined
    const current = groups.at(-1) ?? []
    if (stripped === undefined) {
      current.push(child)
    }
    else {
      isChanged = true
      if (current.at(-1)?.type === 'Break') {
        current.pop()
      }
      groups.push([stripped])
    }
  }
  return isChanged ? groups.filter(group => group.length > 0).map(group => paragraphOf(paragraph, group)) : [paragraph]
}

function splitParagraph(paragraph: Paragraph): Paragraph {
  return { ...paragraph, children: paragraph.children.flatMap((child): Phrasing[] => (child.type === 'Str' ? [...splitString(child)] : [child])) }
}

function withInlineSpans(document: DocumentResult): DocumentResult {
  return { ...document, children: document.children.flatMap((child): DocumentResult['children'][number][] => (child.type === 'Paragraph' ? splitLists(child).map(paragraph => splitParagraph(paragraph)) : [child])) }
}

// plugin の Document の Paragraph に、Code への分割を後処理として掛ける。
export function withInlineSpansPlugin(creator: Readonly<TextlintPluginCreator>): TextlintPluginCreator {
  class CodeSpanProcessor {
    private readonly inner = new creator.Processor()

    availableExtensions(): string[] {
      return this.inner.availableExtensions()
    }

    processor(extension: string): ReturnType<TextlintPluginProcessor['processor']> {
      const base = this.inner.processor(extension)
      return {
        async preProcess(text, filePath) {
          return withInlineSpans(documentOf(await base.preProcess(text, filePath)))
        },
        postProcess(messages, filePath) {
          return base.postProcess(messages, filePath)
        },
      }
    }
  }
  return { Processor: CodeSpanProcessor }
}
