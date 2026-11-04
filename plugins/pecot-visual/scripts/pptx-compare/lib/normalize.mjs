/**
 * 変換 run 間で揺れる非本質的な差の正規化と、part 単位の差分集計。
 *
 * 正規化する対象は、#1061 / #1062 で非決定と測定されたものと、バージョン差で並びだけ変わるもの。
 *  - ルート要素の xmlns 属性の並び順（全 xml / rels）。
 *  - `p:cNvPr` の `id` / `name` 属性。要素が 1 つ増減すると、以降の連番が全てずれる。
 *    `descr` / `hidden` 等の他属性は残す。
 *  - SVG `clipPath` の乱数 id（`clip_` + 英数）。出現順の連番へ置換する（svg 本体と slide xml の両方）。
 *  - `docProps/core.xml` の `dcterms:created` / `dcterms:modified`。
 *  - 埋め込み書体の part 名・番号。
 *    `ppt/_rels/presentation.xml.rels` の font 種別 Relationship は、Id / Target とも置換する。
 *    置換後の値は、解決先 part の sha256 に由来する。
 *    `p:embeddedFontLst` の `r:id` も、同じ sha256 へ置換する。
 *    typeface と slot ラベルは置換しない。regular に bold の実体が入る取り違えを、差分として残すためだ。
 *
 * 正規化しないものは、ラスタ media（png / jpg）。
 * 同一テンプレの再変換でも、端末テキストの字形描画揺れで相違し得る。
 * ただし実回帰との判別ができないため、除外リストを持たない。
 * 「ラスタ media の相違」として件数と part 名・サイズ差を列挙し、判断を読者に残す。
 */
import { isFontPart, isRasterMediaPart } from './pptx-parts.mjs'

/** 埋め込み書体 Relationship の Type。 */
const FONT_REL_TYPE
  = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'

/** font Relationship を宣言する rels。font 種別はこの 1 本にしか現れない。 */
const PRESENTATION_RELS = 'ppt/_rels/presentation.xml.rels'

/** 1 つの `<Relationship .../>` 要素にマッチする。 */
const RELATIONSHIP_PATTERN = /<Relationship\b[^>]*\/>/g

/** 属性値を 1 つ取り出す。無ければ undefined。 */
function attributeOf(tag, name) {
  const matched = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return matched === null ? undefined : matched[1]
}

/**
 * font Relationship の解決表を作る。
 *
 * 戻り値:
 *  - `shaByRelId`: `p:embeddedFontLst` の `r:id` → 解決先 part の sha256。
 *  - `fontPartsBySha`: sha256 → [{ name, size }]。同内容 part が複数あり得るため、配列とする。
 */
export function buildFontContext(parts) {
  const shaByRelId = new Map()
  const fontPartsBySha = new Map()
  for (const [name, part] of parts) {
    if (!isFontPart(name)) continue
    const list = fontPartsBySha.get(part.sha256) ?? []
    list.push({ name, size: part.size })
    fontPartsBySha.set(part.sha256, list)
  }
  const relsText = parts.get(PRESENTATION_RELS)?.text
  if (relsText !== undefined) {
    for (const [tag] of relsText.matchAll(RELATIONSHIP_PATTERN)) {
      if (attributeOf(tag, 'Type') !== FONT_REL_TYPE) continue
      const id = attributeOf(tag, 'Id')
      const target = attributeOf(tag, 'Target')
      if (id === undefined || target === undefined) continue
      const partName = `ppt/${target.replace(/^\.\//, '')}`
      const sha = parts.get(partName)?.sha256
      if (sha !== undefined) shaByRelId.set(id, sha)
    }
  }
  return { shaByRelId, fontPartsBySha }
}

/**
 * ルート要素の属性を名前順に並べ替える。
 * xml 宣言直後の最初の開始タグだけを対象にし、子要素には触らない。
 */
export function sortRootAttributes(xml) {
  const tagPattern = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")+)(\s*\/?)>/
  const matched = tagPattern.exec(xml)
  if (matched === null) return xml
  const attributes = [...matched[2].matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)]
    .map((attribute) => [attribute[1], attribute[2]])
  attributes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const rebuilt = attributes.map(([key, value]) => ` ${key}="${value}"`).join('')
  return xml.slice(0, matched.index)
    + `<${matched[1]}${rebuilt}${matched[3]}>`
    + xml.slice(matched.index + matched[0].length)
}

