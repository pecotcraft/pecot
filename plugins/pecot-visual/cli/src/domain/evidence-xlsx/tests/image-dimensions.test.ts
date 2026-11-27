import { describe, expect, it } from 'vitest'

import { readImageDimensions } from '../image-dimensions.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('PNG は、IHDR チャンクから、ビッグエンディアンの 32 ビット整数で幅と高さを読み取る', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、PNG に対するテストです。IHDR チャンクを持つ 1920x1080 の PNG を渡した場合に、形式が `png` で、幅と高さを返すことを確認します。')
    expect(readImageDimensions(buildPng(1920, 1080))).toStrictEqual({
      ok: true,
      format: 'png',
      width: 1920,
      height: 1080,
    })
  })

  it('PNG は、1x1 の最小の大きさでも、読み取れる', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、PNG に対するテストです。1x1 の PNG を渡した場合に、幅と高さが 1 の結果を返すことを確認します。')
    expect(readImageDimensions(buildPng(1, 1))).toStrictEqual({
      ok: true,
      format: 'png',
      width: 1,
      height: 1,
    })
  })

  it('PNG は、Uint8Array の byteOffset が 0 でない場合でも、同じ幅と高さを返す', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、PNG に対するテストです。共有のバッファから切り出した、`byteOffset` が 5 の `Uint8Array` を渡した場合でも、先頭がずれずに 800x600 を返すことを確認します。')
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

  it('PNG は、シグネチャが一致していても、24 バイトに満たない場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、PNG に対するテストです。PNG のシグネチャを持つ 20 バイトのデータを渡した場合は、`reason` が `unreadable` で、`PNG ends before IHDR` を含む結果を返すことを確認します。')
    const truncated = buildPng(640, 480).subarray(0, 20)

    expect(readImageDimensions(truncated)).toStrictEqual({
      ok: false,
      reason: 'unreadable',
      message: 'PNG ends before IHDR (20 bytes)',
    })
  })

  it('PNG は、最初のチャンクが IHDR でない場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、PNG に対するテストです。最初のチャンクが `IDAT` の PNG を渡した場合に、`ok` が `false` で、`reason` が `unreadable` の結果を返すことを確認します。')
    expect(readImageDimensions(buildPng(640, 480, 'IDAT'))).toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
  })

  it.each([
    ['width が 0', 0, 480],
    ['height が 0', 640, 0],
  ])('PNG は、%s の場合は、読み取れないものとして扱う', async (_label, width, height) => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、PNG に対するテストです。幅または高さが 0 の PNG を渡した場合に、`ok` が `false` で、`reason` が `unreadable` の結果を返すことを確認します。')
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
  ])('JPEG は、%s の SOF から、幅と高さを読み取る', async (_label, marker) => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。SOF0 から SOF2 までのいずれかのセグメントを持つ 1280x720 の JPEG を渡した場合に、形式が `jpeg` で、幅と高さを返すことを確認します。')
    const jpeg = buildJpeg(segment(marker, sofPayload(1280, 720)))

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: true,
      format: 'jpeg',
      width: 1280,
      height: 720,
    })
  })

  it('JPEG は、APP0 と DQT のセグメントを読み飛ばして、後ろにある SOF から幅と高さを読み取る', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。APP0 と DQT のセグメントの後ろに SOF がある場合に、SOF の値（2000x1500）を返すことを確認します。')
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

  it('JPEG は、APP1（EXIF）に埋め込まれたサムネイルの SOF を、本体の SOF と取り違えない', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。APP1 に 160x120 のサムネイルの JPEG が埋め込まれている場合に、サムネイルではなく本体の SOF の値（4032x3024）を返すことを確認します。')
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

  it('JPEG は、DHT・JPG・DAC のマーカーを、SOF と誤認しない', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。SOF と同じ `0xC0` 台の `0xC4`（DHT）、`0xC8`（JPG）、`0xCC`（DAC）のセグメントがある場合に、読み飛ばして SOF の値（320x240）を返すことを確認します。')
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

  it('JPEG は、SOF がなく DHT だけで終わる場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。SOF のセグメントがなく、DHT だけで終わる JPEG を渡した場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const jpeg = buildJpeg(segment(0xC4, [0x00, 0x01, 0x02, 0x03]))

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('JPEG は、マーカーの前に連続する 0xFF の詰めバイトがあっても、読み飛ばして SOF を読み取る', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。マーカーの前に `0xFF` が 3 バイト続く場合は、詰めバイトとして読み飛ばし、SOF の値（100x50）を返すことを確認します。')
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
  ])('JPEG は、長さのフィールドを持たない単独のマーカー（%s）を読み飛ばして、SOF を読み取る', async (_label, marker) => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。長さのフィールドを持たない単独のマーカー（`TEM` や `RST0` など）が SOF の前にある場合は、読み飛ばして SOF の値（64x32）を返すことを確認します。')
    const jpeg = buildJpeg([0xFF, marker], segment(0xC0, sofPayload(64, 32)))

    expect(readImageDimensions(jpeg)).toStrictEqual({
      ok: true,
      format: 'jpeg',
      width: 64,
      height: 32,
    })
  })

  it('JPEG は、SOS に到達した場合は、SOF の探索をやめて、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。SOF より先に SOS がある場合は、SOS より後ろを探索せず、`reason` が `unreadable` で、`reached SOS` を含む結果を返すことを確認します。')
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

  it('JPEG は、EOI に到達した場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。SOF がないまま EOI で終わる JPEG を渡した場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const jpeg = buildJpeg([0xFF, 0xD9])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('JPEG は、セグメントの長さが 2 未満の場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。セグメントの長さのフィールドが 1 を示す、不正な JPEG を渡した場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const jpeg = buildJpeg([0xFF, 0xE0, 0x00, 0x01])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('JPEG は、セグメントの長さのフィールドが途中で終わっている場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。セグメントの長さのフィールドが 1 バイトしかないデータを渡した場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const jpeg = buildJpeg([0xFF, 0xE0, 0x00])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('JPEG は、SOF のセグメントの長さが、幅と高さのフィールドに届かない場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。SOF のペイロードが短く、幅と高さのフィールドを含まない場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const jpeg = buildJpeg(segment(0xC0, [8, 0x00]))

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('JPEG は、SOF が宣言された長さの途中で切れている場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。SOF の末尾を 3 バイト切り落としたデータを渡した場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const full = buildJpeg(segment(0xC0, sofPayload(640, 480)))

    expect(readImageDimensions(full.subarray(0, -3))).toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
  })

  it.each([
    ['width が 0', 0, 480],
    ['height が 0', 640, 0],
  ])('JPEG は、SOF の%sの場合は、読み取れないものとして扱う', async (_label, width, height) => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。SOF の幅または高さが 0 の JPEG を渡した場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const jpeg = buildJpeg(segment(0xC0, sofPayload(width, height)))
    expect(readImageDimensions(jpeg)).toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('JPEG は、マーカーの位置に 0xFF がない場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。先頭の後ろに `0xFF` ではないバイトが続く場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const jpeg = buildJpeg([0x12, 0x34, 0x56])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('JPEG は、末尾が 0xFF で終わっている場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。マーカーの種類を示すバイトがなく、`0xFF` で終わる JPEG を渡した場合に、`reason` が `unreadable` の結果を返すことを確認します。')
    const jpeg = buildJpeg([0xFF])

    expect(readImageDimensions(jpeg)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('JPEG は、SOF が現れないままデータの末尾に達した場合は、読み取れないものとして扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、JPEG に対するテストです。APP0 のセグメントだけで終わり、SOF がない JPEG を渡した場合に、`reason` が `unreadable` の結果を返すことを確認します。')
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
  ])('%s の場合は、未対応の形式として扱う', async (_label, values) => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、PNG と JPEG 以外に対するテストです。GIF や BMP、画像ではない文字列、空のデータなどを渡した場合に、`reason` が `unsupported-format` の結果を返すことを確認します。')
    expect(readImageDimensions(Uint8Array.from(values))).toMatchObject({
      ok: false,
      reason: 'unsupported-format',
    })
  })

  it('PNG のシグネチャの後ろ 4 バイトが不正な場合は、未対応の形式として扱う', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、PNG に対するテストです。シグネチャの後半の 4 バイトを 0 に書き換えた PNG を渡した場合に、`reason` が `unsupported-format` の結果を返すことを確認します。')
    const broken = buildPng(640, 480)
    broken.set([0x00, 0x00, 0x00, 0x00], 4)

    expect(readImageDimensions(broken)).toMatchObject({
      ok: false,
      reason: 'unsupported-format',
    })
  })

  it('未対応の形式のメッセージは、先頭のバイトの 16 進数表記を含む', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、未対応の形式に対するテストです。GIF の先頭 4 バイトを渡した場合に、メッセージに `47 49 46 38` が含まれることを確認します。')
    const result = readImageDimensions(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('47 49 46 38')
  })

  it('空のデータの場合の、未対応の形式のメッセージは、(empty) を含む', async () => {
    await explains('画像データの幅と高さを読み取る `readImageDimensions` の、未対応の形式に対するテストです。空のデータを渡した場合に、メッセージに `(empty)` が含まれることを確認します。')
    const result = readImageDimensions(new Uint8Array(0))

    expect(result.ok ? '' : result.message).toContain('(empty)')
  })
})
