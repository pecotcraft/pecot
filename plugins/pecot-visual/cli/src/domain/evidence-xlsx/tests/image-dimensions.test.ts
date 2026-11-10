import { describe, expect, it } from 'vitest'

import { readImageDimensions } from '../image-dimensions.js'

// フィクスチャはテスト内で手組みする。実画像ファイルをコミットせずに
// シグネチャ / セグメント構造の分岐を 1 対 1 で狙い撃ちできるため。

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

function ascii(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

function buildPng(
  width: number,
  height: number,
  chunkType = 'IHDR',
): Uint8Array {
  return Uint8Array.from([
    ...PNG_SIGNATURE,
    // IHDR チャンク長 (13)
    0x00, 0x00, 0x00, 0x0D,
    ...ascii(chunkType),
    ...uint32(width),
    ...uint32(height),
  ])
}

function uint32(value: number): number[] {
  return [(value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF]
}

function uint16(value: number): number[] {
  return [(value >>> 8) & 0xFF, value & 0xFF]
}

/**
マーカー + 長さフィールド (自身の 2 バイトを含む) + ペイロード。
*/
function segment(marker: number, payload: readonly number[]): number[] {
  return [0xFF, marker, ...uint16(payload.length + 2), ...payload]
}

/**
SOF ペイロード: precision(1) + height(2) + width(2) + component 数(1)。
*/
function sofPayload(width: number, height: number): number[] {
  return [8, ...uint16(height), ...uint16(width), 3]
}

function buildJpeg(...body: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from([0xFF, 0xD8, ...body.flat()])
}

describe('readImageDimensions — PNG', () => {
  it('IHDR から big-endian uint32 で寸法を読む', () => {
    expect(readImageDimensions(buildPng(1920, 1080))).toStrictEqual({
      ok: true,
      format: 'png',
      width: 1920,
      height: 1080,
    })
  })

  it('1x1 の最小寸法も受理する', () => {
    expect(readImageDimensions(buildPng(1, 1))).toStrictEqual({
      ok: true,
      format: 'png',
      width: 1,
      height: 1,
    })
  })

  it('byteOffset ≠ 0 の Uint8Array でも同じ寸法を返す', () => {
    // fs.readFile の Buffer は共有プールからの切り出しで byteOffset ≠ 0 になり得る。
    // DataView を bytes.buffer 全体で作ると先頭がずれて誤読するため、そのケースを固定する。
    const png = buildPng(800, 600)
    const pool = new Uint8Array(png.length + 5)
    pool.set(png, 5)
    const shifted = pool.subarray(5)

    expect(shifted.byteOffset).toBe(5)
    expect(readImageDimensions(shifted)).toStrictEqual({
      ok: true,
      format: 'png',
      width: 800,
      height: 600,
    })
  })

  it('シグネチャ一致でも 24 バイト未満なら unreadable', () => {
    const truncated = buildPng(640, 480).subarray(0, 20)

    expect(readImageDimensions(truncated)).toStrictEqual({
      ok: false,
      reason: 'unreadable',
      message: 'PNG ends before IHDR (20 bytes)',
    })
  })

  it('第 1 チャンクが IHDR 以外なら unreadable', () => {
    expect(readImageDimensions(buildPng(640, 480, 'IDAT'))).toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
  })

  it.each([
    ['width が 0', 0, 480],
    ['height が 0', 640, 0],
  ])('%s なら unreadable', (_label, width, height) => {
    expect(readImageDimensions(buildPng(width, height))).toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
  })
})

describe('readImageDimensions — JPEG', () => {
  it.each([
    ['baseline (SOF0)', 0xC0],
    ['extended sequential (SOF1)', 0xC1],
    ['progressive (SOF2)', 0xC2],
  ])('%s の SOF から寸法を読む', (_label, marker) => {
    const jpeg = buildJpeg(segment(marker, sofPayload(1280, 720)))

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: true,
      format: 'jpeg',
      width: 1280,
      height: 720,
    })
  })

  it('APP0 / DQT を跨いだ先の SOF を見つける', () => {
    const jpeg = buildJpeg(
      // APP0 (JFIF ヘッダー相当のダミーペイロード)
      segment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01]),
      // DQT
      segment(0xDB, Array.from({ length: 65 }, () => 0x10)),
      segment(0xC2, sofPayload(2000, 1500)),
    )

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: true,
      format: 'jpeg',
      width: 2000,
      height: 1500,
    })
  })

  it('APP1 (EXIF) が抱える埋め込みサムネイルの SOF を本体と取り違えない', () => {
    // セグメント長でスキップせず生バイトを走査すると、APP1 payload 内の
    // サムネイル JPEG の SOF0 を先に拾って 160x120 を返してしまう。
    const embeddedThumbnail = [
      0xFF, 0xD8,
      ...segment(0xC0, sofPayload(160, 120)),
      0xFF, 0xD9,
    ]
    const jpeg = buildJpeg(
      segment(0xE1, [...ascii('Exif'), 0x00, 0x00, ...embeddedThumbnail]),
      segment(0xC0, sofPayload(4032, 3024)),
    )

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: true,
      format: 'jpeg',
      width: 4032,
      height: 3024,
    })
  })

  it('0xC4 (DHT) / 0xC8 (JPG) / 0xCC (DAC) を SOF と誤認しない', () => {
    // いずれも 0xCn 帯だが SOF ではない。範囲判定で受理すると
    // ハフマンテーブルの中身を寸法として読んでしまう。
    const jpeg = buildJpeg(
      segment(0xC4, [0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
      segment(0xC8, [0x11, 0x22, 0x33, 0x44]),
      segment(0xCC, [0x55, 0x66, 0x77, 0x88]),
      segment(0xC0, sofPayload(320, 240)),
    )

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: true,
      format: 'jpeg',
      width: 320,
      height: 240,
    })
  })

  it('SOF が現れないまま DHT だけで終わる場合は unreadable', () => {
    const jpeg = buildJpeg(segment(0xC4, [0x00, 0x01, 0x02, 0x03]))

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('マーカー前の fill バイト (連続 0xFF) を読み飛ばす', () => {
    const jpeg = buildJpeg([0xFF, 0xFF, 0xFF], segment(0xC0, sofPayload(100, 50)))

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: true,
      format: 'jpeg',
      width: 100,
      height: 50,
    })
  })

  it.each([
    ['TEM (0x01)', 0x01],
    ['RST0 (0xD0)', 0xD0],
    ['RST7 (0xD7)', 0xD7],
    ['SOI (0xD8)', 0xD8],
  ])('長さフィールドを持たない standalone マーカー %s を跨げる', (_label, marker) => {
    const jpeg = buildJpeg([0xFF, marker], segment(0xC0, sofPayload(64, 32)))

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: true,
      format: 'jpeg',
      width: 64,
      height: 32,
    })
  })

  it('SOS に到達したら SOF 探索を打ち切って unreadable', () => {
    // SOS 以降はエントロピー符号化データで、そこを走査すると偶然の 0xFFC0 を拾う。
    const jpeg = buildJpeg(
      segment(0xDA, [0x01, 0x01, 0x00]),
      segment(0xC0, sofPayload(999, 999)),
    )

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: false,
      reason: 'unreadable',
      message: 'no SOF segment in JPEG (reached SOS)',
    })
  })

  it('EOI に到達したら unreadable', () => {
    const jpeg = buildJpeg([0xFF, 0xD9])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('セグメント長が 2 未満なら unreadable', () => {
    const jpeg = buildJpeg([0xFF, 0xE0, 0x00, 0x01])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('セグメント長フィールドが欠けていれば unreadable', () => {
    const jpeg = buildJpeg([0xFF, 0xE0, 0x00])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('SOF のセグメント長が寸法フィールドに届かなければ unreadable', () => {
    const jpeg = buildJpeg(segment(0xC0, [8, 0x00]))

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('SOF が宣言長の途中で切れていれば unreadable', () => {
    const full = buildJpeg(segment(0xC0, sofPayload(640, 480)))

    expect(readImageDimensions(full.subarray(0, -3))).toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
  })

  it.each([
    ['width が 0', 0, 480],
    ['height が 0', 640, 0],
  ])('SOF の %s なら unreadable', (_label, width, height) => {
    const jpeg = buildJpeg(segment(0xC0, sofPayload(width, height)))
    expect(readImageDimensions(jpeg)).toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('マーカー境界に 0xFF がなければ unreadable', () => {
    const jpeg = buildJpeg([0x12, 0x34, 0x56])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('0xFF で終端していれば unreadable', () => {
    const jpeg = buildJpeg([0xFF])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('SOF が現れないままバッファ末尾まで進んだら unreadable', () => {
    const jpeg = buildJpeg(segment(0xE0, [0x4A, 0x46, 0x49, 0x46]))

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})

describe('readImageDimensions — 非対応形式', () => {
  it.each([
    ['GIF89a', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x10, 0x00]],
    ['BMP', [0x42, 0x4D, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00]],
    ['テキスト', ascii('not an image')],
    ['1 バイトのみ', [0xFF]],
    ['空バッファ', []],
  ])('%s は unsupported-format', (_label, values) => {
    expect(readImageDimensions(Uint8Array.from(values))).toMatchObject({
      ok: false,
      reason: 'unsupported-format',
    })
  })

  it('PNG シグネチャの末尾 4 バイトが不正なら unsupported-format', () => {
    const broken = buildPng(640, 480)
    broken.set([0x00, 0x00, 0x00, 0x00], 4)

    expect(readImageDimensions(broken)).toMatchObject({
      ok: false,
      reason: 'unsupported-format',
    })
  })

  it('message に先頭バイトの 16 進表現を含む', () => {
    const result = readImageDimensions(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('47 49 46 38')
  })

  it('空バッファの message は (空) を含む', () => {
    const result = readImageDimensions(new Uint8Array(0))

    expect(result.ok ? '' : result.message).toContain('(empty)')
  })
})
