// EvidenceSpec から xlsx を書き出す infra 層のエントリポイント。
//
// 受け取るのは parseEvidenceSpec が正規化済みの spec。省略可能フィールドが
// 埋まっているので、ここから下流は `?? []` の防御を書かない。
//
// 処理順は「全画像を読んで skip 分類 → 有効 0 件なら書き出しに触れずエラー →
// XML 生成 → zip 組立 → 上書き書出」。
// 有効 0 件で出力を開かないのは、既存の `--out` を truncate しないため (data-model §4: 部分生成物を残さない)。
//
// yazl のラッパは pptx 側の YazlPptxWriter を流用せず、finish の Promise 化だけを書き写している。
// evidence は media を無圧縮でそのまま入れる / entry 順を固定する、といった要求を持つ。
// これが pptx ポートの契約と別で、ポートを共有すると双方の制約が混在するため。

// yazl の ZipFile は内部状態を持つ mutable オブジェクトで、readonly 化できない。
// そのため prefer-readonly-parameter-types を本ファイル全体で無効化する (archive.ts と同流儀)。
/* eslint-disable security/detect-non-literal-fs-filename -- path は CLI 引数由来で信頼境界外を受理する */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- yazl ZipFile は mutable */
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { ZipFile } from 'yazl'

import type { ImageFormat } from '../../domain/evidence-xlsx/image-dimensions.js'
import { readImageDimensions } from '../../domain/evidence-xlsx/image-dimensions.js'
import type { EvidenceImageSource } from '../../domain/evidence-xlsx/layout.js'
import { buildEvidenceLayout } from '../../domain/evidence-xlsx/layout.js'
import {
  buildContentTypesXml,
  buildDrawingRelsXml,
  buildDrawingXml,
  buildRootRelsXml,
  buildSheetRelsXml,
  buildSheetXml,
  buildStylesXml,
  buildWorkbookRelsXml,
  buildWorkbookXml,
  mediaPartName,
  PART_CONTENT_TYPES,
  PART_DRAWING,
  PART_DRAWING_RELS,
  PART_ROOT_RELS,
  PART_SHEET,
  PART_SHEET_RELS,
  PART_STYLES,
  PART_WORKBOOK,
  PART_WORKBOOK_RELS,
} from '../../domain/evidence-xlsx/ooxml.js'
import type { NormalizedEvidenceSpec } from '../../domain/evidence-xlsx/spec-schema.js'

/**
除外理由。contracts/evidence-cli.md §1 の skip 語彙。
*/
export type EvidenceSkipReason = 'not-found' | 'unsupported-format' | 'unreadable'

/**
生成を中断する理由。CLI が --json の `reason` にそのまま載せる。
*/
export type EvidenceWorkbookErrorReason = 'no-valid-images' | 'output-write-failed'

export interface EvidenceSkippedImage {
  readonly path: string
  readonly reason: EvidenceSkipReason
}

export interface EvidenceWriteResult {
  /**
  書き出した xlsx のパス (絶対パス化は command 層の責務)。
  */
  readonly outPath: string
  /**
  配置した項目数 = 有効画像数。
  */
  readonly items: number
  /**
  配置した注記数。除外画像に付いていた注記は数えない。
  */
  readonly annotations: number
  readonly skipped: readonly EvidenceSkippedImage[]
}

export class EvidenceWorkbookError extends Error {
  constructor(message: string, readonly reason: EvidenceWorkbookErrorReason) {
    super(message)
    this.name = 'EvidenceWorkbookError'
  }
}

interface LoadedImage extends EvidenceImageSource {
  readonly bytes: Buffer
  readonly format: ImageFormat
}