/**
 * `p:cNvPr` の `id` / `name` 属性だけを固定値へ置き換える。
 * `descr` / `hidden` 等の他属性は残すため、それらの実際の差は相違として出る。
 */
export function normalizeCNvPrIdName(xml) {
  return xml.replaceAll(/<p:cNvPr\b[^>]*>/g, (tag) =>
    tag.replaceAll(/\b(id|name)="[^"]*"/g, '$1="#"'))
}

/** クリップ id が現れる 3 文脈: `id="clip_…"` / `url(#clip_…)` / `clip-path="clip_…"`。 */
const CLIP_ID_CONTEXT_PATTERN
  = /\bid="(clip_[A-Za-z0-9]+)"|url\(#(clip_[A-Za-z0-9]+)\)|\bclip-path="(clip_[A-Za-z0-9]+)"/g

/**
 * SVG `clipPath` の乱数 id を出現順の連番へ置換する。
 * 観測した形は `clip_19ehl603m`（`clip_` + 英数 9 文字）。
 * `id="…"` / `url(#…)` / `clip-path="…"` の 3 文脈に限定してマッチさせる。
 * 本文（`a:t` 等）中に偶然 `clip_` で始まる文字列があっても、正規化せず相違として残す。
 * 全文字列を無条件に置換すると、内容の異なる 2 つの `clip_` 文字列が同じ連番へ畳まれて、相違が消える。
 */
export function normalizeClipIds(text) {
  const seen = new Map()
  const rename = (id) => {
    if (!seen.has(id)) seen.set(id, `clip_N${seen.size}`)
    return seen.get(id)
  }
  return text.replaceAll(CLIP_ID_CONTEXT_PATTERN, (match, idAttr, urlRef, clipPathAttr) => {
    if (idAttr !== undefined) return `id="${rename(idAttr)}"`
    if (urlRef !== undefined) return `url(#${rename(urlRef)})`
    return `clip-path="${rename(clipPathAttr)}"`
  })
}

/** `docProps/core.xml` の生成日時を固定値へ置き換える。 */
export function normalizeCoreDates(xml) {
  return xml.replaceAll(
    /(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
    '$1NORMALIZED$2',
  )
}

/**
 * font 種別 Relationship の Id / Target を解決先 part の sha256 由来の値へ置換する。
 * rels 内の Relationship 要素は種別を問わず並び順を無視するため、font 種別かどうかに
 * 関わらず全要素を文字列ソートする（rels 内の並び順自体には意味が無い）。
 * 解決できない Relationship は Id / Target を書き換えずに残す（相違として見えるようにする）。
 */
export function normalizeRelationships(xml, context) {
  const replaced = xml.replaceAll(RELATIONSHIP_PATTERN, (tag) => {
    if (attributeOf(tag, 'Type') !== FONT_REL_TYPE) return tag
    const id = attributeOf(tag, 'Id')
    const sha = id === undefined ? undefined : context.shaByRelId.get(id)
    if (sha === undefined) return tag
    return tag
      .replace(/\bId="[^"]*"/, `Id="font:${sha}"`)
      .replace(/\bTarget="[^"]*"/, `Target="font:${sha}"`)
  })
  const relationships = [...replaced.matchAll(RELATIONSHIP_PATTERN)].map((m) => m[0])
  if (relationships.length === 0) return replaced
  const sorted = [...relationships].sort()
  return replaced
    .replaceAll(RELATIONSHIP_PATTERN, '')
    .replace('</Relationships>', `${sorted.join('')}</Relationships>`)
}

/**
 * `p:embeddedFontLst` 内の `r:id` を解決先 part の sha256 へ置換する。
 * 置換範囲を `p:embeddedFontLst` に限る（`p:sldId` 等の `r:id` は触らない）。
 */
export function normalizeEmbeddedFontIds(xml, context) {
  return xml.replaceAll(
    /<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/g,
    (block) => block.replaceAll(/\br:id="([^"]*)"/g, (attribute, id) => {
      const sha = context.shaByRelId.get(id)
      return sha === undefined ? attribute : `r:id="font:${sha}"`
    }),
  )
}

/** part 名に応じた正規化を掛ける。text を持たない part は undefined を返す。 */
export function normalizePart(name, text, context) {
  if (text === undefined) return undefined
  if (/\.svg$/i.test(name)) return normalizeClipIds(text)
  if (/\.rels$/i.test(name)) {
    return sortRootAttributes(normalizeRelationships(text, context))
  }
  let out = text
  if (name === 'docProps/core.xml') out = normalizeCoreDates(out)
  if (name === 'ppt/presentation.xml') out = normalizeEmbeddedFontIds(out, context)
  out = sortRootAttributes(out)
  out = normalizeCNvPrIdName(out)
  return normalizeClipIds(out)
}

