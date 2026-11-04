// 画像バイト列から原寸 (px) と形式を読み取る純関数。
// ファイル読み込みは呼び出し側 (infra) の責務で、domain は fs に依存しない。
//
// 寸法は xl/drawings/drawing1.xml の EMU 算出に使う。
// 算出では DISPLAY_WIDTH_PX 以下へ縦横比を保って縮小する (FR-005)。
// 形式は xl/media/image<N>.<ext> と [Content_Types].xml の拡張子決定に使う。
// 拡張子を偽ったファイルをその拡張子で格納すると、Excel が修復ダイアログを出す (SC-005 違反)。
// そのため形式はシグネチャから判定する。

/**
失敗理由。contracts/evidence-cli.md §1 の skip 語彙と 1:1 で対応する。
*/
export type ImageDimensionsFailure = 'unsupported-format' | 'unreadable'

/**
受理する画像形式。zip 内拡張子と [Content_Types].xml の Default 宣言もこれで決まる。
*/
export type ImageFormat = 'png' | 'jpeg'

/**
寸法読み取りの結果。1 件の失敗で xlsx 生成全体を落とさない (FR-006) ため、
例外ではなく ok:false で返す。`message` は CLI がそのまま stderr に出せる文言。

`not-found` は fs アクセスの結果であり infra 側の責務なので、ここには持たせない。
*/
export type ImageDimensionsResult
  = | { readonly ok: true, readonly format: ImageFormat, readonly width: number, readonly height: number }
    | { readonly ok: false, readonly reason: ImageDimensionsFailure, readonly message: string }

// PNG シグネチャ 89 50 4E 47 0D 0A 1A 0A を big-endian uint32 2 つに分けた値。
const PNG_SIGNATURE_HEAD = 0x89_50_4E_47
const PNG_SIGNATURE_TAIL = 0x0D_0A_1A_0A
// 第 1 チャンクのタイプ 'IHDR' の ASCII を big-endian uint32 として見た値。
const PNG_IHDR_TYPE = 0x49_48_44_52
// シグネチャ(8) + チャンク長(4) + チャンクタイプ(4) + width(4) + height(4)
const PNG_MINIMUM_LENGTH = 24

const JPEG_SOI = 0xFF_D8
const MARKER_PREFIX = 0xFF
const MARKER_TEM = 0x01
const MARKER_RST_FIRST = 0xD0
const MARKER_RST_LAST = 0xD7
const MARKER_SOI = 0xD8
const MARKER_EOI = 0xD9
const MARKER_SOS = 0xDA
// 受理する SOF は baseline (C0) / extended sequential (C1) / progressive (C2) の 3 種のみ。
// C4 (DHT) / C8 (JPG 予約) / CC (DAC) は 0xCn 帯にあるが SOF ではないため範囲判定にしない。
const MARKER_SOF0 = 0xC0
const MARKER_SOF1 = 0xC1
const MARKER_SOF2 = 0xC2
// セグメント長(2) + precision(1) + height(2) + width(2)
const JPEG_SOF_MINIMUM_LENGTH = 7

/**
PNG / JPEG のバイト列から原寸を読み取る。

EXIF の orientation は**適用しない**。入力画像は xl/media/ へ無加工でコピーされる (FR-005)。
Excel / LibreOffice は orientation を解釈せず、SOF / IHDR に格納された寸法で描画する。
ここで回転後の寸法を返すと、描画される画像と注記の枠だけがずれる。
*/
export function readImageDimensions(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- TypedArray は可変型
  bytes: Uint8Array,
): ImageDimensionsResult {
  // fs.readFile が返す Buffer は 8KB プールからの切り出しで、byteOffset ≠ 0 になり得る。
  // そのため常に offset / length を明示して DataView を作る (bytes.buffer 全体を見ない)。
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (hasPngSignature(view)) return readPngDimensions(view)
  if (hasJpegSignature(view)) return readJpegDimensions(view)
  return {
    ok: false,
    reason: 'unsupported-format',
    message: `PNG / JPEG のシグネチャに一致しません (先頭 ${describeHead(view)})`,
  }
}

