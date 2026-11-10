// 複数の単スライド PPTX を 1 つの PPTX に統合する。
//
// 各 input PPTX は 1 枚のスライドのみを含む前提 (Slidev → dom-to-pptx の単スライド変換結果)。
// メディアファイル名の衝突を避けるため、スライド番号付きにリネームし、slide rels の参照を書き換える。
// その後、次の 3 つを再構築する。
// presentation.xml の sldIdLst。
// presentation.xml.rels の slide relationship。
// [Content_Types].xml の slide override。

import path from 'node:path'

import { escapeXmlAttribute } from './xml-escape.js'
import type { XmlDocument, XmlEngine } from '../_shared/ports.js'
import { NS_CONTENT_TYPES, NS_OFFICE_RELATIONSHIPS, NS_PACKAGE_RELATIONSHIPS, NS_PRESENTATIONML, REL_TYPE_FONT, REL_TYPE_SLIDE } from '../_shared/ooxml-uris.js'

const CT_SLIDE
  = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'

const CT_FONT_DATA = 'application/x-fontdata'

/**
`p:embeddedFont` が取り得る字形。
*/
type FontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic'

/**
ECMA-376 CT_EmbeddedFontDataId の子要素の並び順。
*/
const FONT_STYLES: readonly FontStyle[] = ['regular', 'bold', 'italic', 'boldItalic']

export interface MergeInput {
  /**
  スライド番号 (1 始まり)。merge 後の slide<N>.xml の N に使われる。
  */
  readonly slideNumber: number
  /**
  元 PPTX の zip エントリ名 → buffer のマップ。
  */
  readonly files: ReadonlyMap<string, Buffer>
}

export interface MergeOutputFile {
  readonly part: string
  readonly buffer: Buffer
}

export interface MergeResult {
  readonly slideCount: number
  readonly files: readonly MergeOutputFile[]
  /**
  統合中に検出した非致命の異常（現状は埋め込みフォントの実体不一致）。
  異常なしの merge では空配列。呼び出し側は run 全体の warnings に合流させる。
  */
  readonly warnings: readonly string[]
}

interface MutableEntry {
  readonly part: string
  readonly buffer: Buffer
}

function stem(filename: string): string {
  const extension_ = path.posix.extname(filename)
  return extension_ === '' ? filename : filename.slice(0, filename.length - extension_.length)
}

function extensionOf(filename: string): string {
  return path.posix.extname(filename)
}

/**
Slide rels の Relationship[Target] (`../media/<old>` 参照) を rename map で書き換える。
*/
function rewriteRelsTargets(
  document: XmlDocument,
  mediaRenameMap: ReadonlyMap<string, string>,
): void {
  const nsMap = { rel: NS_PACKAGE_RELATIONSHIPS }
  const relationships = document.selectNodes('//rel:Relationship', nsMap)
  for (const relationship of relationships) {
    /* c8 ignore next 2 -- 実 OOXML rels では Target は必ず存在するが、getAttr の契約上 undefined を返し得るため `?? ''` で防御 */
    const target = relationship.getAttr('Target') ?? ''
    if (!target.startsWith('../media/')) continue
    const oldMedia = target.slice('../media/'.length)
    const newMedia = mediaRenameMap.get(oldMedia)
    if (newMedia !== undefined) {
      relationship.setAttr('Target', `../media/${newMedia}`)
    }
  }
}

