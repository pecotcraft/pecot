// CUJ: 利用者が `pecotv drawio url <input> -o <out>.html` を実行し、兄弟ファイルとして
// 実描画された PNG を受け取る。
//
// 守る対象は、src/infra/drawio/screenshot.ts を実 chromium で通す処理（capturePng → viewer.diagrams.net で描いて撮る）。
// 単体・統合テストは、capturePng を DI スタブか失敗注入 env で置き換える。
// そのため、Playwright を実起動して viewer で描いた図が、PNG として出力されるところまでは、誰も見ていない。
// playwright を更新したときにこの処理が破損しても、既存テストはすべて緑のまま通る（#1061 / PR #1066 F-13）。
//
// 既存の実 chromium PNG smoke（tests/integration/commands/drawio-url.test.ts の `capturePng smoke`）は手動実行専用。
// PECOTV_PLAYWRIGHT_AVAILABLE=1 のときだけ動く。
// run-tests.sh / githooks のどの流れでも立たない。
// こちらは e2e lane の他ファイルと同じ「chromium 取得済みなら動く」判定に揃え、常用のテストで評価されるようにする。
//
// 外部依存: 本ファイルは viewer.diagrams.net と fonts.googleapis.com へ実アクセスする。
// 図の描画は diagrams.net の viewer でしか行えず、ローカルに代替が無い（製品自身が持つ依存と同じ）。
// 到達できない環境では失敗する。
// skip 条件を「chromium 未取得」に閉じているのは、ネットワーク不通を skip 条件に足すと、
// F-13 が守ろうとした処理が通知なしに評価されなくなるため。
//
// fixture はリポジトリに置かず、一時ディレクトリへ書き出す。
// 日本語 value を持つ図が警告 0 件（= exit 0）で通ることまで含めて、1 本の CUJ にする。
// そのため value と style（whiteSpace=wrap の有無）を組にして持つ必要がある。
// 既存 fixture では組み替えられない。

/* eslint-disable security/detect-non-literal-fs-filename -- 読み書きするのは mkdtemp で作った一時ディレクトリ配下のみ */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { assertCliBuilt, formatOutputTails, isChromiumCached } from '../_helpers/pecotv-e2e-run.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { durationCeilingMs } from '../_helpers/duration-ceiling.js'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_TS_ROOT, '..')
const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')

// PNG シグネチャ（8 byte）。以降に length(4) + "IHDR"(4) + width(4) + height(4) が続く。
const PNG_SIGNATURE_HEX = '89504e470d0a1a0a'
const IHDR_WIDTH_OFFSET = 16
const IHDR_HEIGHT_OFFSET = 20

// hang regression を spawnSync の SIGTERM kill より手前で落とすための上限。性能目標ではない。
// 計測は 4 run で 2.2〜2.7s（chromium 起動 + viewer 描画 + CLI 起動を含む）。
// 他の e2e ファイルと同じマージン倍率（計測比 4.4 倍）だと 12s 程度になるが、ここは採らない。
// 待ち時間の大半が viewer.diagrams.net と Web フォントの取得で、遅延の裾がリポジトリ内の計測で押さえられないため。
// 代わりに screenshot.ts が自前で持つ EXPORT_TIMEOUT_MS（60s）の外側へ置く。
// viewer が描かないケースは protocol timeout として理由付きで落ちる。
// ここまで来るのは「60s の timeout すら発火しない hang」だけになる。
const DURATION_CEILING_MS = durationCeilingMs(90_000)
const SPAWN_TIMEOUT_MS = 120_000

/**
日本語 value を持つ最小の draw.io 図。

box shape の日本語 value に `whiteSpace=wrap` が無いと、validateWhitespaceWrap が警告を出す。
結果は exit 3 になる（domain/drawio/url.ts）。
書体は常に確かめるので、全セルに fontFamily=sans-serif（本体の既定値）を付ける。
ここで見たいのは PNG 描画なので、警告要因を持たない形にして、exit 0 を素直に主張できるようにする。
*/
const JAPANESE_DIAGRAM = `<mxfile>
<diagram name="ja-minimal">
<mxGraphModel page="0" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1">
<root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="title" value="実描画の確認" style="text;html=1;whiteSpace=wrap;align=center;fontFamily=sans-serif;fontSize=24;fontColor=#4f46e5;" vertex="1" parent="1">
    <mxGeometry x="40" y="40" width="240" height="40" as="geometry"/>
  </mxCell>
  <mxCell id="box" value="日本語テキストを含む図形" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#4f46e5;fontFamily=sans-serif;" vertex="1" parent="1">
    <mxGeometry x="40" y="100" width="240" height="80" as="geometry"/>
  </mxCell>
</root>
</mxGraphModel>
</diagram>
</mxfile>
`

