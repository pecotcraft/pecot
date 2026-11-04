// merge_pptx.py の TS 移植版 (`src/domain/pptx-ooxml/merge.ts`) の unit test。
// fixture は in-memory の Map<string, Buffer> で構築する (zip I/O は呼び出し側責務)。

import { describe, expect, it } from 'vitest'

import { mergePptxFiles, type MergeInput } from '../merge.js'
import { XmldomXmlEngine } from '../../../infra/pptx-ooxml/xml-engine.js'
import { compareStrings } from '../../_shared/compare-strings.js'

const engine = new XmldomXmlEngine()

const NS_PRESENTATIONML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'

function buffer(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

function basePresentationXml(): Buffer {
  return buffer(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
    + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
    + `</p:presentation>`,
  )
}

function basePresRels(): Buffer {
  return buffer(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`
    + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
    + `</Relationships>`,
  )
}

function baseContentTypes(): Buffer {
  return buffer(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="${NS_CONTENT_TYPES}">`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
    + `<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    + `</Types>`,
  )
}

function slideXml(label: string): Buffer {
  return buffer(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<p:sld xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="urn:test"/></p:txBody></p:sp></p:spTree></p:cSld><!-- ${label} --></p:sld>`,
  )
}

function slideRelsWithMedia(): Buffer {
  return buffer(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
    + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
    + `</Relationships>`,
  )
}

function makeFiles(
  label: string,
  options: Readonly<{ withMedia: boolean, includeBaseStructure: boolean }>,
): Map<string, Buffer> {
  const entries: [string, Buffer][] = [
    ['ppt/slides/slide1.xml', slideXml(label)],
  ]
  if (options.withMedia) {
    entries.push(
      ['ppt/slides/_rels/slide1.xml.rels', slideRelsWithMedia()],
      ['ppt/media/image1.png', buffer(`PNG-${label}`)],
    )
  }
  if (options.includeBaseStructure) {
    entries.push(
      ['ppt/presentation.xml', basePresentationXml()],
      ['ppt/_rels/presentation.xml.rels', basePresRels()],
      ['[Content_Types].xml', baseContentTypes()],
    )
  }
  return new Map(entries)
}

describe('mergePptxFiles', () => {
  it('入力 0 件は Error を throw', () => {
    expect(() => mergePptxFiles([], engine)).toThrow(/no input/i)
  })

  it('slideNumber が 1..N の連番でなければ Error を throw (歯抜け検出)', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('a', { withMedia: false, includeBaseStructure: true }) },
      // slide 2 を欠いて slide 3 にジャンプ → 歯抜け
      { slideNumber: 3, files: makeFiles('c', { withMedia: false, includeBaseStructure: false }) },
    ]
    expect(() => mergePptxFiles(inputs, engine)).toThrow(/1\.\.N consecutive/i)
  })

  it('slideNumber が 2 から始まると Error (1 から始まらない)', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 2, files: makeFiles('s2', { withMedia: false, includeBaseStructure: true }) },
    ]
    expect(() => mergePptxFiles(inputs, engine)).toThrow(/1\.\.N consecutive/i)
  })

  it('merge 後の presentation.xml に standalone="yes" が含まれる (Python 版との byte 等価性)', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('a', { withMedia: false, includeBaseStructure: true }) },
      { slideNumber: 2, files: makeFiles('b', { withMedia: false, includeBaseStructure: false }) },
    ]
    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''
    expect(presXml).toContain('standalone="yes"')
    const presRels = partMap.get('ppt/_rels/presentation.xml.rels')?.toString('utf8') ?? ''
    expect(presRels).toContain('standalone="yes"')
    const ct = partMap.get('[Content_Types].xml')?.toString('utf8') ?? ''
    expect(ct).toContain('standalone="yes"')
  })

  it('スライド 1 のベース構造を採用し、N 件分の slideX.xml を生成する', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('s1', { withMedia: true, includeBaseStructure: true }) },
      { slideNumber: 2, files: makeFiles('s2', { withMedia: true, includeBaseStructure: false }) },
      { slideNumber: 3, files: makeFiles('s3', { withMedia: false, includeBaseStructure: false }) },
    ]
    const result = mergePptxFiles(inputs, engine)
    expect(result.slideCount).toBe(3)

    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    expect(partMap.has('ppt/slides/slide1.xml')).toBe(true)
    expect(partMap.has('ppt/slides/slide2.xml')).toBe(true)
    expect(partMap.has('ppt/slides/slide3.xml')).toBe(true)
    // base 構造はスライド 1 のものが採用される
    expect(partMap.has('ppt/presentation.xml')).toBe(true)
    expect(partMap.has('ppt/_rels/presentation.xml.rels')).toBe(true)
    expect(partMap.has('[Content_Types].xml')).toBe(true)
  })

  it('メディアファイルがスライド番号付きにリネームされ、rels も書き換わる', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('a', { withMedia: true, includeBaseStructure: true }) },
      { slideNumber: 2, files: makeFiles('b', { withMedia: true, includeBaseStructure: false }) },
    ]
    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))

    // rename: image1.png → image1-s1.png / image1-s2.png
    expect(partMap.has('ppt/media/image1-s1.png')).toBe(true)
    expect(partMap.has('ppt/media/image1-s2.png')).toBe(true)

    // 元の image1.png は base に含まれない (mediaは個別 rename を経由)
    expect(partMap.has('ppt/media/image1.png')).toBe(false)

    // rels: slide1 / slide2 の rels Target が rename 後を指す
    const rels1 = partMap.get('ppt/slides/_rels/slide1.xml.rels')?.toString('utf8') ?? ''
    expect(rels1).toContain('Target="../media/image1-s1.png"')
    const rels2 = partMap.get('ppt/slides/_rels/slide2.xml.rels')?.toString('utf8') ?? ''
    expect(rels2).toContain('Target="../media/image1-s2.png"')
  })

  it('presentation.xml の sldIdLst が N 件の sldId に rebuild される', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('a', { withMedia: false, includeBaseStructure: true }) },
      { slideNumber: 2, files: makeFiles('b', { withMedia: false, includeBaseStructure: false }) },
      { slideNumber: 3, files: makeFiles('c', { withMedia: false, includeBaseStructure: false }) },
    ]
    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''
    // id=256/257/258、r:id=rId101/rId102/rId103
    expect(presXml).toContain('id="256"')
    expect(presXml).toContain('id="257"')
    expect(presXml).toContain('id="258"')
    expect(presXml).toContain('r:id="rId101"')
    expect(presXml).toContain('r:id="rId102"')
    expect(presXml).toContain('r:id="rId103"')
    // 元の sldId が削除されている (id="256" は新規分のみ)
    const sldIdMatches = presXml.match(/<p:sldId\b/g) ?? []
    expect(sldIdMatches.length).toBe(3)
  })

  it('presentation.xml.rels の type=slide だけが rebuild され、他 type は保たれる', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('a', { withMedia: false, includeBaseStructure: true }) },
      { slideNumber: 2, files: makeFiles('b', { withMedia: false, includeBaseStructure: false }) },
    ]
    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const relsXml = partMap.get('ppt/_rels/presentation.xml.rels')?.toString('utf8') ?? ''
    // slideMaster relationship は元のまま残る
    expect(relsXml).toContain('slideMaster1.xml')
    // slide relationship は新 ID で 2 件
    expect(relsXml).toContain('Id="rId101"')
    expect(relsXml).toContain('Id="rId102"')
    expect(relsXml).toContain('Target="slides/slide1.xml"')
    expect(relsXml).toContain('Target="slides/slide2.xml"')
  })

  it('[Content_Types].xml の slide Override が rebuild される', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('a', { withMedia: false, includeBaseStructure: true }) },
      { slideNumber: 2, files: makeFiles('b', { withMedia: false, includeBaseStructure: false }) },
      { slideNumber: 3, files: makeFiles('c', { withMedia: false, includeBaseStructure: false }) },
    ]
    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const ct = partMap.get('[Content_Types].xml')?.toString('utf8') ?? ''
    // 既存 presentation.xml の Override は残る
    expect(ct).toContain('PartName="/ppt/presentation.xml"')
    // slide1/2/3 の Override が存在
    expect(ct).toContain('PartName="/ppt/slides/slide1.xml"')
    expect(ct).toContain('PartName="/ppt/slides/slide2.xml"')
    expect(ct).toContain('PartName="/ppt/slides/slide3.xml"')
  })

  it('slideNumber が降順で渡されても 1 を base にする (toSorted で正規化)', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 2, files: makeFiles('B', { withMedia: false, includeBaseStructure: false }) },
      { slideNumber: 1, files: makeFiles('A', { withMedia: false, includeBaseStructure: true }) },
    ]
    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    expect(partMap.has('ppt/presentation.xml')).toBe(true)
    expect(partMap.has('ppt/slides/slide1.xml')).toBe(true)
    expect(partMap.has('ppt/slides/slide2.xml')).toBe(true)
  })

  it('media に不要な空 prefix エントリ "ppt/media/" は無視される', () => {
    const files = makeFiles('a', { withMedia: false, includeBaseStructure: true })
    files.set('ppt/media/', buffer('')) // zip に偶発する dir entry のシミュレート
    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    // "ppt/media/" は output に rename されない
    const renamedKeys = partMap.keys().filter(k => k.startsWith('ppt/media/')).toArray()
    expect(renamedKeys).toEqual([])
  })

  it('rels の ../media/ 以外 Target / rename map に無いメディアは書き換えない', () => {
    // slide rels に、../media/ への参照だが rename map に無い image2.png を含める。
    // ../slideLayouts/ への参照 (../media/ で始まらない) も含める。
    const customSlideRels = buffer(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
      + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image-uncatalogued.png"/>`
      + `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
      + `</Relationships>`,
    )
    const files = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', slideXml('mixed')],
      ['ppt/slides/_rels/slide1.xml.rels', customSlideRels],
      ['ppt/media/image1.png', buffer('PNG-image1')],
      ['ppt/presentation.xml', basePresentationXml()],
      ['ppt/_rels/presentation.xml.rels', basePresRels()],
      ['[Content_Types].xml', baseContentTypes()],
    ])
    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const rels = partMap.get('ppt/slides/_rels/slide1.xml.rels')?.toString('utf8') ?? ''
    // image1.png は rename されている
    expect(rels).toContain('Target="../media/image1-s1.png"')
    // image-uncatalogued.png は rename map に無いため書き換わらない
    expect(rels).toContain('Target="../media/image-uncatalogued.png"')
    // slideLayouts への参照は触られない
    expect(rels).toContain('Target="../slideLayouts/slideLayout1.xml"')
  })

  it('拡張子の無いメディアファイル名でもスライド番号が付く', () => {
    const files = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', slideXml('noext')],
      ['ppt/media/binary-blob', buffer('blob-data')],
    ])
    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    expect(partMap.has('ppt/media/binary-blob-s1')).toBe(true)
  })

  it('Content_Types に slide 系 Override が無いベースでも slideX.xml の Override が追加される', () => {
    const noSlideOverrideContentTypes = buffer(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="${NS_CONTENT_TYPES}">`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
      + `</Types>`,
    )
    const files = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', slideXml('s1')],
      ['ppt/presentation.xml', basePresentationXml()],
      ['ppt/_rels/presentation.xml.rels', basePresRels()],
      ['[Content_Types].xml', noSlideOverrideContentTypes],
    ])
    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const ct = partMap.get('[Content_Types].xml')?.toString('utf8') ?? ''
    expect(ct).toContain('PartName="/ppt/slides/slide1.xml"')
  })

  it('slide1.xml と rels が無い (base のみ) の単スライド入力は、スライドコピーをスキップする', () => {
    // Python 版 merge_pptx は `if src_slide in files:` で防御している分岐
    const files = new Map<string, Buffer>([
      ['ppt/presentation.xml', basePresentationXml()],
      ['ppt/_rels/presentation.xml.rels', basePresRels()],
      ['[Content_Types].xml', baseContentTypes()],
    ])
    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    // ベース構造はコピー済
    expect(partMap.has('ppt/presentation.xml')).toBe(true)
    // slide1.xml は input に無いため output にも無い
    expect(partMap.has('ppt/slides/slide1.xml')).toBe(false)
  })

  it('base 構造に rels / content-types / presentation のいずれかが無い場合は、何も言わずスキップ', () => {
    // presentation.xml と rels が無いベース (一部のミニマル fixture)
    const files = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', slideXml('only')],
    ])
    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    expect(result.slideCount).toBe(1)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    expect(partMap.has('ppt/slides/slide1.xml')).toBe(true)
    expect(partMap.has('ppt/presentation.xml')).toBe(false)
  })

  it('10+ 枚連番でも rId / Content_Types / sldIdLst が連続して並ぶ (off-by-one 検出)', () => {
    const total = 12 // 10+ で桁またぎ (rId101..rId112) を確認
    const inputs: MergeInput[] = Array.from({ length: total }, (_, index) => ({
      slideNumber: index + 1,
      files: makeFiles(`s${String(index + 1)}`, {
        withMedia: false,
        includeBaseStructure: index === 0,
      }),
    }))
    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))

    // (a) slideX.xml が 1..12 全て存在
    for (let n = 1; n <= total; n += 1) {
      expect(partMap.has(`ppt/slides/slide${String(n)}.xml`)).toBe(true)
    }

    // (b) presentation.xml から、<p:sldId> の r:id / id を順序付きで抽出する。
    //     presentation.xml は、<p:sldId> 以外に r:id を持つ要素が無い。
    //     ただし意図を明確にするため、<p:sldId> 限定の正規表現で抽出する。
    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''
    const rIds = presXml.matchAll(/<p:sldId[^>]+r:id="(rId\d+)"/g).map(m => m[1]).toArray()
    expect(rIds).toEqual(Array.from({ length: total }, (_, index) => `rId${String(100 + index + 1)}`))
    const sldIds = presXml.matchAll(/<p:sldId[^>]+\sid="(\d+)"/g).map(m => Number(m[1])).toArray()
    expect(sldIds).toEqual(Array.from({ length: total }, (_, index) => 256 + index))

    // (c) presentation.xml.rels: slide relationship が 12 件
    const presRels = partMap.get('ppt/_rels/presentation.xml.rels')?.toString('utf8') ?? ''
    for (let n = 1; n <= total; n += 1) {
      expect(presRels).toContain(`Id="rId${String(100 + n)}"`)
      expect(presRels).toContain(`Target="slides/slide${String(n)}.xml"`)
    }

    // (d) [Content_Types].xml: slide1..slide12 全て Override
    const ct = partMap.get('[Content_Types].xml')?.toString('utf8') ?? ''
    for (let n = 1; n <= total; n += 1) {
      expect(ct).toContain(`PartName="/ppt/slides/slide${String(n)}.xml"`)
    }
  })
})

const REL_TYPE_FONT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'

/**
fixture 側の属性値エスケープ。
`&` と二重引用符を含む typeface を、XML として妥当にする。
*/
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
}

/**
埋め込みフォントを持つ 1 枚分の PPTX。dom-to-pptx はどのスライドでも rId201314 /
fonts/201314.fntdata から採番するため、fixture でも part 名をスライド間で衝突させる。
*/
function makeFilesWithFonts(
  label: string,
  fonts: readonly { readonly typeface: string, readonly style: string, readonly data: string }[],
  options: Readonly<{ includeBaseStructure: boolean }>,
): Map<string, Buffer> {
  const files = makeFiles(label, { withMedia: false, includeBaseStructure: options.includeBaseStructure })
  const byTypeface = new Map<string, { readonly style: string, readonly rId: string }[]>()
  const relationships: string[] = []
  for (const [index, font] of fonts.entries()) {
    const number = 201_314 + index
    const rId = `rId${String(number)}`
    files.set(`ppt/fonts/${String(number)}.fntdata`, buffer(font.data))
    relationships.push(
      `<Relationship Id="${rId}" Type="${REL_TYPE_FONT}" Target="fonts/${String(number)}.fntdata"/>`,
    )
    const styles = byTypeface.get(font.typeface) ?? []
    styles.push({ style: font.style, rId })
    byTypeface.set(font.typeface, styles)
  }
  const embedded = [...byTypeface].map(([typeface, styles]) =>
    `<p:embeddedFont><p:font typeface="${escapeAttribute(typeface)}"/>`
    + styles.map(entry => `<p:${entry.style} r:id="${entry.rId}"/>`).join('')
    + `</p:embeddedFont>`).join('')

  files.set('ppt/presentation.xml', buffer(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
    + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
    + `<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>`
    + `<p:embeddedFontLst>${embedded}</p:embeddedFontLst>`
    + `<p:defaultTextStyle/>`
    + `</p:presentation>`,
  ))
  files.set('ppt/_rels/presentation.xml.rels', buffer(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">`
    + `<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`
    + relationships.join('')
    + `</Relationships>`,
  ))
  return files
}

