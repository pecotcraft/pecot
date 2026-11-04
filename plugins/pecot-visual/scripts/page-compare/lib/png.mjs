/**
 * 最小の PNG デコーダ。Node 組み込みの zlib だけを使う。
 *
 * 対応: bit depth 8、color type 2（RGB）と 6（RGBA）、非インターレース。
 * IHDR・IDAT・IEND を読む。pHYs・eXIf・tEXt などの未知 chunk は読み飛ばす。
 * chunk の CRC は検証しない。画素の一致判定は sha256 と画素比較で行うため、CRC は不要。
 * 対応外の形式と読めない入力は、理由付きの PngError を投げる。
 *
 *   const { width, height, channels, data } = decodePng(buffer)
 *
 * data は走査線を詰めた Uint8Array で、長さは width * height * channels。
 */
import { inflateSync } from 'node:zlib'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export class PngError extends Error {}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 走査線ごとのフィルタを戻す。raw は「フィルタ種別 1 バイト + 走査線」の並び。 */
function unfilter(raw, width, height, channels) {
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const prev = dst - stride
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? out[dst + i - channels] : 0
      const up = y > 0 ? out[prev + i] : 0
      const upLeft = y > 0 && i >= channels ? out[prev + i - channels] : 0
      let add
      switch (filter) {
        case 0: add = 0; break
        case 1: add = left; break
        case 2: add = up; break
        case 3: add = (left + up) >> 1; break
        case 4: add = paeth(left, up, upLeft); break
        default: throw new PngError(`未知のフィルタ種別: ${filter}（走査線 ${y}）`)
      }
      out[dst + i] = (raw[src + i] + add) & 0xff
    }
  }
  return out
}

export function decodePng(buffer) {
  if (buffer.length < 8 || SIGNATURE.some((byte, i) => buffer[i] !== byte)) {
    throw new PngError('PNG の署名ではありません')
  }
  let header = null
  const idat = []
  let ended = false
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) throw new PngError(`chunk ${type} が途中で切れています`)
    if (type === 'IHDR') {
      if (length !== 13) throw new PngError('IHDR の長さが 13 ではありません')
      header = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        bitDepth: buffer[start + 8],
        colorType: buffer[start + 9],
        interlace: buffer[start + 12],
      }
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end))
    } else if (type === 'IEND') {
      ended = true
      break
    }
    offset = end + 4
  }
  if (header === null) throw new PngError('IHDR がありません')
  if (!ended) throw new PngError('IEND がありません')
  if (header.interlace !== 0) throw new PngError('インターレース PNG には対応していません')
  if (header.bitDepth !== 8) {
    throw new PngError(`bit depth ${header.bitDepth} には対応していません（8 のみ）`)
  }
  const channelsByType = { 2: 3, 6: 4 }
  const channels = channelsByType[header.colorType]
  if (channels === undefined) {
    throw new PngError(`color type ${header.colorType} には対応していません（2 と 6 のみ）`)
  }
  if (header.width === 0 || header.height === 0) throw new PngError('寸法が 0 です')
  if (idat.length === 0) throw new PngError('IDAT がありません')

  let raw
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch (error) {
    throw new PngError(`IDAT の伸長に失敗: ${error.message}`)
  }
  const expected = header.height * (header.width * channels + 1)
  if (raw.length !== expected) {
    throw new PngError(`伸長後の長さが想定と違います: ${raw.length} B（想定 ${expected} B）`)
  }
  return {
    width: header.width,
    height: header.height,
    channels,
    data: unfilter(raw, header.width, header.height, channels),
  }
}
