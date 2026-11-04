#!/usr/bin/env node
/**
 * 1 本以上の pptx を枚ごとに集計し、入力を列に並べた比較表を Markdown（と任意で JSON）で出す。
 * 変換手順（Slidev 公式 pptx / pptx-editable / pecotv slide convert 等）の構成差を並べるための集計で、
 * 合否の判定は持たない。
 *
 *   node plugins/pecot-visual/scripts/pptx-compare/inspect-pptx.mjs <a.pptx> [b.pptx ...] \
 *
 *     [--out <md>] [--json <path>]
 *
 * オプション:
 *   --out <md>     Markdown をファイルへ書く（既定は stdout）。
 *   --json <path>  同じ内容を JSON で書く。`files[]` に、deck 全体 `deck` と枚ごとの `slides[]` を持つ。
 *   `--out=path` / `--json=path` の `=` 形式も受け付ける。
 *
 * # 集計の定義
 *
 * 枚順は、`ppt/presentation.xml` の `p:sldIdLst` の順に `ppt/_rels/presentation.xml.rels` を辿って決める。
 * part 名を併記する。
 * 図形は、`p:spTree` 配下を子孫まで数える（`p:grpSp` 内も含む）。
 * `mc:Fallback` 配下は除く。
 *
 *   - `p:sp` 数 / テキストあり sp 数。`p:txBody` 配下の `a:t` を連結して空でない sp を数える。
 *
 *   - `a:t` 数: `p:sp` の `p:txBody` 配下と、`p:graphicFrame` 内 `a:tbl` の `a:tc` 配下の
 *     `a:t` 要素の件数。`a:r` と `a:fld` の両方を数え、空文字の `a:t` も 1 件とする。
 *
 *   - `p:pic` 数 / `p:graphicFrame` 数（`a:graphicData/@uri` で table / chart / その他）。
 *
 *   - `a:prstGeom/@prst` の種別別件数と `a:custGeom` 件数。
 *
 *   - `p:timing` の有無 / 背景 blip（`p:bg//a:blipFill`）の有無。
 *
 *   - 全面画像: 次のどちらかに当たるもの。閾値は使わない。
 *     1 つ目は、背景 blip があり、`p:sp` `p:pic` `p:graphicFrame` が 0 件のもの（背景のみ）。
 *     2 つ目は、`p:sldSz` と幅・高さが完全一致する `a:xfrm` を持つ `p:pic` があるもの（全面 pic）。
 *
 *   - 画像参照: slide の rels で Type が `.../image` の関係の、参照先 part を数える。
 *     svg と、非 svg（png / jpeg 等）に分けて、件数とバイトにする。
 *     同じ slide 内の重複参照は 1 回とする。
 *
 *   - CSS 由来の部分ラスタ: `p:cNvPr/@descr` が `Rendered as an image because of CSS ` で始まる pic。
 *     続く reason 別に数える。
 *
 * deck 全体の集計項目は、次のとおり。
 * 枚数。一意 media の件数とバイト（複数枚が同じ part を参照しても 1 回）。
 * slide の `a:latin` / `a:ea` の typeface と出現回数。
 * 埋め込みフォント part の件数（`ppt/fonts/` 配下、または content-type が font のもの）。
 * `p:timing` を持つ枚数。全面画像の枚数。
 *
 * # 出力
 *
 * 入力ごとに A、B、C のような記号を振る。
 * 全体集計の比較表（列 = 入力）と、項目ごとの枚ごとの比較表（行 = 枚順、列 = 入力）を出す。
 * 枚数が違う入力の欠損セルは `-`。
 *
 * # exit code
 *
 *   0: 正常に集計した。
 *   2: 実行エラー。引数なし・未対応オプション・ファイル不在を含む。
 *      zip でない / pptx として読めない・cli/dist 不在も含む。
 *      `--out` `--json` の書き込み失敗を含む想定外の例外も同じ。
 *
 * 判定を持たないため、1 は使わない。
 *
 * # cli/dist の解決順
 *
 * compare-pptx.mjs と同じ。
 * 1. 環境変数 `PECOTV_CLI_DIST`（dist ディレクトリの絶対パス）。
 * 2. 既定の `plugins/pecot-visual/cli/dist/`（`lib/cli-dist.mjs` の `loadCliDist`）。
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { parseOptions } from './lib/args.mjs'
import { loadCliDist } from './lib/cli-dist.mjs'
import { inspectPptx } from './lib/inspect-metrics.mjs'
import { readParts } from './lib/pptx-parts.mjs'

const USAGE = 'usage: node inspect-pptx.mjs <a.pptx> [b.pptx ...] [--out <md>] [--json <path>]'
const MISSING = '-'

function parseArgs(argv) {
  const { positional, values } = parseOptions(argv, { valued: ['--out', '--json'] })
  if (positional.length === 0) throw new Error('pptx を 1 つ以上指定する')
  return { paths: positional, out: values['--out'], json: values['--json'] }
}

/** 入力の記号。A から Z の後は AA、AB と続く。 */
function labelOf(index) {
  let label = ''
  let rest = index
  do {
    label = String.fromCharCode(65 + (rest % 26)) + label
    rest = Math.floor(rest / 26) - 1
  } while (rest >= 0)
  return label
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function row(values) {
  return `| ${values.map(cell).join(' | ')} |`
}

function table(header, rows) {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)]
}

