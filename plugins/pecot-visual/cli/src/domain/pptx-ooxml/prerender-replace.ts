// Slidev prerender 高解像度画像を PPTX 内 `ppt/media/*.png` に差し替える純粋ロジック。
// Python 旧実装 (`postprocess_and_merge.py:111-322` および呼び出し側 :474-540) と、
// 厳密に等価な 3 段階フォールバックを再現する。
// 3 段階は、座標+サイズ → サイズのみ → 全 PNG 走査。
//
// `null` は domain 規約 (`unicorn/no-null`) で禁止されているため、未マッチは
// `undefined` で表現する (旧 Python の None と意味的に等価)。

import path from 'node:path'

import type { XmlDocument } from '../_shared/ports.js'
import { NS_DRAWINGML, NS_OFFICE_RELATIONSHIPS, NS_PACKAGE_RELATIONSHIPS, NS_PRESENTATIONML } from '../_shared/ooxml-uris.js'

const REL_NS: Readonly<Record<string, string>> = {
  rel: NS_PACKAGE_RELATIONSHIPS,
}

const PIC_NS: Readonly<Record<string, string>> = {
  a: NS_DRAWINGML,
  p: NS_PRESENTATIONML,
  r: NS_OFFICE_RELATIONSHIPS,
}

// EMU (English Metric Unit) → CSS px 換算 (1 inch = 914400 EMU, 1 inch = 96 CSS px)
const EMU_PER_CSS_PX = 9525

// Python 旧実装の tolerance 値 (位置 / サイズ相対 / サイズ絶対)
const POSITION_TOLERANCE_PX = 50
const SIZE_TOLERANCE_RATIO = 0.15
const FALLBACK_SIZE_TOLERANCE_PX = 50

// PNG signature 89 50 4E 47 0D 0A 1A 0A
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const IHDR_MARKER = Buffer.from('IHDR', 'ascii')
const PNG_HEADER_MIN_LENGTH = 24

export interface PrerenderMeta {
  readonly width: number
  readonly height: number
  readonly left?: number
  readonly top?: number
  readonly selector?: string
}

export interface PrerenderEntry {
  readonly imagePath: string
  readonly metaPath: string
}

export interface PicRecord {
  readonly mediaPart: string
  readonly xEmu: number
  readonly yEmu: number
  readonly cxEmu: number
  readonly cyEmu: number
  readonly pngWidth: number
  readonly pngHeight: number
}

export function getPngDimensions(
  buffer: Readonly<Buffer>,
): { readonly width: number, readonly height: number } | undefined {
  if ((buffer.length < PNG_HEADER_MIN_LENGTH) || !buffer.subarray(0, 8).equals(PNG_MAGIC) || !buffer.subarray(12, 16).equals(IHDR_MARKER)) return undefined
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return { width, height }
}

export function buildPicMediaMap(
  slide: XmlDocument,
  rels: XmlDocument,
  partMap: ReadonlyMap<string, Buffer>,
): readonly PicRecord[] {
  const ridToMedia = new Map<string, string>()
  for (const relationship of rels.selectNodes('//rel:Relationship', REL_NS)) {
    const rid = relationship.getAttr('Id')
    if (rid === undefined) continue
    const target = relationship.getAttr('Target')
    if (target === undefined) continue
    const markerIndex = target.indexOf('../media/')
    if (markerIndex === -1) continue
    const tail = target.slice(markerIndex + '../media/'.length)
    ridToMedia.set(rid, `ppt/media/${tail}`)
  }

  const records: PicRecord[] = []
  for (const pic of slide.selectNodes('.//p:pic', PIC_NS)) {
    const [blip] = pic.selectNodes('.//p:blipFill/a:blip', PIC_NS)
    if (blip === undefined) continue
    const rid = blip.getAttr('r:embed')
    if (rid === undefined) continue
    const mediaPart = ridToMedia.get(rid)
    if (mediaPart === undefined) continue

    const [off] = pic.selectNodes('.//p:spPr/a:xfrm/a:off', PIC_NS)
    const [extension] = pic.selectNodes('.//p:spPr/a:xfrm/a:ext', PIC_NS)
    if (off === undefined || extension === undefined) continue

    const xEmu = parseEmu(off.getAttr('x'))
    const yEmu = parseEmu(off.getAttr('y'))
    const cxEmu = parseEmu(extension.getAttr('cx'))
    const cyEmu = parseEmu(extension.getAttr('cy'))

    const mediaBuffer = partMap.get(mediaPart)
    const dims = mediaBuffer === undefined ? undefined : getPngDimensions(mediaBuffer)

    records.push({
      mediaPart,
      xEmu,
      yEmu,
      cxEmu,
      cyEmu,
      pngWidth: dims?.width ?? 0,
      pngHeight: dims?.height ?? 0,
    })
  }

  return records.toSorted((a, b) => {
    return a.yEmu === b.yEmu ? a.xEmu - b.xEmu : a.yEmu - b.yEmu
  })
}