describe('mergePptxFiles: 埋め込みフォントの統合', () => {
  it('スライド 1 に無い書体も全スライドの和集合で残す', () => {
    // dom-to-pptx は、そのスライドで描画に使われた書体だけを埋め込む。
    // そのため埋め込み集合は、スライドごとに違う。
    // #1062 の計測では、実デッキ 51 枚が 2 通りの集合に割れた。
    const inputs: MergeInput[] = [
      {
        slideNumber: 1,
        files: makeFilesWithFonts('s1', [
          { typeface: 'Display Extended', style: 'regular', data: 'DISPLAY-REGULAR' },
        ], { includeBaseStructure: true }),
      },
      {
        slideNumber: 2,
        files: makeFilesWithFonts('s2', [
          { typeface: 'Inter', style: 'regular', data: 'INTER-REGULAR' },
          { typeface: 'Display Extended', style: 'bold', data: 'DISPLAY-BOLD' },
        ], { includeBaseStructure: false }),
      },
    ]

    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''

    expect(presXml).toContain('typeface="Display Extended"')
    expect(presXml).toContain('typeface="Inter"')
    // 1 typeface = 1 p:embeddedFont にまとめ、字形は regular → bold の順に並べる。
    expect(presXml.matchAll(/<p:embeddedFont>/g).toArray()).toHaveLength(2)
    const displayFont = /<p:embeddedFont><p:font typeface="Display Extended"\/>(.*?)<\/p:embeddedFont>/.exec(presXml)?.[1] ?? ''
    expect(displayFont.indexOf('<p:regular')).toBeLessThan(displayFont.indexOf('<p:bold'))

    const fontParts = partMap.keys().filter(part => part.startsWith('ppt/fonts/')).toArray().toSorted(compareStrings)
    expect(fontParts).toEqual(['ppt/fonts/font1.fntdata', 'ppt/fonts/font2.fntdata', 'ppt/fonts/font3.fntdata'])
    const data = fontParts.map(part => partMap.get(part)?.toString('utf8') ?? '')
    expect(data.toSorted(compareStrings)).toEqual(['DISPLAY-BOLD', 'DISPLAY-REGULAR', 'INTER-REGULAR'])
  })

  it('rels / Content_Types / fonts part を重複なく作り直す', () => {
    const inputs: MergeInput[] = [
      {
        slideNumber: 1,
        files: makeFilesWithFonts('s1', [
          { typeface: 'Inter', style: 'regular', data: 'INTER-REGULAR' },
        ], { includeBaseStructure: true }),
      },
      {
        // 同じ (typeface, 字形) を別 part 名で持つスライド。part 名はどちらも 201314 で衝突する。
        slideNumber: 2,
        files: makeFilesWithFonts('s2', [
          { typeface: 'Inter', style: 'regular', data: 'INTER-REGULAR' },
        ], { includeBaseStructure: false }),
      },
    ]

    const result = mergePptxFiles(inputs, engine)
    const parts = result.files.map(f => f.part)
    expect(parts).toHaveLength(new Set(parts).size)

    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    // 同じ組は 1 つに畳む。元の part 名（201314.fntdata）は残さない。
    expect(parts.filter(part => part.startsWith('ppt/fonts/'))).toEqual(['ppt/fonts/font1.fntdata'])

    const presRels = partMap.get('ppt/_rels/presentation.xml.rels')?.toString('utf8') ?? ''
    const fontRelationshipIds = presRels.matchAll(/<Relationship[^>]*relationships\/font"[^>]*\/>/g)
      .map(m => /Id="([^"]+)"/.exec(m[0])?.[1])
      .toArray()
    expect(fontRelationshipIds).toEqual(['rIdFont1'])
    expect(presRels).not.toContain('fonts/201314.fntdata')

    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''
    expect(presXml.matchAll(/<p:embeddedFontLst/g).toArray()).toHaveLength(1)
    expect(presXml).toContain('r:id="rIdFont1"')

    const ct = partMap.get('[Content_Types].xml')?.toString('utf8') ?? ''
    expect(ct.matchAll(/Extension="fntdata"/g).toArray()).toHaveLength(1)
    expect(ct).toContain('ContentType="application/x-fontdata"')
  })

  it('どのスライドにも埋め込みフォントが無ければ、fonts part と embeddedFontLst を作らない', () => {
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('s1', { withMedia: false, includeBaseStructure: true }) },
      { slideNumber: 2, files: makeFiles('s2', { withMedia: false, includeBaseStructure: false }) },
    ]

    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))

    expect(result.files.some(f => f.part.startsWith('ppt/fonts/'))).toBe(false)
    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''
    expect(presXml).not.toContain('embeddedFontLst')
    // 埋め込みが 1 件も無ければ ECMA-376 の既定 false のままにする。
    expect(presXml).not.toContain('embedTrueTypeFonts')
    expect(presXml).not.toContain('saveSubsetFonts')
    expect(partMap.get('[Content_Types].xml')?.toString('utf8')).not.toContain('fntdata')
    expect(result.warnings).toEqual([])
  })

  it('スライド 1 が無埋め込みでも embedTrueTypeFonts / saveSubsetFonts を付ける', () => {
    // F-01: 両属性は dom-to-pptx が埋め込みを行ったスライドにしか付けない
    // （dist/dom-to-pptx.cjs 231-232 が "true" で setAttribute）。ベースに採るスライド 1 が
    // 無埋め込みだと属性が無いまま embeddedFontLst だけが載り、PowerPoint が埋め込みを使わない。
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('s1', { withMedia: false, includeBaseStructure: true }) },
      {
        slideNumber: 2,
        files: makeFilesWithFonts('s2', [
          { typeface: 'Inter', style: 'regular', data: 'INTER-REGULAR' },
        ], { includeBaseStructure: false }),
      },
    ]

    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''

    expect(presXml).toContain('embedTrueTypeFonts="true"')
    expect(presXml).toContain('saveSubsetFonts="true"')
    expect(presXml).toContain('<p:embeddedFontLst')
    expect(presXml).toContain('typeface="Inter"')
    expect(partMap.keys().filter(part => part.startsWith('ppt/fonts/')).toArray()).toEqual([
      'ppt/fonts/font1.fntdata',
    ])
    const ct = partMap.get('[Content_Types].xml')?.toString('utf8') ?? ''
    expect(ct.matchAll(/Extension="fntdata"/g).toArray()).toHaveLength(1)
    expect(ct).toContain('ContentType="application/x-fontdata"')
  })

  it('typeface の & と二重引用符を属性値としてエスケープする', () => {
    // F-10(2): typeface は CSS の font-family 由来。XML 属性に直書きすると不正な XML になる。
    const typeface = 'A&B "Quoted" <C>'
    const inputs: MergeInput[] = [
      {
        slideNumber: 1,
        files: makeFilesWithFonts('s1', [
          { typeface, style: 'regular', data: 'AMP-REGULAR' },
        ], { includeBaseStructure: true }),
      },
    ]

    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''

    expect(presXml).toContain('typeface="A&amp;B &quot;Quoted&quot; &lt;C&gt;"')
    // 生の & と二重引用符が属性値に残っていないこと。残ると再パースで失敗する。
    expect(presXml).not.toContain('typeface="A&B')
    // 再パースできる（= 妥当な XML のまま）。
    const reparsed = engine.parse(partMap.get('ppt/presentation.xml') ?? Buffer.alloc(0))
    const fontNode = reparsed.selectNodes('//p:embeddedFontLst/p:embeddedFont/p:font', { p: NS_PRESENTATIONML })[0]
    expect(fontNode?.getAttr('typeface')).toBe(typeface)
  })

  it('同一 (typeface, 字形) で実体が違えばスライド 1 側を残し warning を積む', () => {
    // F-04 / F-10(3): 将来ライブラリがスライド単位のサブセット化を入れると、後続スライド固有のグリフが気づかれずに欠ける。
    // 先勝ちは変えず、判別できるよう warning にする。
    const inputs: MergeInput[] = [
      {
        slideNumber: 1,
        files: makeFilesWithFonts('s1', [
          { typeface: 'Inter', style: 'regular', data: 'INTER-FROM-SLIDE1' },
        ], { includeBaseStructure: true }),
      },
      {
        slideNumber: 2,
        files: makeFilesWithFonts('s2', [
          { typeface: 'Inter', style: 'regular', data: 'INTER-FROM-SLIDE2-DIFFERENT' },
        ], { includeBaseStructure: false }),
      },
    ]

    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))

    const fontParts = partMap.keys().filter(part => part.startsWith('ppt/fonts/')).toArray()
    expect(fontParts).toEqual(['ppt/fonts/font1.fntdata'])
    expect(partMap.get('ppt/fonts/font1.fntdata')?.toString('utf8')).toBe('INTER-FROM-SLIDE1')

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Inter')
    expect(result.warnings[0]).toContain('regular')
  })

  it('4 字形が別スライドに散っていても regular → bold → italic → boldItalic に並べる', () => {
    // F-10(4): 並び順は ECMA-376 CT_EmbeddedFontDataId の sequence。入力の出現順に依存しない。
    const inputs: MergeInput[] = [
      {
        slideNumber: 1,
        files: makeFilesWithFonts('s1', [
          { typeface: 'Inter', style: 'boldItalic', data: 'INTER-BI' },
        ], { includeBaseStructure: true }),
      },
      {
        slideNumber: 2,
        files: makeFilesWithFonts('s2', [
          { typeface: 'Inter', style: 'italic', data: 'INTER-I' },
        ], { includeBaseStructure: false }),
      },
      {
        slideNumber: 3,
        files: makeFilesWithFonts('s3', [
          { typeface: 'Inter', style: 'bold', data: 'INTER-B' },
        ], { includeBaseStructure: false }),
      },
      {
        slideNumber: 4,
        files: makeFilesWithFonts('s4', [
          { typeface: 'Inter', style: 'regular', data: 'INTER-R' },
        ], { includeBaseStructure: false }),
      },
    ]

    const result = mergePptxFiles(inputs, engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    const presXml = partMap.get('ppt/presentation.xml')?.toString('utf8') ?? ''

    expect(presXml.matchAll(/<p:embeddedFont>/g).toArray()).toHaveLength(1)
    const inner = /<p:embeddedFont><p:font typeface="Inter"\/>(.*?)<\/p:embeddedFont>/.exec(presXml)?.[1] ?? ''
    const styleOrder = inner.matchAll(/<p:(regular|bold|italic|boldItalic) /g).map(m => m[1]).toArray()
    expect(styleOrder).toEqual(['regular', 'bold', 'italic', 'boldItalic'])
    expect(result.warnings).toEqual([])
  })
})

