// Issue #922 / #923 / #924 — 生成した evidence xlsx が表計算アプリで修復なしに開けることの e2e
// (SC-005)。`pnpm test:e2e` 経由でのみ起動する。
//
// skip 判定には、「soffice が Calc ドキュメントを PDF 化できるか」を CSV で確かめる変換可能性スモークを使う。
// 生成 xlsx 自身を probe にすると、実装の欠陥をそのまま skip で隠してしまう。
// そのため、変換手段の有無だけを独立に見る。libreoffice-calc 未導入なら CSV も load 失敗する。
//
// CUJ: writeEvidenceWorkbook が生成した xlsx を soffice で PDF 化する。
// pdftotext 出力にタイトルと No.1 が現れることを確認する。
// 手組み PNG の CRC 正当性も、この流れで担保される。
//
// 注記 (#923) の欠陥クラスは、cNvPr id 重複・prstGeom / avLst 不正・txBody 構造不備。
// これらは「XPath の統合テストは通るのにアプリが読めない」形で出る。
// そのため、実レンダラを通すこの流れが、唯一の機械的な確認手段になる。
// callout の文言が PDF に現れることを成否条件にすることで、sp が読み飛ばされていないところまで見る。
//
// ヘッダー・並び順 (#924) も同様に、XML 上の順序が正しくても、レンダラ上で重なる / 逆順に出る欠陥がある。
// これは実変換でしか出ないため、この流れで縦並び順まで見る。

/* eslint-disable security/detect-non-literal-fs-filename */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { TestContext } from 'vitest'
import { afterAll, describe, expect, it } from 'vitest'

import { writeEvidenceWorkbook } from '../../src/infra/evidence-xlsx/workbook-writer.js'
import { SofficePdfConverter } from '../../src/infra/pptx-ooxml/soffice.js'
import { buildPng } from '../_helpers/image-fixture.js'
import type { PixelRegion, PpmImage } from '../_helpers/raster.js'
import { colorBounds, countColorOutside, rasterize, readPpm } from '../_helpers/raster.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const CONVERT_TIMEOUT_MS = 180_000

const temporaryRoot = useTemporaryDirectory('pecotv-922-evidence-', { hook: 'all' })
function isCommandAvailable(command: string): boolean {
  return spawnSync('which', [command], { encoding: 'utf8' }).status === 0
}

/**
注記の位置を測る画像の色。注記の赤 (FF0000)・画像枠 (BFBFBF)・帯 (1F4E79 / FFF2CC / BDD7EE)・白・黒のどれからも離してある。
*/
const POSITION_IMAGE_RGB: readonly [number, number, number] = [40, 160, 80]
const ANNOTATION_RED: readonly [number, number, number] = [0xFF, 0x00, 0x00]

/**
画像色に許す各チャネルの差。LibreOffice が画像を再サンプルしても外接矩形は動かないので小さくてよい。
*/
const POSITION_IMAGE_TOLERANCE = 2

/**
画像の表示幅 (pt)。fitToWidth=1 の A4 横 1 ページに収まる幅で、1920x1080 の縦はこの 9/16 倍の 405pt。
*/
const IMAGE_DISPLAY_WIDTH_PT = 720
const IMAGE_ASPECT = 16 / 9
/**
縦横比の許容 (比の差)。ページ分割で画像が割れていれば 16:9 から大きくずれる。外接矩形の 1〜2px は 0.01 に収まる。
*/
const ASPECT_TOLERANCE = 0.02

/**
許容 (pt)。ooxml.ts の線幅から導く。highlight / callout は枠線 2.25pt の半分。
arrow は線幅 3pt の半分に、矢尻 (w="lg" = 線幅の 5 倍 = 15pt) の半幅 7.5pt を足す。
*/
const BORDER_HALF_PT = 1.125
const ARROW_LINE_HALF_PT = 1.5
const ARROWHEAD_HALF_PT = 7.5
/**
レンダラの丸めと、画像の外接矩形が画像枠 (1.5pt の灰色) の内側で測れることによる誤差 (px)。
*/
const RENDER_MARGIN_PX = 3

