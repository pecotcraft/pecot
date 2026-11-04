#!/usr/bin/env node
/**
 * compare-pptx.mjs / inspect-pptx.mjs の検証用に、小さな pptx を cli/dist の archive writer で合成する。
 *
 *   node make-fixture.mjs <variant> <out.pptx>
 *
 * 出力先は引数で受ける。
 * project ディレクトリ内に生成すると、nx の `default` 入力に紛れ込む。
 * そのため、呼び出し側の `.test.sh` が `mktemp -d` 配下を渡す。
 *
 * base の構成は次のとおり。
 * 2 slide。`p:embeddedFontLst` は 2 書体 3 slot。fntdata は 3 本。
 * clip id を含む svg が 1 本。png が 1 本。
 * `wrap="none"` + `a:spAutoFit` の bodyPr が 1 つ。
 * `hidden="1"` 付きの cNvPr が 1 つ。テキスト無しの sp が 1 つ。`p:timing` は無し。
 *
 * yazl は各エントリの mtime に現在時刻を入れるため zip のバイト列は run ごとに変わる。
 * part の内容だけが決定論的なので、ファイルサイズを assert するテストは書かない。
 */
import { loadCliDist } from '../lib/cli-dist.mjs'
import { isSelfExecuted } from '../lib/self-exec.mjs'

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const NS_ASVG = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const NS_DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
const URI_TABLE = 'http://schemas.openxmlformats.org/drawingml/2006/table'
/** p:sldSz と同じ幅・高さ。全面 pic の fixture が使う。 */
const SLIDE_SIZE = [9144000, 5143500]
/** inspect-pptx.mjs 用 variant が追加する svg media の内容。 */
export const INSPECT_SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>'

/** 合成できる variant の一覧。`.test.sh` の網羅と 1:1 で対応する。 */
export const VARIANTS = [
  'base',
  'xmlns-order',
  'cnvpr-id',
  'clip-id',
  'core-dates',
  'font-swap',
  'font-rename',
  'font-content',
  'cnvpr-hidden',
  'real-diff',
  'extra-slide',
  'pic-and-typeface-drop',
  'clip-in-text-a',
  'clip-in-text-b',
  // 以下は inspect-pptx.mjs 用。base の 2 slide に slide 3 以降を足す（base 自体は変えない）。
  'full-image',
  'table-frame',
  'css-raster-pic',
  'prst-mix',
  'timing',
]

/** base の deck 定義。variant はこの構造を書き換える。 */
function baseSpec() {
  return {
    rootAttributeOrder: ['a', 'r', 'p'],
    created: '2026-09-07T00:00:00Z',
    cNvPrIdOffset: 0,
    hidden: true,
    clipIds: ['clip_19ehl603m', 'clip_2af03bz71'],
    png: 'PNG-BYTES-BASE',
    // inspect 用 variant が足す media part（{ part, data }）。base は持たない。
    media: [],
    fonts: [
      { part: 'ppt/fonts/201314.fntdata', relId: 'rId201314', data: 'FNTDATA-SAMPLE-REGULAR' },
      { part: 'ppt/fonts/201315.fntdata', relId: 'rId201315', data: 'FNTDATA-SAMPLE-BOLD' },
      { part: 'ppt/fonts/201316.fntdata', relId: 'rId201316', data: 'FNTDATA-INTER-REGULAR' },
    ],
    embedded: [
      {
        typeface: 'Sample Sans',
        slots: [['regular', 'rId201314'], ['bold', 'rId201315']],
      },
      { typeface: 'Inter', slots: [['regular', 'rId201316']] },
    ],
    slides: [
      {
        n: 1,
        sps: [
          { id: 2, text: 'タイトル A', off: [100, 200], ext: [3000, 400], divergent: true, descr: true },
          { id: 3, text: '本文 B', off: [100, 800], ext: [4000, 600], hidden: true },
          { id: 4, text: '', off: [100, 1600], ext: [500, 500] },
        ],
        pics: [{ id: 5, off: [5000, 200], ext: [1000, 1000] }],
      },
      {
        n: 2,
        sps: [
          { id: 2, text: 'セクション C', off: [200, 300], ext: [3500, 450] },
          { id: 3, text: '説明 D', off: [200, 900], ext: [4200, 650] },
        ],
        pics: [{ id: 4, off: [6000, 300], ext: [900, 900] }],
      },
    ],
  }
}

