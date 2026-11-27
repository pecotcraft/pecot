// PPM の画素を添付用の PNG にする関数（tests/_helpers/raster.ts）の契約。

import zlib from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { ppmToPng } from '../../_helpers/raster.js'
import { explains } from '../../_helpers/explains.js'

interface DecodedPng {
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly colorType: number
  readonly pixels: Buffer
}

function decodePng(png: Readonly<Buffer>): DecodedPng {
  expect(png.subarray(0, 8)).toStrictEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
  let offset = 8
  let header: Buffer | undefined
  const data: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    expect(png.readUInt32BE(offset + 8 + length), `${type} の CRC`).toBe(zlib.crc32(png.subarray(offset + 4, offset + 8 + length)))
    if (type === 'IHDR') header = body
    else if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  if (header === undefined) throw new Error('IHDR が無い')
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const raw = zlib.inflateSync(Buffer.concat(data))
  const rows = Array.from({ length: height }, (_, y) => {
    const start = y * (1 + width * 3)
    expect(raw.at(start), `${String(y)} 行目のフィルタ`).toBe(0)
    return raw.subarray(start + 1, start + 1 + width * 3)
  })
  return { width, height, bitDepth: header[8] ?? -1, colorType: header[9] ?? -1, pixels: Buffer.concat(rows) }
}

describe('ppmToPng', () => {
  it('PPM の寸法と画素を、そのまま 8bit のフルカラーの PNG に変換する', async () => {
    await explains('PPM の画素を添付用の PNG に変換する `ppmToPng` のテストです。幅 3、高さ 2 の画素を渡した場合に、PNG を読み取り直した寸法と画素が元と一致し、ビット深度が 8、カラータイプが 2 になることを確認します。')
    const width = 3
    const height = 2
    const pixels = Buffer.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255,
      10, 20, 30, 40, 50, 60, 70, 80, 90,
    ])

    const decoded = decodePng(ppmToPng({ width, height, pixels }))

    expect(decoded).toStrictEqual({ width, height, bitDepth: 8, colorType: 2, pixels })
  })

  it('画素のデータが寸法に対して不足している場合は、寸法を含むメッセージで例外が発生する', async () => {
    await explains('PPM の画素を添付用の PNG に変換する `ppmToPng` のテストです。幅 2、高さ 2 に対して 11 バイトしかない画素を渡した場合に、メッセージに `2x2` が含まれる例外が発生することを確認します。')
    expect(() => ppmToPng({ width: 2, height: 2, pixels: Buffer.alloc(11) })).toThrow('2x2')
  })
})
