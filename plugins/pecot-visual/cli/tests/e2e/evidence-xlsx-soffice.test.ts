// 生成 xlsx を soffice で PDF 化し、修復なしに開けること・注記が spec の位置に描かれることを見る e2e (`pnpm test:e2e` 経由)。
// skip は生成 xlsx ではなく CSV の変換可否で判定する (生成 xlsx を probe にすると実装の欠陥を skip が隠す)。
/* eslint-disable security/detect-non-literal-fs-filename */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { TestContext } from 'vitest'
import { afterAll, describe, expect, it } from 'vitest'

import type { Annotation } from '../../src/domain/evidence-xlsx/spec-schema.js'
import { writeEvidenceWorkbook } from '../../src/infra/evidence-xlsx/workbook-writer.js'
import { SofficePdfConverter } from '../../src/infra/pptx-ooxml/soffice.js'
import { buildPng } from '../_helpers/image-fixture.js'
import type { PixelRegion, PpmImage } from '../_helpers/raster.js'
import { CONVERT_TIMEOUT_MS, colorBounds, countColorOutside, rasterize, readPpm } from '../_helpers/raster.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const temporaryRoot = useTemporaryDirectory('pecotv-922-evidence-', { hook: 'all' })
function isCommandAvailable(command: string): boolean {
  return spawnSync('which', [command], { encoding: 'utf8' }).status === 0
}

/**
注記の赤・画像枠・帯・白・黒のどれからも離した、位置を測る画像の色。
*/
const FIRST_IMAGE_RGB: readonly [number, number, number] = [40, 160, 80]
const SECOND_IMAGE_RGB: readonly [number, number, number] = [160, 80, 200]
const ANNOTATION_RED: readonly [number, number, number] = [0xFF, 0x00, 0x00]
const IMAGE_COLOR_TOLERANCE = 2

/**
画像の表示幅 (pt)。fitToWidth=1 の A4 横で、1920x1080 の縦はこの 9/16 倍。
*/
const IMAGE_DISPLAY_WIDTH_PT = 720
const IMAGE_ASPECT = 16 / 9
/**
ページ分割で画像が割れていれば 16:9 から大きくずれる。
*/
const ASPECT_TOLERANCE = 0.02

/**
ooxml.ts の線幅から導く許容 (pt)。枠線 2.25pt の半分、矢印の線幅 3pt の半分、矢尻 (w="lg") の半幅。
*/
const BORDER_HALF_PT = 1.125
const ARROW_LINE_HALF_PT = 1.5
const ARROWHEAD_HALF_PT = 7.5
/**
レンダラの丸めと、画像枠の内側で外接矩形を測ることによる誤差 (px)。
*/
const RENDER_MARGIN_PX = 3