function applyVariant(spec, variant) {
  switch (variant) {
    case 'base':
      return spec
    case 'xmlns-order':
      spec.rootAttributeOrder = ['p', 'a', 'r']
      return spec
    case 'cnvpr-id':
      spec.cNvPrIdOffset = 10
      return spec
    case 'clip-id':
      spec.clipIds = ['clip_7zq41ke0b', 'clip_kd93mx17a']
      return spec
    case 'core-dates':
      spec.created = '2026-09-07T12:34:56Z'
      return spec
    case 'font-swap': {
      // fntdata 2 本の中身を入れ替え、embeddedFontLst の r:id を追従させる
      // （同一設定 2 run で観測された非決定。実体と slot の対応は保たれる）。
      const swapped = spec.fonts[0].data
      spec.fonts[0].data = spec.fonts[1].data
      spec.fonts[1].data = swapped
      spec.embedded[0].slots = [['regular', 'rId201315'], ['bold', 'rId201314']]
      return spec
    }
    case 'font-rename': {
      // part 名と Relationship Id だけを付け替える（内容は同一）。
      const renamed = ['font1', 'font2', 'font3']
      const relIdOf = new Map()
      spec.fonts = spec.fonts.map((font, index) => {
        const relId = `rIdFont${index + 1}`
        relIdOf.set(font.relId, relId)
        return { part: `ppt/fonts/${renamed[index]}.fntdata`, relId, data: font.data }
      })
      spec.embedded = spec.embedded.map((font) => ({
        typeface: font.typeface,
        slots: font.slots.map(([slot, relId]) => [slot, relIdOf.get(relId) ?? relId]),
      }))
      return spec
    }
    case 'font-content':
      // 名前は同じで bold の実体だけ差し替える（実体の取り違えを模した負例）。
      spec.fonts[1].data = 'FNTDATA-SAMPLE-BOLD-ALTERED'
      return spec
    case 'cnvpr-hidden':
      spec.hidden = false
      return spec
    case 'real-diff': {
      const slide2 = spec.slides[1]
      // `a:t` を 1 つ消し、別 sp の cx を変え、pic を 1 つ足す。
      slide2.sps = [{ ...slide2.sps[1], ext: [4600, 650] }]
      slide2.pics = [...slide2.pics, { id: 6, off: [7000, 1500], ext: [800, 800] }]
      spec.png = 'PNG-BYTES-ALTERED'
      spec.fonts.push({
        part: 'ppt/fonts/201317.fntdata',
        relId: 'rId201317',
        data: 'FNTDATA-NOTO-REGULAR',
      })
      spec.embedded.push({ typeface: 'Noto Sans JP', slots: [['regular', 'rId201317']] })
      return spec
    }
    case 'extra-slide':
      spec.slides.push({
        n: 3,
        sps: [{ id: 2, text: '追加 E', off: [300, 400], ext: [3300, 500] }],
        pics: [],
      })
      return spec
    case 'pic-and-typeface-drop': {
      // 判定「p:pic が減らない」「埋め込み typeface が全て残る」の FAIL 側を通す負例。
      // slide 1 から p:pic を 1 つ削除し、埋め込み typeface（Inter）を 1 つ落とす。
      const slide1 = spec.slides[0]
      slide1.pics = []
      spec.embedded = spec.embedded.filter((font) => font.typeface !== 'Inter')
      spec.fonts = spec.fonts.filter((font) => font.relId !== 'rId201316')
      return spec
    }
    case 'clip-in-text-a':
      // normalizeClipIds の過剰正規化を検出する負例。id="…" / url(#…) / clip-path="…" の
      // 文脈外（本文 a:t）に現れる `clip_` 文字列は clip-in-text-b と対にして使う。
      spec.slides[0].sps[0] = { ...spec.slides[0].sps[0], text: 'clip_aaaaaaaaa' }
      return spec
    case 'clip-in-text-b':
      spec.slides[0].sps[0] = { ...spec.slides[0].sps[0], text: 'clip_bbbbbbbbb' }
      return spec
    case 'full-image':
      // slide 3: 背景 blip だけで spTree が空。slide 4: p:sldSz と同寸の pic。
      // 両 slide が同じ media part を参照する（deck 全体の一意 media は 1 件）。
      spec.media.push({ part: 'ppt/media/image2.png', data: 'PNG-FULL-IMAGE' })
      spec.slides.push(
        {
          n: 3,
          background: 'rIdImg1',
          sps: [],
          pics: [],
          rels: [{ id: 'rIdImg1', target: '../media/image2.png' }],
        },
        {
          n: 4,
          sps: [],
          pics: [{ id: 2, off: [0, 0], ext: SLIDE_SIZE, embed: 'rIdImg1' }],
          rels: [{ id: 'rIdImg1', target: '../media/image2.png' }],
        },
      )
      return spec
    case 'table-frame':
      // slide 3: テキスト sp 1 つと、table / chart / diagram の graphicFrame 各 1 つ。
      // 表は 2×2 で 1 セルだけ空（a:t を持たない）。
      spec.slides.push({
        n: 3,
        sps: [{ id: 2, text: '表タイトル', off: [100, 100], ext: [3000, 400] }],
        pics: [],
        frames: [
          { id: 3, kind: 'table', cells: [['列 1', '列 2'], ['値 1', '']] },
          { id: 4, kind: 'chart' },
          { id: 5, kind: 'diagram' },
        ],
      })
      return spec
    case 'css-raster-pic': {
      // slide 3: 公式 pptx-editable の部分ラスタ（descr）を模した pic 3 つと、svgBlip 付きの pic 1 つ。
      spec.media.push(
        { part: 'ppt/media/image3.png', data: 'PNG-CSS-FILTER' },
        { part: 'ppt/media/image4.svg', data: INSPECT_SVG },
      )
      const raster = (id, reason) => ({
        id,
        off: [100 * id, 100],
        ext: [500, 500],
        embed: 'rIdImg1',
        descr: `Rendered as an image because of CSS ${reason}`,
      })
      spec.slides.push({
        n: 3,
        sps: [],
        pics: [
          raster(2, 'filter'),
          raster(3, 'filter'),
          raster(4, 'clip-path'),
          { id: 5, off: [600, 100], ext: [500, 500], embed: 'rIdImg1', svgEmbed: 'rIdImg2', descr: 'a11y-note' },
        ],
        rels: [
          { id: 'rIdImg1', target: '../media/image3.png' },
          { id: 'rIdImg2', target: '../media/image4.svg' },
        ],
      })
      return spec
    }
    case 'prst-mix': {
      // slide 3: prstGeom rect ×2 / roundRect / line と custGeom 1 つ。テキストありは 3 つで、
      // うち 2 つに a:latin / a:ea を持たせる。
      const font = { latin: 'Inter', ea: 'Noto Sans JP' }
      spec.slides.push({
        n: 3,
        sps: [
          { id: 2, text: '四角 G', off: [100, 100], ext: [1000, 400], geom: 'rect', font },
          { id: 3, text: '', off: [100, 600], ext: [1000, 400], geom: 'rect' },
          { id: 4, text: '角丸 H', off: [100, 1100], ext: [1000, 400], geom: 'roundRect', font },
          { id: 5, text: '', off: [100, 1600], ext: [1000, 0], geom: 'line' },
          { id: 6, text: '自由形 I', off: [100, 2100], ext: [1000, 400], geom: 'cust' },
        ],
        pics: [],
      })
      return spec
    }
    case 'timing':
      spec.slides.push({
        n: 3,
        sps: [{ id: 2, text: 'アニメーション J', off: [100, 100], ext: [3000, 400] }],
        pics: [],
        timing: true,
      })
      return spec
    /* c8 ignore next 2 */
    default:
      throw new Error(`未対応の variant: ${variant}`)
  }
}

