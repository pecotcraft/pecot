/**
 * inspect-pptx.mjs の集計本体。pptx 1 本から枚ごと・deck 全体の構成指標を取り出す。
 *
 * `lib/metrics.mjs` の `collectMetrics`（#1062 baseline。spTree 直下だけを数える）とは
 * 別の関数として持ち、あちらは呼ばない。こちらは変換手順ごとの構成差を見るため、
 * spTree 配下を子孫まで数える（`p:grpSp` に入った図形も 1 件として数える）。
 * `mc:Fallback` 配下は `mc:Choice` 側と二重に数えないよう除く。
 *
 * xpath は cli/dist の `XmldomXmlEngine` で評価する。`cli.NAMESPACES` に package rels と
 * asvg が無いため、本モジュールの `NS` で補って全 `selectNodes` に渡す。
 */
import { posix } from 'node:path'

const NS_REL_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_ASVG = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'

const URI_TABLE = 'http://schemas.openxmlformats.org/drawingml/2006/table'
const URI_CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const REL_TYPE_IMAGE_SUFFIX = '/image'

/** 公式 pptx-editable が部分ラスタ化した pic の `p:cNvPr@descr` の接頭辞。 */
export const CSS_RASTER_PREFIX = 'Rendered as an image because of CSS '

/** `mc:Fallback` 配下を除く条件。`mc:Choice` 側と二重に数えないため。 */
const NOT_FALLBACK = '[not(ancestor::mc:Fallback)]'

function namespaces(cli) {
  return { ...cli.NAMESPACES, rel: NS_REL_PKG, asvg: NS_ASVG }
}

function parseXml(engine, parts, name) {
  const part = parts.get(name)
  if (part === undefined || part.text === undefined) return null
  try {
    return engine.parse(Buffer.from(part.text, 'utf8'))
  } catch (error) {
    throw new Error(`XML の parse に失敗: ${name} (${error.message})`)
  }
}

/** part 名に対応する rels part 名（`dir/_rels/base.rels`）。 */
function relsPartName(partName) {
  return posix.join(posix.dirname(partName), '_rels', `${posix.basename(partName)}.rels`)
}

/** rels の Target を package 内の part 名に解決する。外部参照は null。 */
function resolveTarget(sourcePart, target, targetMode) {
  if (targetMode === 'External') return null
  if (target.startsWith('/')) return target.slice(1)
  return posix.normalize(posix.join(posix.dirname(sourcePart), target))
}

/** part の rels を読み、Id → { type, part } の Map を返す。rels が無ければ空 Map。 */
function readRels(engine, parts, partName, ns) {
  const document = parseXml(engine, parts, relsPartName(partName))
  const rels = new Map()
  if (document === null) return rels
  for (const node of document.selectNodes('/rel:Relationships/rel:Relationship', ns)) {
    const id = node.getAttr('Id')
    const target = node.getAttr('Target')
    if (id === undefined || target === undefined) continue
    rels.set(id, {
      type: node.getAttr('Type') ?? '',
      part: resolveTarget(partName, target, node.getAttr('TargetMode')),
    })
  }
  return rels
}

/** `sldIdLst` の順に slide part 名を返す（rels で解決できない sldId は part 名 null）。 */
function slideOrder(engine, parts, ns) {
  const presentation = parseXml(engine, parts, 'ppt/presentation.xml')
  if (presentation === null) throw new Error('ppt/presentation.xml がありません')
  const rels = readRels(engine, parts, 'ppt/presentation.xml', ns)
  const order = presentation
    .selectNodes('/p:presentation/p:sldIdLst/p:sldId', ns)
    .map((node) => rels.get(node.getAttr('r:id') ?? '')?.part ?? null)
  const [size] = presentation.selectNodes('/p:presentation/p:sldSz', ns)
  const slideSize = size === undefined
    ? null
    : { cx: Number(size.getAttr('cx')), cy: Number(size.getAttr('cy')) }
  return { order, slideSize }
}

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1
}