/**
spec の相対座標 (0〜1) の矩形と、軸ごとの許容 (pt)。
*/
interface ExpectedRectangle {
  readonly label: string
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  readonly toleranceXPt: number
  readonly toleranceYPt: number
}

const EXPECTED_RECTANGLES: readonly ExpectedRectangle[] = [
  {
    label: 'highlight',
    minX: 0.55,
    minY: 0.55,
    maxX: 0.7,
    maxY: 0.7,
    toleranceXPt: BORDER_HALF_PT,
    toleranceYPt: BORDER_HALF_PT,
  },
  {
    // box (0.75,0.55)-(0.95,0.70) と anchor (0.85,0.74) の外接矩形。
    label: 'callout',
    minX: 0.75,
    minY: 0.55,
    maxX: 0.95,
    maxY: 0.74,
    toleranceXPt: BORDER_HALF_PT,
    toleranceYPt: BORDER_HALF_PT,
  },
  {
    // from (0.60,0.85) と to (0.90,0.80) の外接矩形。矢尻は縦に半幅ぶん出る。
    label: 'arrow',
    minX: 0.6,
    minY: 0.8,
    maxX: 0.9,
    maxY: 0.85,
    toleranceXPt: ARROW_LINE_HALF_PT,
    toleranceYPt: ARROWHEAD_HALF_PT + ARROW_LINE_HALF_PT,
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
soffice で Calc → PDF 変換ができない環境では、以降を skip する。
console.warn + return にすると pass として計上され、変換を一度も通していないことが集計から読み取れない。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- TestContext は可変
function skipWithoutCalcConversion(context: TestContext): void {
  context.skip(
    !isCalcConversionUsable,
    'soffice が Calc ドキュメントを PDF 化できる環境ではないため skip。'
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
位置のケースは、soffice の PDF 化に加えて pdftoppm が要る。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- TestContext は可変
function skipWithoutRaster(context: TestContext): void {
  context.skip(
    !isRasterUsable,
    'soffice の Calc → PDF 変換と pdftoppm が使える環境ではないため skip。'
    + ' `sudo apt-get install -y libreoffice-calc poppler-utils` を実行してから再試行してください。',
  )
}

/**
画像の色を最も多く含むページを選ぶ。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
function pageWithImage(pages: readonly PpmImage[]): PpmImage {
  const ranked = pages
    .map(page => ({ page, pixels: colorBounds(page, POSITION_IMAGE_RGB, POSITION_IMAGE_TOLERANCE).pixels }))
    .toSorted((left, right) => right.pixels - left.pixels)
  const best = ranked.at(0)
  if (best === undefined || best.pixels === 0) throw new Error('画像の色がどのページにも現れない')
  return best.page
}

afterAll(() => {
  if (temporaryRoot() !== '' && existsSync(temporaryRoot())) {
    rmSync(temporaryRoot(), { recursive: true, force: true })
  }
})

describe('生成 xlsx の soffice 変換', () => {
  it('修復なしに Calc として PDF 化でき、タイトルと No.1 が現れる', { timeout: 240_000 }, async (context) => {
    skipWithoutCalcConversion(context)

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
    skipWithoutCalcConversion(context)

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
        // 画像の右寄りに置くと PDF のページ分割で文言が切れるため、左半分に収める。
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
    skipWithoutCalcConversion(context)

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

  // 注記の位置 (#324): oneCellAnchor のオフセットはセルの寸法を超えると LibreOffice が切り詰め、
  // 右下を指す注記が左上に寄る。XML の構造テストでは出ないので、描画された赤の位置を spec の座標と比べる。
  // 右下に置いても、fitToWidth=1 で横に割れないので 1 ページに収まる。
  it('注記が spec の相対座標の指す画像上の位置に描かれる', { timeout: 240_000 }, async (context) => {
    skipWithoutRaster(context)

    const caseRoot = caseDirectory('position')
    const shot = path.join(caseRoot, '21-position.png')
    writeFileSync(shot, buildPng(1920, 1080, [...POSITION_IMAGE_RGB]))
    const out = path.join(caseRoot, 'evidence-position.xlsx')

    const result = await writeEvidenceWorkbook({
      title: '注記の位置',
      createdDate: '2026-08-17',
      extraHeaders: [],
      items: [{
        imagePath: shot,
        caption: '右下の注記',
        annotations: [
          { type: 'highlight', box: { x: 0.55, y: 0.55, w: 0.15, h: 0.15 } },
          {
            type: 'callout',
            text: '右下を指す',
            box: { x: 0.75, y: 0.55, w: 0.2, h: 0.15 },
            anchor: { x: 0.85, y: 0.74 },
          },
          { type: 'arrow', from: { x: 0.6, y: 0.85 }, to: { x: 0.9, y: 0.8 } },
        ],
      }],
    }, out)
    expect(result.annotations).toBe(3)

    const converted = await new SofficePdfConverter().convertToPdf({
      inputPath: out,
      outputDirectory: path.join(caseRoot, 'pdf'),
      timeoutMs: CONVERT_TIMEOUT_MS,
    })
    expect(existsSync(converted.pdfPath)).toBe(true)

    const pages = rasterize(converted.pdfPath, path.join(caseRoot, 'ppm')).map(file => readPpm(file))
    expect(pages.length).toBeGreaterThan(0)
    const page = pageWithImage(pages)

    const image = colorBounds(page, POSITION_IMAGE_RGB, POSITION_IMAGE_TOLERANCE)
    const imageWidth = image.maxX - image.minX + 1
    const imageHeight = image.maxY - image.minY + 1
    expect(
      Math.abs(imageWidth / imageHeight - IMAGE_ASPECT),
      `画像が 16:9 で描かれていない (${imageWidth.toString()}x${imageHeight.toString()} px)。ページ分割で画像が割れている`,
    ).toBeLessThan(ASPECT_TOLERANCE)

    const pxPerPtX = imageWidth / IMAGE_DISPLAY_WIDTH_PT
    const pxPerPtY = imageHeight / (IMAGE_DISPLAY_WIDTH_PT / IMAGE_ASPECT)
    const regions: PixelRegion[] = []
    for (const expected of EXPECTED_RECTANGLES) {
      const toleranceX = expected.toleranceXPt * pxPerPtX + RENDER_MARGIN_PX
      const toleranceY = expected.toleranceYPt * pxPerPtY + RENDER_MARGIN_PX
      const target: PixelRegion = {
        minX: image.minX + expected.minX * imageWidth,
        minY: image.minY + expected.minY * imageHeight,
        maxX: image.minX + expected.maxX * imageWidth,
        maxY: image.minY + expected.maxY * imageHeight,
      }
      const region: PixelRegion = {
        minX: Math.floor(target.minX - toleranceX),
        minY: Math.floor(target.minY - toleranceY),
        maxX: Math.ceil(target.maxX + toleranceX),
        maxY: Math.ceil(target.maxY + toleranceY),
      }
      regions.push(region)

      const red = colorBounds(page, ANNOTATION_RED, 0, region)
      expect(red.pixels, `${expected.label} の赤が期待する領域に描かれていない`).toBeGreaterThan(0)
      const edges: readonly (readonly [string, number, number, number])[] = [
        ['左', red.minX, target.minX, toleranceX],
        ['上', red.minY, target.minY, toleranceY],
        ['右', red.maxX, target.maxX, toleranceX],
        ['下', red.maxY, target.maxY, toleranceY],
      ]
      for (const [name, measured, wanted, allowed] of edges) {
        expect(
          Math.abs(measured - wanted),
          `${expected.label} の${name}端が期待位置 ${wanted.toFixed(1)} px から離れている (描画では ${measured.toString()} px)`,
        ).toBeLessThanOrEqual(allowed)
      }
    }

    expect(countColorOutside(page, ANNOTATION_RED, 0, regions), 'どの注記の領域にも入らない赤の画素がある')
      .toBe(0)
  })
})
