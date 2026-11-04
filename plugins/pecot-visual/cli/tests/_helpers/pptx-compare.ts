// 2 つの PPTX を XPath 抽出値レベルで相互比較するヘルパ（#897 US2 / SC-003・FR-008）。
//
// 「全変換の出力」と「差分変換の出力」が同じかを、正解源（golden）を持たずに判定するための
// 共有ロジック。統合テスト（fake 変換）・e2e（実 Chromium）・実機検証（外部 pptx モード）の
// 3 箇所から同じ観点で使う。
// pptx 全体のバイト一致は課さない（spec 009-pptx-diff-cache の Assumptions）。
// ただし `ppt/media/` は差分キャッシュの主成果物なので、標準では内容ハッシュまで見る。
//
// 比較観点（contracts/cache-interface.md §4）を次に示す。
//   - `p:sldIdLst/p:sldId` の件数。
//     merge の rebuildSldIdLst が id / r:id を件数から決定論的に再構築する。
//     そのため、この比較は「枚数が同じ」以上の意味を持たない。
//     **順序は part 索引（ppt/slides/slideN.xml）ごとの内容比較で担保する**。
//   - 形状座標 `//a:xfrm/a:off` の x / y、`//a:xfrm/a:ext` の cx / cy。
//   - テキスト `//a:t`。
//   - フォント `//a:rPr/a:latin` / `//a:rPr/a:ea` の typeface。
//   - 文字詰め `//a:rPr` の spc。
//   - ハイパーリンク `//a:rPr/a:hlinkClick` の r:id。
//   - `ppt/slides/_rels/slideN.xml.rels` の Relationship（Id / Type / Target）。
//   - スライドごとの `//a:blip` 件数と、`ppt/media/` の part 名 → 内容ハッシュ / PNG 寸法。

import { createHash } from 'node:crypto'

import { expect } from 'vitest'

import { YauzlYazlPptxArchive } from '../../src/infra/pptx-ooxml/archive.js'
import { XmldomXmlEngine } from '../../src/infra/pptx-ooxml/xml-engine.js'
import type { XmlDocument } from '../../src/domain/_shared/ports.js'
import { extractFromDocument } from './xpath-extract.js'
import { compareStrings } from '../../src/domain/_shared/compare-strings.js'

const NAMESPACES: Readonly<Record<string, string>> = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
}

const SLIDE_PART_PATTERN = /^ppt\/slides\/slide\d+\.xml$/
const SLIDE_RELS_PART_PATTERN = /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/
const MEDIA_PART_PREFIX = 'ppt/media/'

interface ValueSpec {
  readonly name: string
  readonly xpath: string
  /**
  `attr:<name>` / `text`。count 観点は本ヘルパでは使わない（型が union になるため）
  */
  readonly method: string
}

const SLIDE_VALUE_SPECS: readonly ValueSpec[] = [
  { name: 'offX', xpath: '//a:xfrm/a:off', method: 'attr:x' },
  { name: 'offY', xpath: '//a:xfrm/a:off', method: 'attr:y' },
  { name: 'extCx', xpath: '//a:xfrm/a:ext', method: 'attr:cx' },
  { name: 'extCy', xpath: '//a:xfrm/a:ext', method: 'attr:cy' },
  { name: 'text', xpath: '//a:t', method: 'text' },
  { name: 'latinTypeface', xpath: '//a:rPr/a:latin', method: 'attr:typeface' },
  { name: 'eaTypeface', xpath: '//a:rPr/a:ea', method: 'attr:typeface' },
  { name: 'spc', xpath: '//a:rPr', method: 'attr:spc' },
  { name: 'hlinkRid', xpath: '//a:rPr/a:hlinkClick', method: 'attr:r:id' },
]

/**
PNG の IHDR 由来の寸法。
*/
export interface PngDimensions {
  readonly width: number
  readonly height: number
}

/**
`ppt/media/` の 1 part 分。
*/
export interface MediaValues {
  readonly sha256: string
  readonly byteLength: number
  /**
  PNG 以外・IHDR を読めない場合は undefined
  */
  readonly png: PngDimensions | undefined
}

/**
1 スライド part 分の観点別の値。
*/
export interface SlideValues {
  /**
  観点名 → 抽出した値の配列（全観点が文字列の配列。count 観点は blipCount に分離してある）
  */
  readonly values: Readonly<Record<string, readonly string[]>>
  readonly blipCount: number
}