export function matchPrerenderToMedia(
  meta: PrerenderMeta,
  picMap: readonly PicRecord[],
  matched: ReadonlySet<string>,
): string | undefined {
  if (meta.left === undefined || meta.top === undefined) return undefined

  let bestMatch: string | undefined
  let bestDistance = Infinity

  for (const pic of picMap) {
    if (matched.has(pic.mediaPart)) continue

    const picLeftPx = pic.xEmu / EMU_PER_CSS_PX
    const picTopPx = pic.yEmu / EMU_PER_CSS_PX
    const dx = meta.left - picLeftPx
    const dy = meta.top - picTopPx
    const distance = Math.hypot(dx, dy)
    if ((distance > POSITION_TOLERANCE_PX) || !isValidPicSize(pic)) continue
    const wRatio = Math.abs(meta.width - pic.pngWidth) / Math.max(meta.width, 1)
    const hRatio = Math.abs(meta.height - pic.pngHeight) / Math.max(meta.height, 1)
    if (wRatio > SIZE_TOLERANCE_RATIO || hRatio > SIZE_TOLERANCE_RATIO || !(distance < bestDistance)) {
      continue
    }

    bestDistance = distance
    bestMatch = pic.mediaPart
  }

  return bestMatch
}

export function fallbackSizeMatch(
  meta: PrerenderMeta,
  picMap: readonly PicRecord[],
  matched: ReadonlySet<string>,
): string | undefined {
  for (const pic of picMap) {
    if (matched.has(pic.mediaPart) || !isValidPicSize(pic)) continue
    const wRatio = Math.abs(meta.width - pic.pngWidth) / Math.max(meta.width, 1)
    const hRatio = Math.abs(meta.height - pic.pngHeight) / Math.max(meta.height, 1)
    if (wRatio <= SIZE_TOLERANCE_RATIO && hRatio <= SIZE_TOLERANCE_RATIO) {
      return pic.mediaPart
    }
  }
  return undefined
}

/**
`buildPicMediaMap` で PNG dimensions が解決できなかった pic は、`pngWidth=0 || pngHeight=0` で記録される。
解決できない理由は、破損しているか partMap に未収録のどちらか。
そのため、サイズ判定をする全フェーズで一律スキップする。
*/
function isValidPicSize(pic: PicRecord): boolean {
  return pic.pngWidth !== 0 && pic.pngHeight !== 0
}

export async function findPrerenderImages(
  slidesDirectory: string,
  slideNumber: number,
  io: { readonly exists: (path: string) => Promise<boolean> },
): Promise<readonly PrerenderEntry[]> {
  const result: PrerenderEntry[] = []
  let index = 0
  // 連番で .png + .meta.json をペア検索。.png が無いインデックスで停止する。
  for (;;) {
    const stem = `prerender-slide${String(slideNumber)}-${String(index)}`
    const imagePath = path.join(slidesDirectory, `${stem}.png`)
    const isImageExists = await io.exists(imagePath)
    if (!isImageExists) break
    const metaPath = path.join(slidesDirectory, `${stem}.meta.json`)
    result.push({ imagePath, metaPath })
    index += 1
  }
  return result
}

