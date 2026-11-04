/**
 * 比較結果を Markdown にする。判定行・集計行・差分表の書式は固定。
 * CUJ の合格基準がこれらの行を字面のまま引く。
 */

/**
 * input は beforeDir・afterDir・matched・onlyBefore・onlyAfter・diffs を持つ。
 *   matched: 対応ページの件数。
 *   onlyBefore / onlyAfter: 片側にだけあるページ番号の配列。
 *   diffs の各要素は page と、dimension（before と after）または pixels（count・first・bbox）を持つ。
 * 差のあるページ数は、diffs と片側欠けの合計。
 * 戻り値: { markdown, exitCode }
 */
export function buildReport(input) {
  const { beforeDir, afterDir, matched, onlyBefore, onlyAfter, diffs } = input
  const differing = diffs.length + onlyBefore.length + onlyAfter.length
  const lines = []
  const write = (line = '') => lines.push(line)

  write('# ページ画像の比較')
  write()
  write(`- before: \`${beforeDir}\``)
  write(`- after: \`${afterDir}\``)
  write()
  write(differing === 0
    ? '結果: PASS（差のあるページはありません）'
    : `結果: FAIL（差のあるページ ${differing} 件）`)
  write()
  write(`- 対応ページ: ${matched} / before 固有: ${onlyBefore.length} / after 固有: ${onlyAfter.length}`)
  if (onlyBefore.length > 0) write(`- before だけのページ: ${onlyBefore.join(', ')}`)
  if (onlyAfter.length > 0) write(`- after だけのページ: ${onlyAfter.join(', ')}`)
  write()
  if (diffs.length > 0) {
    write('| ページ | 差分画素 | 最初の座標 | 外接矩形 |')
    write('|---:|---|---|---|')
    for (const diff of diffs) {
      if (diff.dimension !== undefined) {
        const { before, after } = diff.dimension
        write(`| ${diff.page} | 寸法 ${before.width}x${before.height} → ${after.width}x${after.height} | - | - |`)
      } else {
        const { count, first, bbox } = diff.pixels
        write(`| ${diff.page} | ${count} | (${first.x},${first.y})`
          + ` | (${bbox.x0},${bbox.y0})-(${bbox.x1},${bbox.y1}) |`)
      }
    }
    write()
  }
  return { markdown: `${lines.join('\n')}\n`, exitCode: differing === 0 ? 0 : 1 }
}