export interface PptxSnapshot {
  /**
  比較対象のパス（不一致メッセージに出す）
  */
  readonly path: string
  /**
  `p:sldIdLst/p:sldId` の件数
  */
  readonly sldIdCount: number
  /**
  part 名（`ppt/slides/slideN.xml`）→ 観点別の値
  */
  readonly slides: Readonly<Record<string, SlideValues>>
  /**
  part 名（`ppt/slides/_rels/slideN.xml.rels`）→ `Id|Type|Target` の列
  */
  readonly slideRels: Readonly<Record<string, readonly string[]>>
  /**
  part 名（`ppt/media/*`）→ 内容ハッシュと PNG 寸法
  */
  readonly media: Readonly<Record<string, MediaValues>>
}

/**
退化検知の強さ。実デッキには画像のみのスライドがあり得るため、外部比較では緩める。
*/
export type DegeneracyGate = 'per-slide' | 'deck'

/**
media の比較の強さ。実変換の非決定性が測定された環境では 'dimensions' に落とす。
*/
export type MediaComparison = 'sha256' | 'dimensions'

export interface ComparisonOptions {
  /**
  デッキ枚数の絶対値。外部 pptx モードのように事前に確定しない場合は省略する
  */
  readonly expectedSlideCount?: number
  /**
  既定 'per-slide'（合成デッキは全スライドがテキストと座標を持つ前提で書ける）
  */
  readonly degeneracyGate?: DegeneracyGate
  /**
  既定 'sha256'
  */
  readonly mediaComparison?: MediaComparison
}

/**
文字列の配列を返す観点だけを扱う。
`extractFromDocument` は count 観点のために `number | readonly string[]` を返す。
本ヘルパは count 観点を使わないため、number が来たら設定ミスとして落とす。
通知なしに空配列へ置き換えると、比較が恒真になる。
*/
function stringValuesOf(document: XmlDocument, spec: Readonly<ValueSpec>): readonly string[] {
  const value = extractFromDocument(document, spec.xpath, spec.method, NAMESPACES)
  if (typeof value === 'number') {
    throw new TypeError(`観点 ${spec.name} に count 系 method (${spec.method}) は使えません`)
  }
  return value
}

function pngDimensionsOf(buffer: Readonly<Buffer>): PngDimensions | undefined {
  if (buffer.length < 24) return undefined
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
  return isPng && (buffer.subarray(12, 16).toString('ascii') === 'IHDR') ? { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) } : undefined
}

/**
part 名をキーにした決定論的な Record へ畳む（part 名の昇順）。
*/
function byPartName<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)))
}

/**
PPTX を 1 度だけ開いて全観点の値を集める。part ごとに `extractFromPptx` を呼ぶと
観点数だけ zip を開き直すため、ここでは archive を 1 回開いて全 spec を適用する。
*/
export async function snapshotPptx(pptxPath: string): Promise<PptxSnapshot> {
  const archive = new YauzlYazlPptxArchive()
  const engine = new XmldomXmlEngine()
  const reader = await archive.read(pptxPath)
  const slideEntries: [string, SlideValues][] = []
  const relsEntries: [string, readonly string[]][] = []
  const mediaEntries: [string, MediaValues][] = []
  let sldIdCount = 0
  try {
    for await (const entry of reader.entries()) {
      if (entry.part.startsWith(MEDIA_PART_PREFIX)) {
        const buffer = await entry.read()
        mediaEntries.push([entry.part, {
          sha256: createHash('sha256').update(buffer).digest('hex'),
          byteLength: buffer.length,
          png: pngDimensionsOf(buffer),
        }])
        continue
      }
      if (entry.part === 'ppt/presentation.xml') {
        const document = engine.parse(await entry.read())
        sldIdCount = document.selectNodes('//p:sldIdLst/p:sldId', NAMESPACES).length
        continue
      }
      if (SLIDE_RELS_PART_PATTERN.test(entry.part)) {
        const document = engine.parse(await entry.read())
        relsEntries.push([
          entry.part,
          document.selectNodes('//rel:Relationship', NAMESPACES).map(node =>
            [node.getAttr('Id') ?? '', node.getAttr('Type') ?? '', node.getAttr('Target') ?? ''].join('|'),
          ).toSorted(compareStrings),
        ])
        continue
      }
      if (!SLIDE_PART_PATTERN.test(entry.part)) continue
      const document = engine.parse(await entry.read())
      slideEntries.push([entry.part, {
        values: Object.fromEntries(
          SLIDE_VALUE_SPECS.map(spec => [spec.name, stringValuesOf(document, spec)]),
        ),
        blipCount: document.selectNodes('//a:blip', NAMESPACES).length,
      }])
    }
  }
  finally {
    await reader.close()
  }
  return {
    path: pptxPath,
    sldIdCount,
    slides: byPartName(slideEntries),
    slideRels: byPartName(relsEntries),
    media: byPartName(mediaEntries),
  }
}

