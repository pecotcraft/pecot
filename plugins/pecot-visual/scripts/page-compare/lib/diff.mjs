/**
 * ページ画像の比較。sha256 の一致判定と、同寸画像の画素比較。
 */
import { createHash } from 'node:crypto'

export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 同寸の 2 画像を画素ごとに比べる。許容差は 0。
 * channels が違う場合も RGB の 3 値で比べる。alpha は比べない。
 * 差が無ければ null を返す。
 * 差があれば count・first（x と y）・bbox（x0 y0 x1 y1）を返す。
 * first は走査順（上から下、左から右）で最初の差分画素。
 */
export function comparePixels(a, b) {
  let count = 0
  let first = null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const ia = (y * a.width + x) * a.channels
      const ib = (y * b.width + x) * b.channels
      if (a.data[ia] === b.data[ib]
        && a.data[ia + 1] === b.data[ib + 1]
        && a.data[ia + 2] === b.data[ib + 2]) {
        continue
      }
      count += 1
      if (first === null) first = { x, y }
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return count === 0 ? null : { count, first, bbox: { x0, y0, x1, y1 } }
}
