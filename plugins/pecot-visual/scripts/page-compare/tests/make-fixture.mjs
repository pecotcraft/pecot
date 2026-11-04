#!/usr/bin/env node
/**
 * compare-pages.mjs の検証用に、小さな PNG を合成する。
 *
 *   node make-fixture.mjs <variant> <out.png>
 *
 * エンコードは自前で行う。フィルタは 0（None）だけを使い、CRC32 も自前で計算する。
 * 画像は 4×3 画素で、画素値は座標から決める。
 *
 * variant:
 *   base       基準の RGB 画像。
 *   same       base と同じ画素で、tEXt chunk を足したもの。バイト列だけが違う。
 *   one-pixel  base の座標 (2,1) の 1 画素だけを変えたもの。
 *   size       寸法が 5×3 の画像。
 *   rgba       base と同じ画素を colorType 6（alpha 255）で持つもの。
 *   interlace  インターレース 1 を宣言するもの。デコーダは対応外として拒否する。
 *   bit16      bit depth 16 を宣言するもの。デコーダは対応外として拒否する。
 */
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

import { isSelfExecuted } from '../lib/self-exec.mjs'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function ihdr(width, height, bitDepth, colorType, interlace) {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = bitDepth
  data[9] = colorType
  data[12] = interlace
  return chunk('IHDR', data)
}

/** 座標から決める RGB 画素。 */
function pixel(x, y) {
  return [(x * 40) % 256, (y * 70) % 256, (x * 13 + y * 29) % 256]
}

/** フィルタ 0 の走査線を並べ、zlib で圧縮した IDAT を返す。 */
function idat(width, height, channels, pixelAt) {
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = [0]
    for (let x = 0; x < width; x += 1) {
      const rgb = pixelAt(x, y)
      row.push(...rgb)
      if (channels === 4) row.push(255)
    }
    rows.push(Buffer.from(row))
  }
  return chunk('IDAT', deflateSync(Buffer.concat(rows)))
}

export function buildPng(variant) {
  const iend = chunk('IEND', Buffer.alloc(0))
  switch (variant) {
    case 'base':
      return Buffer.concat([SIGNATURE, ihdr(4, 3, 8, 2, 0), idat(4, 3, 3, pixel), iend])
    case 'same': {
      const text = chunk('tEXt', Buffer.from('Comment\0fixture', 'latin1'))
      return Buffer.concat([SIGNATURE, ihdr(4, 3, 8, 2, 0), text, idat(4, 3, 3, pixel), iend])
    }
    case 'one-pixel': {
      const changed = (x, y) => (x === 2 && y === 1 ? [255, 255, 255] : pixel(x, y))
      return Buffer.concat([SIGNATURE, ihdr(4, 3, 8, 2, 0), idat(4, 3, 3, changed), iend])
    }
    case 'size':
      return Buffer.concat([SIGNATURE, ihdr(5, 3, 8, 2, 0), idat(5, 3, 3, pixel), iend])
    case 'rgba':
      return Buffer.concat([SIGNATURE, ihdr(4, 3, 8, 6, 0), idat(4, 3, 4, pixel), iend])
    case 'interlace':
      return Buffer.concat([SIGNATURE, ihdr(4, 3, 8, 2, 1), idat(4, 3, 3, pixel), iend])
    case 'bit16':
      return Buffer.concat([SIGNATURE, ihdr(4, 3, 16, 2, 0), idat(4, 3, 3, pixel), iend])
    default:
      throw new Error(`未知の variant: ${variant}`)
  }
}

if (isSelfExecuted(import.meta.url)) {
  const [variant, out] = process.argv.slice(2)
  if (variant === undefined || out === undefined) {
    process.stderr.write('usage: node make-fixture.mjs <variant> <out.png>\n')
    process.exit(2)
  }
  writeFileSync(out, buildPng(variant))
}
