// pdftoppm で PDF を画素列にし、色ごとの位置を測る e2e 用の helper。
// 画素は RGB 各 1 バイトの P6 (binary) PPM で受ける。

/* eslint-disable security/detect-non-literal-fs-filename */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { expect } from 'vitest'

import { compareStrings } from '../../src/domain/_shared/compare-strings.js'

/**
pdftoppm の既定の解像度 (dpi)。1.5pt の画像枠が数 px の幅で出る値。
*/
export const RENDER_DPI = 150

/**
pdftoppm を待つ時間の既定値 (ms)。
*/
export const CONVERT_TIMEOUT_MS = 180_000

export interface PpmImage {
  readonly width: number
  readonly height: number
  /**
  RGB 各 1 バイトが行優先で隙間なく並ぶ画素列。
  */
  readonly pixels: Buffer
}

/**
画素の矩形範囲。端は含む (minX 以上 maxX 以下)。
*/
export interface PixelRegion {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/**
色の外接矩形。一致する画素が無いときは pixels が 0 で、座標は -1 になる。
*/
export interface ColorBounds extends PixelRegion {
  readonly pixels: number
}

/**
P6 (binary) PPM を読む。pdftoppm の既定出力形式で、ヘッダは
「マジック → 幅 → 高さ → 最大値」の 4 トークン。トークン間の空白は任意で、
`#` から行末まではコメント。画素は RGB 各 1 バイトが行優先で並ぶ。
*/
export function readPpm(filePath: string): PpmImage {
  const data = readFileSync(filePath)
  let offset = 0
  const tokens: string[] = []
  while (tokens.length < 4) {
    while (offset < data.length && isPpmSpace(data.at(offset))) offset += 1
    if (data.at(offset) === 0x23) {
      while (offset < data.length && data.at(offset) !== 0x0A) offset += 1
      continue
    }
    const start = offset
    while (offset < data.length && !isPpmSpace(data.at(offset))) offset += 1
    tokens.push(data.toString('ascii', start, offset))
  }
  expect(tokens[0], `${filePath} が P6 形式ではない`).toBe('P6')
  // 最大値の直後の空白 1 文字までがヘッダ。CRLF を出すラスタライザに合わせて
  // \r\n は 1 文字として飛ばす (1 バイトずれると RGB の位相が全滅し、原因の読めない
  // fail になる)。
  expect(isPpmSpace(data.at(offset)), `${filePath} のヘッダ終端が空白ではない`).toBe(true)
  let pixelStart = offset + 1
  if (data.at(offset) === 0x0D && data.at(pixelStart) === 0x0A) pixelStart += 1
  return {
    width: Number(tokens[1]),
    height: Number(tokens[2]),
    pixels: data.subarray(pixelStart),
  }
}

function isPpmSpace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D
}

/**
PDF の全ページを PPM にする。アンチエイリアスを切って塗りの色を厳密一致させる。
*/
export function rasterize(
  pdfPath: string,
  outputDirectory: string,
  dpi: number = RENDER_DPI,
  timeoutMs: number = CONVERT_TIMEOUT_MS,
): readonly string[] {
  mkdirSync(outputDirectory, { recursive: true })
  const prefix = path.join(outputDirectory, 'page')
  const result = spawnSync(
    'pdftoppm',
    ['-r', String(dpi), '-aa', 'no', '-aaVector', 'no', pdfPath, prefix],
    { encoding: 'utf8', timeout: timeoutMs },
  )
  expect(result.status, `pdftoppm に失敗: ${result.stderr}`).toBe(0)
  return readdirSync(outputDirectory)
    .filter(name => name.endsWith('.ppm'))
    .toSorted(compareStrings)
    .map(name => path.join(outputDirectory, name))
}

function isMatchedAt(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
  page: PpmImage,
  x: number,
  y: number,
  rgb: readonly [number, number, number],
  tolerance: number,
): boolean {
  const offset = (y * page.width + x) * 3
  return Math.abs((page.pixels.at(offset) ?? NaN) - rgb[0]) <= tolerance
    && Math.abs((page.pixels.at(offset + 1) ?? NaN) - rgb[1]) <= tolerance
    && Math.abs((page.pixels.at(offset + 2) ?? NaN) - rgb[2]) <= tolerance
}

/**
指定色の外接矩形と画素数を測る。`region` を渡すと、その範囲の中だけを見る。
`tolerance` は各チャネルの許容差。
*/
export function colorBounds(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
  page: PpmImage,
  rgb: readonly [number, number, number],
  tolerance = 0,
  region?: Readonly<PixelRegion>,
): ColorBounds {
  const startX = Math.max(0, region?.minX ?? 0)
  const startY = Math.max(0, region?.minY ?? 0)
  const endX = Math.min(page.width - 1, region?.maxX ?? page.width - 1)
  const endY = Math.min(page.height - 1, region?.maxY ?? page.height - 1)
  let pixels = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      if (!isMatchedAt(page, x, y, rgb, tolerance)) continue
      pixels += 1
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  return pixels === 0
    ? { pixels, minX: -1, minY: -1, maxX: -1, maxY: -1 }
    : { pixels, minX, minY, maxX, maxY }
}

/**
指定色の画素のうち、どの `regions` にも入らないものの数を数える。
*/
export function countColorOutside(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
  page: PpmImage,
  rgb: readonly [number, number, number],
  tolerance: number,
  regions: readonly Readonly<PixelRegion>[],
): number {
  let count = 0
  for (let y = 0; y < page.height; y += 1) {
    for (let x = 0; x < page.width; x += 1) {
      if (!isMatchedAt(page, x, y, rgb, tolerance)) continue
      const isInside = regions.some(region => x >= region.minX && x <= region.maxX
        && y >= region.minY && y <= region.maxY)
      if (!isInside) count += 1
    }
  }
  return count
}
