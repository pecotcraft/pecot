// PPTX 後処理の純粋関数群。Python 版 postprocess.py の 3 つの transform を
// XmlDocument / XmlNode ポート経由で実装する。XmlEngine.parse / serialize は
// 呼ばない（commands 層の責務）。

import { doesContainJapanese, calculateSpcValue, type FontPolicy } from './font-policy.js'
import { escapeXmlAttribute } from './xml-escape.js'
import type { XmlDocument, XmlNode } from '../_shared/ports.js'
import { NS_DRAWINGML, NS_MARKUP_COMPATIBILITY, NS_OFFICE_RELATIONSHIPS, NS_PACKAGE_RELATIONSHIPS, NS_POWERPOINT_2010, NS_POWERPOINT_2015_09, NS_PRESENTATIONML, REL_TYPE_HYPERLINK } from '../_shared/ooxml-uris.js'

// Python 版 postprocess.py:29-48 と一致する OOXML 名前空間 URI。

export const NAMESPACES: Readonly<Record<string, string>> = {
  a: NS_DRAWINGML,
  p: NS_PRESENTATIONML,
  r: NS_OFFICE_RELATIONSHIPS,
  mc: NS_MARKUP_COMPATIBILITY,
  p14: NS_POWERPOINT_2010,
  p159: NS_POWERPOINT_2015_09,
}

const REL_NS: Readonly<Record<string, string>> = { rel: NS_PACKAGE_RELATIONSHIPS }

const URL_PATTERN = /^https?:\/\//

export interface LetterSpacingEntry {
  readonly letterSpacing: string
  readonly fontSize: string
}

export interface FontFixResult {
  readonly fontFixed: number
  readonly spacingFixed: number
}

export interface HyperlinkFixResult {
  readonly converted: number
}

export interface TransitionResult {
  readonly added: number
}

export type TransitionType = 'fade' | 'morph'

/**
Python 版 postprocess.py:83 `_fix_japanese_fonts_in_tree` を直訳。

Python と等価な sibling 順序を保つため、`<a:rPr>` 直下に `<a:latin>` が
存在すればその直後に `<a:ea>` を sibling 挿入する。`<a:latin>` が無い場合のみ
`rPr` 末尾に append する。Python 旧方式の `rpr.insert(latin_index + 1, ea_elem)`
と等価なノード並びを再現する。

`policy.ea` が無ければ東アジア書体は書かない。`letterSpacingMap` の `spc` の書き込みは続ける。
*/
export function applyJapaneseFontFix(
  slide: XmlDocument,
  policy: FontPolicy,
  letterSpacingMap: ReadonlyMap<string, LetterSpacingEntry>,
): FontFixResult {
  const { ea } = policy
  let fontFixed = 0
  let spacingFixed = 0

  for (const run of slide.selectNodes('//a:r', NAMESPACES)) {
    const [textElement] = run.selectNodes('.//a:t', NAMESPACES)
    if (textElement === undefined) continue
    const textContent = textElement.text()
    if (textContent === '') continue

    const [rpr] = run.selectNodes('.//a:rPr', NAMESPACES)
    if (rpr === undefined) continue

    if (ea !== undefined && doesContainJapanese(textContent)) {
      const [eaElement] = rpr.selectNodes('./a:ea', NAMESPACES)
      if (eaElement === undefined) {
        insertEaAfterLatin(rpr, ea)
      }
      else {
        eaElement.setAttr('typeface', ea)
      }
      fontFixed += 1
    }

    const spacingInfo = letterSpacingMap.get(textContent)
    if (spacingInfo === undefined) continue
    const spcValue = calculateSpcValue(spacingInfo.letterSpacing)
    rpr.setAttr('spc', String(spcValue))
    spacingFixed += 1
  }

  // endParaRPr 処理。段落末尾プロパティに対して、段落内テキスト連結が
  // 日本語を含む場合に typeface を ea に固定する。Python 版は parent から
  // `.//a:t/text()` で再帰的にテキストを集約しているため、`../descendant::a:t` で揃える。
  // ea が無ければ書体を書かないので、この処理ごと行わない。
  if (ea !== undefined) {
    for (const endParaRpr of slide.selectNodes('//a:endParaRPr', NAMESPACES)) {
      const textParts = endParaRpr.selectNodes('../descendant::a:t', NAMESPACES)
      const paragraphText = textParts.map(node => node.text()).join('')
      if (!doesContainJapanese(paragraphText)) continue

      const [eaElement] = endParaRpr.selectNodes('./a:ea', NAMESPACES)
      if (eaElement === undefined) {
        insertEaAfterLatin(endParaRpr, ea)
      }
      else {
        eaElement.setAttr('typeface', ea)
      }
    }
  }

  return { fontFixed, spacingFixed }
}