/**
snapshot から 1 観点の値を取り出す（未知の観点名は空配列）。
*/
export function valuesOf(slide: Readonly<SlideValues>, name: string): readonly string[] {
  return new Map(Object.entries(slide.values)).get(name) ?? []
}

/**
part 名（`ppt/slides/slideN.xml`）の N 昇順にスライドを並べる。
*/
export function slidesInOrder(snapshot: Readonly<PptxSnapshot>): readonly SlideValues[] {
  return Object.entries(snapshot.slides)
    .map(([part, values]) => ({ number: Math.trunc(Number(/slide(\d+)\.xml$/.exec(part)?.[1] ?? '0')), values }))
    .toSorted((left, right) => left.number - right.number)
    .map(entry => entry.values)
}

/**
どちらの出力も空 / 破損している場合に比較が恒真になる、silent-green を防ぐ絶対値の下限検証。
比較の前に各出力単体へ当てる。

`degeneracyGate: 'deck'` は実デッキ向け。
テキストと xfrm を持たない画像のみのスライドは、正常な実デッキにも含まれる。
そのため per-slide で要求すると、正しい出力で落ちる。
*/
function assertPptxNotDegenerate(
  snapshot: Readonly<PptxSnapshot>,
  options: Readonly<ComparisonOptions>,
): void {
  const label = snapshot.path
  const entries = Object.entries(snapshot.slides)
  expect(entries.length, `${label}: slide part が 0 件`).toBeGreaterThan(0)
  expect(snapshot.sldIdCount, `${label}: sldIdLst 件数が slide part 件数と不一致`).toBe(entries.length)
  if (options.expectedSlideCount !== undefined) {
    expect(entries.length, `${label}: slide part 件数がデッキ枚数と不一致`).toBe(options.expectedSlideCount)
  }
  expect(Object.keys(snapshot.media).length, `${label}: ppt/media/ が 0 件`).toBeGreaterThan(0)

  const hasText = (values: Readonly<SlideValues>): boolean => valuesOf(values, 'text').length > 0
  const hasOffset = (values: Readonly<SlideValues>): boolean => valuesOf(values, 'offX').length > 0
  if ((options.degeneracyGate ?? 'per-slide') === 'deck') {
    expect(entries.some(([, values]) => hasText(values)), `${label}: デッキ全体で //a:t が 0 件`).toBe(true)
    expect(entries.some(([, values]) => hasOffset(values)), `${label}: デッキ全体で //a:xfrm/a:off が 0 件`).toBe(true)
    return
  }
  for (const [part, values] of entries) {
    expect(hasText(values), `${label}: ${part} の //a:t が 0 件`).toBe(true)
    expect(hasOffset(values), `${label}: ${part} の //a:xfrm/a:off が 0 件`).toBe(true)
  }
}

/**
media を比較の強さに応じて正規化する（'dimensions' は part 名と PNG 寸法だけ残す）。
*/
function normalizeMedia(
  media: Readonly<Record<string, MediaValues>>,
  comparison: MediaComparison,
): Readonly<Record<string, unknown>> {
  return comparison === 'sha256' ? media : Object.fromEntries(Object.entries(media).map(([part, values]) => [part, { png: values.png }]))
}