function rootAttributes(order) {
  const declarations = { a: `xmlns:a="${NS_A}"`, r: `xmlns:r="${NS_R}"`, p: `xmlns:p="${NS_P}"` }
  return order.map((prefix) => declarations[prefix]).join(' ')
}

function shapeXml(sp, spec) {
  const id = sp.id + spec.cNvPrIdOffset
  // descr の値は、cNvPr の他属性保持を見るためだけの固定文字列。
  // clip id とは無関係にする。clip-id variant で clip 文字列を変えても、descr は変わらないようにするためだ。
  const descr = sp.descr === true ? ' descr="a11y-note"' : ''
  const hidden = sp.hidden === true && spec.hidden ? ' hidden="1"' : ''
  const bodyPr = sp.divergent === true
    ? '<a:bodyPr wrap="none"><a:spAutoFit/></a:bodyPr>'
    : '<a:bodyPr wrap="square"><a:noAutofit/></a:bodyPr>'
  const runProps = sp.font === undefined
    ? ''
    : `<a:rPr lang="ja-JP"><a:latin typeface="${sp.font.latin}"/><a:ea typeface="${sp.font.ea}"/></a:rPr>`
  const run = sp.text === '' ? '<a:p/>' : `<a:p><a:r>${runProps}<a:t>${sp.text}</a:t></a:r></a:p>`
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Object ${id}"${descr}${hidden}/>`
    + '<p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    + `<p:spPr><a:xfrm><a:off x="${sp.off[0]}" y="${sp.off[1]}"/>`
    + `<a:ext cx="${sp.ext[0]}" cy="${sp.ext[1]}"/></a:xfrm>${geometryXml(sp.geom)}</p:spPr>`
    + `<p:txBody>${bodyPr}${run}</p:txBody></p:sp>`
}

