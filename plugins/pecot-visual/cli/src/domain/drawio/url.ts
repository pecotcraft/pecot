// drawio XML から draw.io ブラウザ URL を構築する純粋関数群。
// fs / process には触れない（憲法 II）。icon:// 解決の SVG 読み込みは
// resolveIcon コールバック経由で infra 層に注入する。
//
// Python リファレンス: plugins/pecot-visual/skills/v-drawio/scripts/drawio-url.py
// 互換性は **意味等価** とする。viewbox クエリの文字列が一致し、`#R<base64>` の復号後 XML が一致する。
// bit-identical ではない。
// 理由は 2 つある。Node `zlib.deflateRawSync` と Python `zlib.compressobj` で flush 戦略が違う。
// また `encodeURIComponent` と `urllib.parse.quote(safe="")` で、記号 5 種の扱いが反転している。

import { Buffer } from 'node:buffer'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

import { DOMParser, MIME_TYPE, onErrorStopParsing } from '@xmldom/xmldom'
import type { Document as XmldomDocument, Element as XmldomElement, Node as XmldomNode } from '@xmldom/xmldom'

import type { GenerateDrawioUrlOptions, IconResolver } from './types.js'
import { isGenericFamily } from './web-fonts.js'

const FONT_ALLOWED_ATTRS: ReadonlySet<string> = new Set(['face', 'size', 'color', 'style'])

// regexp/no-super-linear-backtracking への配慮として、コメント本文は 1 文字ずつ消費する。
// 使うのは `[^-]` と、直後が終端でない `-` の 2 つで、終端 `-->` まで非貪欲に進める。
// 全てに一致する非貪欲の素朴な書き方は、linear-backtracking の警告対象になる。
const XML_COMMENT_REGEX = /<!--(?:[^-]|-(?!->))*-->/g
const ICON_WITH_COLOR_REGEX = /icon:\/\/([\w./-]+)(?:%23|#)([\dA-Fa-f]{3,8})/g
const ICON_WITHOUT_COLOR_REGEX = /icon:\/\/([\w./-]+)(?!%23|#[\dA-Fa-f])/g
const STYLE_ATTR_REGEX = /style="([^"]*)"/g
const FONT_TAG_REGEX = /<font\b([^>]*)>/gi
// font 属性抽出: `name = "..."` または `name = '...'`
const ATTR_REGEX = /(\w+)\s*=\s*(?:"[^"]*"|'[^']*')/g
const SINGLE_QUOTE_ATTR_REGEX = /\w+\s*=\s*'[^']*'/g
const FONT_COLOR_VALUE_REGEX = /color\s*=\s*["']([^"']*)["']/i
// 折り返しが必要な value 判定。
//
// 計画書では、CJK 統合漢字・ひらがな・カタカナ・全角記号を範囲リテラルで指定していた。
// ただし元案 (`/[぀-ヿ㐀-鿿＀-￯]/`) は `regexp/no-obscure-range` の lint エラーになり、採用できない。
// そこで `\P{ASCII}` に切り替え、「ASCII 範囲外の文字すべて」を対象にした。
// 結果として、半角カナ・絵文字・キリル文字なども折り返し必須の扱いになる。検出が広がる方向の trade-off。
// 比例幅でない文字は draw.io でも折り返しが必要になるため、実害は低い。
// `whiteSpace=wrap` を付ければ警告は解消する。
// 改行と <br> も、同列の折り返し要因として OR で結合する。
// test() 用途のため g フラグは付けない。u フラグは Unicode property escape の要件。
const WRAP_REQUIRED_REGEX = /\P{ASCII}|\r?\n|<br\s*\/?>/iu

// 不正 XML は libxml2 と同じく例外にする（既定の xmldom は部分的な木を返す）。
const XML_PARSER = new DOMParser({ onError: onErrorStopParsing })

// libxmljs2 は入力先頭の U+FEFF（BOM）を受理して読み飛ばしていた。
// xmldom と onErrorStopParsing の組み合わせは、BOM を root 要素外のコンテンツとして throw する。
// これは xml-engine.ts と同じ問題。
// ここで parse に失敗すると catch 節で警告 0 件のまま、何も知らせずに確認を飛ばしてしまう。
// そのためパース前に BOM を除去する。
function stripBom(text: string): string {
  return text.startsWith('\u{FEFF}') ? text.slice(1) : text
}

/**
parse に失敗した XML は undefined を返し、呼び出し側は確認を飛ばす。
*/
export function parseDrawioXml(xml: string): XmldomDocument | undefined {
  try {
    return XML_PARSER.parseFromString(stripBom(xml), MIME_TYPE.XML_APPLICATION)
  }
  catch {
    return undefined
  }
}

