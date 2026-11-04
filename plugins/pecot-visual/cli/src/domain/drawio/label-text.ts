// 図のセルが表示する文言を、文章規則に渡す形で取り出す純粋関数。
// fs / process には触れない（憲法 II）。

import { DOMParser, MIME_TYPE } from '@xmldom/xmldom'

import type { TextItem } from '../_shared/text-item.js'
import { compressedDiagrams, decodeData, parseDrawioXml, textCells } from './url.js'
import type { Document as XmldomDocument } from '@xmldom/xmldom'
import type { TextCell } from './url.js'

const BREAK_TAG_REGEX = /<br\s*\/?>/gi
const BLOCK_TAG_REGEX = /<\/?(?:div|p|li)\b[^>]*>/gi
const ANY_TAG_REGEX = /<[^>]*>/g
const NO_BREAK_SPACE_REGEX = /\u{A0}/gu
const BLANK_LINES_REGEX = /\n{2,}/g

// 不正な HTML でも例外にせず、読める分だけ読む（警告は出さない）
const HTML_PARSER = new DOMParser({
  onError: () => {
    // 警告は読み取りに影響しないので捨てる
  },
})

// mxGraph は style に html=1 があるセルの文言を HTML として表示する
function isHtmlCell(cell: Readonly<TextCell>): boolean {
  return cell.style.split(';').includes('html=1')
}

// 読めないときの退避で復号する実体。1 回の走査で置き換えるので、&amp;nbsp; は &nbsp; までしか戻らない
const FALLBACK_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['&nbsp;', ' '],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', '\''],
  ['&amp;', '&'],
])
const FALLBACK_ENTITY_REGEX = /&(?:nbsp|lt|gt|quot|#39|amp);/g

function decodeEntities(text: string): string {
  return text.replaceAll(FALLBACK_ENTITY_REGEX, entity => FALLBACK_ENTITIES.get(entity) ?? entity)
}

// 表示される文字だけを取り出す。<br> と div / p / li の境界は表示上の改行なので、改行にしてからタグを読む
function htmlToText(html: string): string {
  const withBreaks = html.replaceAll(BREAK_TAG_REGEX, '\n').replaceAll(BLOCK_TAG_REGEX, '\n')
  let text: string
  try {
    // 断片は根が 1 つとは限らないので div で包む。実体（&nbsp; 等）は復号される
    text = HTML_PARSER.parseFromString(`<div>${withBreaks}</div>`, MIME_TYPE.HTML).documentElement?.textContent ?? ''
  }
  catch {
    // 閉じていないタグ等で読めないときは、タグだけを除く
    text = decodeEntities(withBreaks.replaceAll(ANY_TAG_REGEX, ''))
  }
  return text.replaceAll(NO_BREAK_SPACE_REGEX, ' ').replaceAll(BLANK_LINES_REGEX, '\n').trim()
}

// 圧縮形式の <diagram> を展開した文書を返す。展開できないものは文言を確認できないので投げる
function expandedDocument(id: string, data: string): XmldomDocument {
  let expanded: XmldomDocument | undefined
  try {
    expanded = parseDrawioXml(decodeData(data))
  }
  catch {
    expanded = undefined
  }
  if (expanded === undefined) {
    throw new Error(`圧縮された図 (diagram id="${id}") を展開できないため、文言を確認できません`)
  }
  return expanded
}

/**
直接の文書と、圧縮形式の <diagram> を展開した文書を、図の順に返す。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- xmldom は可変。Document / Element / Node は readonly 化できない
function documentsToCheck(document: XmldomDocument): readonly XmldomDocument[] {
  return [document, ...compressedDiagrams(document).map(({ id, data }) => expandedDocument(id, data))]
}

/**
文言を持つセルの文言を列挙する。XML として読めない入力は空を返す。
圧縮形式の <diagram> は展開してから読む。展開できない図は文言を確認できないので投げる。
*/
export function labelTexts(xml: string): readonly TextItem[] {
  const document = parseDrawioXml(xml)
  if (document === undefined) return []
  const labels: TextItem[] = []
  for (const target of documentsToCheck(document)) {
    for (const cell of textCells(target)) {
      const text = isHtmlCell(cell) ? htmlToText(cell.text) : cell.text
      if (text.trim() === '') continue
      labels.push({ item: `mxCell id="${cell.id}"`, text })
    }
  }
  return labels
}
