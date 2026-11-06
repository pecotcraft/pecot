// CUJ: 利用者が `pecotv drawio export <input> --icons <dir> -o <out>.svg` を実行する。
// SVG と、兄弟ファイルの PDF（拡張子を .pdf に置換）を受け取る。
//
// 守る対象は、src/infra/drawio/pdf.ts を実 chromium で通す処理。
// exportViaEmbed で得た SVG を、ローカル chromium で 1 ページの PDF に印刷する。
// 単体・統合テストは playwright を vi.mock か DI スタブで置き換える。
// そのため、実際に PDF が 1 ページで、SVG の寸法どおりの用紙で出ているかは、誰も見ていない。
// A4 フォールバックや、空白の 2 ページ目が付いていないかも同様。
//
// 外部依存: SVG は embed.diagrams.net へ実アクセスして得る（drawio-png-chromium.test.ts と同じ）。
// skip 条件を「chromium 未取得」に閉じ、ネットワーク不通は skip しない。
// 不通を skip 条件に足すと、この流れが通知なしに評価されなくなるため。
//
// fixture はリポジトリに置かず一時ディレクトリへ書き出す。PDF から日本語ラベルが文字として
// 抽出できること（ベクタのまま印刷されていること）まで見るため、日本語 value を持つ図が要る。
// 両セルの書体は v-drawio の DESIGN.md が利用者の図に指定する並びと同じにし、日本語が
// Noto Sans CJK JP で描かれることまで見る。

/* eslint-disable security/detect-non-literal-fs-filename -- 読み書きするのは mkdtemp で作った一時ディレクトリ配下のみ */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertCliBuilt, BIN_PECOTV, formatOutputTails, isChromiumCached } from '../_helpers/pecotv-e2e-run.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { durationCeilingMs } from '../_helpers/duration-ceiling.js'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_TS_ROOT, '..')
const ICONS_DIR = path.join(PLUGIN_ROOT, 'assets', 'drawio-icons')

// hang regression を spawnSync の kill より手前で落とすための上限。性能目標ではない。
// pdf.ts / screenshot.ts が自前で持つ 60s の timeout の外側に置く（drawio-png-chromium.test.ts と同じ）。
const DURATION_CEILING_MS = durationCeilingMs(90_000)
const SPAWN_TIMEOUT_MS = 120_000

/**
CSS px を PDF の pt に換算する係数（96 dpi → 72 pt/inch）。
*/
const PT_PER_PX = 0.75
/**
Chromium は用紙寸法を丸めるため px×0.75 と厳密一致しない。A4 フォールバックを弾ける幅で許す。
*/
const MEDIA_BOX_TOLERANCE_PT = 1

const TITLE_LABEL = '実描画の確認'
const BOX_LABEL = '日本語テキストを含む図形'
const FONT_FAMILY = 'Inter, Noto Sans JP, sans-serif'
/**
pdffonts が表示する埋め込みフォント名（サブセット接頭辞 `XXXXXX+` の後ろ）に含まれる語。
*/
const CJK_FONT_NAME = 'NotoSansCJKjp'

const JAPANESE_DIAGRAM = `<mxfile>
<diagram name="ja-minimal">
<mxGraphModel page="0" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1">
<root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="title" value="${TITLE_LABEL}" style="text;html=1;whiteSpace=wrap;align=center;fontFamily=${FONT_FAMILY};fontSize=24;fontColor=#4f46e5;" vertex="1" parent="1">
    <mxGeometry x="40" y="40" width="240" height="40" as="geometry"/>
  </mxCell>
  <mxCell id="box" value="${BOX_LABEL}" style="rounded=1;whiteSpace=wrap;html=1;fontFamily=${FONT_FAMILY};fillColor=#ffffff;strokeColor=#4f46e5;" vertex="1" parent="1">
    <mxGeometry x="40" y="100" width="240" height="80" as="geometry"/>
  </mxCell>
</root>
</mxGraphModel>
</diagram>
</mxfile>
`

interface ExportDoneEvent {
  readonly event?: string
  readonly file?: string
  readonly pdf?: string | null
  readonly pdfFailed?: boolean
  readonly warnings?: number
}

interface ExportRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMs: number
}

const workDirectory = useTemporaryDirectory('pecotv-drawio-pdf-e2e-', { hook: 'all' })

