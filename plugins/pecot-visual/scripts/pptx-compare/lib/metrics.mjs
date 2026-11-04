/**
 * pptx から slide 別・deck 全体の指標を抽出し、sp を before / after で比較する。
 *
 * 指標の定義は、#1062 の baseline と同一にする。
 * baseline の値は、sp 1115 / テキストあり sp 718 / pic 304 / `a:t` 893 / divergence 175。
 *
 *  - `p:sp` / `p:pic` は `/p:sld/p:cSld/p:spTree` の直下のみ（`//` の子孫は取らない）。
 *  - `a:t` は `./p:txBody/a:p/a:r/a:t` を sp 単位に連結（`a:fld` 配下は拾わない）。
 *  - `a:xfrm` は `./p:spPr/a:xfrm` の off / ext。
 *
 * xpath は、cli/dist の `XmldomXmlEngine` と `NAMESPACES`（a / p / r / mc / p14 / p159）で評価する。
 * nsMap を渡さないと prefix 未解決で 0 件になる。
 * そのため、全 `selectNodes` に渡す。
 * slide XML の parse 失敗は握り潰さず、例外を投げる（先頭の mjs が exit 2 に倒す）。
 */
import { statSync } from 'node:fs'

/** 埋め込み書体の slot。`p:embeddedFont` 配下に現れる順で並べる。 */
const FONT_SLOTS = ['regular', 'bold', 'italic', 'boldItalic']

/** part 名から slide 番号を取り出す。slide の対応付けはこの番号で行う。 */
export function slideNumber(partName) {
  const matched = /slide(\d+)\.xml$/.exec(partName)
  return matched === null ? 0 : Number(matched[1])
}

/** `p:spPr > a:xfrm` の off / ext を数値で取り出す。無ければ null。 */
function extractXfrm(shape, namespaces) {
  const [xfrm] = shape.selectNodes('./p:spPr/a:xfrm', namespaces)
  if (xfrm === undefined) return null
  const [off] = xfrm.selectNodes('./a:off', namespaces)
  const [ext] = xfrm.selectNodes('./a:ext', namespaces)
  const number = (node, name) => {
    const raw = node?.getAttr(name)
    return raw === undefined ? null : Number(raw)
  }
  return {
    x: number(off, 'x'),
    y: number(off, 'y'),
    cx: number(ext, 'cx'),
    cy: number(ext, 'cy'),
  }
}

/** xfrm を 1 行の文字列にする。 */
export function formatXfrm(xfrm) {
  if (xfrm === null) return '(no xfrm)'
  return `off(${xfrm.x},${xfrm.y}) ext(${xfrm.cx}x${xfrm.cy})`
}

/**
 * `p:embeddedFontLst` の宣言を取り出す。
 * slot の `r:id` は、rels で解決した part の sha256 に読み替える。
 * typeface と slot ラベルは置換しない。regular に bold の実体が入る取り違えを残すためだ。
 */
function extractEmbeddedFonts(presentationText, cli, fontContext) {
  if (presentationText === undefined) return []
  const document = new cli.XmlEngine().parse(Buffer.from(presentationText, 'utf8'))
  const fonts = []
  const blocks = document.selectNodes(
    '/p:presentation/p:embeddedFontLst/p:embeddedFont',
    cli.NAMESPACES,
  )
  for (const block of blocks) {
    const [font] = block.selectNodes('./p:font', cli.NAMESPACES)
    const slots = []
    for (const slot of FONT_SLOTS) {
      const [node] = block.selectNodes(`./p:${slot}`, cli.NAMESPACES)
      if (node === undefined) continue
      const relId = node.getAttr('r:id')
      const sha = relId === undefined ? undefined : fontContext.shaByRelId.get(relId)
      const parts = sha === undefined ? [] : (fontContext.fontPartsBySha.get(sha) ?? [])
      slots.push({
        slot,
        sha: sha ?? '(未解決)',
        part: parts.length === 0 ? '(未解決)' : parts[0].name,
        bytes: parts.length === 0 ? 0 : parts[0].size,
      })
    }
    fonts.push({ typeface: font?.getAttr('typeface') ?? '(unknown)', slots })
  }
  return fonts
}

/**
 * pptx 1 本の指標を集める。`parts` は読み出し済みの part Map、
 * `fontContext` は `buildFontContext()` の結果。
 */
