// Issue #1029 — 固定書式 (帯・罫線・画像枠) が実レンダラを通しても消えないことの e2e。
// `pnpm test:e2e` 経由でのみ起動する。
//
// CUJ: MCP `evidence_create` (実利用者の経由) で xlsx を生成する。
// soffice で PDF 化し、pdftoppm で全ページを画像にし、色ヒストグラムで装飾の画素が存在することを見る。
//
// この流れでしか出ない欠陥クラスは次の 3 つ。
//   - styles.xml の count / fillId / borderId のずれ。アプリが書式を通知なしに落とす。
//     XML の構造テストは通るのに、塗りが消える。
//   - 画像枠 (xdr:pic の a:ln) を描かないレンダラ。
//   - 画像が丸ごと描画されない。アンカー・rId・media パーツの不整合による。
//
// 判定の柱は 2 本ある。
//   1. 色ヒストグラム: 装飾と画像それぞれの画素が「存在する」ことだけを見る。
//      ページ分割の位置はフォント代替とスケーリングに依存して動く。
//      座標でサンプリングすると、書式が正しいまま skip でも fail でもない形で落ちる。
//      装飾色はフィクスチャ画像の RGB から離してあるので、色の一致は「装飾が描かれた」ことだけを意味する。
//   2. 帯の水平方向の幾何: 帯色の「途切れずに続く長さ」と「左端から右端までの幅」を比べる。
//      色ヒストグラムは塗りの総量しか見ない。
//      そのため、帯が内側の縦罫線で 2 分割された、帯がラベル列だけに縮んだ、といった欠陥は、
//      画素数が変わらずそのまま通ってしまう。
//      比率の閾値は置かず、設計上の等値関係だけを当てる。
//      等値関係は、帯は途切れない / 帯の右端は画像の右端以上 / 帯はページ幅に収まる。
//
// skip 判定は既存 evidence-xlsx-soffice.test.ts と同じ CSV 変換スモークに pdftoppm の
// 有無を足したもの。生成 xlsx 自身を probe にすると実装の欠陥を skip で隠す。

/* eslint-disable security/detect-non-literal-fs-filename */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import type { TestContext } from 'vitest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SofficePdfConverter } from '../../src/infra/pptx-ooxml/soffice.js'
import { buildPng } from '../_helpers/image-fixture.js'
import { CONVERT_TIMEOUT_MS, readPpm, rasterize } from '../_helpers/raster.js'
import { CLI_DIST, drainStderr, makeTransport } from '../_helpers/mcp-stdio.js'
import type { PpmImage } from '../_helpers/raster.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const REQUEST_TIMEOUT_MS = 60_000

/**
装飾ごとに必要な画素数の下限。
計測の最小は淡青のラベル塗りの 6646 px で、500 はそこから 1 桁の余裕がある。
滲みや圧縮由来の単発画素 (数 px) とは、桁で分かれる。
*/
const MINIMUM_PIXELS = 500

/**
画像色の一致に許す各チャネルの差。
LibreOffice は 300DPI 超の画像を再サンプルするため、宣言値からずれる。
3840x200 の 1 枚は、計測で赤 40・緑 80・青 200 が、青 201 になった。
装飾の塗りは vector で無変位なので、この許容は画像側にだけ与える。
*/
const IMAGE_COLOR_TOLERANCE = 2

/**
2 セルで 1 本に見せる帯の地色。幾何の assert はこの 2 色だけを対象にする。
*/
const BAND_COLORS: readonly (readonly [string, readonly [number, number, number]])[] = [
  ['タイトル帯 (1F4E79)', [0x1F, 0x4E, 0x79]],
  ['キャプション帯 (FFF2CC)', [0xFF, 0xF2, 0xCC]],
]

/**
styles.xml / drawing1.xml が塗る色。8 桁 ARGB / 6 桁 RGB の下位 6 桁と一致する。
*/
const DECORATION_COLORS: readonly (readonly [string, readonly [number, number, number]])[] = [
  ...BAND_COLORS,
  ['ヘッダー表のラベル塗り (BDD7EE)', [0xBD, 0xD7, 0xEE]],
  ['画像枠 (BFBFBF)', [0xBF, 0xBF, 0xBF]],
  ['罫線 (808080)', [0x80, 0x80, 0x80]],
  // 注記図形 (callout の枠・highlight・arrow) の線色。callout はセル書式と同じ
  // フォントを a:latin / a:ea で明示しており、その指定で図形が描画されなくなる形の
  // 退行をここで捕まえる。
  ['注記の線 (FF0000)', [0xFF, 0x00, 0x00]],
]

/**
代表セットのスクリーンショット。装飾色と取り違えないよう、フィクスチャの色は
装飾色から離した値にする (この対応は ooxml.ts のコメントと対になっている)。
*/
interface Shot {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly rgb: readonly [number, number, number]
  readonly caption: string
}