export async function applyPrerenderImageReplace(
  slide: XmlDocument,
  rels: XmlDocument,
  partMap: Map<string, Buffer>,
  entries: readonly PrerenderEntry[],
  io: {
    readonly readFile: (path: string) => Promise<Buffer>
    readonly warn: (message: string) => void
  },
): Promise<{ readonly replaced: number }> {
  if (entries.length === 0) return { replaced: 0 }

  const picMap = buildPicMediaMap(slide, rels, partMap)
  const matched = new Set<string>()
  let replaced = 0

  for (const entry of entries) {
    const meta = await loadMeta(entry.metaPath, io)
    if (meta === undefined) continue

    // existence 確認後に削除されるレースや FS 一過性エラーで全体が落ちるのを防ぐ。
    // loadMeta と非対称な堅牢性を揃え、失敗 entry は warn して skip する。
    let highResolutionBuffer: Buffer
    try {
      highResolutionBuffer = await io.readFile(entry.imagePath)
    }
    catch (error) {
      io.warn(`prerender image read failed: ${entry.imagePath}: ${String(error)}`)
      continue
    }

    // 1 段目: 座標 + サイズ。matchPrerenderToMedia は matched 済 mediaPart を
    // 候補から除外するため、stage1 が undefined でない場合は必ず未マッチで採用する。
    const stage1 = matchPrerenderToMedia(meta, picMap, matched)
    if (stage1 !== undefined) {
      partMap.set(stage1, Buffer.from(highResolutionBuffer))
      matched.add(stage1)
      replaced += 1
      continue
    }

    // 2 段目: サイズのみ (1 段目が undefined の時のみ発動)
    const stage2 = fallbackSizeMatch(meta, picMap, matched)
    if (stage2 !== undefined) {
      partMap.set(stage2, Buffer.from(highResolutionBuffer))
      matched.add(stage2)
      replaced += 1
      continue
    }

    // 3 段目: pic_media_map が空のときのみ全 PNG 走査 (絶対差 50 px)
    if (picMap.length === 0) {
      replaced += applyAllPngFallback(partMap, highResolutionBuffer, meta, matched)
    }
  }

  return { replaced }
}

function applyAllPngFallback(
  partMap: Map<string, Buffer>,
  highResolutionBuffer: Readonly<Buffer>,
  meta: PrerenderMeta,
  matched: Set<string>,
): number {
  let count = 0
  // Map iteration safety: 既存 key の上書きのみ。新規 key 追加は無いので visit 順序は撹乱しない。
  for (const [partName, partBuffer] of partMap) {
    if (!partName.startsWith('ppt/media/') || !partName.endsWith('.png') || matched.has(partName)) continue
    const dims = getPngDimensions(partBuffer)
    if (dims === undefined) continue
    if (!(Math.abs(dims.width - meta.width) <= FALLBACK_SIZE_TOLERANCE_PX
      && Math.abs(dims.height - meta.height) <= FALLBACK_SIZE_TOLERANCE_PX)) {
      continue
    }

    partMap.set(partName, Buffer.from(highResolutionBuffer))
    matched.add(partName)
    count += 1
  }
  return count
}

async function loadMeta(
  metaPath: string,
  io: {
    readonly readFile: (path: string) => Promise<Buffer>
    readonly warn: (message: string) => void
  },
): Promise<PrerenderMeta | undefined> {
  let raw: Buffer
  try {
    raw = await io.readFile(metaPath)
  }
  catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  }
  catch {
    return undefined
  }
  if (!isRecord(parsed)) {
    io.warn(`prerender meta unrecognized: ${metaPath} (not a JSON object)`)
    return undefined
  }
  const width = parsed['width']
  const height = parsed['height']
  if (typeof width !== 'number' || typeof height !== 'number') {
    io.warn(`prerender meta unrecognized: ${metaPath} (width/height missing or non-numeric)`)
    return undefined
  }
  const meta: { width: number, height: number, left?: number, top?: number, selector?: string }
    = { width, height }
  if (typeof parsed['left'] === 'number') meta.left = parsed['left']
  if (typeof parsed['top'] === 'number') meta.top = parsed['top']
  if (typeof parsed['selector'] === 'string') meta.selector = parsed['selector']
  return meta
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function parseEmu(value: string | undefined): number {
  if (value === undefined) return 0
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) ? n : 0
}