/**
2 つの snapshot の差分を人が読める行として列挙する。空配列なら一致。
比較器そのものの判別能力を検証する「負のコントロール」から使う。
*/
export function diffPptxSnapshots(
  left: Readonly<PptxSnapshot>,
  right: Readonly<PptxSnapshot>,
): readonly string[] {
  const differences: string[] = []
  if (left.sldIdCount !== right.sldIdCount) {
    differences.push(`sldIdLst 件数: ${String(left.sldIdCount)} vs ${String(right.sldIdCount)}`)
  }

  const leftSlides = new Map(Object.entries(left.slides))
  const rightSlides = new Map(Object.entries(right.slides))
  for (const part of [...new Set([...leftSlides.keys(), ...rightSlides.keys()])].toSorted(compareStrings)) {
    const leftValues = leftSlides.get(part)
    const rightValues = rightSlides.get(part)
    if (leftValues === undefined || rightValues === undefined) {
      differences.push(`${part}: 片側にのみ存在する`)
      continue
    }
    for (const spec of SLIDE_VALUE_SPECS) {
      const leftValue = JSON.stringify(valuesOf(leftValues, spec.name))
      const rightValue = JSON.stringify(valuesOf(rightValues, spec.name))
      if (leftValue !== rightValue) {
        differences.push(`${part}: ${spec.name} が不一致 (${leftValue} vs ${rightValue})`)
      }
    }
    if (leftValues.blipCount !== rightValues.blipCount) {
      differences.push(`${part}: blipCount が不一致 (${String(leftValues.blipCount)} vs ${String(rightValues.blipCount)})`)
    }
  }

  const leftRels = new Map(Object.entries(left.slideRels))
  const rightRels = new Map(Object.entries(right.slideRels))
  for (const part of [...new Set([...leftRels.keys(), ...rightRels.keys()])].toSorted(compareStrings)) {
    const leftValue = leftRels.get(part)
    const rightValue = rightRels.get(part)
    if (leftValue === undefined || rightValue === undefined) {
      differences.push(`${part}: 片側にのみ存在する`)
      continue
    }
    if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
      differences.push(`${part}: Relationship が不一致 (${JSON.stringify(leftValue)} vs ${JSON.stringify(rightValue)})`)
    }
  }

  const leftMedia = new Map(Object.entries(left.media))
  const rightMedia = new Map(Object.entries(right.media))
  for (const part of [...new Set([...leftMedia.keys(), ...rightMedia.keys()])].toSorted(compareStrings)) {
    const leftValue = leftMedia.get(part)
    const rightValue = rightMedia.get(part)
    if (leftValue === undefined || rightValue === undefined) {
      differences.push(`${part}: 片側にのみ存在する`)
      continue
    }
    if (leftValue.sha256 !== rightValue.sha256) {
      const hashes = `${leftValue.sha256.slice(0, 12)} vs ${rightValue.sha256.slice(0, 12)}`
      const sizes = `${String(leftValue.byteLength)} vs ${String(rightValue.byteLength)} bytes`
      differences.push(`${part}: 内容ハッシュが不一致 (${hashes}, ${sizes})`)
    }
    if (JSON.stringify(leftValue.png) !== JSON.stringify(rightValue.png)) {
      differences.push(`${part}: PNG 寸法が不一致 (${JSON.stringify(leftValue.png)} vs ${JSON.stringify(rightValue.png)})`)
    }
  }
  return differences
}

/**
2 つの PPTX パスを受け取り、絶対値の下限検証を通したうえで抽出値の一致を assert する。
`slides` / `slideRels` / `media` を `toStrictEqual` で比べる。
これにより不一致時は、vitest の diff が「どの part のどの観点がどう違うか」を出す。

@returns 取得済みの snapshot。呼び出し側が追加の assert をするとき、開き直さず使える。
*/
export async function expectPptxOutputsEquivalent(
  pathA: string,
  pathB: string,
  options: Readonly<ComparisonOptions> = {},
): Promise<{ readonly a: PptxSnapshot, readonly b: PptxSnapshot }> {
  const snapshotA = await snapshotPptx(pathA)
  const snapshotB = await snapshotPptx(pathB)
  assertPptxNotDegenerate(snapshotA, options)
  assertPptxNotDegenerate(snapshotB, options)
  expect(snapshotB.sldIdCount).toBe(snapshotA.sldIdCount)
  expect(snapshotB.slides).toStrictEqual(snapshotA.slides)
  expect(snapshotB.slideRels).toStrictEqual(snapshotA.slideRels)
  const mediaComparison = options.mediaComparison ?? 'sha256'
  expect(normalizeMedia(snapshotB.media, mediaComparison))
    .toStrictEqual(normalizeMedia(snapshotA.media, mediaComparison))
  return { a: snapshotA, b: snapshotB }
}
