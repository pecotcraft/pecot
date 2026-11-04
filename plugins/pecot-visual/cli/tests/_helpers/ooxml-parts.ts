// 生成 xlsx を zip エントリから読み解くための共通観測ヘルパー。
// integration (in-process) と e2e (実 CLI プロセス) の双方が同じ見方で
// パーツを覗けるよう、名前空間表と解決手順だけをここに集約する。
// 「何が入っているべきか」の期待値は各テストの主張なので持ち込まない。
//
// XPath は prefix 必須。sheet1.xml / workbook.xml は既定名前空間つき文書なので
// prefix なしの `//c` はヒットしない。

import { expect } from 'vitest'

import type { XmlDocument } from '../../src/domain/_shared/ports.js'
import { XmldomXmlEngine } from '../../src/infra/pptx-ooxml/xml-engine.js'

/**
xlsx の各パーツで使う名前空間 prefix。XPath の nsMap にそのまま渡す。
*/
export const OOXML_NS: Readonly<Record<string, string>> = {
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
}

/**
zip エントリ 1 件を XML として読む。未存在は明示的に失敗させる。
*/
export function parsePart(entries: ReadonlyMap<string, Buffer>, part: string): XmlDocument {
  const buffer = entries.get(part)
  if (buffer === undefined) {
    throw new Error(`zip に ${part} がありません (実在: ${entries.keys().toArray().join(', ')})`)
  }
  return new XmldomXmlEngine().parse(buffer)
}

/**
drawing1.xml.rels から rId → media パーツ名を解く (拡張子は偽装名ではなく実形式)。
*/
export function mediaPartsByRelationship(
  entries: ReadonlyMap<string, Buffer>,
): Map<string, string> {
  const rels = parsePart(entries, 'xl/drawings/_rels/drawing1.xml.rels')
  const resolved = new Map<string, string>()
  for (const node of rels.selectNodes('//rel:Relationship', OOXML_NS)) {
    const target = node.getAttr('Target') ?? ''
    resolved.set(node.getAttr('Id') ?? '', `xl/${target.replace('../', '')}`)
  }
  return resolved
}

/**
sheet1.xml の inline string を出現順に読む (行の昇順 → 列の昇順)。
*/
export function inlineStringTexts(sheet: Readonly<XmlDocument>): readonly string[] {
  return sheet.selectNodes('//s:c/s:is/s:t', OOXML_NS).map(node => node.text())
}

/**
stdout が単一行 JSON であることも含めて読む (--json の 1 イベント 1 行契約)。
*/
export function readSingleJsonEvent(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n').filter(line => line.length > 0)
  expect(lines).toHaveLength(1)
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りを narrowing
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>
}