/**
タグ名で要素を列挙する。名前空間は見ない（draw.io の XML は名前空間を持たない）。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- xmldom は可変。Document / Element / Node は readonly 化できない
function elementsByTagName(document: XmldomDocument, tagName: string): readonly XmldomElement[] {
  const list = document.getElementsByTagName(tagName)
  const elements: XmldomElement[] = []
  for (let index = 0; index < list.length; index += 1) {
    const element = list.item(index)
    if (element !== null) elements.push(element)
  }
  return elements
}

/**
属性値を返す（未設定は undefined）。xmldom は entity デコード済みの文字列を返す。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- xmldom は可変。Document / Element / Node は readonly 化できない
function attributeValue(element: XmldomElement, name: string): string | undefined {
  return element.getAttribute(name) ?? undefined
}

export function stripComments(xml: string): string {
  return xml.replaceAll(XML_COMMENT_REGEX, '')
}

/**
mxCell の value 属性内 HTML を確認し、警告メッセージ配列を返す。
Python 版の `_validate_html` と同等の検出ルールは次の 3 つ。
  1. `<font>` の属性が face/size/color/style 以外 → warn。
  2. value 内 HTML でシングルクォート属性値を使用 → warn。
  3. `<font color>` と mxCell style の fontColor が同一値で二重指定 → info。
*/
export function validateHtml(xml: string): readonly string[] {
  const warnings: string[] = []
  const document = parseDrawioXml(xml)
  if (document === undefined) return warnings

  for (const cell of elementsByTagName(document, 'mxCell')) {
    const rawValue = attributeValue(cell, 'value')
    if (rawValue === undefined || rawValue === '' || !rawValue.includes('<')) continue
    const cellId = attributeValue(cell, 'id') ?? '?'
    const styleAttribute = attributeValue(cell, 'style') ?? ''

    // ルール2: シングルクォート属性値検出（生 XML 値で確認）
    for (const sq of rawValue.matchAll(SINGLE_QUOTE_ATTR_REGEX)) {
      warnings.push(
        `[warn] mxCell id=${cellId}: シングルクォート属性値を検出 — ${sq[0]}。&quot; によるダブルクォートを使用してください`,
      )
    }

    // xmldom の getAttribute() は既に entity デコード済 string を返すため、
    // Python `html.unescape` 相当の二重デコードは不要。
    const valueHtml = rawValue

    // ルール1: <font> の不正属性検出
    for (const fontMatch of valueHtml.matchAll(FONT_TAG_REGEX)) {
      /* c8 ignore next -- FONT_TAG_REGEX は group(1) を必ずキャプチャする。空文字の右辺は到達不能 */
      const attributeString = fontMatch[1] ?? ''
      for (const attributeMatch of attributeString.matchAll(ATTR_REGEX)) {
        /* c8 ignore next -- ATTR_REGEX は group(1) を必ずキャプチャする。空文字の右辺は到達不能 */
        const attributeName = (attributeMatch[1] ?? '').toLowerCase()
        if (FONT_ALLOWED_ATTRS.has(attributeName)) continue
        const sortedAllowed = [...FONT_ALLOWED_ATTRS].toSorted((a, b) => a.localeCompare(b)).join(', ')
        warnings.push(
          `[warn] mxCell id=${cellId}: <font> の非対応属性 '${attributeName}' を検出。対応属性: ${sortedAllowed}`,
        )
      }
    }

    // ルール3: fontColor 二重指定検出
    const fontColorStyle = styleAttribute
      .split(';')
      .find(part => part.startsWith('fontColor='))
      ?.split('=', 2)[1]
      ?.trim()
      .toLowerCase()
    if (fontColorStyle !== undefined && fontColorStyle !== '') {
      for (const fontMatch of valueHtml.matchAll(FONT_TAG_REGEX)) {
        /* c8 ignore next -- FONT_TAG_REGEX は group(1) を必ずキャプチャする。空文字の右辺は到達不能 */
        const attributeString = fontMatch[1] ?? ''
        const colorMatch = FONT_COLOR_VALUE_REGEX.exec(attributeString)
        if (colorMatch === null) continue
        /* c8 ignore next -- FONT_COLOR_VALUE_REGEX は group(1) を必ずキャプチャする。空文字の右辺は到達不能 */
        const htmlColor = (colorMatch[1] ?? '').trim().toLowerCase()
        if (htmlColor === fontColorStyle) {
          warnings.push(
            `[info] mxCell id=${cellId}: <font color="${htmlColor}"> と style fontColor=${fontColorStyle} が同一値で二重指定されています`,
          )
        }
      }
    }
  }

  return warnings
}