/**
presentation.xml の sldIdLst を totalSlides 件の sldId に作り替える。
id は 256 始まり、r:id は rId101 始まり (Python 版と同一)。
*/
function rebuildSldIdLst(document: XmlDocument, totalSlides: number): void {
  const nsMap = { p: NS_PRESENTATIONML, r: NS_OFFICE_RELATIONSHIPS }
  const lists = document.selectNodes('//p:sldIdLst', nsMap)
  /* c8 ignore next -- presentation.xml には常に p:sldIdLst が存在 */
  if (lists.length === 0) return
  const sldIdLst = lists[0]
  /* c8 ignore next -- selectNodes 経由で取得した node は undefined にならない */
  if (sldIdLst === undefined) return
  // 既存子を全て削除
  const existingSldIds = sldIdLst.selectNodes('./p:sldId', nsMap)
  for (const child of existingSldIds) {
    child.remove()
  }
  // 新規 sldId を追加
  for (let index = 1; index <= totalSlides; index += 1) {
    const sldId = 255 + index
    const rId = `rId${String(100 + index)}`
    const xml = `<p:sldId xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}" id="${String(sldId)}" r:id="${rId}"/>`
    sldIdLst.appendChildXml(xml)
  }
}

/**
presentation.xml.rels の Relationship 群のうち type=slide なものを rebuild する。
*/
function rebuildPresRels(document: XmlDocument, totalSlides: number): void {
  const nsMap = { rel: NS_PACKAGE_RELATIONSHIPS }
  const relationships = document.selectNodes('//rel:Relationship', nsMap)
  for (const relationship of relationships) {
    if (relationship.getAttr('Type') === REL_TYPE_SLIDE) {
      relationship.remove()
    }
  }
  for (let index = 1; index <= totalSlides; index += 1) {
    const rId = `rId${String(100 + index)}`
    const xml
      = `<Relationship xmlns="${NS_PACKAGE_RELATIONSHIPS}" Id="${rId}" Type="${REL_TYPE_SLIDE}" Target="slides/slide${String(index)}.xml"/>`
    document.appendChildXml(xml)
  }
}

/**
[Content_Types].xml の Override@PartName="/ppt/slides/slideN.xml" を rebuild する。
*/
function rebuildContentTypes(document: XmlDocument, totalSlides: number): void {
  const nsMap = { ct: NS_CONTENT_TYPES }
  const overrides = document.selectNodes('//ct:Override', nsMap)
  for (const override of overrides) {
    /* c8 ignore next 2 -- 実 [Content_Types].xml の PartName は必ずあるが、getAttr は undefined を返し得るので `?? ''` で守る */
    const partName = override.getAttr('PartName') ?? ''
    if (partName.startsWith('/ppt/slides/slide') && partName.endsWith('.xml')) {
      override.remove()
    }
  }
  for (let index = 1; index <= totalSlides; index += 1) {
    const xml
      = `<Override xmlns="${NS_CONTENT_TYPES}" PartName="/ppt/slides/slide${String(index)}.xml" ContentType="${CT_SLIDE}"/>`
    document.appendChildXml(xml)
  }
}

interface EmbeddedFont {
  readonly typeface: string
  readonly style: FontStyle
  readonly buffer: Buffer
}

/**
1 枚分の PPTX が埋め込んでいるフォントを (typeface, 字形, 実体) の一覧にする。

dom-to-pptx はそのスライドの描画に使われた書体だけを埋め込むため、埋め込み集合はスライドごとに違う。
#1062 の計測では、51 枚のデッキのうち 47 枚が 2 書体（うち 1 書体は regular と bold）を持ち、
残る 4 枚は 1 書体の regular のみだった。
*/
function collectEmbeddedFonts(
  files: ReadonlyMap<string, Buffer>,
  engine: XmlEngine,
): readonly EmbeddedFont[] {
  const presentationBuffer = files.get('ppt/presentation.xml')
  const relsBuffer = files.get('ppt/_rels/presentation.xml.rels')
  if (presentationBuffer === undefined || relsBuffer === undefined) return []

  const targetById = new Map<string, string>()
  const relationshipNodes = engine.parse(relsBuffer).selectNodes('//rel:Relationship', { rel: NS_PACKAGE_RELATIONSHIPS })
  for (const relationship of relationshipNodes) {
    if (relationship.getAttr('Type') !== REL_TYPE_FONT) continue
    const id = relationship.getAttr('Id')
    const target = relationship.getAttr('Target')
    if (id !== undefined && target !== undefined) targetById.set(id, target)
  }

  const nsMap = { p: NS_PRESENTATIONML }
  const fonts: EmbeddedFont[] = []
  const presentation = engine.parse(presentationBuffer)
  for (const embedded of presentation.selectNodes('//p:embeddedFontLst/p:embeddedFont', nsMap)) {
    const typeface = embedded.selectNodes('./p:font', nsMap)[0]?.getAttr('typeface')
    if (typeface === undefined || typeface === '') continue
    for (const style of FONT_STYLES) {
      const rId = embedded.selectNodes(`./p:${style}`, nsMap)[0]?.getAttr('r:id')
      if (rId === undefined) continue
      const target = targetById.get(rId)
      if (target === undefined) continue
      // Target は ppt/_rels/ からの相対パス（計測値は `fonts/<n>.fntdata`）。
      const part = path.posix.normalize(path.posix.join('ppt', target))
      const buffer = files.get(part)
      if (buffer === undefined) continue
      fonts.push({ typeface, style, buffer })
    }
  }
  return fonts
}

