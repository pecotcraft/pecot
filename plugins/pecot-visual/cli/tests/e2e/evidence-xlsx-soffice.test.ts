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
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const CONVERT_TIMEOUT_MS = 180_000

const temporaryRoot = useTemporaryDirectory('pecotv-922-evidence-', { hook: 'all' })
function isCommandAvailable(command: string): boolean {
  return spawnSync('which', [command], { encoding: 'utf8' }).status === 0
}

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
})