/**
mxCell の style と value を確認し、警告メッセージ配列を返す。
対象は、折り返し必須 (日本語/改行/<br>) なのに `whiteSpace=wrap` が style に無い、box 系 vertex。
v-diagram-creator が stderr の [warn] を読んで該当 mxCell に追記できる粒度で、id を入れる。
*/
export function validateWhitespaceWrap(xml: string): readonly string[] {
  const warnings: string[] = []
  const document = parseDrawioXml(xml)
  if (document === undefined) return warnings

  for (const cell of elementsByTagName(document, 'mxCell')) {
    if (attributeValue(cell, 'vertex') !== '1') continue
    const rawValue = attributeValue(cell, 'value') ?? ''
    if (rawValue === '' || !WRAP_REQUIRED_REGEX.test(rawValue)) continue
    const styleAttribute = attributeValue(cell, 'style') ?? ''
    if (!isBoxShape(styleAttribute) || hasWhitespaceWrap(styleAttribute)) continue
    const cellId = attributeValue(cell, 'id') ?? '?'
    // grapheme cluster 単位で 20 文字に切るため、Intl.Segmenter を使う。
    // surrogate pair の絵文字や合成文字は、途中で切らない。
    // CR と LF は、エスケープした文字列で出して見えるようにする。
    const graphemes: string[] = []
    const graphemeSegments = new Intl.Segmenter().segment(rawValue)
    for (const { segment } of graphemeSegments) {
      graphemes.push(segment)
    }
    const preview = graphemes.slice(0, 20).join('')
      .replaceAll('\r', String.raw`\r`)
      .replaceAll('\n', String.raw`\n`)
    const ellipsis = graphemes.length > 20 ? '…' : ''
    warnings.push(
      `[warn] mxCell id=${cellId}: 折り返しが必要な value (日本語/改行を含む) ですが style に whiteSpace=wrap がありません — value 先頭: "${preview}${ellipsis}"。style に whiteSpace=wrap を付けてください`,
    )
  }

  return warnings
}