function insertEaAfterLatin(
  rpr: XmlNode,
  eaTypeface: string,
): void {
  const [latin] = rpr.selectNodes('./a:latin', NAMESPACES)
  if (latin === undefined) {
    rpr.appendChildXml(eaElementXml(eaTypeface))
  }
  else {
    latin.addNextSiblingXml(eaElementXml(eaTypeface))
  }
}

/**
次の CSS 専用キーワードは PowerPoint が解釈できない。
システム系は `-apple-system` / `BlinkMacSystemFont` / `system-ui`。
総称系は `sans-serif` / `serif` / `monospace` / `cursive` / `fantasy`。
CSS の値は `inherit` / `initial` / `unset`。
そのため `<a:latin>` / `<a:ea>` / `<a:cs>` の typeface 属性が該当 token に一致する場合は、当該要素を削除する。
これにより fallback が働く。
fallback 先は slide layout / theme1.xml の `<a:fontScheme>` (theme font)。
具体的には `+mj-lt` / `+mn-lt` / `+mj-ea` / `+mn-ea` を指す。
視覚的な fallback の質が改善する。
dom-to-pptx は CSS の `font-family: -apple-system, ...` をそのまま typeface 属性に書き出してしまう。
その挙動を補正する。
*/
const CSS_ONLY_TYPEFACE_PATTERN
  = /^(?:-apple-system|BlinkMacSystemFont|system-ui|-?webkit-system[a-z-]*|sans-serif|serif|monospace|cursive|fantasy|inherit|initial|unset)$/

export function sanitizeCssOnlyTypefaces(slide: XmlDocument): { readonly removed: number } {
  let removed = 0
  for (const xpath of ['//a:latin', '//a:ea', '//a:cs']) {
    for (const element of slide.selectNodes(xpath, NAMESPACES)) {
      const typeface = element.getAttr('typeface') ?? ''
      if (!CSS_ONLY_TYPEFACE_PATTERN.test(typeface)) {
        continue
      }

      element.remove()
      removed += 1
    }
  }
  return { removed }
}

/**
スライドから出現アニメーションを取り除く（#1070）。

`/p:sld/p:timing` を要素ごと削除する。
効果の時間木 `p:tnLst` と段階表示の宣言 `p:bldLst` は、その配下にあるため、まとめて外れる。
図形側に掃除すべき痕跡は残らない。
計測では、timing を外したスライドの要素構成が、アニメーションを持たないスライドと一致した。
`//p:timing` は使わず、`/p:sld/p:timing` だけを対象とする。
将来 `p:extLst` 配下で同名要素が現れても、巻き込まないため。

どのスライドに対して呼ぶかの判断（方針の本文）は commands/slidev-to-pptx/convert.ts が持つ。
*/
export function removeAnimationTiming(slide: XmlDocument): { readonly removed: number } {
  let removed = 0
  for (const timing of slide.selectNodes('/p:sld/p:timing', NAMESPACES)) {
    timing.remove()
    removed += 1
  }
  return { removed }
}

/**
Python 版 postprocess.py:204 `_fix_hyperlinks_in_tree` を直訳。

引数 `relsDocument` は、呼び出し元で必ず Document 化された状態にしておくこと。
Python 版の `if rels_tree is None: rels_tree = etree.Element(...)` 相当の新規生成は、
infra 層 / commands 層の責務。
*/
export function applyHyperlinkFix(
  slide: XmlDocument,
  rels: XmlDocument,
  hrefMap: ReadonlyMap<string, string>,
  linkColor: string | undefined,
): HyperlinkFixResult {
  // リンク色の宣言が無いテーマでは、どの run がリンクかを決められない。置換しない。
  if (linkColor === undefined) return { converted: 0 }
  let converted = 0
  const linkColorUpper = linkColor.toUpperCase()

  let nextRid = computeNextRid(rels)

  for (const run of slide.selectNodes('//a:r', NAMESPACES)) {
    const [textElement] = run.selectNodes('./a:t', NAMESPACES)
    if (textElement === undefined) continue
    const text = textElement.text().trim()
    if (text === '') continue

    const [rpr] = run.selectNodes('./a:rPr', NAMESPACES)
    if (rpr === undefined) continue

    const [srgbClr] = rpr.selectNodes('./a:solidFill/a:srgbClr', NAMESPACES)
    if (srgbClr === undefined) continue

    const colorValue = srgbClr.getAttr('val') ?? ''
    if (colorValue.toUpperCase() !== linkColorUpper) continue

    const [existingHlink] = rpr.selectNodes('./a:hlinkClick', NAMESPACES)
    if (existingHlink !== undefined) continue

    const url = hrefMap.get(text) ?? (URL_PATTERN.test(text) ? text : undefined)
    if (url === undefined) continue

    const newRid = `rId${String(nextRid)}`
    nextRid += 1

    const relsXml
      = `<rel:Relationship xmlns:rel="${NS_PACKAGE_RELATIONSHIPS}"`
        + ` Id="${escapeXmlAttribute(newRid)}"`
        + ` Type="${escapeXmlAttribute(REL_TYPE_HYPERLINK)}"`
        + ` Target="${escapeXmlAttribute(url)}"`
        + ` TargetMode="External"/>`
    rels.appendChildXml(relsXml)

    const hlinkXml
      = `<a:hlinkClick xmlns:a="${NS_DRAWINGML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}"`
        + ` r:id="${escapeXmlAttribute(newRid)}"/>`
    rpr.appendChildXml(hlinkXml)

    converted += 1
  }

  return { converted }
}