interface UnionEmbeddedFontsResult {
  readonly fonts: readonly EmbeddedFont[]
  readonly warnings: readonly string[]
}

/**
全スライドの埋め込みフォントを和集合にする。
同じ (typeface, 字形) は、先に現れたスライドの実体を採る。
dom-to-pptx はフェッチしたフォントファイルをそのまま埋め込むため、同じ組の実体はスライド間で同一になる。
#1062 の計測では、Inter [regular] は 294,722 B で sha256 が一致した。
仮に食い違っても、OOXML は 1 つの typeface に同じ字形を 2 つ持てないため、先勝ちで決定論的に選ぶ。

ただし将来ライブラリがスライド単位のサブセット化を入れると、実体が食い違ったまま後続スライド固有のグリフが失われる。
その場合も通知されない。判別できるよう、実体が一致しない組は warning に積む。
*/
function unionEmbeddedFonts(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
  perSlide: readonly (readonly EmbeddedFont[])[],
): UnionEmbeddedFontsResult {
  const union = new Map<string, EmbeddedFont>()
  const warned = new Set<string>()
  const warnings: string[] = []
  for (const fonts of perSlide) {
    for (const font of fonts) {
      const key = `${font.typeface}\0${font.style}`
      const existing = union.get(key)
      if (existing === undefined) {
        union.set(key, font)
        continue
      }
      if (warned.has(key) || existing.buffer.equals(font.buffer)) {
        continue
      }

      warned.add(key)
      warnings.push(
        `embedded font data differs between slides: "${font.typeface}" [${font.style}] `
        + `(${String(existing.buffer.length)} B and ${String(font.buffer.length)} B); `
        + 'using the data from the slide closer to slide 1 (the one that appears first)',
      )
    }
  }
  return { fonts: union.values().toArray(), warnings }
}

/**
次の 3 つを和集合で作り直す。
presentation.xml の `p:embeddedFontLst`。
presentation.xml.rels の font relationship。
`ppt/fonts/` の実体。

統合しないと、スライド 1 をベース構造に採る仕様のため、スライド 1 に無い書体が 2 枚目以降から失われる。
part 名はスライドごとに衝突する。どのスライドでも `201314.fntdata` から採番されるためだ。
そのため元の名前は使わず、`ppt/fonts/font<N>.fntdata` に振り直す。
*/
function rebuildEmbeddedFonts(
  baseFiles: Map<string, Buffer>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
  fonts: readonly EmbeddedFont[],
  engine: XmlEngine,
): void {
  const presentationBuffer = baseFiles.get('ppt/presentation.xml')
  const relsBuffer = baseFiles.get('ppt/_rels/presentation.xml.rels')
  // presentation.xml / rels のどちらかを欠く入力では参照側を書き換えられない。先に font part を
  // 消すと、rels だけ欠けた入力で参照だけが宙に浮くため、削除はガードの後ろに置く。
  if (presentationBuffer === undefined || relsBuffer === undefined) return

  const staleFontParts = baseFiles.keys().filter(part => part.startsWith('ppt/fonts/')).toArray()
  for (const part of staleFontParts) {
    baseFiles.delete(part)
  }

  const presentation = engine.parse(presentationBuffer)
  const nsMap = { p: NS_PRESENTATIONML }
  for (const existing of presentation.selectNodes('//p:embeddedFontLst', nsMap)) {
    existing.remove()
  }

  const rels = engine.parse(relsBuffer)
  const relationshipNodes = rels.selectNodes('//rel:Relationship', { rel: NS_PACKAGE_RELATIONSHIPS })
  for (const relationship of relationshipNodes) {
    if (relationship.getAttr('Type') === REL_TYPE_FONT) relationship.remove()
  }

  if (fonts.length > 0) {
    // typeface ごとに字形をまとめる（1 typeface = 1 p:embeddedFont）。出現順を保つ。
    const byTypeface = new Map<string, { readonly style: string, readonly rId: string }[]>()
    for (const [index, font] of fonts.entries()) {
      const rId = `rIdFont${String(index + 1)}`
      baseFiles.set(`ppt/fonts/font${String(index + 1)}.fntdata`, Buffer.from(font.buffer))
      rels.appendChildXml(
        `<Relationship xmlns="${NS_PACKAGE_RELATIONSHIPS}" Id="${rId}" Type="${REL_TYPE_FONT}"`
        + ` Target="fonts/font${String(index + 1)}.fntdata"/>`,
      )
      const styles = byTypeface.get(font.typeface) ?? []
      styles.push({ style: font.style, rId })
      byTypeface.set(font.typeface, styles)
    }

    const entries = [...byTypeface].map(([typeface, styles]) => {
      const children = FONT_STYLES
        .flatMap(style => styles.filter(entry => entry.style === style))
        .map(entry => `<p:${entry.style} r:id="${entry.rId}"/>`)
        .join('')
      return `<p:embeddedFont><p:font typeface="${escapeXmlAttribute(typeface)}"/>${children}</p:embeddedFont>`
    }).join('')
    const xml = `<p:embeddedFontLst xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">${entries}</p:embeddedFontLst>`

    // CT_Presentation の要素順は
    // sldIdLst → sldSz → notesSz → smartTags → embeddedFontLst → defaultTextStyle。
    // pptxgenjs は smartTags を出力しない。
    const anchor = presentation.selectNodes('/p:presentation/p:notesSz', nsMap).at(-1)
      ?? presentation.selectNodes('/p:presentation/p:sldSz', nsMap).at(-1)
      ?? presentation.selectNodes('/p:presentation/p:sldIdLst', nsMap).at(-1)
    if (anchor === undefined) presentation.appendChildXml(xml)
    else anchor.addNextSiblingXml(xml)

    // embedTrueTypeFonts / saveSubsetFonts は ECMA-376 の既定が false になっている。
    // dom-to-pptx も、埋め込みを行ったスライドにしか付けない（dist/dom-to-pptx.cjs 231-232）。
    // ベースに採るスライド 1 が無埋め込みだと、属性が無いまま embeddedFontLst だけが載る。
    // その場合 PowerPoint は埋め込み書体を使わない。和集合が空でないときは自分で付け直す。
    for (const root of presentation.selectNodes('/p:presentation', nsMap)) {
      root.setAttr('embedTrueTypeFonts', 'true')
      root.setAttr('saveSubsetFonts', 'true')
    }
  }

  baseFiles.set('ppt/presentation.xml', engine.serialize(presentation))
  baseFiles.set('ppt/_rels/presentation.xml.rels', engine.serialize(rels))

  const contentTypesBuffer = baseFiles.get('[Content_Types].xml')
  if (contentTypesBuffer === undefined || fonts.length === 0) return
  const contentTypes = engine.parse(contentTypesBuffer)
  const hasDefault = contentTypes
    .selectNodes('//ct:Default', { ct: NS_CONTENT_TYPES })
    .some(node => node.getAttr('Extension') === 'fntdata')
  if (hasDefault) {
    return
  }

  contentTypes.appendChildXml(
    `<Default xmlns="${NS_CONTENT_TYPES}" Extension="fntdata" ContentType="${CT_FONT_DATA}"/>`,
  )
  baseFiles.set('[Content_Types].xml', engine.serialize(contentTypes))
}

/**
ECMA-376 CT_Presentation の子要素 sequence。schema は順序を固定しており、
PowerPoint は読み込みには寛容だが、他ツール・検証器は順序違反を弾く。
*/
const PRESENTATION_CHILD_ORDER: readonly string[] = [
  'sldMasterIdLst',
  'notesMasterIdLst',
  'handoutMasterIdLst',
  'sldIdLst',
  'sldSz',
  'notesSz',
  'smartTags',
  'embeddedFontLst',
  'custShowLst',
  'photoAlbum',
  'custDataLst',
  'kinsoku',
  'defaultTextStyle',
  'modifyVerifier',
  'extLst',
]

/**
`p:presentation` の子要素を CT_Presentation の sequence 順に並べ直す。

pptxgenjs 由来の単スライド PPTX は `p:sldIdLst` が `p:notesMasterIdLst` より前に出る
schema 逸脱を持つ（#1062 計測）。merge は presentation.xml をスライド 1 からそのまま
受け継ぐため、統合後もそのまま残る。sequence に無い要素は相対順を保って末尾へ置く。
*/
function reorderPresentationChildren(document: XmlDocument): void {
  const nsMap = { p: NS_PRESENTATIONML }
  const children = document.selectNodes('/p:presentation/*', nsMap)
  const ranked = children.map((node, index) => {
    const rank = PRESENTATION_CHILD_ORDER.indexOf(node.localName())
    return { node, rank: rank === -1 ? PRESENTATION_CHILD_ORDER.length : rank, index }
  })
  const sorted = ranked.toSorted((a, b) => a.rank - b.rank || a.index - b.index)
  // 既に規格順なら DOM を触らない（無用な差分と再シリアライズを避ける）。
  if (sorted.every((entry, index) => entry.index === index)) return
  for (const entry of sorted) {
    entry.node.moveToEnd()
  }
}

/**
単スライド PPTX 群を 1 つに統合する純粋関数 (file system / zip I/O は呼び出し側)。

@param inputs   各 PPTX の zip 中身マップ。`slideNumber` 昇順で出力される。
@param engine   XML パーサ / シリアライザ。
@returns        zip に書き戻すべき part 群と件数。
*/
export function mergePptxFiles(
  inputs: readonly MergeInput[],
  engine: XmlEngine,
): MergeResult {
  if (inputs.length === 0) {
    throw new Error('mergePptxFiles: no input PPTX files')
  }

  // slideNumber 昇順で安定化
  const sorted = [...inputs].toSorted((a, b) => a.slideNumber - b.slideNumber)

  // tech-advisor B2: slideNumber が 1..N の連番でなければ throw。
  // caller (commands/slidev-to-pptx/convert.ts) は readdir 結果から数値抽出 + sort している。
  // 通常は連番だが、歯抜け (例: slide-1.pptx と slide-3.pptx のみ存在) を検出する。
  for (const [index, input] of sorted.entries()) {
    if (input.slideNumber !== index + 1) {
      throw new Error(
        `mergePptxFiles: slideNumber must be 1..N consecutive, got ${String(input.slideNumber)} at index ${String(index)}`,
      )
    }
  }

  const baseFiles = new Map<string, Buffer>()
  const slideCount = sorted.length
  const fontsPerSlide: (readonly EmbeddedFont[])[] = []

  for (const input of sorted) {
    const slideNumber = input.slideNumber
    const files = input.files

    fontsPerSlide.push(collectEmbeddedFonts(files, engine))

    // スライド 1 をベース構造として採用 (presentation.xml / [Content_Types].xml / _rels 等)
    if (slideNumber === 1) {
      for (const [fname, data] of files) {
        if (fname.startsWith('ppt/media/')) continue
        baseFiles.set(fname, Buffer.from(data))
      }
    }

    // メディアファイルをスライド番号付きでリネーム
    const mediaRenameMap = new Map<string, string>()
    for (const [fname, data] of files) {
      if (fname === 'ppt/media/' || !fname.startsWith('ppt/media/')) continue
      const oldName = fname.slice('ppt/media/'.length)
      const newName = `${stem(oldName)}-s${String(slideNumber)}${extensionOf(oldName)}`
      const newPath = `ppt/media/${newName}`
      baseFiles.set(newPath, Buffer.from(data))
      mediaRenameMap.set(oldName, newName)
    }

    // slide rels を更新 (../media/ 参照を rename 後に書き換え)
    const sourceRels = 'ppt/slides/_rels/slide1.xml.rels'
    const destinationRels = `ppt/slides/_rels/slide${String(slideNumber)}.xml.rels`
    const sourceRelsBuffer = files.get(sourceRels)
    if (sourceRelsBuffer !== undefined) {
      const document = engine.parse(sourceRelsBuffer)
      rewriteRelsTargets(document, mediaRenameMap)
      baseFiles.set(destinationRels, engine.serialize(document))
    }

    // slide XML 本体をコピー (slide1.xml → slideN.xml)
    const sourceSlide = 'ppt/slides/slide1.xml'
    const destinationSlide = `ppt/slides/slide${String(slideNumber)}.xml`
    const sourceSlideBuffer = files.get(sourceSlide)
    if (sourceSlideBuffer !== undefined) {
      baseFiles.set(destinationSlide, Buffer.from(sourceSlideBuffer))
    }
  }

  // presentation.xml の sldIdLst を再構築
  const presBuffer = baseFiles.get('ppt/presentation.xml')
  if (presBuffer !== undefined) {
    const document = engine.parse(presBuffer)
    rebuildSldIdLst(document, slideCount)
    baseFiles.set('ppt/presentation.xml', engine.serialize(document))
  }

  // _rels/presentation.xml.rels の slide relationship を再構築
  const presRelsBuffer = baseFiles.get('ppt/_rels/presentation.xml.rels')
  if (presRelsBuffer !== undefined) {
    const document = engine.parse(presRelsBuffer)
    rebuildPresRels(document, slideCount)
    baseFiles.set('ppt/_rels/presentation.xml.rels', engine.serialize(document))
  }

  // [Content_Types].xml の slide override を再構築
  const contentTypesBuffer = baseFiles.get('[Content_Types].xml')
  if (contentTypesBuffer !== undefined) {
    const document = engine.parse(contentTypesBuffer)
    rebuildContentTypes(document, slideCount)
    baseFiles.set('[Content_Types].xml', engine.serialize(document))
  }

  // 埋め込みフォントを全スライドの和集合で作り直す（スライド 1 の集合だけでは足りない）。
  const union = unionEmbeddedFonts(fontsPerSlide)
  rebuildEmbeddedFonts(baseFiles, union.fonts, engine)

  // 子要素の並びを CT_Presentation の sequence に揃える。ベースに採るスライド 1 の
  // presentation.xml が pptxgenjs 由来の順序逸脱を持つため、統合の最後に一度直す。
  const orderedBuffer = baseFiles.get('ppt/presentation.xml')
  if (orderedBuffer !== undefined) {
    const document = engine.parse(orderedBuffer)
    reorderPresentationChildren(document)
    baseFiles.set('ppt/presentation.xml', engine.serialize(document))
  }

  const out: MutableEntry[] = []
  for (const [part, buffer] of baseFiles) {
    out.push({ part, buffer })
  }
  return { slideCount, files: out, warnings: union.warnings }
}