const JAPANESE_REGEX = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u
const BLANK_TEXT_REGEX = /^(?:\s|&nbsp;|&#160;)*$/i
const HTML_TOKEN_REGEX = /<(\/?)([a-z][a-z\d]*)\b([^>]*)>|([^<]+)/gi
const HTML_VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'wbr'])
const FONT_FACE_ATTR_REGEX = /\bface\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const FONT_SIZE_ATTR_REGEX = /\bsize\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const STYLE_ATTR_VALUE_REGEX = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const WHITESPACE_REGEX = /\s+/
const PIXEL_SIZE_REGEX = /^[\d.]+(?:px)?$/
const FONT_SHORTHAND_SIZE_REGEX = /^(?:[\d.]+(?:px|em|rem|pt|%|ex|ch|vw|vh|cm|mm|in|pc)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i

// 総称の等幅。この書体を並びに含む文字列はコードとみなし、書体の確認から外す。
const MONOSPACE_FONT = 'monospace'
// 直し方の案の末尾に足す総称の書体
const FALLBACK_GENERIC_FONT = 'sans-serif'

/**
確かめる書体。テーマの宣言の `fonts.body` と `fonts.eastAsian` に当たる。
*/
export interface ThemeFonts {
  readonly body: readonly string[]
  readonly eastAsian?: string | undefined
}

/**
確かめる文字サイズ（px）。テーマの宣言の `fontSizes` に当たる。
*/
export interface ThemeFontSizes {
  readonly heading: number
  readonly headingSm: number
  readonly body: number
  readonly bodySm: number
  readonly label: number
}

/**
文言に書く確認元。テーマ名があれば「テーマの書体（名前）」、無ければ「既定の書体」。
*/
function fontSourceLabel(themeName: string | undefined): string {
  return themeName === undefined ? '既定の書体' : `テーマの書体（${themeName}）`
}

/**
直し方に書く fontFamily の値。body と eastAsian の重複（大文字小文字を除く）を除いて `, ` でつなぐ。
並びが総称の書体で終わらなければ、末尾に sans-serif を足す。
宣言の書体が端末と Web フォントのどちらにも無いときに、英字がセリフ体で描かれるのを防ぐ。
*/
function fontFamilyAdvice(fonts: Readonly<ThemeFonts>): string {
  const seen = new Set<string>()
  const names: string[] = []
  for (const raw of [...fonts.body, ...(fonts.eastAsian === undefined ? [] : [fonts.eastAsian])]) {
    const name = raw.trim()
    if (name === '' || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    names.push(name)
  }
  if (!isGenericFamily(names.at(-1) ?? '')) names.push(FALLBACK_GENERIC_FONT)
  return names.join(', ')
}

function fontSizeGuide(sizes: Readonly<ThemeFontSizes>): string {
  const values = [sizes.heading, sizes.headingSm, sizes.body, sizes.bodySm, sizes.label]
  const roles = `見出し ${String(sizes.heading)}・小見出し ${String(sizes.headingSm)}・本文 ${String(sizes.body)}`
    + `・補足 ${String(sizes.bodySm)}・ラベル ${String(sizes.label)}`
  return `使えるサイズは ${values.map(String).join('・')}px の 5 つだけです（${roles}）`
}
// draw.io は fontSize 未指定のセルを 11px で描く
const DRAWIO_DEFAULT_FONT_SIZE = 11

type FontList = readonly string[]

/**
font-family の列挙を書体の並びにする（引用符を除き小文字化）。
*/
function parseFontList(fontFamilyList: string): FontList {
  return fontFamilyList.split(',')
    .map(font => font.trim().replaceAll(/^["']|["']$/g, '').trim().toLowerCase())
    .filter(font => font !== '')
}

/**
文字サイズの指定。px は数値にし、px 以外（em・% など）は px が NaN で指定文字列を残す。
*/
interface SizeSpec {
  readonly raw: string
  readonly px: number
}

function parseSize(raw: string): SizeSpec {
  const trimmed = raw.trim()
  const lowered = trimmed.toLowerCase()
  return { raw: trimmed, px: PIXEL_SIZE_REGEX.test(lowered) ? Number(lowered.replace(/px$/, '')) : NaN }
}

/**
`;` 区切りの宣言列（draw.io の style は `=`、CSS の style 属性は `:` 区切り）を [名前, 値] にする。
*/
function declarations(style: string, separator: '=' | ':'): readonly (readonly [name: string, value: string])[] {
  const result: (readonly [string, string])[] = []
  for (const part of style.split(';')) {
    const index = part.indexOf(separator)
    if (index === -1) continue
    result.push([part.slice(0, index).trim(), part.slice(index + 1).trim()])
  }
  return result
}

/**
値の出どころ。cell は mxCell の style、html は value の HTML 内の指定。
*/
type Source = 'none' | 'cell' | 'html'

/**
文字列に適用される書体と大きさ。HTML のタグスタックで継承する。
*/
interface TextState {
  readonly font: FontList | undefined
  readonly fontSource: Source
  readonly size: SizeSpec
  readonly sizeSource: Source
  /**
  祖先の `<font size>` の指定（使えない旧属性なので、あれば内側の文字すべてが対象）
  */
  readonly fontSizeAttribute: string | undefined
}

interface TextRun extends TextState {
  readonly text: string
}

interface TextWalk {
  readonly runs: readonly TextRun[]
  /**
  読み取れなかった CSS の `font:` 一括指定
  */
  readonly unreadableShorthands: readonly string[]
}

/**
`font: 14px/1.5 Fira Code` のような一括指定から書体とサイズを読む。読めなければ undefined。
*/
function parseFontShorthand(value: string): { readonly size: string, readonly family: string } | undefined {
  const tokens = value.trim().split(WHITESPACE_REGEX)
  const index = tokens.findIndex(token => FONT_SHORTHAND_SIZE_REGEX.test(token.split('/', 1)[0] ?? token))
  const sizeToken = index === -1 ? undefined : tokens.at(index)
  return sizeToken === undefined || index === tokens.length - 1 ? undefined : { size: sizeToken.split('/', 1)[0] ?? sizeToken, family: tokens.slice(index + 1).join(' ') }
}

/**
タグの style 属性の中身。引用符は &quot; 等の実体参照で届き、`;` で宣言が切れるため先に戻す。
*/
function tagStyle(attributes: string): string {
  const match = STYLE_ATTR_VALUE_REGEX.exec(attributes)
  return (match?.[1] ?? match?.[2] ?? '').replaceAll('&quot;', '"').replaceAll('&#39;', '\'')
}

/**
開きタグ 1 つが書体・大きさに与える上書きを state に適用する。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- shorthands は出力。読み取れなかった一括指定の出力先
function applyTag(tag: string, attributes: string, state: Readonly<TextState>, shorthands: string[]): TextState {
  let next = state
  if (tag === 'font') {
    const face = FONT_FACE_ATTR_REGEX.exec(attributes)
    const faceValue = face?.[1] ?? face?.[2]
    if (faceValue !== undefined) next = { ...next, font: parseFontList(faceValue), fontSource: 'html' }
    const size = FONT_SIZE_ATTR_REGEX.exec(attributes)
    const sizeValue = size?.[1] ?? size?.[2]
    if (sizeValue !== undefined) next = { ...next, fontSizeAttribute: sizeValue }
  }
  const declarationEntries = declarations(tagStyle(attributes), ':')
  for (const [name, value] of declarationEntries) {
    next = applyDeclaration(next, name, value, (unread) => {
      shorthands.push(unread)
    })
  }
  return next
}

/**
style 属性の宣言 1 つが書体・大きさに与える上書きを state に適用する。
*/
function applyDeclaration(
  state: Readonly<TextState>,
  name: string,
  value: string,
  onUnreadShorthand: (value: string) => void,
): TextState {
  switch (name.toLowerCase()) {
    case 'font-family': {
      return { ...state, font: parseFontList(value), fontSource: 'html' }
    }
    case 'font-size': {
      return { ...state, size: parseSize(value), sizeSource: 'html' }
    }
    case 'font': {
      const shorthand = parseFontShorthand(value)
      if (shorthand === undefined) {
        onUnreadShorthand(value)
        return state
      }
      return { ...state, font: parseFontList(shorthand.family), fontSource: 'html', size: parseSize(shorthand.size), sizeSource: 'html' }
    }
    default: {
      return state
    }
  }
}

/**
value の HTML を 1 回走査し、空でない文字列ごとに適用される書体と大きさを求める。
状態（書体・大きさ・`<font size>`）はタグスタックで継承し、閉じタグで開いたときの状態に戻る。
*/
function walkText(value: string, initial: Readonly<TextState>): TextWalk {
  const runs: TextRun[] = []
  const unreadableShorthands: string[] = []
  const stack: { readonly tag: string, readonly state: TextState }[] = []
  let current: TextState = initial
  for (const match of value.matchAll(HTML_TOKEN_REGEX)) {
    const text = match[4]
    if (text !== undefined) {
      if (!BLANK_TEXT_REGEX.test(text)) runs.push({ ...current, text: text.trim() })
      continue
    }
    const tag = (match[2] ?? '').toLowerCase()
    const attributes = match[3] ?? ''
    if (HTML_VOID_TAGS.has(tag) || attributes.trimEnd().endsWith('/')) continue
    if (match[1] === '/') {
      const index = stack.findLastIndex(entry => entry.tag === tag)
      const entry = stack.at(index)
      if (index !== -1 && entry !== undefined) {
        current = entry.state
        stack.length = index
      }
      continue
    }
    stack.push({ tag, state: current })
    current = applyTag(tag, attributes, current, unreadableShorthands)
  }
  return { runs, unreadableShorthands }
}

export interface TextCell {
  readonly id: string
  /**
  表示する文字列（mxCell の value、または包む object / UserObject の label）。HTML のことがある
  */
  readonly text: string
  readonly style: string
}

const WRAPPER_TAGS: ReadonlySet<string> = new Set(['object', 'userobject'])
const ELEMENT_NODE_TYPE = 1

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- xmldom は可変。Document / Element / Node は readonly 化できない
function isElement(node: XmldomNode | null): node is XmldomElement {
  return node !== null && node.nodeType === ELEMENT_NODE_TYPE
}

/**
文字を持つセルを列挙する。
`<object label>` / `<UserObject label>` に包まれた mxCell は、label を文字列として使う。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- xmldom は可変。Document / Element / Node は readonly 化できない
export function textCells(document: XmldomDocument): readonly TextCell[] {
  const cells: TextCell[] = []
  for (const cell of elementsByTagName(document, 'mxCell')) {
    const parent = cell.parentNode
    const wrapper = isElement(parent) && WRAPPER_TAGS.has(parent.nodeName.toLowerCase()) ? parent : undefined
    const text = (wrapper === undefined ? attributeValue(cell, 'value') : attributeValue(wrapper, 'label')) ?? ''
    if (text === '') continue
    cells.push({
      id: attributeValue(wrapper ?? cell, 'id') ?? attributeValue(cell, 'id') ?? '?',
      text,
      style: attributeValue(cell, 'style') ?? '',
    })
  }
  return cells
}

/**
セルの style（fontFamily・fontSize）から文字列の初期状態を作る。fontSize 未指定は draw.io 既定の 11px。
*/
function initialState(style: string): TextState {
  let font: FontList | undefined
  let size: SizeSpec | undefined
  for (const [name, value] of declarations(style, '=')) {
    if (name === 'fontFamily') font = parseFontList(value)
    else if (name === 'fontSize') size = parseSize(value)
  }
  return {
    font,
    fontSource: font === undefined ? 'none' : 'cell',
    size: size ?? { raw: `${String(DRAWIO_DEFAULT_FONT_SIZE)}px`, px: DRAWIO_DEFAULT_FONT_SIZE },
    sizeSource: size === undefined ? 'none' : 'cell',
    fontSizeAttribute: undefined,
  }
}

const SHORTHAND_WARNING = 'CSS の font 一括指定の書体とサイズを読み取れません。使わずに font-family と font-size を個別に指定してください'

/**
図の文字の書体がテーマの宣言の書体から外れる
mxCell への警告メッセージ配列を返す。
宣言の書体は、`fonts.body` と `eastAsian` の和集合を指す。
外れるとは、2 つの場合を指す。1 つは、先頭書体が宣言の書体でないこと（指定なしの draw.io 既定 Helvetica を含む）。
もう 1 つは、和文を含むのに書体の並びに `eastAsian` が無いこと。`eastAsian` を宣言しないテーマでは確かめない。
書体の並びに総称 `monospace` を含む文字列は、コードとみなして確かめない。
書体はセル style の fontFamily を初期値にして、文字列ごとに求める。
value の HTML（`<font face>`・`style="font-family:..."`・`style="font:..."`）の入れ子の内側では、上書きして求める。
`<object label>` / `<UserObject label>` に包まれたセルは、label を文字列として確認する。
themeName は文言に書くテーマの名前。省くと「既定の書体」と書く。
*/
export function validateSlideFonts(xml: string, fonts: Readonly<ThemeFonts>, themeName?: string): readonly string[] {
  const warnings: string[] = []
  const document = parseDrawioXml(xml)
  if (document === undefined) return warnings

  const eastAsian = fonts.eastAsian === undefined ? undefined : parseFontList(fonts.eastAsian)[0]
  const allowed: ReadonlySet<string> = new Set([...fonts.body.flatMap(name => parseFontList(name)), ...(eastAsian === undefined ? [] : [eastAsian])])
  const label = fontSourceLabel(themeName)
  const advice = fontFamilyAdvice(fonts)

  for (const cell of textCells(document)) {
    const { runs: allRuns, unreadableShorthands } = walkText(cell.text, initialState(cell.style))
    const runs = allRuns.filter(run => !(run.font?.includes(MONOSPACE_FONT) ?? false))
    const prefix = `[warn] mxCell id=${cell.id}:`
    for (const shorthand of unreadableShorthands) {
      warnings.push(`${prefix} font: ${shorthand} — ${SHORTHAND_WARNING}`)
    }
    const offTheme = runs.find(run => run.font?.[0] === undefined || !allowed.has(run.font[0]))
    if (offTheme !== undefined) {
      const actual = offTheme.font?.[0] === undefined ? '書体指定なし（draw.io 既定の Helvetica）' : `先頭書体「${offTheme.font[0]}」`
      const fix = offTheme.fontSource === 'html'
        ? `value 内の font-family 指定（<font face> や style の font-family）を消してください。書体はセルの style の fontFamily=${advice} に任せます`
        : `style に fontFamily=${advice} を付けてください`
      warnings.push(
        `${prefix} ${actual}の文字列が${label}ではありません — "${offTheme.text}"。図の文字は${label}で組みます。${fix}`,
      )
    }
    if (eastAsian === undefined || fonts.eastAsian === undefined) continue
    const missingJapanese = runs.find(run => JAPANESE_REGEX.test(run.text) && !(run.font?.includes(eastAsian) ?? false))
    if (missingJapanese === undefined) continue
    const fix = missingJapanese.fontSource === 'html'
      ? `value 内の font-family 指定（<font face> や style の font-family）を消すか ${advice} にしてください`
      : `fontFamily を ${advice} にしてください`
    warnings.push(
      `${prefix} 和文を含む文字列の書体の並びに ${fonts.eastAsian} がありません — "${missingJapanese.text}"。和文が代替書体で描かれます。${fix}`,
    )
  }

  return warnings
}

/**
規定外の文字サイズを、サイズの表示ラベルごとに最初の 1 件ずつ返す。
*/
function offSlideSizes(runs: readonly TextRun[], steps: ReadonlySet<number>): readonly (readonly [label: string, run: TextRun])[] {
  const found = new Map<string, TextRun>()
  for (const run of runs) {
    const label = run.fontSizeAttribute === undefined
      ? (Number.isNaN(run.size.px) ? run.size.raw : `${String(run.size.px)}px`)
      : `<font size="${run.fontSizeAttribute}">`
    if ((run.fontSizeAttribute !== undefined || Number.isNaN(run.size.px) || !steps.has(run.size.px)) && !found.has(label)) found.set(label, run)
  }
  return [...found]
}

function sizeCause(label: string, run: TextRun): string {
  if (run.fontSizeAttribute !== undefined) return `${label} は使えません`
  if (Number.isNaN(run.size.px)) return `文字サイズ ${label} は px 以外の指定です。px で指定してください`
  if (run.sizeSource === 'none') return 'fontSize 未指定（draw.io 既定の 11px）です'
  return `文字サイズ ${label} はテーマの規定外です`
}

/**
図の文字の大きさがテーマの宣言の 5 段（`fontSizes`）から外れる mxCell への、警告メッセージ配列を返す。
大きさはセル style の fontSize（未指定は draw.io 既定の 11px）を初期値にして、文字列ごとに求める。
value の HTML（`style="font-size:..."`・`style="font:..."`）の入れ子の内側では、上書きして求める。
`<font size>` は使わない前提で、出たら警告する。px 以外の単位は指定文字列を出して px での指定を案内する。
文字を持たないセルは対象外。
*/
export function validateSlideFontSizes(xml: string, sizes: Readonly<ThemeFontSizes>): readonly string[] {
  const warnings: string[] = []
  const document = parseDrawioXml(xml)
  if (document === undefined) return warnings

  const steps: ReadonlySet<number> = new Set([sizes.heading, sizes.headingSm, sizes.body, sizes.bodySm, sizes.label])
  const guide = fontSizeGuide(sizes)

  for (const cell of textCells(document)) {
    const { runs } = walkText(cell.text, initialState(cell.style))
    for (const [label, run] of offSlideSizes(runs, steps)) {
      const fix = run.sizeSource === 'html' || run.fontSizeAttribute !== undefined
        ? 'value 内の font-size 指定（<font size> や style の font-size）を消し、セルの style に fontSize=<サイズ> を付けてください'
        : 'style に fontSize=<サイズ> を付けてください'
      warnings.push(
        `[warn] mxCell id=${cell.id}: ${sizeCause(label, run)} — "${run.text}"。${guide}。${fix}`,
      )
    }
  }

  return warnings
}

function isBoxShape(style: string): boolean {
  const segments = style.split(';').map(s => s.trim()).filter(s => s.length > 0)
  if (segments.some(s => s.startsWith('edgeStyle='))) return false
  const first = segments[0] ?? ''
  // draw.io の rounded は boolean 値 (0/1) のみを取る。表記揺れ (rounded=true 等) は対象外。
  return ['', 'text', 'ellipse', 'swimlane'].includes(first)
    || segments.some(s => s.startsWith('shape=') || s === 'rounded=0' || s === 'rounded=1')
}

function hasWhitespaceWrap(style: string): boolean {
  return style.split(';').map(s => s.trim()).includes('whiteSpace=wrap')
}

/**
style="..." 属性内に現れる `icon://path#color` を resolveIcon 経由で
data URI に置換する。value 等のテキスト内容は対象外（Python リファレンスと同じ）。
*/
export function resolveIconsInStyle(xml: string, resolveIcon: IconResolver): string {
  return xml.replaceAll(STYLE_ATTR_REGEX, (_match, styleValue: string) => {
    let next = styleValue.replaceAll(ICON_WITH_COLOR_REGEX, (_full, iconReference: string, color: string) => {
      return resolveIcon(iconReference, color) ?? `icon://${iconReference}`
    })
    next = next.replaceAll(ICON_WITHOUT_COLOR_REGEX, (_full, iconReference: string) => {
      return resolveIcon(iconReference) ?? `icon://${iconReference}`
    })
    return `style="${next}"`
  })
}

/**
mxGeometry のバウンディングボックスから `viewbox=<json>` クエリ文字列を生成する。
Python `_calc_viewbox` と同等。viewbox 不要時は空文字を返す。
*/
export function calcViewbox(xml: string): string {
  const document = parseDrawioXml(xml)
  if (document === undefined) return ''

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const geo of elementsByTagName(document, 'mxGeometry')) {
    if (attributeValue(geo, 'as') !== 'geometry') continue
    const x = parseNumberAttribute(attributeValue(geo, 'x'))
    const y = parseNumberAttribute(attributeValue(geo, 'y'))
    const w = parseNumberAttribute(attributeValue(geo, 'width'))
    const h = parseNumberAttribute(attributeValue(geo, 'height'))
    if (w === 0 && h === 0) continue
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x + w > maxX) maxX = x + w
    if (y + h > maxY) maxY = y + h
  }

  if (minX === Infinity) return ''
  const pad = 20
  // Python `json.dumps` のデフォルト separator は (", ", ": ") のため、
  // JS の `JSON.stringify` (no-space) と異なる。viewbox 文字列を Python と
  // 一致させるため手動でフォーマットする。キー順は dict 挿入順 (x/y/width/height) を踏襲。
  const x = Math.trunc(minX - pad)
  const y = Math.trunc(minY - pad)
  const width = Math.trunc(maxX - minX + pad * 2)
  const height = Math.trunc(maxY - minY + pad * 2)
  const vb = `{"x": ${String(x)}, "y": ${String(y)}, "width": ${String(width)}, "height": ${String(height)}}`
  return `viewbox=${pythonQuote(vb)}`
}

/**
XML を draw.io URL の `#R<base64>` 部分にエンコードする。
手順は encodeURIComponent → deflateRaw(level=9) → base64 の順。
Python `_encode_data` と意味等価とする（zlib の flush 戦略が違うため、base64 の byte 完全一致は不可能）。
*/
export function encodeData(xml: string): string {
  const encoded = encodeURIComponent(xml)
  const deflated = deflateRawSync(Buffer.from(encoded, 'utf8'), { level: 9 })
  return deflated.toString('base64')
}

/**
encodeData の逆。base64 を展開し、URI エンコードを戻して XML を得る。
圧縮形式の <diagram> の中身（base64 → inflateRaw → decodeURIComponent）と同じ手順。
展開できないときは投げる。
*/
export function decodeData(data: string): string {
  const inflated = inflateRawSync(Buffer.from(data, 'base64')).toString('utf8')
  return decodeURIComponent(inflated)
}

/**
圧縮形式の <diagram> を列挙する。mxGraphModel を子に持たず、中身が文字列の <diagram> が対象。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- xmldom は可変。Document / Element / Node は readonly 化できない
export function compressedDiagrams(document: XmldomDocument): readonly { readonly id: string, readonly data: string }[] {
  const diagrams: { readonly id: string, readonly data: string }[] = []
  for (const diagram of elementsByTagName(document, 'diagram')) {
    if (elementsByTagName(document, 'mxGraphModel').some(model => model.parentNode === diagram)) continue
    const data = (diagram.textContent ?? '').trim()
    if (data === '') continue
    diagrams.push({ id: attributeValue(diagram, 'id') ?? '?', data })
  }
  return diagrams
}

/**
URL 生成前の共通の前処理（コメント除去と icon:// 解決）。
generateDrawioUrl / generateDrawioViewerUrl は、本関数を通した XML を受け取る前提。
呼び出し側が 1 回だけ実行して使い回す（resolveIcon の SVG 読み込みを重複させない）。
*/
export function prepareDrawioXml(xml: string, resolveIcon: IconResolver): string {
  return resolveIconsInStyle(stripComments(xml), resolveIcon)
}

// `mode` は cli-surface §2.4 で view/edit を受理する。
// ただし draw.io URL 仕様に mode クエリは存在しないため、生成 URL は同一（no-op）。
// Python リファレンスも view 固定。
export function generateDrawioUrl(preparedXml: string, _options: Readonly<GenerateDrawioUrlOptions>): string {
  const viewbox = calcViewbox(preparedXml)
  const prefix = viewbox === '' ? 'https://app.diagrams.net/' : `https://app.diagrams.net/?${viewbox}`
  return `${prefix}#R${encodeData(preparedXml)}`
}

/**
draw.io lightbox viewer 用の URL を生成する。
PNG 撮影用に editor UI を抑止する固定クエリ (`lightbox=1&edit=_blank&layers=1&nav=1&toolbar=0`) を付ける。
`viewbox` は付与せず、lightbox の scale-to-fit に任せる。
*/
export function generateDrawioViewerUrl(preparedXml: string): string {
  return `https://app.diagrams.net/?lightbox=1&edit=_blank&layers=1&nav=1&toolbar=0#R${encodeData(preparedXml)}`
}

/**
draw.io URL へ遷移する表示用 HTML を組み立てる。

URL は `<meta http-equiv="refresh">` と可視リンク `<a id="target">` の 2 箇所にだけ、
同じ HTML 属性エスケープを通した文字列として現れる。JS は URL を持たず、
`<a>` の href を読んで `location.replace` するだけなので、JS 文字列エスケープは不要。
これで 3 層になる。JS 有効なら location.replace、JS 無効なら meta refresh、
自動遷移が抑止される環境では手動クリックで遷移する。

`<meta charset>` を head の先頭に置くのは、file:// には Content-Type が無く
encoding sniffing の窓が先頭 1024 バイトしかないため。長大 URL を先に置くと窓から外れる。

生成時刻・乱数など非決定的な要素は含めない（同じ URL からは常に同じバイト列になる）。
*/
export function renderRedirectHtml(url: string): string {
  const escaped = escapeHtmlAttribute(url)
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0;url=${escaped}">`,
    '<title>draw.io ダイアグラム</title>',
    '</head>',
    '<body>',
    '<p>draw.io でダイアグラムを開いています。自動で開かない場合は次のリンクをクリックしてください。</p>',
    `<p><a id="target" href="${escaped}">draw.io でダイアグラムを開く</a></p>`,
    `<script>location.replace(document.getElementById('target').href)</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/**
二重引用符で囲む HTML 属性値のためのエスケープ。単引用符は属性の区切りでないため対象外。
*/
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
Python `urllib.parse.quote(safe="")` に揃えた percent-encoder。
`_.~-` 以外（A-Za-z0-9 含む英数記号と非 ASCII）をパーセントエンコードする。
`encodeURIComponent` は記号 5 種（感嘆符・アスタリスク・引用符・括弧 2 種）をそのまま通す。
`viewbox=` クエリの一致を担保するため、専用実装を持つ。
*/
function pythonQuote(value: string): string {
  const bytes = Buffer.from(value, 'utf8')
  let out = ''
  for (const byte of bytes) {
    const isSafe
      = (byte >= 0x30 && byte <= 0x39) // 0-9
        || (byte >= 0x41 && byte <= 0x5A) // A-Z
        || (byte >= 0x61 && byte <= 0x7A) // a-z
        || byte === 0x5F // _
        || byte === 0x2E // .
        || byte === 0x7E // ~
        || byte === 0x2D // -
    out += isSafe
      ? String.fromCodePoint(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

function parseNumberAttribute(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}