// Chromium cache 不在環境では skip する（e2e lane の他ファイルと同じ共有ヘルパ）。
const isChromiumReady = isChromiumCached()

function isCommandAvailable(command: string): boolean {
  return spawnSync('which', [command], { encoding: 'utf8' }).status === 0
}

/**
実行ホストに Noto Sans CJK JP が入っているか。無い環境では Chromium が別の書体へ落ちる。
*/
function hasNotoSansCjkJp(): boolean {
  const listed = spawnSync('fc-list', [':family=Noto Sans CJK JP'], { encoding: 'utf8' })
  return listed.status === 0 && listed.stdout.trim() !== ''
}

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (workDirectory() !== '') rmSync(workDirectory(), { recursive: true, force: true })
})

/**
図を書き出して `drawio export ... --json` を実行する。
*/
function runExport(name: string, environment: Readonly<Record<string, string>> = {}): ExportRun {
  const caseDirectory = workDirectory(name)
  const inputPath = path.join(caseDirectory, 'ja-minimal.drawio')
  const outputPath = path.join(caseDirectory, 'out.svg')
  rmSync(caseDirectory, { recursive: true, force: true })
  mkdirSync(caseDirectory, { recursive: true })
  writeFileSync(inputPath, JAPANESE_DIAGRAM, 'utf8')

  const startedAt = performance.now()
  const result = spawnSync(
    BIN_PECOTV,
    ['drawio', 'export', inputPath, '--icons', ICONS_DIR, '-o', outputPath, '--json'],
    {
      // bootstrap の flock 待ちが ceiling 計測区間に乗らないよう、bootstrap をそのまま通す。
      env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1', ...environment },
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  const elapsedMs = performance.now() - startedAt
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  console.info(`[drawio-pdf] ${name}: exit=${String(result.status)} ${(elapsedMs / 1000).toFixed(1)}s`)
  return { status: result.status, stdout, stderr, elapsedMs }
}

function parseDone(stdout: string): ExportDoneEvent {
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りを ExportDoneEvent に narrowing
  return JSON.parse(stdout.trim()) as ExportDoneEvent
}

/**
SVG ルート要素の width / height（px）を読む。製品側の readSvgPixelSize とは独立に判定する。
*/
function readSvgSize(svg: string): { readonly width: number, readonly height: number } {
  const rootTag = /<svg\b[^>]*>/.exec(svg)?.[0] ?? ''
  const width = Number(/\swidth="(?<value>[\d.]+)px"/.exec(rootTag)?.groups?.['value'])
  const height = Number(/\sheight="(?<value>[\d.]+)px"/.exec(rootTag)?.groups?.['value'])
  return { width, height }
}

/**
PDF 本文から MediaBox を読む（Chromium の PDF は page 辞書を平文で持つ）。
*/
function readMediaBoxes(pdf: string): readonly (readonly number[])[] {
  return pdf.matchAll(/\/MediaBox\s*\[(?<box>[^\]]*)\]/g)
    .map(match => (match.groups?.['box'] ?? '').trim().split(/\s+/).map(Number)).toArray()
}

describe.skipIf(!isChromiumReady)('CUJ: drawio export が実 chromium で SVG と兄弟 PDF を書き出す', () => {
  // pdftotext の CUJ が同じ成果物を読むため、成功ケースの出力パスを共有する。
  let successPdfPath = ''

  it('日本語入りの図から exit 0 で SVG と 1 ページの PDF を書き出す', () => {
    const run = runExport('success')
    if (run.status !== 0) {
      console.error(`[drawio-pdf] 失敗 exit=${String(run.status)}\n${formatOutputTails(run.stdout, run.stderr)}`)
    }
    expect(run.status, `stderr tail: ${run.stderr.slice(-2000)}`).toBe(0)

    const caseDirectory = workDirectory('success')
    const svgPath = path.join(caseDirectory, 'out.svg')
    const pdfPath = path.join(caseDirectory, 'out.pdf')
    const done = parseDone(run.stdout)
    expect(done.event).toBe('drawio.export.done')
    expect(done.pdfFailed, `stderr tail: ${run.stderr.slice(-2000)}`).toBe(false)
    expect(done.file).toBe(svgPath)
    expect(path.isAbsolute(String(done.pdf))).toBe(true)
    expect(done.pdf).toBe(pdfPath)
    expect(done.warnings).toBe(0)

    expect(existsSync(svgPath)).toBe(true)
    expect(existsSync(pdfPath)).toBe(true)
    const pdfBytes = readFileSync(pdfPath)
    expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    const pdf = pdfBytes.toString('latin1')
    // `/Pages` を拾わないよう語境界で切る。空白の 2 ページ目が付く回帰をここで検出する。
    expect(pdf.match(/\/Type\s*\/Page\b/g) ?? []).toHaveLength(1)

    const size = readSvgSize(readFileSync(svgPath, 'utf8'))
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)
    const boxes = readMediaBoxes(pdf)
    expect(boxes).toHaveLength(1)
    const [x0 = NaN, y0 = NaN, x1 = NaN, y1 = NaN] = boxes[0] ?? []
    // 寸法が読めずに既定の A4（595×842 pt）で出た場合をここで弾く。
    expect(Math.abs((x1 - x0) - size.width * PT_PER_PX)).toBeLessThanOrEqual(MEDIA_BOX_TOLERANCE_PT)
    expect(Math.abs((y1 - y0) - size.height * PT_PER_PX)).toBeLessThanOrEqual(MEDIA_BOX_TOLERANCE_PT)

    expect(run.elapsedMs).toBeLessThan(DURATION_CEILING_MS)
    successPdfPath = pdfPath
  }, DURATION_CEILING_MS + 30_000)

  it.skipIf(!isCommandAvailable('pdftotext'))('書き出した PDF から日本語ラベルが文字として抽出できる', () => {
    expect(successPdfPath, '成功ケースの PDF が無い（先行 it の失敗を参照）').not.toBe('')
    const extracted = spawnSync('pdftotext', [successPdfPath, '-'], { encoding: 'utf8' })
    expect(extracted.status, `pdftotext stderr: ${extracted.stderr}`).toBe(0)
    // pdftotext は折り返し位置で改行を入れるため、空白を除いてから比較する。
    const text = extracted.stdout.replaceAll(/\s+/g, '')
    expect(text).toContain(TITLE_LABEL)
    expect(text).toContain(BOX_LABEL)
  })

  it.skipIf(!isCommandAvailable('pdffonts') || !hasNotoSansCjkJp())('日本語ラベルは Noto Sans CJK JP を埋め込んで描かれる', () => {
    expect(successPdfPath, '成功ケースの PDF が無い（先行 it の失敗を参照）').not.toBe('')
    const listed = spawnSync('pdffonts', [successPdfPath], { encoding: 'utf8' })
    expect(listed.status, `pdffonts stderr: ${listed.stderr}`).toBe(0)
    // 1, 2 行目は見出しと罫線。各行の先頭列がフォント名。
    const fontNames = listed.stdout.split('\n').slice(2).map(line => line.split(/\s+/, 1)[0] ?? '').filter(name => name !== '')
    expect(fontNames.some(name => name.includes(CJK_FONT_NAME)), `pdffonts:\n${listed.stdout}`).toBe(true)
  })

  it('PDF 生成に失敗すると SVG を残して exit 3 で degrade する', () => {
    const run = runExport('degrade', { PECOTV_FORCE_PDF_FAIL: '1' })
    // --json の失敗理由（SVG export の時間切れ等）は stdout に出るため、stderr と並べて残す。
    expect(run.status, `stdout tail: ${run.stdout.slice(-2000)}\nstderr tail: ${run.stderr.slice(-2000)}`).toBe(3)

    const caseDirectory = workDirectory('degrade')
    const done = parseDone(run.stdout)
    expect(done.event).toBe('drawio.export.done')
    expect(done.pdfFailed).toBe(true)
    // eslint-disable-next-line unicorn/no-null -- JSON の契約が `pdf: null`
    expect(done.pdf).toBe(null)
    expect(done.warnings).toBe(1)
    expect(run.stderr).toContain('[warn] PDF 生成失敗')
    expect(existsSync(path.join(caseDirectory, 'out.svg'))).toBe(true)
    expect(existsSync(path.join(caseDirectory, 'out.pdf'))).toBe(false)

    expect(run.elapsedMs).toBeLessThan(DURATION_CEILING_MS)
  }, DURATION_CEILING_MS + 30_000)
})
/* eslint-enable security/detect-non-literal-fs-filename */