/**
有効画像を配置した xlsx を outPath へ書き出す。有効画像が 1 件も無ければ
`EvidenceWorkbookError('no-valid-images')` で失敗し、出力ファイルには触れない。
*/
export async function writeEvidenceWorkbook(
  spec: Readonly<NormalizedEvidenceSpec>,
  outPath: string,
): Promise<EvidenceWriteResult> {
  const loaded: LoadedImage[] = []
  const skipped: EvidenceSkippedImage[] = []
  // 逐次読み込み。連番と skip 一覧を items の配列順どおりに決めるため並行化しない。
  for (const item of spec.items) {
    const read = await readImageFile(item.imagePath)
    if (!read.ok) {
      skipped.push({ path: item.imagePath, reason: read.reason })
      continue
    }
    const dimensions = readImageDimensions(read.bytes)
    if (!dimensions.ok) {
      skipped.push({ path: item.imagePath, reason: dimensions.reason })
      continue
    }
    loaded.push({
      item,
      bytes: read.bytes,
      format: dimensions.format,
      width: dimensions.width,
      height: dimensions.height,
    })
  }

  if (loaded.length === 0) {
    throw new EvidenceWorkbookError(
      `配置できる画像がありません (${spec.items.length.toString()} 件すべて除外)`,
      'no-valid-images',
    )
  }

  // media 名と No.<n> は、「有効画像だけの連番」で振り直す (contracts §3: 欠番なし)。
  const media = loaded.map((image, offset) => ({
    part: mediaPartName(offset + 1, image.format),
    bytes: image.bytes,
  }))
  const layout = buildEvidenceLayout({
    title: spec.title,
    createdDate: spec.createdDate,
    extraHeaders: spec.extraHeaders,
    images: loaded,
  })

  const zip = new ZipFile()
  // [Content_Types].xml を先頭エントリに置く (OPC の慣行。一部リーダが先頭前提で読む)。
  addText(zip, PART_CONTENT_TYPES, buildContentTypesXml(loaded.map(image => image.format)))
  addText(zip, PART_ROOT_RELS, buildRootRelsXml())
  addText(zip, PART_WORKBOOK, buildWorkbookXml(layout.sheetName))
  addText(zip, PART_WORKBOOK_RELS, buildWorkbookRelsXml())
  addText(zip, PART_SHEET, buildSheetXml(layout))
  addText(zip, PART_SHEET_RELS, buildSheetRelsXml())
  addText(zip, PART_STYLES, buildStylesXml())
  addText(zip, PART_DRAWING, buildDrawingXml(layout.placements))
  addText(zip, PART_DRAWING_RELS, buildDrawingRelsXml(media.map(entry => entry.part)))
  for (const entry of media) {
    // 入力画像は無加工コピー (FR-005)。PNG / JPEG は既に圧縮済みで deflate が働かないため、
    // 時間と出力サイズを無駄にしないよう compress: false で格納する。
    zip.addBuffer(entry.bytes, entry.part, { compress: false })
  }

  try {
    await finishZip(zip, outPath)
  }
  catch (error: unknown) {
    throw new EvidenceWorkbookError(
      `xlsx を書き出せません: ${outPath} (${formatError(error)})`,
      'output-write-failed',
    )
  }

  return {
    outPath,
    items: loaded.length,
    // layout が導出した図形を数える。除外画像は placements に入らないので自然に外れる。
    annotations: layout.placements.flatMap(placement => placement.annotationShapes).length,
    skipped,
  }
}

type ReadImageResult
  = | { readonly ok: true, readonly bytes: Buffer }
    | { readonly ok: false, readonly reason: EvidenceSkipReason }

/**
画像を読む。ENOENT だけを not-found とする。
EACCES / EISDIR 等の「存在するが読めない」は unreadable に寄せる (contracts §1 の skip 語彙は 3 種のみ)。
*/
async function readImageFile(imagePath: string): Promise<ReadImageResult> {
  try {
    return { ok: true, bytes: await readFile(imagePath) }
  }
  catch (error: unknown) {
    return { ok: false, reason: errnoCode(error) === 'ENOENT' ? 'not-found' : 'unreadable' }
  }
}

function errnoCode(error: unknown): string | undefined {
  /* c8 ignore next -- fs.readFile の reject は常に code つき Error のため到達不能、防御網のみ */
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function addText(zip: ZipFile, part: string, xml: string): void {
  zip.addBuffer(Buffer.from(xml, 'utf8'), part)
}

/**
yazl の outputStream をファイルへ流し切るまで待つ。
*/
function finishZip(zip: ZipFile, outPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const writeStream = createWriteStream(outPath)
    writeStream.on('error', reject)
    writeStream.on('finish', resolve)
    /* c8 ignore next -- outputStream 側の error は組立済み Buffer のみを流すため再現不能 */
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(writeStream)
    zip.end()
  })
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は fs / stream 経由では発生しない、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */
