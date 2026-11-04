// xpath-cases.yml ベースで PPTX から XPath 値を抽出するための共通ヘルパ。
// `globToRegex` / `extractFromPptx` / `aggregateCount` をここへ集約する。
//
// 対応する extract method は、リポジトリ内の利用実態に合わせて
// `count` / `attr:<name>` / `text` の 3 種類のみ。
/* eslint-disable security/detect-non-literal-regexp */

import { XmldomXmlEngine } from '../../src/infra/pptx-ooxml/xml-engine.js'
import { YauzlYazlPptxArchive } from '../../src/infra/pptx-ooxml/archive.js'
import type { XmlDocument } from '../../src/domain/_shared/ports.js'

export interface ExtractedValue {
  readonly part: string
  /**
  `count` なら該当ノード数、`attr:<name>` / `text` なら各ノードの属性値 / テキスト。
  */
  readonly value: number | readonly string[]
}

/**
`ppt/slides/slide*.xml` のような glob を `^ppt/slides/slide[^/]*\.xml$` 相当の
正規表現へ変換する。Python 版 fnmatch 互換 (アスタリスクのみ。疑問符とブラケット表記は未対応) で十分。
*/
export function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll('*', '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/**
単一 part の document へ xpath と extract method を適用する。
未対応の method は yml / 呼び出し側の設定ミスなので、暗黙の fallback を返さず失敗させる。
*/
export function extractFromDocument(
  document: XmlDocument,
  xpath: string,
  method: string,
  namespaces: Readonly<Record<string, string>>,
): number | readonly string[] {
  const nodes = document.selectNodes(xpath, namespaces)
  if (method === 'count') return nodes.length
  if (method === 'text') return nodes.map(n => n.text())
  if (method.startsWith('attr:')) {
    const attributeName = method.slice('attr:'.length)
    return nodes.map(n => n.getAttr(attributeName) ?? '')
  }
  throw new Error(`未対応の extract method: ${method} (count / attr:<name> / text のみ対応)`)
}

/**
PPTX の各 part を読みつつ、xpath / extract method を適用して値を抽出する。
*/
export async function extractFromPptx(
  pptxPath: string,
  partGlobs: readonly string[],
  xpath: string,
  method: string,
  namespaces: Readonly<Record<string, string>>,
): Promise<readonly ExtractedValue[]> {
  const archive = new YauzlYazlPptxArchive()
  const reader = await archive.read(pptxPath)
  const engine = new XmldomXmlEngine()
  const matched: ExtractedValue[] = []
  try {
    const compiled = partGlobs.map(g => globToRegex(g))
    for await (const entry of reader.entries()) {
      if (compiled.every(re => !re.test(entry.part))) continue
      const buffer = await entry.read()
      const document = engine.parse(buffer)
      matched.push({
        part: entry.part,
        value: extractFromDocument(document, xpath, method, namespaces),
      })
    }
  }
  finally {
    await reader.close()
  }
  return matched.toSorted((a, b) => a.part.localeCompare(b.part))
}

/**
`count` 抽出の ExtractedValue 群を全 part 合計へ集約する。
戻り型を number に固定することで、呼び出し側が union の narrowing 無しに
`toBeGreaterThanOrEqual` 等の数値 matcher へ渡せるようにする。
*/
export function aggregateCount(values: readonly ExtractedValue[]): number {
  let total = 0
  for (const v of values) {
    if (typeof v.value === 'number') total += v.value
  }
  return total
}