export function collectMetrics(pptxPath, parts, cli, fontContext) {
  const engine = new cli.XmlEngine()
  const slideNames = [...parts.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))

  const slides = []
  for (const name of slideNames) {
    const xml = parts.get(name).text
    let document
    try {
      document = engine.parse(Buffer.from(xml, 'utf8'))
    } catch (error) {
      throw new Error(`slide XML の parse に失敗: ${name} (${error.message})`)
    }
    const spNodes = document.selectNodes('/p:sld/p:cSld/p:spTree/p:sp', cli.NAMESPACES)
    const picNodes = document.selectNodes('/p:sld/p:cSld/p:spTree/p:pic', cli.NAMESPACES)
    const sps = spNodes.map((sp) => ({
      text: sp
        .selectNodes('./p:txBody/a:p/a:r/a:t', cli.NAMESPACES)
        .map((node) => node.text())
        .join(''),
      xfrm: extractXfrm(sp, cli.NAMESPACES),
    }))
    slides.push({
      part: name,
      n: slideNumber(name),
      sps,
      spCount: sps.length,
      picCount: picNodes.length,
      textSpCount: sps.filter((sp) => sp.text !== '').length,
      textCount: spNodes.reduce(
        (sum, sp) => sum + sp.selectNodes('./p:txBody/a:p/a:r/a:t', cli.NAMESPACES).length,
        0,
      ),
      divergence: cli.detectPreviewDivergence(document).length,
      // dom-to-pptx 2.x で新出した要素。sp / pic / テキスト / xfrm の指標では動かない。
      timingCount: (xml.match(/<p:timing\b/g) ?? []).length,
      highlightCount: (xml.match(/<a:highlight\b/g) ?? []).length,
    })
  }

  const fontParts = [...parts.keys()].filter((name) => name.startsWith('ppt/fonts/')).sort()
  const mediaParts = [...parts.keys()].filter((name) => name.startsWith('ppt/media/'))
  let fileSize = null
  try {
    fileSize = statSync(pptxPath).size
  } catch {
    fileSize = null
  }

  return {
    path: pptxPath,
    fileSize,
    partCount: parts.size,
    slideCount: slides.length,
    slides,
    fonts: {
      embedded: extractEmbeddedFonts(parts.get('ppt/presentation.xml')?.text, cli, fontContext),
      parts: fontParts.map((name) => ({
        name,
        size: parts.get(name).size,
        sha256: parts.get(name).sha256,
      })),
      bytes: fontParts.reduce((sum, name) => sum + parts.get(name).size, 0),
    },
    media: {
      count: mediaParts.length,
      png: mediaParts.filter((name) => /\.png$/i.test(name)).length,
      svg: mediaParts.filter((name) => /\.svg$/i.test(name)).length,
      bytes: mediaParts.reduce((sum, name) => sum + parts.get(name).size, 0),
    },
    totals: {
      spCount: sum(slides, (slide) => slide.spCount),
      picCount: sum(slides, (slide) => slide.picCount),
      textSpCount: sum(slides, (slide) => slide.textSpCount),
      textCount: sum(slides, (slide) => slide.textCount),
      divergence: sum(slides, (slide) => slide.divergence),
      timingCount: sum(slides, (slide) => slide.timingCount),
      timingSlides: slides.filter((slide) => slide.timingCount > 0).map((slide) => slide.n),
      highlightCount: sum(slides, (slide) => slide.highlightCount),
      highlightSlides: slides.filter((slide) => slide.highlightCount > 0).map((slide) => slide.n),
    },
  }
}

function sum(list, pick) {
  return list.reduce((total, item) => total + pick(item), 0)
}

/**
 * before / after の sp を比較する。配列順は使わない。
 * `normalizePptxZip` の z 順並べ替えで、順序が変わり得るためだ。
 *
 * - テキストが空でない sp: テキスト値でグループ化し、同数なら xfrm 距離が最小の組で貪欲に対応付ける
 * - テキストが空の sp: xfrm の完全一致で対応付け、残りを未対応として数える
 */
export function matchSps(beforeSps, afterSps) {
  const missingTexts = []
  const addedTexts = []
  const xfrmDiffs = []
  let matched = 0

  const groupByText = (list) => {
    const groups = new Map()
    for (const sp of list) {
      if (sp.text === '') continue
      if (!groups.has(sp.text)) groups.set(sp.text, [])
      groups.get(sp.text).push(sp)
    }
    return groups
  }
  const beforeGroups = groupByText(beforeSps)
  const afterGroups = groupByText(afterSps)

  for (const [text, beforeList] of beforeGroups) {
    const afterList = afterGroups.get(text) ?? []
    const remaining = [...afterList]
    for (const before of beforeList.slice(0, Math.min(beforeList.length, afterList.length))) {
      let bestIndex = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (let index = 0; index < remaining.length; index += 1) {
        const distance = xfrmDistance(before.xfrm, remaining[index].xfrm)
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      }
      const after = remaining.splice(bestIndex, 1)[0]
      matched += 1
      if (bestDistance !== 0) xfrmDiffs.push({ text, before: before.xfrm, after: after.xfrm })
    }
    if (beforeList.length > afterList.length) {
      missingTexts.push({ text, before: beforeList.length, after: afterList.length })
    }
  }
  for (const [text, afterList] of afterGroups) {
    const beforeList = beforeGroups.get(text) ?? []
    if (afterList.length > beforeList.length) {
      addedTexts.push({ text, before: beforeList.length, after: afterList.length })
    }
  }

  const countByXfrm = (list) => {
    const counts = new Map()
    for (const sp of list) {
      if (sp.text !== '') continue
      const key = sp.xfrm === null
        ? 'null'
        : `${sp.xfrm.x},${sp.xfrm.y},${sp.xfrm.cx},${sp.xfrm.cy}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }
  const beforeEmpty = countByXfrm(beforeSps)
  const afterEmpty = countByXfrm(afterSps)
  let emptyOnlyBefore = 0
  let emptyOnlyAfter = 0
  for (const [key, count] of beforeEmpty) {
    emptyOnlyBefore += Math.max(0, count - (afterEmpty.get(key) ?? 0))
  }
  for (const [key, count] of afterEmpty) {
    emptyOnlyAfter += Math.max(0, count - (beforeEmpty.get(key) ?? 0))
  }

  return { matched, missingTexts, addedTexts, xfrmDiffs, emptyOnlyBefore, emptyOnlyAfter }
}

function xfrmDistance(before, after) {
  if (before === null || after === null) {
    return before === after ? 0 : Number.MAX_SAFE_INTEGER
  }
  return Math.abs(before.x - after.x)
    + Math.abs(before.y - after.y)
    + Math.abs(before.cx - after.cx)
    + Math.abs(before.cy - after.cy)
}