/** sp の形状。base の sp は geom を持たず、spPr に形状要素を出さない。 */
function geometryXml(geom) {
  if (geom === undefined) return ''
  if (geom === 'cust') {
    return '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>'
      + '<a:rect l="0" t="0" r="r" b="b"/><a:pathLst/></a:custGeom>'
  }
  return `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>`
}

function pictureXml(pic, spec) {
  const id = pic.id + spec.cNvPrIdOffset
  const descr = pic.descr === undefined ? '' : ` descr="${pic.descr}"`
  const embed = pic.embed ?? 'rId1'
  const blip = pic.svgEmbed === undefined
    ? `<a:blip r:embed="${embed}"/>`
    : `<a:blip r:embed="${embed}"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">`
      + `<asvg:svgBlip xmlns:asvg="${NS_ASVG}" r:embed="${pic.svgEmbed}"/></a:ext></a:extLst></a:blip>`
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"${descr}/>`
    + '<p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
    + `<p:blipFill>${blip}</p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${pic.off[0]}" y="${pic.off[1]}"/>`
    + `<a:ext cx="${pic.ext[0]}" cy="${pic.ext[1]}"/></a:xfrm></p:spPr></p:pic>`
}

function tableXml(cells) {
  const grid = cells[0].map(() => '<a:gridCol w="1000"/>').join('')
  const rows = cells
    .map((cols) => '<a:tr h="300">'
      + cols
        .map((text) => '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>'
          + (text === '' ? '<a:p/>' : `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
          + '</a:txBody><a:tcPr/></a:tc>')
        .join('')
      + '</a:tr>')
    .join('')
  return `<a:tbl><a:tblPr/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl>`
}

/** graphicFrame（table / chart / diagram）。chart / diagram の参照先 part は持たない。 */
function graphicFrameXml(frame, spec) {
  const id = frame.id + spec.cNvPrIdOffset
  const data = {
    table: () => [URI_TABLE, tableXml(frame.cells)],
    chart: () => [NS_C, `<c:chart xmlns:c="${NS_C}" r:id="rIdChart"/>`],
    diagram: () => [NS_DGM, `<dgm:relIds xmlns:dgm="${NS_DGM}"/>`],
  }[frame.kind]
  const [uri, body] = data()
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Frame ${id}"/>`
    + '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
    + '<p:xfrm><a:off x="100" y="600"/><a:ext cx="2000" cy="600"/></p:xfrm>'
    + `<a:graphic><a:graphicData uri="${uri}">${body}</a:graphicData></a:graphic></p:graphicFrame>`
}

function slideXml(slide, spec) {
  const shapes = slide.sps.map((sp) => shapeXml(sp, spec)).join('')
  const pictures = slide.pics.map((pic) => pictureXml(pic, spec)).join('')
  const frames = (slide.frames ?? []).map((frame) => graphicFrameXml(frame, spec)).join('')
  const background = slide.background === undefined
    ? ''
    : `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="${slide.background}"/>`
      + '<a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>'
  const timing = slide.timing === true
    ? '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/>'
      + '</p:par></p:tnLst></p:timing>'
    : ''
  return `${XML_DECL}<p:sld ${rootAttributes(spec.rootAttributeOrder)}>`
    + `<p:cSld>${background}<p:spTree>${shapes}${pictures}${frames}</p:spTree></p:cSld>${timing}</p:sld>`
}

/** slide の rels（画像参照だけ）。rels を持たない slide は part を作らない。 */
function slideRels(slide) {
  const relations = slide.rels
    .map((rel) => `<Relationship Id="${rel.id}" Type="${REL_TYPE}/image" Target="${rel.target}"/>`)
    .join('')
  return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `${relations}</Relationships>`
}

function presentationXml(spec) {
  const slideIds = spec.slides
    .map((slide, index) => `<p:sldId id="${256 + index}" r:id="rId${101 + index}"/>`)
    .join('')
  const fonts = spec.embedded
    .map((font) => `<p:embeddedFont><p:font typeface="${font.typeface}"/>`
      + font.slots.map(([slot, relId]) => `<p:${slot} r:id="${relId}"/>`).join('')
      + '</p:embeddedFont>')
    .join('')
  return `${XML_DECL}<p:presentation ${rootAttributes(spec.rootAttributeOrder)}>`
    + `<p:sldIdLst>${slideIds}</p:sldIdLst>`
    + '<p:sldSz cx="9144000" cy="5143500"/>'
    + `<p:embeddedFontLst>${fonts}</p:embeddedFontLst></p:presentation>`
}

function presentationRels(spec) {
  const slides = spec.slides
    .map((slide, index) => `<Relationship Id="rId${101 + index}" Type="${REL_TYPE}/slide"`
      + ` Target="slides/slide${slide.n}.xml"/>`)
    .join('')
  const fonts = spec.fonts
    .map((font) => `<Relationship Id="${font.relId}" Target="${font.part.replace('ppt/', '')}"`
      + ` Type="${REL_TYPE}/font"/>`)
    .join('')
  return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `${slides}${fonts}</Relationships>`
}

function coreXml(spec) {
  return `${XML_DECL}<cp:coreProperties`
    + ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">'
    + '<dc:title>pptx-compare fixture</dc:title>'
    + `<dcterms:created>${spec.created}</dcterms:created>`
    + `<dcterms:modified>${spec.created}</dcterms:modified></cp:coreProperties>`
}

function svgXml(spec) {
  const [first, second] = spec.clipIds
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
    + `<defs><clipPath id="${first}"><rect width="100" height="100"/></clipPath>`
    + `<clipPath id="${second}"><rect width="50" height="50"/></clipPath></defs>`
    + `<g clip-path="url(#${first})"><rect width="100" height="100" fill="#4f46e5"/></g>`
    + `<g clip-path="url(#${second})"><rect width="50" height="50" fill="#000"/></g></svg>`
}

function contentTypesXml(spec) {
  const overrides = spec.slides
    .map((slide) => `<Override PartName="/ppt/slides/slide${slide.n}.xml"`
      + ' ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>')
    .join('')
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Default Extension="svg" ContentType="image/svg+xml"/>'
    + '<Default Extension="fntdata" ContentType="application/x-fontdata"/>'
    + '<Override PartName="/ppt/presentation.xml"'
    + ' ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + `${overrides}</Types>`
}

/** variant の pptx を outPath に書き出す。 */
export async function makeFixture(variant, outPath) {
  if (!VARIANTS.includes(variant)) {
    throw new Error(`未対応の variant: ${variant} (使用可能: ${VARIANTS.join('|')})`)
  }
  const spec = applyVariant(baseSpec(), variant)
  const cli = await loadCliDist()
  const writer = new cli.PptxArchive().write()
  const add = (part, text) => writer.addBuffer(part, Buffer.from(text, 'utf8'))
  add('[Content_Types].xml', contentTypesXml(spec))
  add('docProps/core.xml', coreXml(spec))
  add('ppt/presentation.xml', presentationXml(spec))
  add('ppt/_rels/presentation.xml.rels', presentationRels(spec))
  for (const slide of spec.slides) {
    add(`ppt/slides/slide${slide.n}.xml`, slideXml(slide, spec))
    if (slide.rels !== undefined) add(`ppt/slides/_rels/slide${slide.n}.xml.rels`, slideRels(slide))
  }
  for (const media of spec.media) add(media.part, media.data)
  add('ppt/media/image1.svg', svgXml(spec))
  add('ppt/media/image1.png', spec.png)
  for (const font of spec.fonts) add(font.part, font.data)
  await writer.finish(outPath)
  return outPath
}

// 他の mjs から VARIANTS / makeFixture を import したときは実行しない
// （自己実行判定が無いと import だけで usage を出して exit 2 する）。
if (isSelfExecuted(import.meta.url)) {
  const [variant, outPath] = process.argv.slice(2)
  if (variant === undefined || outPath === undefined) {
    process.stderr.write(`usage: node make-fixture.mjs <variant> <out.pptx>\n  variant: ${VARIANTS.join(' | ')}\n`)
    process.exitCode = 2
  } else {
    try {
      await makeFixture(variant, outPath)
    } catch (error) {
      process.stderr.write(`ERROR: ${error.message}\n`)
      process.exitCode = 2
    }
  }
}
