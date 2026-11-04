/**
 * 比較結果を Markdown にし、機械判定の PASS / FAIL を決める。
 *
 * 節構成の前半: 判定 → 全体 → 埋め込み書体 → slide 別。
 * 節構成の後半: 消失 `a:t` → 追加 `a:t` → テキスト一致 sp の xfrm 差 → パート差分（生 / 正規化後）→ ラスタ media の相違。
 *
 * 判定は、機械判定できる 5 基準だけを PASS / FAIL で出す。
 * 判別力の無いもの（divergence の増減・サイズ比・ラスタ media の相違など）は、「要判断」の事実として並べる。
 * 判定は常に全件で行い、`--max-list` は列挙の表示件数だけを絞る。
 */
import { basename } from 'node:path'

import { matchSps, formatXfrm } from './metrics.mjs'
import { partKind } from './normalize.mjs'
import { formatDelta } from './format.mjs'

function formatBytes(value) {
  if (value === null || value === undefined) return '-'
  return `${(value / 1024 / 1024).toFixed(2)} MB (${value.toLocaleString('en-US')} B)`
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '\\n')
}

function truncate(value, limit = 60) {
  const text = String(value)
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** 相違 part を区分別に集計した表を書く。区分の行数自体にも maxList を掛ける。 */
function writeKindTable(write, changed, maxList) {
  const byKind = new Map()
  for (const part of changed) {
    const kind = partKind(part.name)
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(part.name)
  }
  write('| 区分 | 件数 | 例 |')
  write('|---|---:|---|')
  const kinds = [...byKind.entries()]
  for (const [kind, names] of kinds.slice(0, maxList)) {
    const examples = names.slice(0, Math.min(3, maxList))
      .map((name) => `\`${basename(name)}\``)
      .join(', ')
    write(`| \`${kind}\` | ${names.length} | ${examples} |`)
  }
  if (kinds.length > maxList) {
    write(`| … | （残り ${kinds.length - maxList} 区分は省略） | |`)
  }
}

/**
 * Markdown と判定を作る。
 * 戻り値: { markdown, checks, failedCount, exitCode }
 */
export function buildReport(input) {
  const { beforePath, afterPath, before, after, partDiff, showAll, maxList } = input
  const lines = []
  const write = (line = '') => lines.push(line)

  // ---- slide の対応付け（part 名の番号。配列インデックスは使わない） ----
  const beforeByNumber = new Map(before.slides.map((slide) => [slide.n, slide]))
  const afterByNumber = new Map(after.slides.map((slide) => [slide.n, slide]))
  const commonNumbers = [...beforeByNumber.keys()]
    .filter((n) => afterByNumber.has(n))
    .sort((a, b) => a - b)
  const onlyBeforeSlides = [...beforeByNumber.keys()]
    .filter((n) => !afterByNumber.has(n))
    .sort((a, b) => a - b)
  const onlyAfterSlides = [...afterByNumber.keys()]
    .filter((n) => !beforeByNumber.has(n))
    .sort((a, b) => a - b)

  const rows = []
  const missingAll = []
  const addedAll = []
  const xfrmAll = []
  let missingTotal = 0
  let addedTotal = 0
  let textSpDropped = 0
  let picDropped = 0

  for (const n of commonNumbers) {
    const beforeSlide = beforeByNumber.get(n)
    const afterSlide = afterByNumber.get(n)
    const match = matchSps(beforeSlide.sps, afterSlide.sps)
    const missingCount = match.missingTexts.reduce((s, x) => s + (x.before - x.after), 0)
    const addedCount = match.addedTexts.reduce((s, x) => s + (x.after - x.before), 0)
    missingTotal += missingCount
    addedTotal += addedCount
    if (afterSlide.textSpCount < beforeSlide.textSpCount) textSpDropped += 1
    if (afterSlide.picCount < beforeSlide.picCount) picDropped += 1
    for (const item of match.missingTexts) missingAll.push({ slide: n, ...item })
    for (const item of match.addedTexts) addedAll.push({ slide: n, ...item })
    for (const item of match.xfrmDiffs) xfrmAll.push({ slide: n, ...item })

    rows.push({
      n,
      changed: beforeSlide.spCount !== afterSlide.spCount
        || beforeSlide.picCount !== afterSlide.picCount
        || beforeSlide.textSpCount !== afterSlide.textSpCount
        || beforeSlide.divergence !== afterSlide.divergence
        || beforeSlide.timingCount !== afterSlide.timingCount
        || beforeSlide.highlightCount !== afterSlide.highlightCount
        || missingCount > 0
        || addedCount > 0
        || match.xfrmDiffs.length > 0
        || match.emptyOnlyBefore > 0
        || match.emptyOnlyAfter > 0,
      cells: [
        `${beforeSlide.spCount} → ${afterSlide.spCount}`,
        `${beforeSlide.picCount} → ${afterSlide.picCount}`,
        `${beforeSlide.textSpCount} → ${afterSlide.textSpCount}`,
        `${beforeSlide.divergence} → ${afterSlide.divergence}`,
        `${beforeSlide.timingCount} → ${afterSlide.timingCount}`
        + ` / ${beforeSlide.highlightCount} → ${afterSlide.highlightCount}`,
        `${missingCount} / ${addedCount} / ${match.xfrmDiffs.length}`,
      ],
      note: match.emptyOnlyBefore > 0 || match.emptyOnlyAfter > 0
        ? `無テキスト sp 未対応 before ${match.emptyOnlyBefore} / after ${match.emptyOnlyAfter}`
        : '',
    })
  }

  const beforeFaces = new Set(before.fonts.embedded.map((font) => font.typeface))
  const afterFaces = new Set(after.fonts.embedded.map((font) => font.typeface))
  const lostFaces = [...beforeFaces].filter((face) => !afterFaces.has(face))
  const newFaces = [...afterFaces].filter((face) => !beforeFaces.has(face))

  const checks = [
    {
      label: 'before の `a:t` が after に全て残る',
      actual: `消失 ${missingTotal} 件`,
      pass: missingTotal === 0,
    },
    {
      label: 'テキスト一致 sp の `xfrm` 差が無い',
      actual: `xfrm 差 ${xfrmAll.length} 件`,
      pass: xfrmAll.length === 0,
    },
    {
      label: '対応する slide でテキストあり sp が減らない',
      actual: `減少した slide ${textSpDropped} 件`,
      pass: textSpDropped === 0,
    },
    {
      label: '対応する slide で `p:pic` が減らない',
      actual: `減少した slide ${picDropped} 件`,
      pass: picDropped === 0,
    },
    {
      label: 'before の埋め込み typeface が after に全て残る',
      actual: `消失 typeface ${lostFaces.length} 件`,
      pass: lostFaces.length === 0,
    },
  ]
  const failedCount = checks.filter((check) => !check.pass).length

  // ---- 見出し ----
  write(`# pptx 比較: ${basename(beforePath)} → ${basename(afterPath)}`)
  write()
  write(`- before: \`${beforePath}\``)
  write(`- after: \`${afterPath}\``)
  write()

  // ---- 判定 ----
  write('## 判定')
  write()
  write(failedCount === 0
    ? `結果: PASS（機械判定 ${checks.length} 項目すべて PASS）`
    : `結果: FAIL（機械判定 ${checks.length} 項目のうち ${failedCount} 項目が FAIL）`)
  write()
  for (const check of checks) {
    write(`- [${check.pass ? 'PASS' : 'FAIL'}] ${check.label}: ${check.actual}`)
  }
  write()
  write('### 要判断（事実のみ）')
  write()
  write(`- slide 数: ${before.slideCount} → ${after.slideCount}`
    + `（対応 ${commonNumbers.length} / before 固有 ${onlyBeforeSlides.length} / after 固有 ${onlyAfterSlides.length}）。対応の付かない slide は機械判定の対象外`)
  write(`- \`detectPreviewDivergence\` 合計: ${before.totals.divergence} → ${after.totals.divergence}`)
  write(`- ファイルサイズ比: ${before.fileSize !== null && after.fileSize !== null && before.fileSize > 0
    ? `×${(after.fileSize / before.fileSize).toFixed(3)}`
    : '-'}`)
  write(`- after で増えた \`a:t\`: ${addedTotal} 件`)
  write(`- \`p:timing\` 合計: ${before.totals.timingCount} → ${after.totals.timingCount}`
    + ` / \`a:highlight\` 合計: ${before.totals.highlightCount} → ${after.totals.highlightCount}`)
  write(`- ラスタ media の相違: ${partDiff.raster.changed.length} 件`)
  write(`- after だけの typeface: ${newFaces.length === 0 ? '(なし)' : newFaces.map(escapeCell).join(', ')}`)
  write(`- 埋め込み書体 part（sha256 多重集合）: 一致 ${partDiff.fonts.matched}`
    + ` / before 固有 ${partDiff.fonts.onlyBefore.length}`
    + ` / after 固有 ${partDiff.fonts.onlyAfter.length}`)
  write()

  // ---- 全体 ----
  write('## 全体')
  write()
  write('| 指標 | before | after | 差 |')
  write('|---|---:|---:|---:|')
  const total = (label, b, a) => write(`| ${label} | ${b} | ${a} | ${formatDelta(b, a)} |`)
  write(`| ファイルサイズ | ${formatBytes(before.fileSize)} | ${formatBytes(after.fileSize)} | ${
    before.fileSize !== null && after.fileSize !== null
      ? `${formatDelta(before.fileSize, after.fileSize)} B`
      : '-'} |`)
  total('パート数', before.partCount, after.partCount)
  total('slide 数', before.slideCount, after.slideCount)
  total('`p:sp` 合計', before.totals.spCount, after.totals.spCount)
  total('うちテキストあり sp', before.totals.textSpCount, after.totals.textSpCount)
  total('`p:pic` 合計', before.totals.picCount, after.totals.picCount)
  total('`a:t` 合計', before.totals.textCount, after.totals.textCount)
  total('`detectPreviewDivergence` 合計', before.totals.divergence, after.totals.divergence)
  total('`p:timing` を持つ slide', before.totals.timingSlides.length, after.totals.timingSlides.length)
  total('`a:highlight` 合計', before.totals.highlightCount, after.totals.highlightCount)
  write(`| media 件数 (png/svg) | ${before.media.count} (${before.media.png}/${before.media.svg})`
    + ` | ${after.media.count} (${after.media.png}/${after.media.svg})`
    + ` | ${formatDelta(before.media.count, after.media.count)} |`)
  write(`| media 合計バイト | ${formatBytes(before.media.bytes)} | ${formatBytes(after.media.bytes)}`
    + ` | ${formatDelta(before.media.bytes, after.media.bytes)} B |`)
  total('埋め込み書体 part', before.fonts.parts.length, after.fonts.parts.length)
  write(`| 埋め込み書体 バイト | ${formatBytes(before.fonts.bytes)} | ${formatBytes(after.fonts.bytes)}`
    + ` | ${formatDelta(before.fonts.bytes, after.fonts.bytes)} B |`)
  write()
  write(`- \`p:timing\` を持つ slide: before ${before.totals.timingSlides.join(',') || '(なし)'}`
    + ` / after ${after.totals.timingSlides.join(',') || '(なし)'}`)
  write(`- \`a:highlight\` を持つ slide: before ${before.totals.highlightSlides.join(',') || '(なし)'}`
    + ` / after ${after.totals.highlightSlides.join(',') || '(なし)'}`)
  if (onlyBeforeSlides.length > 0) write(`- before にだけある slide: ${onlyBeforeSlides.join(',')}`)
  if (onlyAfterSlides.length > 0) write(`- after にだけある slide: ${onlyAfterSlides.join(',')}`)
  write()

  // ---- 埋め込み書体 ----
  write('## 埋め込み書体')
  write()
  write('slot の突合先は `ppt/_rels/presentation.xml.rels` で解決した part の sha256。')
  write('part 名は run ごとに変わり得るため、名前ではなく sha256 で対応を見る。')
  write()
  write('| 側 | typeface | slot → 解決先 sha256 (先頭 12) / part / bytes |')
  write('|---|---|---|')
  const fontRows = (metrics, side) => {
    if (metrics.fonts.embedded.length === 0) {
      write(`| ${side} | (なし) | (なし) |`)
      return
    }
    for (const font of metrics.fonts.embedded) {
      const slots = font.slots
        .map((slot) => `${slot.slot} → ${slot.sha.slice(0, 12)} / \`${basename(slot.part)}\` / ${slot.bytes} B`)
        .join('<br>')
      write(`| ${side} | ${escapeCell(font.typeface)} | ${slots || '(slot なし)'} |`)
    }
  }
  fontRows(before, 'before')
  fontRows(after, 'after')
  write()
  write(`- before にあって after に無い typeface: ${lostFaces.length === 0 ? '(なし)' : lostFaces.map(escapeCell).join(', ')}`)
  write(`- after で増えた typeface: ${newFaces.length === 0 ? '(なし)' : newFaces.map(escapeCell).join(', ')}`)
  write(`- 書体 part の突合（sha256 多重集合）: 一致 ${partDiff.fonts.matched}`
    + ` / before 固有 ${partDiff.fonts.onlyBefore.length}`
    + ` / after 固有 ${partDiff.fonts.onlyAfter.length}`)
  for (const part of partDiff.fonts.onlyBefore.slice(0, maxList)) {
    write(`  - before 固有: \`${basename(part.name)}\` ${part.size} B (sha ${part.sha.slice(0, 12)})`)
  }
  for (const part of partDiff.fonts.onlyAfter.slice(0, maxList)) {
    write(`  - after 固有: \`${basename(part.name)}\` ${part.size} B (sha ${part.sha.slice(0, 12)})`)
  }
  write()

  // ---- slide 別 ----
  write('## slide 別')
  write()
  const shown = showAll ? rows : rows.filter((row) => row.changed)
  if (rows.length === 0) {
    write('対応する slide がありません。')
  } else if (shown.length === 0) {
    write('差分のある slide はありません（対応する全 slide で sp / pic / テキスト / divergence / xfrm が一致）。')
  } else {
    write('`a:t` 欠落 / 追加 / xfrm 差 は before → after で対応付けた結果の件数。')
    write()
    write('| slide | `p:sp` | `p:pic` | テキストあり sp | divergence'
      + ' | `p:timing` / `a:highlight` | 欠落/追加/xfrm差 | 備考 |')
    write('|---:|---|---|---|---|---|---|---|')
    for (const row of shown) {
      write(`| ${row.n} | ${row.cells.join(' | ')} | ${row.note} |`)
    }
    if (!showAll) {
      write()
      write(`（差分のある slide のみ ${shown.length} 行を表示。対応する全 ${rows.length} slide は \`--all\` で表示）`)
    }
  }
  write()

  // ---- a:t の消失 / 追加 ----
  const textTable = (heading, items, totalCount) => {
    write(heading)
    write()
    if (items.length === 0) {
      write('なし。')
    } else {
      write(`合計 ${totalCount} 件（${items.length} 種）。`)
      write()
      write('| slide | テキスト | before 件数 | after 件数 |')
      write('|---:|---|---:|---:|')
      for (const item of items.slice(0, maxList)) {
        write(`| ${item.slide} | \`${escapeCell(truncate(item.text, 80))}\` | ${item.before} | ${item.after} |`)
      }
      if (items.length > maxList) {
        write(`| … | （残り ${items.length - maxList} 種は省略） | | |`)
      }
    }
    write()
  }
  textTable('## before にあって after に無い `a:t` 文字列', missingAll, missingTotal)
  textTable('## after で増えた `a:t` 文字列', addedAll, addedTotal)

  // ---- xfrm 差 ----
  write('## テキスト一致 sp の `xfrm` 差')
  write()
  if (xfrmAll.length === 0) {
    write('なし。')
  } else {
    write(`合計 ${xfrmAll.length} 件。`)
    write()
    write('| slide | テキスト | before | after |')
    write('|---:|---|---|---|')
    for (const item of xfrmAll.slice(0, maxList)) {
      write(`| ${item.slide} | \`${escapeCell(truncate(item.text, 40))}\` | ${formatXfrm(item.before)} | ${formatXfrm(item.after)} |`)
    }
    if (xfrmAll.length > maxList) {
      write(`| … | （残り ${xfrmAll.length - maxList} 件は省略） | | |`)
    }
  }
  write()

  // ---- パート差分 ----
  write('## パート差分')
  write()
  write('正規化: ルート要素の xmlns 属性順、`p:cNvPr` の `id` / `name`、SVG `clipPath` 乱数 id、')
  write('`docProps/core.xml` の日時、font 種別 Relationship の Id / Target と `p:embeddedFontLst` の')
  write('`r:id`（解決先 part の sha256 へ置換）。')
  write('正規化後の集計から埋め込み書体 part とラスタ media を除く。')
  write('前者は sha256 多重集合で、後者は「ラスタ media の相違」で別に扱う。')
  write()
  write(`- 生の sha256 相違: ${partDiff.raw.changed.length} 件`
    + `（一致 ${partDiff.raw.same} / before 固有 ${partDiff.raw.onlyBefore.length} / after 固有 ${partDiff.raw.onlyAfter.length}）`)
  write(`- 正規化後の相違: ${partDiff.normalized.changed.length} 件`
    + `（一致 ${partDiff.normalized.same} / before 固有 ${partDiff.normalized.onlyBefore.length} / after 固有 ${partDiff.normalized.onlyAfter.length}）`)
  write()
  if (partDiff.raw.changed.length > 0) {
    write('生の相違（区分別）:')
    write()
    writeKindTable(write, partDiff.raw.changed, maxList)
    write()
  }
  if (partDiff.normalized.changed.length > 0) {
    write('正規化後の相違（区分別）:')
    write()
    writeKindTable(write, partDiff.normalized.changed, maxList)
    write()
    for (const part of partDiff.normalized.changed.slice(0, maxList)) {
      write(`- \`${part.name}\`: ${part.beforeSize} B → ${part.afterSize} B`)
    }
    if (partDiff.normalized.changed.length > maxList) {
      write(`- （残り ${partDiff.normalized.changed.length - maxList} 件は省略）`)
    }
    write()
  }
  if (partDiff.normalized.onlyBefore.length > 0) {
    write(`- before 固有: ${partDiff.normalized.onlyBefore.slice(0, maxList).map((name) => `\`${name}\``).join(', ')}`)
    if (partDiff.normalized.onlyBefore.length > maxList) {
      write(`  - （残り ${partDiff.normalized.onlyBefore.length - maxList} 件は省略）`)
    }
  }
  if (partDiff.normalized.onlyAfter.length > 0) {
    write(`- after 固有: ${partDiff.normalized.onlyAfter.slice(0, maxList).map((name) => `\`${name}\``).join(', ')}`)
    if (partDiff.normalized.onlyAfter.length > maxList) {
      write(`  - （残り ${partDiff.normalized.onlyAfter.length - maxList} 件は省略）`)
    }
  }
  write()

  // ---- ラスタ media ----
  write('## ラスタ media の相違')
  write()
  write('同一テンプレの再変換でも、プリレンダした端末テキスト画像の字形描画揺れで相違し得る。')
  write('実回帰との判別ができないため除外リストを持たず、事実として列挙する。')
  write()
  write(`- ラスタ media の相違: ${partDiff.raster.changed.length} 件`
    + `（一致 ${partDiff.raster.same} / before 固有 ${partDiff.raster.onlyBefore.length} / after 固有 ${partDiff.raster.onlyAfter.length}）`)
  if (partDiff.raster.changed.length > 0) {
    write()
    write('| part | before | after | 差 |')
    write('|---|---:|---:|---:|')
    for (const part of partDiff.raster.changed.slice(0, maxList)) {
      write(`| \`${basename(part.name)}\` | ${part.beforeSize} B | ${part.afterSize} B`
        + ` | ${formatDelta(part.beforeSize, part.afterSize)} B |`)
    }
    if (partDiff.raster.changed.length > maxList) {
      write(`| … | （残り ${partDiff.raster.changed.length - maxList} 件は省略） | | |`)
    }
  }
  write()

  return {
    markdown: `${lines.join('\n')}\n`,
    checks,
    failedCount,
    exitCode: failedCount === 0 ? 0 : 1,
  }
}