/**
全角 70 字。ラベル列 (140px) を大きく超え、帯の右へはみ出す長さ。
*/
const LONG_CAPTION
  = 'ログイン画面から管理者権限で認証を実施しダッシュボードの初期表示と通知バッジの件数が想定どおりであることを目視で確認した結果を記録する'

const SHOTS: readonly Shot[] = [
  { name: '01-login.png', width: 1920, height: 1080, rgb: [200, 40, 40], caption: LONG_CAPTION },
  { name: '02-wide.png', width: 3840, height: 200, rgb: [40, 80, 200], caption: '横長のヘッダー領域' },
  { name: '03-small.png', width: 200, height: 150, rgb: [40, 160, 80], caption: '極小のダイアログ' },
  { name: '04-tall.png', width: 400, height: 3000, rgb: [230, 230, 230], caption: '縦長の一覧' },
]

const temporaryRoot = useTemporaryDirectory('pecotv-1029-evidence-format-', { hook: 'all' })

function isCommandAvailable(command: string): boolean {
  return spawnSync('which', [command], { encoding: 'utf8' }).status === 0
}

/**
soffice が Calc を PDF 化でき、pdftoppm でラスタライズできる環境かを確かめる。
*/
async function canRenderPipelineRun(): Promise<boolean> {
  if (!isCommandAvailable('soffice') || !isCommandAvailable('pdftoppm')) return false
  const probeDirectory = mkdtempSync(path.join(tmpdir(), 'pecotv-1029-probe-'))
  try {
    const probeCsv = path.join(probeDirectory, 'probe.csv')
    writeFileSync(probeCsv, 'pecotv,probe\n1,2\n', 'utf8')
    const result = await new SofficePdfConverter().convertToPdf({
      inputPath: probeCsv,
      outputDirectory: path.join(probeDirectory, 'pdf'),
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

/**
レンダリング手段が使えない環境では skip する。
console.warn + return にすると pass として計上され、一度も描画していないことが集計から読み取れない。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- TestContext は可変
function skipWithoutRenderPipeline(context: TestContext): void {
  context.skip(
    !isRenderUsable,
    'soffice の Calc → PDF 変換と pdftoppm が使える環境ではないため skip。'
    + ' `sudo apt-get install -y libreoffice-calc poppler-utils` を実行してから再試行してください。',
  )
}

/**
全ページを通した 1 色ぶんの計測結果。
*/
interface ColorMeasurement {
  /**
  一致した画素の総数。
  */
  readonly pixels: number
  /**
  1 行の中でその色の左端から右端までが最も広い行の、その幅 (px)。
  */
  readonly widestExtent: number
  /**
  上の幅を持つ行のうち、途切れずに続く最長の連続長 (px)。
  */
  readonly longestRunAtWidestExtent: number
  /**
  その色が現れた最も右の x 座標 (px)。
  */
  readonly rightmost: number
}

/**
指定色の画素数と水平方向の広がりを全ページから測る。

`tolerance` は各チャネルの許容差。
LibreOffice は 300DPI 超の画像を再サンプルするため、画像の色は宣言値から数階調ずれる。
塗り (vector) は無変位なので、装飾色は 0 で見る。
*/
function measureColor(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は mutable 型
  rasters: readonly PpmImage[],
  rgb: readonly [number, number, number],
  tolerance = 0,
): ColorMeasurement {
  const [red, green, blue] = rgb
  let pixels = 0
  let widestExtent = 0
  let longestRunAtWidestExtent = 0
  let rightmost = -1

  for (const page of rasters) {
    for (let y = 0; y < page.height; y += 1) {
      let first = -1
      let last = -1
      let run = 0
      let longestRun = 0
      for (let x = 0; x < page.width; x += 1) {
        const offset = (y * page.width + x) * 3
        const isMatched = Math.abs((page.pixels.at(offset) ?? NaN) - red) <= tolerance
          && Math.abs((page.pixels.at(offset + 1) ?? NaN) - green) <= tolerance
          && Math.abs((page.pixels.at(offset + 2) ?? NaN) - blue) <= tolerance
        if (isMatched) {
          pixels += 1
          if (first < 0) first = x
          last = x
          run += 1
          longestRun = Math.max(longestRun, run)
        }
        else run = 0
      }
      if (first < 0) continue
      rightmost = Math.max(rightmost, last)
      const extent = last - first + 1
      if (extent > widestExtent) {
        widestExtent = extent
        longestRunAtWidestExtent = longestRun
      }
      else if (extent === widestExtent) {
        longestRunAtWidestExtent = Math.max(longestRunAtWidestExtent, longestRun)
      }
    }
  }
  return { pixels, widestExtent, longestRunAtWidestExtent, rightmost }
}

// 判定に soffice を実際に起動するため時間がかかる。ファイルの読み込み時に 1 度だけ行う。
const isRenderUsable = await canRenderPipelineRun()

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_DIST}\n先に \`pnpm build\` を実行してください`)
  }
})

afterAll(() => {
  if (temporaryRoot() !== '' && existsSync(temporaryRoot())) {
    rmSync(temporaryRoot(), { recursive: true, force: true })
  }
})

