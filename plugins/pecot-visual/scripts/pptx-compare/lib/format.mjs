/**
 * compare-pptx.mjs / compare-cx-measure.mjs の Markdown 出力で共通の表記フォーマット。
 */

/** 前後の差分を `+N` / `0` / `-N` 表記にする（同値は `+0` ではなく `0`）。 */
export function formatDelta(before, after) {
  const delta = after - before
  if (delta === 0) return '0'
  return delta > 0 ? `+${delta}` : String(delta)
}
