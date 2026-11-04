// プレビュー正規化の純粋関数群。
// dom-to-pptx 2.1.1 は nowrap 要素に `wrap="none"` + `<a:spAutoFit/>` を出力する。
// この組み合わせを LibreOffice が中心基準 auto-size で描画するため、
// コンテナ内 PDF プレビューで左揃えテキストが中央寄せ化する。
// 内包 pptxgenjs が 3.12.0 → 4.0.1 に上がっても、この組み合わせは維持される。
// #1062 の計測では、51 枚のデッキの検知件数は 1.1.10 / 2.1.1 とも 175 件で同数だった。
// 元 PPTX は変更せず、プレビュー専用コピーに対して `noAutofit` + `wrap="square"` へ置換する。
// 実装は XmlDocument / XmlNode ポート経由で行い、parse / serialize は commands 層の責務とする。

import { NAMESPACES } from './post-process.js'
import type { XmlDocument, XmlNode } from '../_shared/ports.js'
import { NS_DRAWINGML } from '../_shared/ooxml-uris.js'

/**
プレビュー差異の 1 件分の検知結果。`rule` は将来の差異ルール拡張に備えた
discriminated key。`shapeName` は `p:cNvPr/@name` が解決できた場合のみ付与し、
取れない場合は undefined で degrade する。
*/
export interface PreviewDivergenceFinding {
  readonly rule: 'spautofit-wrap-none'
  readonly shapeName?: string
}

// `wrap="none"` かつ子に `a:spAutoFit` を持つ bodyPr のみを対象とする。
// wrap=none と spAutoFit の片方だけを持つ要素は触らない。
const DIVERGENT_BODYPR_XPATH = '//a:bodyPr[@wrap=\'none\'][a:spAutoFit]'

/**
1 つの slide XML から、LibreOffice 描画差異を生む bodyPr を列挙する。

全 `selectNodes` 呼び出しに NAMESPACES nsMap を渡す（渡さないと prefix 未解決で
0 件になる）。slide 番号の付与は command 層が part 名から導出する。
*/
export function detectPreviewDivergence(
  slide: XmlDocument,
): readonly PreviewDivergenceFinding[] {
  const findings: PreviewDivergenceFinding[] = []
  for (const bodyPr of slide.selectNodes(DIVERGENT_BODYPR_XPATH, NAMESPACES)) {
    const shapeName = resolveShapeName(bodyPr)
    findings.push(
      shapeName === undefined
        ? { rule: 'spautofit-wrap-none' }
        : { rule: 'spautofit-wrap-none', shapeName },
    )
  }
  return findings
}

/**
検知対象の bodyPr を `wrap="square"` + `<a:noAutofit/>` に正規化する。

- `wrap` 属性を `square` に setAttr する（他属性は保存される）。
- 子 `a:spAutoFit` を `<a:noAutofit xmlns:a="…"/>` に replaceWithXml する。
  fragment parse 用に xmlns:a 宣言が必須。

冪等。正規化済み（noAutofit + wrap=square）の bodyPr は XPath にヒットしないため、再適用されない。
*/
export function applyPreviewNormalization(
  slide: XmlDocument,
): { readonly normalized: number } {
  let normalized = 0
  for (const bodyPr of slide.selectNodes(DIVERGENT_BODYPR_XPATH, NAMESPACES)) {
    bodyPr.setAttr('wrap', 'square')
    const [spAutoFit] = bodyPr.selectNodes('./a:spAutoFit', NAMESPACES)
    /* c8 ignore next 3 -- XPath が a:spAutoFit を子に持つ bodyPr のみを返すため undefined の分岐は到達不能 */
    if (spAutoFit === undefined) continue
    spAutoFit.replaceWithXml(`<a:noAutofit xmlns:a="${NS_DRAWINGML}"/>`)
    normalized += 1
  }
  return { normalized }
}

function resolveShapeName(bodyPr: XmlNode): string | undefined {
  const [cNvPr] = bodyPr.selectNodes(
    'ancestor::p:sp/p:nvSpPr/p:cNvPr',
    NAMESPACES,
  )
  if (cNvPr === undefined) return undefined
  const name = cNvPr.getAttr('name')
  return name === undefined || name === '' ? undefined : name
}