describe('固定書式のレンダリング', () => {
  it('MCP evidence_create の出力に帯・罫線・画像枠が描かれる', { timeout: 600_000 }, async (context) => {
    skipWithoutRenderPipeline(context)

    // 代表セットを 1 ブックに集約する。寸法・注記・キャプション長・extraHeaders を
    // 1 回の変換でまとめて通すことで、重い soffice 起動を 1 度に抑える。
    expect(LONG_CAPTION.length, '長キャプションの想定字数').toBeGreaterThanOrEqual(60)
    expect(LONG_CAPTION.length).toBeLessThanOrEqual(80)

    const caseRoot = temporaryRoot('format')
    mkdirSync(caseRoot, { recursive: true })
    const items = SHOTS.map((shot) => {
      const imagePath = path.join(caseRoot, shot.name)
      writeFileSync(imagePath, buildPng(shot.width, shot.height, [shot.rgb[0], shot.rgb[1], shot.rgb[2]]))
      return { imagePath, caption: shot.caption }
    })
    const specPath = path.join(caseRoot, 'spec.json')
    writeFileSync(specPath, JSON.stringify({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [
        { label: '作成者', value: 'K. Hayakawa' },
        { label: '環境', value: 'staging' },
      ],
      items: [
        {
          ...items[0],
          annotations: [
            {
              type: 'callout',
              text: 'ログインボタンを押下',
              box: { x: 0.05, y: 0.62, w: 0.3, h: 0.12 },
              anchor: { x: 0.3, y: 0.45 },
            },
            { type: 'highlight', box: { x: 0.2, y: 0.35, w: 0.2, h: 0.15 } },
          ],
        },
        ...items.slice(1),
      ],
    }), 'utf8')
    const outPath = path.join(caseRoot, 'evidence.xlsx')

    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const client = new Client({ name: 'pecotv-e2e-evidence-format', version: '0.0.0' })
    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const called = await client.callTool(
        { name: 'evidence_create', arguments: { input_path: specPath, out_path: outPath } },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      expect(called.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
    }
    finally {
      await client.close()
    }
    expect(existsSync(outPath)).toBe(true)

    const converted = await new SofficePdfConverter().convertToPdf({
      inputPath: outPath,
      outputDirectory: path.join(caseRoot, 'pdf'),
      timeoutMs: CONVERT_TIMEOUT_MS,
    })
    // soffice は load 失敗でも exit 0 を返すため、PDF の実在と非空を成否条件にする。
    expect(existsSync(converted.pdfPath)).toBe(true)
    expect(statSync(converted.pdfPath).size).toBeGreaterThan(0)

    const pages = rasterize(converted.pdfPath, path.join(caseRoot, 'ppm'))
    expect(pages.length).toBeGreaterThan(0)
    const rasters = pages.map(page => readPpm(page))

    for (const [label, rgb] of DECORATION_COLORS) {
      expect(measureColor(rasters, rgb).pixels, `${label} の画素が足りない`)
        .toBeGreaterThanOrEqual(MINIMUM_PIXELS)
    }
    // 装飾は出ているのに画像が描かれていない PDF を通さないための対照。1 枚でも
    // 欠けると落ちるよう 4 枚すべてを見る。
    for (const shot of SHOTS) {
      expect(measureColor(rasters, shot.rgb, IMAGE_COLOR_TOLERANCE).pixels, `${shot.name} が描かれていない`)
        .toBeGreaterThanOrEqual(MINIMUM_PIXELS)
    }

    // 帯の幾何。塗りの総量では捕まらない「帯が内側の縦罫線で 2 分割された」
    // 「帯がラベル列だけに縮んだ」を、閾値ではなく等値関係で当てる。
    // 1 枚目は 1920x1080 → 表示幅 960px で、帯と同じ幅に描かれるはずの画像。
    const fullWidthImage = measureColor(rasters, SHOTS[0]?.rgb ?? [0, 0, 0], IMAGE_COLOR_TOLERANCE)
    expect(fullWidthImage.longestRunAtWidestExtent).toBeGreaterThan(0)
    const pageWidth = rasters[0]?.width ?? 0
    for (const [label, rgb] of BAND_COLORS) {
      const band = measureColor(rasters, rgb)
      // 帯の内側に縦罫線が残ると、最も広い行でも連続長が幅に届かない。
      expect(band.longestRunAtWidestExtent, `${label} が途中で途切れている`)
        .toBe(band.widestExtent)
      // 帯の右端は画像の右端に揃える設計。ラベル列だけに縮むと画像幅を大きく下回る。
      expect(band.widestExtent, `${label} が画像より狭い`)
        .toBeGreaterThanOrEqual(fullWidthImage.longestRunAtWidestExtent)
      // A4 幅 1 ページの印刷設定が働いていれば帯はページ幅に収まる。
      expect(band.rightmost, `${label} がページ幅からはみ出している`)
        .toBeLessThan(pageWidth)
    }
  })
})