/** 名前でソートしたオブジェクトにする（出力の決定性のため）。 */
function sortedObject(map) {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function isSvgPart(name) {
  return /\.svg$/i.test(name)
}

/** content-type が font 系の part 名の集合（Default は拡張子、Override は part 名で判定）。 */
function fontPartsByContentType(engine, parts) {
  const document = parseXml(engine, parts, '[Content_Types].xml')
  const names = new Set()
  if (document === null) return names
  const ns = { ct: 'http://schemas.openxmlformats.org/package/2006/content-types' }
  const isFontType = (value) => /font/i.test(value ?? '')
  const fontExtensions = new Set(
    document
      .selectNodes('/ct:Types/ct:Default', ns)
      .filter((node) => isFontType(node.getAttr('ContentType')))
      .map((node) => (node.getAttr('Extension') ?? '').toLowerCase()),
  )
  for (const name of parts.keys()) {
    const extension = posix.extname(name).slice(1).toLowerCase()
    if (fontExtensions.has(extension)) names.add(name)
  }
  for (const node of document.selectNodes('/ct:Types/ct:Override', ns)) {
    if (!isFontType(node.getAttr('ContentType'))) continue
    const name = (node.getAttr('PartName') ?? '').replace(/^\//, '')
    if (parts.has(name)) names.add(name)
  }
  return names
}

/**
 * slide 1 枚の指標。`index` は sldIdLst 上の 1 始まりの位置。
 * 画像の bytes は part のサイズで、同じ part を同じ slide から複数回参照しても 1 回だけ数える。
 */
function inspectSlide(engine, parts, partName, index, slideSize, ns) {
  const empty = { index, part: partName, missing: true }
  if (partName === null || !parts.has(partName)) return empty
  const document = parseXml(engine, parts, partName)
  const [tree] = document.selectNodes('/p:sld/p:cSld/p:spTree', ns)
  const under = (xpath) => (tree === undefined ? [] : tree.selectNodes(xpath, ns))

  const sps = under(`.//p:sp${NOT_FALLBACK}`)
  const pics = under(`.//p:pic${NOT_FALLBACK}`)
  const frames = under(`.//p:graphicFrame${NOT_FALLBACK}`)

  let textRunCount = 0
  let textSpCount = 0
  for (const sp of sps) {
    const runs = sp.selectNodes('./p:txBody//a:t', ns)
    textRunCount += runs.length
    if (runs.map((node) => node.text()).join('') !== '') textSpCount += 1
  }
  const graphicFrame = { table: 0, chart: 0, other: 0 }
  for (const frame of frames) {
    const [data] = frame.selectNodes('./a:graphic/a:graphicData', ns)
    const uri = data?.getAttr('uri')
    if (uri === URI_TABLE) graphicFrame.table += 1
    else if (uri === URI_CHART) graphicFrame.chart += 1
    else graphicFrame.other += 1
    textRunCount += frame.selectNodes('.//a:tbl//a:tc//a:t', ns).length
  }

  const prstGeom = {}
  for (const geom of under(`.//a:prstGeom${NOT_FALLBACK}`)) {
    increment(prstGeom, geom.getAttr('prst') ?? '(no prst)')
  }
  const custGeomCount = under(`.//a:custGeom${NOT_FALLBACK}`).length

  const timing = document.selectNodes('/p:sld/p:timing', ns).length > 0
  const backgroundBlip = document.selectNodes('/p:sld/p:cSld/p:bg//a:blipFill', ns).length > 0

  const fullSizePic = slideSize !== null && pics.some((pic) => {
    const [ext] = pic.selectNodes('./p:spPr/a:xfrm/a:ext', ns)
    return ext !== undefined
      && Number(ext.getAttr('cx')) === slideSize.cx
      && Number(ext.getAttr('cy')) === slideSize.cy
  })
  let fullImageReason = null
  if (backgroundBlip && sps.length + pics.length + frames.length === 0) {
    fullImageReason = 'background-only'
  } else if (fullSizePic) {
    fullImageReason = 'full-size-pic'
  }

  const imageParts = new Set()
  for (const rel of readRels(engine, parts, partName, ns).values()) {
    if (!rel.type.endsWith(REL_TYPE_IMAGE_SUFFIX) || rel.part === null) continue
    imageParts.add(rel.part)
  }
  const images = summarizeImages([...imageParts], parts)

  const cssRasterReasons = {}
  for (const pic of pics) {
    const [cNvPr] = pic.selectNodes('./p:nvPicPr/p:cNvPr', ns)
    const descr = cNvPr?.getAttr('descr')
    if (descr === undefined || !descr.startsWith(CSS_RASTER_PREFIX)) continue
    increment(cssRasterReasons, descr.slice(CSS_RASTER_PREFIX.length).trim() || '(空)')
  }

  return {
    index,
    part: partName,
    missing: false,
    spCount: sps.length,
    textSpCount,
    textRunCount,
    picCount: pics.length,
    graphicFrame,
    prstGeom: sortedObject(prstGeom),
    custGeomCount,
    timing,
    backgroundBlip,
    fullImage: fullImageReason !== null,
    fullImageReason,
    images,
    cssRasterReasons: sortedObject(cssRasterReasons),
    imageParts: [...imageParts].sort(),
  }
}

/** 画像 part 名の一覧を svg / 非 svg に分けて件数とバイトにする。part が無い参照は件数だけ数える。 */
function summarizeImages(names, parts) {
  const summary = { raster: { count: 0, bytes: 0 }, svg: { count: 0, bytes: 0 } }
  for (const name of names) {
    const bucket = isSvgPart(name) ? summary.svg : summary.raster
    bucket.count += 1
    bucket.bytes += parts.get(name)?.size ?? 0
  }
  return summary
}

/** slide の `a:latin` / `a:ea` の typeface を出現回数つきで集める。 */
function collectTypefaces(engine, parts, slideParts, ns) {
  const latin = {}
  const ea = {}
  for (const name of slideParts) {
    const document = parseXml(engine, parts, name)
    for (const node of document.selectNodes('//a:latin', ns)) {
      increment(latin, node.getAttr('typeface') ?? '(no typeface)')
    }
    for (const node of document.selectNodes('//a:ea', ns)) {
      increment(ea, node.getAttr('typeface') ?? '(no typeface)')
    }
  }
  return { latin: sortedObject(latin), ea: sortedObject(ea) }
}

/**
 * pptx 1 本の集計。`parts` は `readParts()` の結果、`cli` は `loadCliDist()` の結果。
 * 戻り値は JSON にそのまま出せる plain object。
 */
export function inspectPptx(pptxPath, parts, cli) {
  const engine = new cli.XmlEngine()
  const ns = namespaces(cli)
  const { order, slideSize } = slideOrder(engine, parts, ns)
  const slides = order.map((partName, position) =>
    inspectSlide(engine, parts, partName, position + 1, slideSize, ns))
  const present = slides.filter((slide) => !slide.missing)

  const uniqueImages = [...new Set(present.flatMap((slide) => slide.imageParts))].sort()
  const fontParts = new Set([
    ...[...parts.keys()].filter((name) => name.startsWith('ppt/fonts/')),
    ...fontPartsByContentType(engine, parts),
  ])

  return {
    path: pptxPath,
    deck: {
      slideCount: slides.length,
      slideSize,
      uniqueMedia: { ...summarizeImages(uniqueImages, parts), parts: uniqueImages },
      typefaces: collectTypefaces(engine, parts, present.map((slide) => slide.part), ns),
      embeddedFonts: { present: fontParts.size > 0, count: fontParts.size, parts: [...fontParts].sort() },
      timingSlideCount: present.filter((slide) => slide.timing).length,
      fullImageSlideCount: present.filter((slide) => slide.fullImage).length,
    },
    slides,
  }
}