function computeNextRid(rels: XmlDocument): number {
  let max = 0
  for (const relationship of rels.selectNodes('//rel:Relationship', REL_NS)) {
    const id = relationship.getAttr('Id') ?? ''
    if (!id.startsWith('rId')) continue
    const tail = id.slice(3)
    const n = Math.trunc(Number(tail))
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

/**
Python 版 postprocess.py:309 `_add_transition_to_tree` を直訳。

既存 `<p:transition>` および `<mc:AlternateContent>` 内の transition を削除した上で
指定タイプのトランジションを挿入する。

挿入位置は、ECMA-376 (CT_Slide) が定める slide 直下の要素順序 `cSld → clrMapOvr → transition → timing` に合わせる。
具体的には clrMapOvr（無ければ cSld）の直後に置く。
root 末尾へ append すると、`<p:timing>` を持つ slide で transition が timing の後ろに回り、順序が崩れる。
*/
export function applyTransition(
  slide: XmlDocument,
  type: TransitionType,
  durationMs: number,
  options: { readonly morphOption?: 'byObject' | 'byWord' | 'byChar' } = {},
): TransitionResult {
  for (const existing of slide.selectNodes('/*/p:transition', NAMESPACES)) {
    existing.remove()
  }

  for (const ac of slide.selectNodes('/*/mc:AlternateContent', NAMESPACES)) {
    const inner = ac.selectNodes('.//p:transition', NAMESPACES)
    if (inner.length > 0) ac.remove()
  }

  const morphOption = options.morphOption ?? 'byObject'
  const xml = type === 'morph'
    ? buildMorphTransitionXml(durationMs, morphOption)
    : buildFadeTransitionXml(durationMs)

  const anchor = slide.selectNodes('/*/p:clrMapOvr', NAMESPACES).at(-1)
    ?? slide.selectNodes('/*/p:cSld', NAMESPACES).at(-1)
  if (anchor === undefined) {
    // cSld を欠く slide は schema 上あり得ないが、位置決めできない場合の防御として末尾へ置く。
    slide.appendChildXml(xml)
  }
  else {
    anchor.addNextSiblingXml(xml)
  }
  return { added: 1 }
}

function eaElementXml(typeface: string): string {
  return `<a:ea xmlns:a="${NS_DRAWINGML}" typeface="${escapeXmlAttribute(typeface)}"/>`
}

function buildMorphTransitionXml(
  durationMs: number,
  morphOption: 'byObject' | 'byWord' | 'byChar',
): string {
  return `<mc:AlternateContent xmlns:mc="${NS_MARKUP_COMPATIBILITY}">`
    + `<mc:Choice xmlns:p159="${NS_POWERPOINT_2015_09}" Requires="p159">`
    + `<p:transition xmlns:p="${NS_PRESENTATIONML}" xmlns:p14="${NS_POWERPOINT_2010}" p14:dur="${String(durationMs)}">`
    + `<p159:morph option="${escapeXmlAttribute(morphOption)}"/>`
    + '</p:transition>'
    + '</mc:Choice>'
    + '<mc:Fallback>'
    + `<p:transition xmlns:p="${NS_PRESENTATIONML}">`
    + '<p:fade/>'
    + '</p:transition>'
    + '</mc:Fallback>'
    + '</mc:AlternateContent>'
}

function buildFadeTransitionXml(durationMs: number): string {
  return `<mc:AlternateContent xmlns:mc="${NS_MARKUP_COMPATIBILITY}">`
    + `<mc:Choice xmlns:p14="${NS_POWERPOINT_2010}" Requires="p14">`
    + `<p:transition xmlns:p="${NS_PRESENTATIONML}" p14:dur="${String(durationMs)}">`
    + '<p:fade/>'
    + '</p:transition>'
    + '</mc:Choice>'
    + '<mc:Fallback>'
    + `<p:transition xmlns:p="${NS_PRESENTATIONML}">`
    + '<p:fade/>'
    + '</p:transition>'
    + '</mc:Fallback>'
    + '</mc:AlternateContent>'
}