function formatCounts(map) {
  const entries = Object.entries(map)
  if (entries.length === 0) return '0'
  return entries.map(([key, count]) => `${key}:${count}`).join(' ')
}

function formatTypefaces(map) {
  const entries = Object.entries(map)
  if (entries.length === 0) return '(なし)'
  return entries.map(([name, count]) => `${name} (${count})`).join(', ')
}

const yesNo = (value) => (value ? 'あり' : 'なし')

const FULL_IMAGE_LABEL = { 'background-only': '背景のみ', 'full-size-pic': '全面 pic' }

/** 枚ごとの比較表に出す項目。`pick` は欠損でない slide を受け取りセル文字列を返す。 */
const SLIDE_COLUMNS = [
  { title: '`p:sp` 数', pick: (slide) => slide.spCount },
  { title: 'テキストあり sp 数', pick: (slide) => slide.textSpCount },
  { title: '`a:t` 数（sp + 表セル）', pick: (slide) => slide.textRunCount },
  { title: '`p:pic` 数', pick: (slide) => slide.picCount },
  {
    title: '`p:graphicFrame`（table / chart / その他）',
    pick: ({ graphicFrame: frame }) => `${frame.table} / ${frame.chart} / ${frame.other}`,
  },
  { title: '`a:prstGeom` 種別別件数', pick: (slide) => formatCounts(slide.prstGeom) },
  { title: '`a:custGeom` 件数', pick: (slide) => slide.custGeomCount },
  { title: '`p:timing`', pick: (slide) => yesNo(slide.timing) },
  { title: '背景 blip', pick: (slide) => yesNo(slide.backgroundBlip) },
  {
    title: '全面画像',
    pick: (slide) => (slide.fullImage ? FULL_IMAGE_LABEL[slide.fullImageReason] : 'なし'),
  },
  {
    title: '画像参照 非 svg（件 / バイト）',
    pick: ({ images }) => `${images.raster.count} / ${images.raster.bytes}`,
  },
  {
    title: '画像参照 svg（件 / バイト）',
    pick: ({ images }) => `${images.svg.count} / ${images.svg.bytes}`,
  },
  { title: 'CSS 由来の部分ラスタ（reason 別）', pick: (slide) => formatCounts(slide.cssRasterReasons) },
]