interface UrlDoneEvent {
  readonly event?: string
  readonly file?: string
  readonly png?: string | null
  readonly pngFailed?: boolean
  readonly warnings?: number
}

const workDirectory = useTemporaryDirectory('pecotv-drawio-png-e2e-', { hook: 'all' })

// Chromium cache 不在環境では skip する（cold ダウンロードの所要が読めず ceiling を引けない）。
// 判定は e2e lane の他ファイルと同じ共有ヘルパに寄せる。
const isChromiumReady = isChromiumCached()

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (workDirectory() !== '') rmSync(workDirectory(), { recursive: true, force: true })
})

/**
IHDR から width / height を読む。シグネチャと IHDR に届かない切り詰めは呼び出し前に弾く。
*/
function readPngSize(png: Readonly<Buffer>): { readonly width: number, readonly height: number } {
  return {
    width: png.readUInt32BE(IHDR_WIDTH_OFFSET),
    height: png.readUInt32BE(IHDR_HEIGHT_OFFSET),
  }
}

describe.skipIf(!isChromiumReady)('CUJ: drawio url が実 chromium で PNG を描画する', () => {
  it('日本語入りの図から exit 0 で PNG を書き出し、寸法を持つ PNG になる', () => {
    const inputPath = workDirectory('ja-minimal.drawio')
    const outputPath = workDirectory('ja-minimal.drawio.html')
    const expectedPngPath = workDirectory('ja-minimal.drawio.png')
    writeFileSync(inputPath, JAPANESE_DIAGRAM, 'utf8')

    const startedAt = performance.now()
    const result = spawnSync(BIN_PECOTV, ['drawio', 'url', inputPath, '-o', outputPath, '--json'], {
      // bootstrap の flock 待ちが ceiling 計測区間に乗らないよう、bootstrap をそのまま通す。
      // pecotv-e2e-run.ts の createPecotvRunner と同じ注入。
      env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' },
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    const elapsedMs = performance.now() - startedAt
    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const stderr = typeof result.stderr === 'string' ? result.stderr : ''
    console.info(`[drawio-png] url: exit=${String(result.status)} ${(elapsedMs / 1000).toFixed(1)}s`)
    // PNG 生成失敗は warn として stderr に出るだけで、exit と stdout のどちらにも理由が載らない。
    // これは commands/drawio/url.ts の pngFailed の分岐。失敗時の一次情報を残す。
    if (result.status !== 0) {
      console.error(
        `[drawio-png] 失敗 exit=${String(result.status)}\n`
        + formatOutputTails(stdout, stderr),
      )
    }

    expect(result.status, `stderr tail: ${stderr.slice(-2000)}`).toBe(0)

    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りを UrlDoneEvent に narrowing
    const done = JSON.parse(stdout.trim()) as UrlDoneEvent
    expect(done.event).toBe('drawio.url.done')
    // pngFailed を先に見る。false でなければ以降の assert より前にここで理由が分かる。
    expect(done.pngFailed, `stderr tail: ${stderr.slice(-2000)}`).toBe(false)
    expect(done.png).toBe(expectedPngPath)
    expect(done.warnings).toBe(0)

    expect(existsSync(expectedPngPath)).toBe(true)
    const png = readFileSync(expectedPngPath)
    expect(png.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE_HEX)

    // 寸法が 0 の PNG は「ヘッダだけ正しい空画像」で、viewer が図を描かずに撮った状態を素通しする。
    const { width, height } = readPngSize(png)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)

    // 描画内容が載っていることの proxy。単色の空キャンバスは圧縮後 1 KB に満たない。
    // ピクセル解凍まではしない（判定したいのは処理の生存であって描画の見た目ではない）。
    expect(png.byteLength).toBeGreaterThan(2000)

    // capturePng は撮った PNG に XML を tEXt チャンク keyword `mxfile` で埋め込む。その有無で、
    // 素の png ではなく draw.io の XML 埋め込み PNG になっていることまで固定する。
    expect(png.includes(Buffer.from('tEXtmxfile\0'))).toBe(true)

    expect(elapsedMs).toBeLessThan(DURATION_CEILING_MS)
  }, DURATION_CEILING_MS + 30_000)
})
/* eslint-enable security/detect-non-literal-fs-filename */