/** 相違 part の区分ラベル。件数の並べ替えで使う。 */
export function partKind(name) {
  if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) return 'ppt/slides/slide*.xml'
  if (/^ppt\/slides\/_rels\//.test(name)) return 'ppt/slides/_rels/*'
  if (/^ppt\/media\/.*\.svg$/i.test(name)) return 'ppt/media/*.svg'
  if (isRasterMediaPart(name)) return 'ppt/media/* (ラスタ)'
  if (isFontPart(name)) return 'ppt/fonts/*'
  return name
}

/** 名前が共通の part を、sha256 / 正規化後テキストで比較する。 */
function diffByName(beforeParts, afterParts, targets, compare) {
  const changed = []
  let same = 0
  for (const name of targets) {
    const before = beforeParts.get(name)
    const after = afterParts.get(name)
    if (compare(name, before, after)) same += 1
    else changed.push({ name, beforeSize: before.size, afterSize: after.size })
  }
  return { changed, same }
}

/**
 * 2 つの pptx の part を比較する。
 *
 * - `raw`: 全 part を sha256 でそのまま比較した結果。正規化の効果を読めるようにする。
 * - `normalized`: 正規化後の比較。埋め込み書体 part とラスタ media は対象外。
 *   それぞれ、sha256 多重集合と別区分で扱う。
 * - `raster`: ラスタ media の相違・片側のみ。
 * - `fonts`: 埋め込み書体 part の sha256 多重集合の比較。
 */
export function diffParts(beforeParts, afterParts, beforeContext, afterContext) {
  const beforeNames = [...beforeParts.keys()]
  const afterNames = [...afterParts.keys()]
  const commonNames = beforeNames.filter((name) => afterParts.has(name))

  const raw = {
    ...diffByName(
      beforeParts,
      afterParts,
      commonNames,
      (_name, before, after) => before.sha256 === after.sha256,
    ),
    onlyBefore: beforeNames.filter((name) => !afterParts.has(name)),
    onlyAfter: afterNames.filter((name) => !beforeParts.has(name)),
  }

  const normalizedTargets = commonNames
    .filter((name) => !isFontPart(name) && !isRasterMediaPart(name))
  const normalized = {
    ...diffByName(beforeParts, afterParts, normalizedTargets, (name, before, after) => {
      if (before.text === undefined || after.text === undefined) {
        return before.sha256 === after.sha256
      }
      return normalizePart(name, before.text, beforeContext)
        === normalizePart(name, after.text, afterContext)
    }),
    onlyBefore: raw.onlyBefore.filter((name) => !isFontPart(name) && !isRasterMediaPart(name)),
    onlyAfter: raw.onlyAfter.filter((name) => !isFontPart(name) && !isRasterMediaPart(name)),
  }

  const rasterTargets = commonNames.filter((name) => isRasterMediaPart(name))
  const raster = {
    ...diffByName(
      beforeParts,
      afterParts,
      rasterTargets,
      (_name, before, after) => before.sha256 === after.sha256,
    ),
    onlyBefore: raw.onlyBefore.filter((name) => isRasterMediaPart(name)),
    onlyAfter: raw.onlyAfter.filter((name) => isRasterMediaPart(name)),
  }

  return {
    raw,
    normalized,
    raster,
    fonts: diffFontParts(beforeContext, afterContext),
  }
}

/** 埋め込み書体 part を sha256 の多重集合として比較する（名前は見ない）。 */
export function diffFontParts(beforeContext, afterContext) {
  const onlyBefore = []
  const onlyAfter = []
  let matched = 0
  const shas = new Set([
    ...beforeContext.fontPartsBySha.keys(),
    ...afterContext.fontPartsBySha.keys(),
  ])
  for (const sha of [...shas].sort()) {
    const before = beforeContext.fontPartsBySha.get(sha) ?? []
    const after = afterContext.fontPartsBySha.get(sha) ?? []
    matched += Math.min(before.length, after.length)
    for (const part of before.slice(after.length)) onlyBefore.push({ sha, ...part })
    for (const part of after.slice(before.length)) onlyAfter.push({ sha, ...part })
  }
  return { matched, onlyBefore, onlyAfter }
}