function buildMarkdown(results) {
  const labels = results.map((_, index) => labelOf(index))
  const header = ['項目', ...labels]
  const lines = ['# pptx 集計', '', '## 入力', '']
  results.forEach((result, index) => {
    lines.push(`- ${labels[index]}: \`${result.path}\`（${result.deck.slideCount} 枚）`)
  })

  const deckRows = [
    ['枚数', (deck) => deck.slideCount],
    ['一意 media 非 svg（件）', (deck) => deck.uniqueMedia.raster.count],
    ['一意 media 非 svg（バイト）', (deck) => deck.uniqueMedia.raster.bytes],
    ['一意 media svg（件）', (deck) => deck.uniqueMedia.svg.count],
    ['一意 media svg（バイト）', (deck) => deck.uniqueMedia.svg.bytes],
    ['`p:timing` を持つ枚数', (deck) => deck.timingSlideCount],
    ['全面画像の枚数', (deck) => deck.fullImageSlideCount],
    ['埋め込みフォント part（件）', (deck) => deck.embeddedFonts.count],
    ['`a:latin` typeface', (deck) => formatTypefaces(deck.typefaces.latin)],
    ['`a:ea` typeface', (deck) => formatTypefaces(deck.typefaces.ea)],
  ]
  lines.push('', '## 全体集計', '')
  lines.push(...table(header, deckRows.map(([title, pick]) => [title, ...results.map((r) => pick(r.deck))])))

  const maxSlides = Math.max(...results.map((result) => result.slides.length))
  const indexes = Array.from({ length: maxSlides }, (_, index) => index + 1)
  const slideHeader = ['枚', ...labels]
  const slideAt = (result, index) => result.slides[index - 1]

  lines.push('', '## 枚ごとの比較', '')
  lines.push(`欠損セル（その入力に該当する枚が無い）は \`${MISSING}\`。`)
  lines.push('', '### part 名', '')
  lines.push(...table(slideHeader, indexes.map((index) => [
    index,
    ...results.map((result) => {
      const slide = slideAt(result, index)
      if (slide === undefined) return MISSING
      return slide.part === null ? '(rels で未解決)' : slide.part
    }),
  ])))
  for (const column of SLIDE_COLUMNS) {
    lines.push('', `### ${column.title}`, '')
    lines.push(...table(slideHeader, indexes.map((index) => [
      index,
      ...results.map((result) => {
        const slide = slideAt(result, index)
        return slide === undefined || slide.missing ? MISSING : column.pick(slide)
      }),
    ])))
  }
  return `${lines.join('\n')}\n`
}

function buildJson(results) {
  const files = results.map((result, index) => ({
    label: labelOf(index),
    path: result.path,
    deck: result.deck,
    slides: result.slides,
  }))
  return `${JSON.stringify({ files }, null, 2)}\n`
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n${USAGE}\n`)
    process.exitCode = 2
    return
  }

  const absent = parsed.paths.filter((path) => !existsSync(path))
  if (absent.length > 0) {
    process.stderr.write(`ERROR: ファイルが見つかりません: ${absent.join(', ')}\n`)
    process.exitCode = 2
    return
  }

  let cli
  try {
    cli = await loadCliDist()
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`)
    process.exitCode = 2
    return
  }

  const results = []
  for (const path of parsed.paths) {
    let parts
    try {
      parts = await readParts(path, cli)
    } catch (error) {
      process.stderr.write(`ERROR: pptx の読み取りに失敗: ${basename(path)}: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    try {
      results.push(inspectPptx(path, parts, cli))
    } catch (error) {
      process.stderr.write(`ERROR: 集計に失敗: ${basename(path)}: ${error.message}\n`)
      process.exitCode = 2
      return
    }
  }

  const markdown = buildMarkdown(results)
  if (parsed.json !== undefined) {
    await writeFile(parsed.json, buildJson(results), 'utf8')
    process.stderr.write(`written: ${parsed.json}\n`)
  }
  if (parsed.out === undefined) {
    process.stdout.write(markdown)
  } else {
    await writeFile(parsed.out, markdown, 'utf8')
    process.stderr.write(`written: ${parsed.out}\n`)
  }
  process.exitCode = 0
}

try {
  await main()
} catch (error) {
  process.stderr.write(`ERROR: 想定外のエラー: ${error.message}\n`)
  process.exitCode = 2
}
