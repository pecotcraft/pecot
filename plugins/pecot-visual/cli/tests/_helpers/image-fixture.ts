// テストが使う画像を手組みする。PNG はチャンクの CRC まで正しく組む（LibreOffice は CRC が合わないと描かない）。

import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

function pngChunk(type: string, data: Readonly<Buffer>): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
RGB 各 1 バイトが行優先で隙間なく並ぶ画素列から、8bit truecolor の PNG を組む。IHDR / IDAT / IEND のみの最小構成。
*/
export function encodeTruecolorPng(width: number, height: number, pixels: Readonly<Uint8Array>): Buffer {
  const rowLength = width * 3
  if (pixels.length < rowLength * height) {
    throw new Error(`画素列が ${String(width)}x${String(height)} の RGB に足りない (${String(pixels.length)} バイト)`)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  // 各行は「フィルタ種別 1 バイト (0 = none) + RGB × width」。
  const raw = Buffer.alloc((1 + rowLength) * height)
  for (let y = 0; y < height; y += 1) {
    raw.set(pixels.subarray(y * rowLength, (y + 1) * rowLength), y * (1 + rowLength) + 1)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
単色 truecolor PNG。
*/
export function buildPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number] = [200, 40, 40],
): Buffer {
  const pixels = Buffer.alloc(width * height * 3)
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(rgb, index * 3)
  }
  return encodeTruecolorPng(width, height, pixels)
}

/**
シグネチャだけの PNG。IHDR に届かないため寸法パーサが unreadable を返す。
*/
export function buildTruncatedPng(): Buffer {
  return Buffer.from(PNG_SIGNATURE)
}

/**
SOI + SOF0 + EOI だけの JPEG。寸法パーサと格納拡張子の判定には足りるが、
走査データが無いので画像としては描画できない (描画を伴う e2e には使わない)。
*/
export function buildJpeg(width: number, height: number): Buffer {
  const sofPayload = Buffer.alloc(8)
  sofPayload.writeUInt16BE(8, 0) // セグメント長 (自身の 2 バイトを含む)
  sofPayload.writeUInt8(8, 2) // sample precision
  sofPayload.writeUInt16BE(height, 3)
  sofPayload.writeUInt16BE(width, 5)
  sofPayload.writeUInt8(1, 7) // component 数
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    Buffer.from([0xFF, 0xC0]),
    sofPayload,
    Buffer.from([0xFF, 0xD9]),
  ])
}