/**
pptxgenjs 由来の順序逸脱（sldIdLst が notesMasterIdLst より前）を持つ presentation.xml。
*/
function outOfOrderPresentation(): Buffer {
  return buffer(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<p:presentation xmlns:p="${NS_PRESENTATIONML}" xmlns:r="${NS_OFFICE_RELATIONSHIPS}">`
    + `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + `<p:sldIdLst><p:sldId id="256" r:id="rId101"/></p:sldIdLst>`
    + `<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>`
    + `<p:defaultTextStyle/>`
    + `<p:sldSz cx="12192000" cy="6858000"/>`
    + `<p:notesSz cx="6858000" cy="9144000"/>`
    + `<p:custom1/><p:custom2/>`
    + `</p:presentation>`,
  )
}

/**
`p:presentation` の直下の子要素名を出現順に返す。
*/
function childOrderOf(buffer: Readonly<Buffer> | undefined): string[] {
  const document = engine.parse(buffer ?? Buffer.alloc(0))
  return document.selectNodes('/p:presentation/*', { p: NS_PRESENTATIONML }).map(node => node.localName())
}

describe('mergePptxFiles: p:presentation の要素順の正規化', () => {
  it('sldIdLst が notesMasterIdLst より前でも CT_Presentation の sequence 順に直す', () => {
    // F-18: pptxgenjs 由来で単スライドの時点から逸脱している。merge はスライド 1 の
    // presentation.xml をそのまま受け継ぐため、統合後に一度並べ直す。
    const files = makeFiles('s1', { withMedia: false, includeBaseStructure: true })
    files.set('ppt/presentation.xml', outOfOrderPresentation())

    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))

    expect(childOrderOf(partMap.get('ppt/presentation.xml'))).toEqual([
      'sldMasterIdLst',
      'notesMasterIdLst',
      'sldIdLst',
      'sldSz',
      'notesSz',
      'defaultTextStyle',
      // sequence に無い要素は相対順を保って末尾へ。
      'custom1',
      'custom2',
    ])
  })

  it('既に規格順なら並びを動かさない', () => {
    const files = makeFilesWithFonts('s1', [
      { typeface: 'Inter', style: 'regular', data: 'INTER-REGULAR' },
    ], { includeBaseStructure: true })

    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))

    expect(childOrderOf(partMap.get('ppt/presentation.xml'))).toEqual([
      'sldIdLst',
      'sldSz',
      'notesSz',
      'embeddedFontLst',
      'defaultTextStyle',
    ])
  })
})