function hasPngSignature(view: Readonly<DataView>): boolean {
  return view.byteLength >= 8
    && view.getUint32(0) === PNG_SIGNATURE_HEAD
    && view.getUint32(4) === PNG_SIGNATURE_TAIL
}

function hasJpegSignature(view: Readonly<DataView>): boolean {
  return view.byteLength >= 2 && view.getUint16(0) === JPEG_SOI
}

function readPngDimensions(view: Readonly<DataView>): ImageDimensionsResult {
  if (view.byteLength < PNG_MINIMUM_LENGTH) {
    return unreadable(`PNG の IHDR まで届きません (${view.byteLength.toString()} バイト)`)
  }
  if (view.getUint32(12) !== PNG_IHDR_TYPE) {
    return unreadable('PNG の第 1 チャンクが IHDR ではありません')
  }
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width === 0 || height === 0 ? unreadable(`PNG の IHDR 寸法が 0 です (${width.toString()}x${height.toString()})`) : { ok: true, format: 'png', width, height }
}

function readJpegDimensions(view: Readonly<DataView>): ImageDimensionsResult {
  // 走査範囲は入力長そのものが上限。1 周ごとに index はマーカー分の 2 バイト以上進むため、
  // セグメント長が最小 (2) でもループは必ず終了する。
  let index = 2
  while (index < view.byteLength) {
    if (view.getUint8(index) !== MARKER_PREFIX) {
      return unreadable(`JPEG のマーカー境界が不正です (offset ${index.toString()})`)
    }
    index += 1
    // マーカー直前の連続 0xFF は fill バイトなので読み飛ばす。
    while (index < view.byteLength && view.getUint8(index) === MARKER_PREFIX) index += 1
    if (index >= view.byteLength) {
      return unreadable('JPEG がマーカーの途中で終端しています')
    }
    const marker = view.getUint8(index)
    index += 1

    // 長さフィールドを持たない standalone マーカー。
    if (marker === MARKER_TEM || marker === MARKER_SOI
      || (marker >= MARKER_RST_FIRST && marker <= MARKER_RST_LAST)) {
      continue
    }
    // SOS 以降はエントロピー符号化データで、SOF はもう現れない。
    if (marker === MARKER_SOS) {
      return unreadable('JPEG に SOF セグメントがありません (SOS に到達)')
    }
    if (marker === MARKER_EOI) {
      return unreadable('JPEG に SOF セグメントがありません (EOI に到達)')
    }

    if (index + 2 > view.byteLength) {
      return unreadable('JPEG のセグメント長フィールドが欠けています')
    }
    const segmentLength = view.getUint16(index)
    // 長さフィールド自身の 2 バイトを含む値なので 2 未満は破損。
    if (segmentLength < 2) {
      return unreadable(`JPEG のセグメント長が不正です (${segmentLength.toString()})`)
    }
    if ([MARKER_SOF0, MARKER_SOF1, MARKER_SOF2].includes(marker)) {
      if (segmentLength < JPEG_SOF_MINIMUM_LENGTH || index + JPEG_SOF_MINIMUM_LENGTH > view.byteLength) {
        return unreadable('JPEG の SOF セグメントが寸法の手前で切れています')
      }
      const height = view.getUint16(index + 3)
      const width = view.getUint16(index + 5)
      return width === 0 || height === 0 ? unreadable(`JPEG の SOF 寸法が 0 です (${width.toString()}x${height.toString()})`) : { ok: true, format: 'jpeg', width, height }
    }
    index += segmentLength
  }
  return unreadable('JPEG に SOF セグメントがありません')
}

function unreadable(message: string): ImageDimensionsResult {
  return { ok: false, reason: 'unreadable', message }
}

/**
unsupported-format のメッセージ用に先頭数バイトを 16 進で示す。
*/
function describeHead(view: Readonly<DataView>): string {
  const limit = Math.min(view.byteLength, 4)
  const parts: string[] = []
  for (let index = 0; index < limit; index += 1) {
    parts.push(view.getUint8(index).toString(16).padStart(2, '0'))
  }
  return parts.length === 0 ? '(空)' : parts.join(' ')
}