interface Edges {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

interface PositionCase {
  readonly label: string
  readonly annotation: Annotation
}

interface PositionShot {
  readonly name: string
  readonly rgb: readonly [number, number, number]
  readonly caption: string
  readonly cases: readonly PositionCase[]
}

/**
spec の annotations と、描画で期待する矩形の元になる座標をここに 1 回だけ書く。矩形と許容は annotationBounds が導く。
2 枚目は別の行にアンカーを置くグループで、画像の端 (x+w=1・y+h=1・矢印の to が x=1) に置く。
*/
const POSITION_SHOTS: readonly PositionShot[] = [
  {
    name: '21-position.png',
    rgb: FIRST_IMAGE_RGB,
    caption: '右下の注記',
    cases: [
      { label: 'highlight', annotation: { type: 'highlight', box: { x: 0.55, y: 0.55, w: 0.15, h: 0.15 } } },
      {
        label: 'callout',
        annotation: {
          type: 'callout',
          text: '右下を指す',
          box: { x: 0.75, y: 0.55, w: 0.2, h: 0.15 },
          anchor: { x: 0.97, y: 0.74 },
        },
      },
      { label: 'arrow', annotation: { type: 'arrow', from: { x: 0.6, y: 0.85 }, to: { x: 0.9, y: 0.8 } } },
    ],
  },
  {
    name: '22-edge.png',
    rgb: SECOND_IMAGE_RGB,
    caption: '端の注記',
    cases: [
      { label: '右端の highlight', annotation: { type: 'highlight', box: { x: 0.82, y: 0.1, w: 0.18, h: 0.2 } } },
      { label: '下端の highlight', annotation: { type: 'highlight', box: { x: 0.1, y: 0.8, w: 0.2, h: 0.2 } } },
      { label: '右端の arrow', annotation: { type: 'arrow', from: { x: 0.45, y: 0.95 }, to: { x: 1, y: 0.9 } } },
    ],
  },
]

/**
soffice が Calc ドキュメントを PDF 化できるか (libreoffice-calc の導入有無) を確かめる。
*/
async function canConvertWithCalc(): Promise<boolean> {
  if (!isCommandAvailable('soffice') || !isCommandAvailable('pdftotext')) return false
  const probeDirectory = mkdtempSync(path.join(tmpdir(), 'pecotv-evidence-probe-'))
  try {
    const probeCsv = path.join(probeDirectory, 'probe.csv')
    writeFileSync(probeCsv, 'pecotv,probe\n1,2\n', 'utf8')
    const outputDirectory = path.join(probeDirectory, 'pdf')
    const result = await new SofficePdfConverter().convertToPdf({
      inputPath: probeCsv,
      outputDirectory,
      timeoutMs: CONVERT_TIMEOUT_MS,
    })
    return existsSync(result.pdfPath) && statSync(result.pdfPath).size > 0
  }
  catch {
    return false
  }
  finally {
    rmSync(probeDirectory, { recursive: true, force: true })
  }
}

function pdfText(pdfPath: string): string {
  const result = spawnSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' })
  /* c8 ignore next -- probe で pdftotext の可用性を確認済みのため通常到達しない */
  return result.status === 0 ? result.stdout : ''
}

/**
並び順の検証で使うスクリーンショット 1 枚ぶんの条件。
*/
interface EvidenceShot {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly rgb: readonly [number, number, number]
  readonly caption: string
}

/**
it ごとの作業ディレクトリ。共有ルートに直接置くと、別の it が同名の fixture を
別内容で上書きして「どの画像を検証したのか」が実行順に依存する。
*/
function caseDirectory(name: string): string {
  const directory = temporaryRoot(name)
  mkdirSync(directory, { recursive: true })
  return directory
}

/**
使えない環境では skip にする (warn + return だと pass に計上され、変換を通していないことが読めない)。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- TestContext は可変
function skipUnless(context: TestContext, isUsable: boolean, requirement: string): void {
  context.skip(
    !isUsable,
    `${requirement}が使える環境ではないため skip。`
    + ' `sudo apt-get install -y libreoffice-calc poppler-utils` を実行してから再試行してください。',
  )
}

/**
文言が列挙順どおりに (欠けず・入れ替わらず) 現れることを見る。
最初の出現位置で判定するため、各 needle は本文中で一意であることが前提。
*/
function expectInOrder(text: string, needles: readonly string[]): void {
  let previousIndex = -1
  for (const needle of needles) {
    const index = text.indexOf(needle)
    expect(index, `PDF 上で ${needle} が直前の項目より後に現れない`).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

// 判定に soffice を実際に起動するため時間がかかる。ファイルの読み込み時に 1 度だけ行う。
const isCalcConversionUsable = await canConvertWithCalc()
const isRasterUsable = isCalcConversionUsable && isCommandAvailable('pdftoppm')

/**
指定色を最も多く含むページを選ぶ。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
function pageWithImage(pages: readonly PpmImage[], rgb: readonly [number, number, number]): PpmImage {
  const ranked = pages
    .map(page => ({ page, pixels: colorBounds(page, rgb, IMAGE_COLOR_TOLERANCE).pixels }))
    .toSorted((left, right) => right.pixels - left.pixels)
  const best = ranked.at(0)
  if (best === undefined || best.pixels === 0) throw new Error('画像の色がどのページにも現れない')
  return best.page
}

/**
注記の相対座標の外接矩形と、端ごとの許容 (pt)。矢尻は to の点を含む縦の端にだけ足す。
*/
function annotationBounds(annotation: Annotation): { rectangle: PixelRegion, tolerance: Edges } {
  const border: Edges = { left: BORDER_HALF_PT, top: BORDER_HALF_PT, right: BORDER_HALF_PT, bottom: BORDER_HALF_PT }
  if (annotation.type === 'highlight') {
    const { x, y, w, h } = annotation.box
    return { rectangle: { minX: x, minY: y, maxX: x + w, maxY: y + h }, tolerance: border }
  }
  if (annotation.type === 'callout') {
    const { x, y, w, h } = annotation.box
    return {
      rectangle: {
        minX: Math.min(x, annotation.anchor.x),
        minY: Math.min(y, annotation.anchor.y),
        maxX: Math.max(x + w, annotation.anchor.x),
        maxY: Math.max(y + h, annotation.anchor.y),
      },
      tolerance: border,
    }
  }
  const { from, to } = annotation
  const isHeadOnTop = to.y <= from.y
  return {
    rectangle: {
      minX: Math.min(from.x, to.x),
      minY: Math.min(from.y, to.y),
      maxX: Math.max(from.x, to.x),
      maxY: Math.max(from.y, to.y),
    },
    tolerance: {
      left: ARROW_LINE_HALF_PT,
      right: ARROW_LINE_HALF_PT,
      top: ARROW_LINE_HALF_PT + (isHeadOnTop ? ARROWHEAD_HALF_PT : 0),
      bottom: ARROW_LINE_HALF_PT + (isHeadOnTop ? 0 : ARROWHEAD_HALF_PT),
    },
  }
}

/**
画像の外接矩形を測る。16:9 でなければ、ページ分割で画像が割れている。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
function measureImage(page: PpmImage, shot: PositionShot): PixelRegion {
  const image = colorBounds(page, shot.rgb, IMAGE_COLOR_TOLERANCE)
  const width = image.maxX - image.minX + 1
  const height = image.maxY - image.minY + 1
  expect(
    Math.abs(width / height - IMAGE_ASPECT),
    `${shot.name} が 16:9 で描かれていない (${width.toString()}x${height.toString()} px)`,
  ).toBeLessThan(ASPECT_TOLERANCE)
  return image
}

/**
期待する矩形 (px) と、端ごとの許容 (px) から、探す領域を作る。
*/
function expectedPixels(image: Readonly<PixelRegion>, testCase: PositionCase): {
  target: PixelRegion
  region: PixelRegion
  allowed: Edges
} {
  const width = image.maxX - image.minX + 1
  const height = image.maxY - image.minY + 1
  const pxPerPtX = width / IMAGE_DISPLAY_WIDTH_PT
  const pxPerPtY = height / (IMAGE_DISPLAY_WIDTH_PT / IMAGE_ASPECT)
  const { rectangle, tolerance } = annotationBounds(testCase.annotation)
  const allowed: Edges = {
    left: tolerance.left * pxPerPtX + RENDER_MARGIN_PX,
    right: tolerance.right * pxPerPtX + RENDER_MARGIN_PX,
    top: tolerance.top * pxPerPtY + RENDER_MARGIN_PX,
    bottom: tolerance.bottom * pxPerPtY + RENDER_MARGIN_PX,
  }
  const target: PixelRegion = {
    minX: image.minX + rectangle.minX * width,
    minY: image.minY + rectangle.minY * height,
    maxX: image.minX + rectangle.maxX * width,
    maxY: image.minY + rectangle.maxY * height,
  }
  return {
    target,
    allowed,
    region: {
      minX: Math.floor(target.minX - allowed.left),
      minY: Math.floor(target.minY - allowed.top),
      maxX: Math.ceil(target.maxX + allowed.right),
      maxY: Math.ceil(target.maxY + allowed.bottom),
    },
  }
}

/**
赤の外接矩形の 4 辺が、期待する矩形の許容内にあることを見る。領域を返す。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
function expectAnnotationDrawn(page: PpmImage, image: Readonly<PixelRegion>, testCase: PositionCase): PixelRegion {
  const { target, region, allowed } = expectedPixels(image, testCase)
  const red = colorBounds(page, ANNOTATION_RED, 0, region)
  expect(red.pixels, `${testCase.label} の赤が期待する領域に描かれていない`).toBeGreaterThan(0)
  const edges: readonly (readonly [string, number, number, number])[] = [
    ['左', red.minX, target.minX, allowed.left],
    ['上', red.minY, target.minY, allowed.top],
    ['右', red.maxX, target.maxX, allowed.right],
    ['下', red.maxY, target.maxY, allowed.bottom],
  ]
  for (const [name, measured, wanted, limit] of edges) {
    expect(
      Math.abs(measured - wanted),
      `${testCase.label} の${name}端が期待位置 ${wanted.toFixed(1)} px から離れている (描画では ${measured.toString()} px)`,
    ).toBeLessThanOrEqual(limit)
  }
  return region
}

function isOverlapping(left: Readonly<PixelRegion>, right: Readonly<PixelRegion>): boolean {
  return left.minX <= right.maxX && right.minX <= left.maxX && left.minY <= right.maxY && right.minY <= left.maxY
}

afterAll(() => {
  if (temporaryRoot() !== '' && existsSync(temporaryRoot())) {
    rmSync(temporaryRoot(), { recursive: true, force: true })
  }
})

describe('生成 xlsx の soffice 変換', () => {
  it('修復なしに Calc として PDF 化でき、タイトルと No.1 が現れる', { timeout: 240_000 }, async (context) => {
    skipUnless(context, isCalcConversionUsable, 'soffice の Calc → PDF 変換')

    const caseRoot = caseDirectory('basic')
    const first = path.join(caseRoot, '01-login.png')
    const second = path.join(caseRoot, '02-home.png')
    writeFileSync(first, buildPng(1920, 1080, [200, 40, 40]))
    writeFileSync(second, buildPng(800, 600, [40, 80, 200]))
    const out = path.join(caseRoot, 'evidence.xlsx')

    const result = await writeEvidenceWorkbook({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      items: [
        { imagePath: first, caption: 'ログイン画面を表示', annotations: [] },
        { imagePath: second, caption: 'ホーム画面へ遷移', annotations: [] },
      ],
    }, out)
    expect(result.items).toBe(2)

    const outputDirectory = path.join(caseRoot, 'pdf')
    const converted = await new SofficePdfConverter().convertToPdf({
      inputPath: out,
      outputDirectory,
      timeoutMs: CONVERT_TIMEOUT_MS,
    })

    // soffice は load 失敗でも exit 0 を返すため、PDF の実在と非空を成否条件にする。
    expect(existsSync(converted.pdfPath)).toBe(true)
    expect(statSync(converted.pdfPath).size).toBeGreaterThan(0)

    const text = pdfText(converted.pdfPath)
    expect(text).toContain('ログイン機能 動作確認エビデンス')
    expect(text).toContain('作成日')
    expect(text).toContain('No.1 ログイン画面を表示')
    expect(text).toContain('No.2 ホーム画面へ遷移')
  })

  it('注記付きでも修復なしに PDF 化でき、callout の文言が現れる', { timeout: 240_000 }, async (context) => {
    skipUnless(context, isCalcConversionUsable, 'soffice の Calc → PDF 変換')

    const caseRoot = caseDirectory('annotated')
    const shot = path.join(caseRoot, '11-annotated.png')
    writeFileSync(shot, buildPng(1920, 1080, [230, 230, 230]))
    const out = path.join(caseRoot, 'evidence-annotated.xlsx')

    const result = await writeEvidenceWorkbook({
      title: '注記付きエビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [],
      items: [{
        imagePath: shot,
        caption: 'ログイン画面を表示',
        annotations: [
          {
            type: 'callout',
            text: 'ログインボタンを押下',
            box: { x: 0.05, y: 0.62, w: 0.3, h: 0.12 },
            anchor: { x: 0.3, y: 0.45 },
          },
          { type: 'highlight', box: { x: 0.2, y: 0.35, w: 0.2, h: 0.15 } },
          { type: 'arrow', from: { x: 0.45, y: 0.62 }, to: { x: 0.32, y: 0.47 } },
        ],
      }],
    }, out)
    expect(result.annotations).toBe(3)

    const outputDirectory = path.join(caseRoot, 'pdf-annotated')
    const converted = await new SofficePdfConverter().convertToPdf({
      inputPath: out,
      outputDirectory,
      timeoutMs: CONVERT_TIMEOUT_MS,
    })

    expect(existsSync(converted.pdfPath)).toBe(true)
    // 図形が読み飛ばされていれば PDF は出ても文言が現れない。
    expect(pdfText(converted.pdfPath)).toContain('ログインボタンを押下')
  })

  // #924: ヘッダーの追加項目と items の指定順が、実レンダラを通した後も宣言順で
  // 上から並ぶことを見る。XPath の統合テストは XML 上の順序しか見ないため、
  // 行割付を取り違えて重なった / 逆順に描かれた場合はこの流れでしか出ない。
  it('追加ヘッダーと items の指定順が PDF 上でも宣言順に並ぶ', { timeout: 240_000 }, async (context) => {
    skipUnless(context, isCalcConversionUsable, 'soffice の Calc → PDF 変換')

    // ファイル名の自然順 (01 → 02 → 03) とは別の順序で並べる。
    // この流れは正規化済み spec を直接渡すので、caption は常に明示値になる。
    // 2 件目だけファイル名の stem と異なる文言にして、「描画されるのは caption であってファイル名ではない」を判別する。
    const caseRoot = caseDirectory('headers')
    const shots: readonly EvidenceShot[] = [
      { name: '03-logout.png', width: 1920, height: 1080, rgb: [200, 40, 40], caption: '03-logout' },
      { name: '01-login.png', width: 800, height: 600, rgb: [40, 80, 200], caption: 'ログイン画面を表示' },
      { name: '02-submit.png', width: 400, height: 300, rgb: [40, 160, 80], caption: '02-submit' },
    ]
    const items = shots.map((shot) => {
      const imagePath = path.join(caseRoot, shot.name)
      writeFileSync(imagePath, buildPng(shot.width, shot.height, shot.rgb))
      return { imagePath, caption: shot.caption, annotations: [] }
    })
    const out = path.join(caseRoot, 'evidence-headers.xlsx')

    const result = await writeEvidenceWorkbook({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [
        { label: '作成者', value: 'K. Hayakawa' },
        { label: '環境', value: 'staging' },
      ],
      items,
    }, out)
    expect(result.items).toBe(3)

    const outputDirectory = path.join(caseRoot, 'pdf-headers')
    const converted = await new SofficePdfConverter().convertToPdf({
      inputPath: out,
      outputDirectory,
      timeoutMs: CONVERT_TIMEOUT_MS,
    })

    expect(existsSync(converted.pdfPath)).toBe(true)
    const text = pdfText(converted.pdfPath)
    // LibreOffice は列の並びでページを割るため、pdftotext の出力は B 列のページ群
    // (ラベルとキャプション) が先、C 列のページ群 (ヘッダーの値) が後になる。
    // 縦並び順は列ごとに見る。
    expectInOrder(text, [
      'ログイン機能 動作確認エビデンス',
      '作成日',
      '作成者',
      '環境',
      'No.1 03-logout',
      'No.2 ログイン画面を表示',
      'No.3 02-submit',
    ])
    expectInOrder(text, ['2026-08-17', 'K. Hayakawa', 'staging'])
  })

  // #324: セルの寸法を超えるオフセットを LibreOffice が切り詰めると、右下の注記が左上に寄る。構造テストでは出ない。
  it('2 枚の画像の注記が、端に置いたものも含め、spec の相対座標の指す位置に縮まず描かれる', { timeout: 240_000 }, async (context) => {
    skipUnless(context, isRasterUsable, 'soffice の Calc → PDF 変換と pdftoppm')

    const caseRoot = caseDirectory('position')
    const items = POSITION_SHOTS.map((shot) => {
      const imagePath = path.join(caseRoot, shot.name)
      writeFileSync(imagePath, buildPng(1920, 1080, [...shot.rgb]))
      return { imagePath, caption: shot.caption, annotations: shot.cases.map(testCase => testCase.annotation) }
    })
    const result = await writeEvidenceWorkbook({
      title: '注記の位置',
      createdDate: '2026-08-17',
      extraHeaders: [],
      items,
    }, path.join(caseRoot, 'evidence-position.xlsx'))
    expect(result.annotations).toBe(POSITION_SHOTS.flatMap(shot => shot.cases).length)

    const converted = await new SofficePdfConverter().convertToPdf({
      inputPath: path.join(caseRoot, 'evidence-position.xlsx'),
      outputDirectory: path.join(caseRoot, 'pdf'),
      timeoutMs: CONVERT_TIMEOUT_MS,
    })
    expect(existsSync(converted.pdfPath)).toBe(true)
    const pages = rasterize(converted.pdfPath, path.join(caseRoot, 'ppm')).map(file => readPpm(file))

    const regionsByPage = new Map<PpmImage, PixelRegion[]>()
    for (const shot of POSITION_SHOTS) {
      const page = pageWithImage(pages, shot.rgb)
      const image = measureImage(page, shot)
      const regions = regionsByPage.get(page) ?? []
      regionsByPage.set(page, regions)
      for (const testCase of shot.cases) {
        const region = expectAnnotationDrawn(page, image, testCase)
        const isOverlapped = regions.some(other => isOverlapping(region, other))
        expect(isOverlapped, `${testCase.label} の領域が別の注記の領域と重なる`).toBe(false)
        regions.push(region)
      }
    }
    for (const [page, regions] of regionsByPage) {
      expect(countColorOutside(page, ANNOTATION_RED, 0, regions), 'どの注記の領域にも入らない赤の画素がある')
        .toBe(0)
    }
  })
})
