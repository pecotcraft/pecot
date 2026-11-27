// merge_pptx.py の TS 移植版 (`src/domain/pptx-ooxml/merge.ts`) の unit test。
// fixture は in-memory の Map<string, Buffer> で構築する (zip I/O は呼び出し側責務)。

import { describe, expect, it } from 'vitest'

import { mergePptxFiles, type MergeInput } from '../merge.js'
import { XmldomXmlEngine } from '../../../infra/pptx-ooxml/xml-engine.js'
import { compareStrings } from '../../_shared/compare-strings.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('入力が 0 件の場合は、例外が発生する', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、入力のテストです。スライドを 1 件も渡さなかった場合に、`no input` を含む例外が発生することを確認します。')
    expect(() => mergePptxFiles([], engine)).toThrow(/no input/i)
  })

  it('slideNumber が 1 から N までの連番でない場合は、欠番を検出して例外が発生する', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、スライドの番号のテストです。1 番の次が 3 番のように番号が飛んでいる場合に、`1..N consecutive` を含む例外が発生することを確認します。')
    const inputs: MergeInput[] = [
      { slideNumber: 1, files: makeFiles('a', { withMedia: false, includeBaseStructure: true }) },
      // slide 2 を欠いて slide 3 にジャンプ → 歯抜け
      { slideNumber: 3, files: makeFiles('c', { withMedia: false, includeBaseStructure: false }) },
    ]
    expect(() => mergePptxFiles(inputs, engine)).toThrow(/1\.\.N consecutive/i)
  })

  it('slideNumber が 1 から始まらない場合は、例外が発生する', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、スライドの番号のテストです。`slideNumber` が 2 だけの入力を渡した場合に、`1..N consecutive` を含む例外が発生することを確認します。')
    const inputs: MergeInput[] = [
      { slideNumber: 2, files: makeFiles('s2', { withMedia: false, includeBaseStructure: true }) },
    ]
    expect(() => mergePptxFiles(inputs, engine)).toThrow(/1\.\.N consecutive/i)
  })

  it('統合後の XML の宣言に standalone="yes" を含める', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、XML の宣言のテストです。2 枚のスライドを統合した場合に、出力する 3 つの XML のすべてに `standalone="yes"` が含まれることを確認します。')
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

  it('スライド 1 の基本の構造を使い、スライドの数だけ slideX.xml を作成する', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、統合の結果のテストです。3 枚のスライドを統合した場合に、スライド数が 3 になり、`slide1.xml` から `slide3.xml` までが出力されることを確認します。')
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

  it('メディアファイルの名前にスライド番号を付け、rels の参照も書き換える', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、メディアファイルのテストです。画像を持つ 2 枚のスライドを統合した場合に、`image1.png` が `image1-s1.png` と `image1-s2.png` に改名され、`Target` も改名後の名前を指すことを確認します。')
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

  it('presentation.xml の sldIdLst を、スライドの数だけの sldId で作り直す', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、`presentation.xml` のテストです。3 枚のスライドを統合した場合に、`sldId` が 3 件になり、`id` が 256 から、`r:id` が `rId101` から連番になることを確認します。')
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

  it('presentation.xml.rels は、種類が slide の関係だけを作り直し、ほかの種類の関係は残す', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、`presentation.xml.rels` のテストです。2 枚のスライドを統合した場合に、`slideMaster` の関係が元のまま残り、`slide` の関係が `rId101` と `rId102` の 2 件になることを確認します。')
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

  it('[Content_Types].xml の slide の Override を作り直す', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、`[Content_Types].xml` のテストです。3 枚のスライドを統合した場合に、`presentation.xml` の `Override` が残り、各スライドの `Override` が出力されることを確認します。')
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

  it('slideNumber が降順で渡された場合でも、1 番を基本の構造にする', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、スライドの順序のテストです。2 番、1 番の順にスライドを渡した場合に、昇順に並べ替えて 1 番を基本の構造とし、2 件のスライドを出力することを確認します。')
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

  it('media の空のディレクトリのエントリ ppt/media/ は、無視する', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、メディアファイルのテストです。zip に含まれることがある、名前が `ppt/media/` だけのエントリを渡した場合に、出力へ含めないことを確認します。')
    const files = makeFiles('a', { withMedia: false, includeBaseStructure: true })
    files.set('ppt/media/', buffer('')) // zip に偶発する dir entry のシミュレート
    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    // "ppt/media/" は output に rename されない
    const renamedKeys = partMap.keys().filter(k => k.startsWith('ppt/media/')).toArray()
    expect(renamedKeys).toEqual([])
  })

  it('rels の Target が ../media/ 以外の場合と、改名の対象にないメディアの場合は、書き換えない', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、メディアの参照のテストです。改名の対象にない `image-uncatalogued.png` や、`../slideLayouts/` への参照がある場合に、改名した画像の参照だけを書き換え、ほかの参照は元のまま残すことを確認します。')
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

  it('拡張子がないメディアファイルにも、スライド番号を付ける', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、メディアファイルのテストです。`binary-blob` のように拡張子がないメディアファイルの場合に、名前の末尾にスライド番号を付けた `binary-blob-s1` になることを確認します。')
    const files = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', slideXml('noext')],
      ['ppt/media/binary-blob', buffer('blob-data')],
    ])
    const result = mergePptxFiles([{ slideNumber: 1, files }], engine)
    const partMap = new Map(result.files.map(f => [f.part, f.buffer]))
    expect(partMap.has('ppt/media/binary-blob-s1')).toBe(true)
  })

  it('基本の [Content_Types].xml に slide の Override がない場合でも、slideX.xml の Override を追加する', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、`[Content_Types].xml` のテストです。`slide` の `Override` を持たない `[Content_Types].xml` を渡した場合でも、`slide1.xml` の `Override` が追加されることを確認します。')
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

  it('slide1.xml と rels がなく、基本の構造だけの入力の場合は、スライドを複製しない', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、入力が基本の構造だけの場合のテストです。`slide1.xml` を持たない 1 件の入力を渡した場合に、`presentation.xml` は出力し、存在しない `slide1.xml` は出力しないことを確認します。')
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

  it('基本の構造に rels、content-types、presentation のいずれかがない場合は、エラーにせず、処理を省略する', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、基本の構造が不足している場合のテストです。`slide1.xml` だけを持つ入力を渡した場合に、例外が発生せず、スライド数が 1 になり、`presentation.xml` は出力しないことを確認します。')
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

  it('スライドが 10 枚以上でも、rId、Content_Types、sldIdLst が連続して並ぶ', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、スライドの数が多い場合のテストです。12 枚のスライドを統合した場合に、`rId101` から `rId112` までと、`sldId` の `id`、`Content_Types` の `Override` が欠けず、順に並ぶことを確認します。')
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
  it('スライド 1 にない書体も、すべてのスライドの和集合として残す', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、埋め込みフォントの統合のテストです。スライドごとに埋め込まれた書体が異なる場合に、すべての書体を残し、書体ごとに `p:embeddedFont` を 1 つにまとめ、字形が `regular`、`bold` の順になることを確認します。')
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

  it('rels、Content_Types、fonts の part を、重複なく作り直す', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、埋め込みフォントの統合のテストです。同じ書体と字形が別のスライドに重複して埋め込まれている場合に、1 つにまとめ、元の part 名を残さず、関係の ID と `Content_Types` の宣言が 1 つだけになることを確認します。')
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

  it('どのスライドにも埋め込みフォントがない場合は、fonts の part と embeddedFontLst を作成しない', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、埋め込みフォントの統合のテストです。埋め込みフォントが 1 件もない場合に、`embeddedFontLst` と `embedTrueTypeFonts` などの属性、`fntdata` の宣言を出力せず、警告もないことを確認します。')
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

  it('スライド 1 に埋め込みフォントがなくても、embedTrueTypeFonts と saveSubsetFonts を付ける', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、埋め込みフォントの統合のテストです。スライド 1 に埋め込みフォントがなく、スライド 2 にある場合は、両方の属性を `true` で出力し、スライド 2 の書体を `embeddedFontLst` に含めることを確認します。')
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

  it('typeface に含まれる & や二重引用符を、属性値としてエスケープする', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、埋め込みフォントの統合のテストです。書体名に `&`、二重引用符、`<` が含まれる場合に、属性値としてエスケープして出力し、再び解析すると元の書体名に戻る、妥当な XML であることを確認します。')
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

  it('同じ書体と字形で内容が異なる場合は、スライド 1 のものを残し、警告を記録する', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、埋め込みフォントの統合のテストです。スライド 1 と 2 が同じ書体と字形で異なる内容を持つ場合に、スライド 1 のものだけを残し、書体名と字形を含む警告を 1 件記録することを確認します。')
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

  it('4 つの字形が別のスライドに分かれていても、regular、bold、italic、boldItalic の順に並べる', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、埋め込みフォントの統合のテストです。同じ書体の 4 つの字形が 4 枚のスライドに分かれて埋め込まれている場合に、入力の順によらず、`regular`、`bold`、`italic`、`boldItalic` の順に並び、警告がないことを確認します。')
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
  it('sldIdLst が notesMasterIdLst より前にある場合でも、規格の順序（CT_Presentation の sequence）に並べ直す', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、`p:presentation` の子要素の順序のテストです。`sldIdLst` が `notesMasterIdLst` より前にある `presentation.xml` を渡した場合に、規格の順序に並べ直し、規格にない要素を末尾に元の順序で残すことを確認します。')
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

  it('すでに規格の順序になっている場合は、並びを変更しない', async () => {
    await explains('スライドごとの PPTX を 1 つに統合する `mergePptxFiles` の、`p:presentation` の子要素の順序のテストです。埋め込みフォントを持つ規格の順序の `presentation.xml` を渡した場合に、子要素の並びが変わらないことを確認します。')
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
