// Issue #491 — InProcessSlidevPptxPipeline (subprocess 撤去後) の smoke。
// `pnpm test:e2e` からのみ起動する重いテスト。
// tests/e2e/ 配下に置くことで、vitest.config.ts の test.exclude (['tests/e2e/**']) により default test から分離される。
//
// CUJ 1: pecotv slide convert で minimal Slidev project から PPTX を生成する。
// 次の 3 点を確かめる。
//   - subprocess 方式 (`convert-slidev-to-pptx`) が cli bundle に静的に存在しない。
//   - --json event に slide.convert.done が含まれる。
//   - 出力 PPTX に ppt/slides/slide1.xml が含まれる。
//
// #1147: 変換方式（既定 = 1 パス方式 / `--no-single-pass`・`PECOTV_SINGLE_PASS=0` = 現行の方式）も
// done payload で確かめる。
// print ルートの無い deck（未同期の旧 deck 相当）が即時に現行の方式へ退避することもここで見る。

/* eslint-disable security/detect-non-literal-fs-filename */
/* eslint-disable vitest/no-disabled-tests -- context.skip() は Chromium 未 install 時の実行時 skip。
   恒久的に無効化したテストではない */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { XmldomXmlEngine } from '../../src/infra/pptx-ooxml/xml-engine.js'
import { YauzlYazlPptxArchive } from '../../src/infra/pptx-ooxml/archive.js'
import { CONTAINER_APPEAR_TIMEOUT_MS } from '../../src/infra/slidev-to-pptx/single-pass-worker.js'
import {
  expectConvertRouteFromEnvironment,
  singlePassFallbackWarnings,
} from '../_helpers/single-pass-route.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

function walkJsFiles(root: string): string[] {
  const out: string[] = []
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkJsFiles(full))
    }
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

const HERE = import.meta.dirname
const CLI_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')
const CLI_DIST = path.join(CLI_ROOT, 'dist', 'cli.js')
// fixture は元位置で実行する。
// tmp 配下にコピーすると、pnpm hoist された deps を親 traversal で resolve できない。
// その結果 slidev build が失敗する (theme-default not found)。
// 代わりに staging artifact (dist/, pptx/, index.html) を afterEach で cleanup する。
// 不変条件: この fixture (minimal-slidev) を元位置で書き換え・掃除するのは本ファイルだけに
// する。e2e ファイル間で fixture を共有してはならない — ファイル間並列実行時に一方の
// cleanup が他方の成果物を消すため、新規 e2e は専用 fixture を使うこと。
const FIXTURE_DIR = path.join(CLI_ROOT, 'tests', 'fixtures', 'minimal-slidev')
const FIXTURE_STAGING_PATHS: readonly string[] = ['dist', 'pptx', 'index.html']
/**
fixture（minimal-slidev）のステップ数。スライド 1 枚・v-click 無し
*/
const FIXTURE_STEP_COUNT = 1

const temporaryRoot = useTemporaryDirectory('pecotv-491-smoke-', { hook: 'all' })

function isChromiumCached(): boolean {
  // Playwright は PLAYWRIGHT_BROWSERS_PATH が指す場所へ install する。未設定時のみ
  // 既定の ~/.cache/ms-playwright を見る。
  const cacheRoot = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? path.join(homedir(), '.cache', 'ms-playwright')
  return existsSync(cacheRoot) && readdirSync(cacheRoot).some(entry => entry.startsWith('chromium-'))
}

const CHROMIUM_SKIP_NOTE
  = 'Playwright Chromium 未 install（`pnpm --filter @pecot/pecotv-cli exec playwright install chromium`）'

interface JsonEvent {
  readonly event?: string
  readonly warnings?: readonly string[]
  readonly cache?: Readonly<{ hits: number, misses: number }>
  readonly timings?: Readonly<{
    readonly scan?: number
    readonly phase1?: number
    readonly phase2?: number
    readonly perSlide?: readonly Readonly<{ key: string, elapsedMs: number, phases?: Readonly<{ goto: number }> }>[]
    readonly singlePass?: unknown
  }>
}

function isJsonEvent(value: unknown): value is JsonEvent {
  return typeof value === 'object' && value !== null
}

/**
stdout の JSON 行から slide.convert.done を取り出す。
*/
function doneEventOf(stdout: string): JsonEvent | undefined {
  for (const line of stdout.trim().split('\n')) {
    if (line === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isJsonEvent(parsed) && parsed.event === 'slide.convert.done') return parsed
    }
    catch {
      // ignore non-JSON lines
    }
  }
  return undefined
}

/**
出力 PPTX の `ppt/slides/slideN.xml` の件数。
*/
async function slideCountOf(pptxPath: string): Promise<number> {
  const reader = await new YauzlYazlPptxArchive().read(pptxPath)
  try {
    let count = 0
    for await (const entry of reader.entries()) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.part)) count++
    }
    return count
  }
  finally {
    await reader.close()
  }
}

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_DIST}\n先に \`npm run build\` を実行してください`)
  }
})

afterAll(() => {
  if (temporaryRoot() && existsSync(temporaryRoot())) {
    rmSync(temporaryRoot(), { recursive: true, force: true })
  }
})

afterEach(() => {
  // fixture は元位置で実行するため、staging artifact を都度 cleanup する。
  // 各 `pecotv slide convert` 呼び出しは spawnSync 経由の subprocess。
  // Playwright Chromium と in-process HTTP server は、subprocess 終了時に OS が回収する。
  // HTTP server は既定 port=0 の ephemeral bind。
  // test process 自身は browser を保持しないため、追加の close は不要。
  for (const entry of FIXTURE_STAGING_PATHS) {
    const target = path.join(FIXTURE_DIR, entry)
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
    }
  }
})

describe('Issue #491 — slidev-to-pptx in-process pipeline smoke', () => {
  it('cli/dist/ 配下の全 .js ファイルに旧 subprocess 方式 (convert-slidev-to-pptx) が含まれない', () => {
    // Step 6 で旧 sub-package を撤去し、cli は in-process pipeline 経由のみで動作する。
    // dist 任意 .js に "convert-slidev-to-pptx" 痕跡が残っていれば回帰の兆候。
    // tsc bundle ではなく per-file 出力のため commands/*.js / infra/**/*.js を walk する。
    const distributionRoot = path.dirname(CLI_DIST)
    const jsFiles = walkJsFiles(distributionRoot)
    const offenders: string[] = []
    for (const file of jsFiles) {
      const content = readFileSync(file, 'utf8')
      if (content.includes('convert-slidev-to-pptx')) {
        offenders.push(path.relative(distributionRoot, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('pecotv slide convert で minimal Slidev project から PPTX 生成 (Chromium 必須)', { timeout: 240_000 }, async (context) => {
    if (!isChromiumCached()) context.skip(CHROMIUM_SKIP_NOTE)

    // fixture は元位置で実行する (afterEach で staging artifact を cleanup)。
    // tmp コピー方式は pnpm hoist された @slidev/theme-default を親 traversal で resolve
    // できないため不可。
    const projectDirectory = FIXTURE_DIR

    const outputPath = temporaryRoot('test.pptx')
    const result = spawnSync(BIN_PECOTV, ['slide', 'convert', projectDirectory, '--out', outputPath, '--json'], {
      env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' },
      encoding: 'utf8',
      timeout: 240_000,
    })

    expect(result.status).toBe(0)
    expect(existsSync(outputPath)).toBe(true)

    const stat = statSync(outputPath)
    expect(stat.size).toBeGreaterThan(10_000)

    const stdoutLines = result.stdout.trim().split('\n').filter(Boolean)
    const events: JsonEvent[] = []
    for (const line of stdoutLines) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (isJsonEvent(parsed)) events.push(parsed)
      }
      catch {
        // ignore non-JSON lines
      }
    }
    const eventNames = events.map(event => event.event).filter(Boolean)
    // event 順序保証: slide.convert.start → slide.convert.done (失敗時は start → error)
    const startIndex = eventNames.indexOf('slide.convert.start')
    const doneIndex = eventNames.indexOf('slide.convert.done')
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(doneIndex).toBeGreaterThan(startIndex)

    // timings payload: scan / phase1 / phase2 が positive で、perSlide が array。
    // eslint-disable-next-line security/detect-object-injection -- doneIndex は indexOf 戻り値
    const doneEvent = events[doneIndex]
    expect(doneEvent?.timings).toBeDefined()
    expect(doneEvent?.timings?.scan).toBeGreaterThan(0)
    expect(doneEvent?.timings?.phase1).toBeGreaterThan(0)
    // phase2 は cli 側 merge に委譲するため、pipeline 内 phase2 timing は実体小さい
    // (>= 0 を expectation とする)
    expect(doneEvent?.timings?.phase2).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(doneEvent?.timings?.perSlide)).toBe(true)
    // 変換方式の assert（#1147）: 既定は 1 パス方式、PECOTV_SINGLE_PASS=0 なら現行の方式で変換している
    expectConvertRouteFromEnvironment(doneEvent)

    // Phase 2/3 (merge + post-process) が cli/domain/pptx-ooxml/{merge,post-process}.ts で完結したことを確認する。
    // 出力 PPTX に slide1.xml と presentation.xml が存在することを見る。
    // post-process が実施された痕跡 (transition の AlternateContent ブロック) も見る。
    const archive = new YauzlYazlPptxArchive()
    const reader = await archive.read(outputPath)
    try {
      const allEntries: string[] = []
      let slide1Buffer: Buffer | undefined
      for await (const entry of reader.entries()) {
        allEntries.push(entry.part)
        if (entry.part === 'ppt/slides/slide1.xml') {
          slide1Buffer = await entry.read()
        }
      }
      const slideEntries = allEntries.filter(part => /^ppt\/slides\/slide\d+\.xml$/.test(part))
      expect(slideEntries.length).toBeGreaterThanOrEqual(1)
      expect(slideEntries).toContain('ppt/slides/slide1.xml')
      expect(allEntries).toContain('ppt/presentation.xml')

      // post-process の痕跡として、次のどちらかの存在を確認する。
      // applyTransition が挿入する AlternateContent ブロック (mc:AlternateContent)。
      // morph/fade transition。
      // どちらも post-process が実行されたことの代表的な evidence。
      expect(slide1Buffer).toBeDefined()
      if (slide1Buffer === undefined) return
      const slide1Xml = slide1Buffer.toString('utf8')
      const engine = new XmldomXmlEngine()
      const document_ = engine.parse(slide1Buffer)
      const ns = { mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006' }
      const acBlocks = document_.selectNodes('//mc:AlternateContent', ns)
      const isXmlHasTransitionTrace = /mc:AlternateContent|<p:transition|<p159:morph|fade/i.test(slide1Xml)
      // 何らかの post-process 痕跡: AlternateContent または "fade"/"morph" 文字列の存在
      const hasPostProcessTrace = acBlocks.length > 0 || isXmlHasTransitionTrace
      expect(hasPostProcessTrace).toBe(true)
    }
    finally {
      await reader.close()
    }
  })

  it('--no-single-pass は env によらず現行の方式で全走査して変換する (Chromium 必須, #1147)', { timeout: 240_000 }, async (context) => {
    if (!isChromiumCached()) context.skip(CHROMIUM_SKIP_NOTE)

    const outputPath = temporaryRoot('no-single-pass.pptx')
    const result = spawnSync(BIN_PECOTV, ['slide', 'convert', FIXTURE_DIR, '--out', outputPath, '--json', '--no-single-pass'], {
      // option が env より優先することも同時に見る
      env: { ...process.env, PECOTV_SINGLE_PASS: '1', PECOTV_BOOTSTRAP_SKIP: '1' },
      encoding: 'utf8',
      timeout: 240_000,
    })

    expect(result.status).toBe(0)
    const doneEvent = doneEventOf(result.stdout)
    expect(doneEvent).toBeDefined()
    expect(doneEvent?.timings).not.toHaveProperty('singlePass')
    expect(singlePassFallbackWarnings(doneEvent)).toStrictEqual([])
    // 全ステップを実際に変換した run であること（staging は afterEach で消えるため全 miss になる）
    expect(doneEvent?.cache?.misses).toBe(FIXTURE_STEP_COUNT)
    const perSlide = doneEvent?.timings?.perSlide ?? []
    expect(perSlide).toHaveLength(FIXTURE_STEP_COUNT)
    // 現行の方式はステップごとにページを開くため goto に実際の値が入る（1 パス方式では 0）
    for (const entry of perSlide) expect(entry.phases?.goto).toBeGreaterThan(0)
    expect(await slideCountOf(outputPath)).toBe(FIXTURE_STEP_COUNT)
  })

  it('print ルートの無い deck は 1 パス方式を即時にやめ、warning 1 件で現行の方式に変換する (Chromium 必須, #1147)', { timeout: 240_000 }, async (context) => {
    if (!isChromiumCached()) context.skip(CHROMIUM_SKIP_NOTE)

    // fixture を tmp へ複製し、print ルートを有効にする vite 設定を除く（未同期の旧 deck 相当）。
    // 依存は fixture と同じ plugin-root の node_modules を絶対 symlink で引く（tmp からは親
    // traversal で解決できないため）。staging 生成物と fixture 固有の node_modules（.slidev の
    // 生成物）は複製しない。
    const projectDirectory = temporaryRoot('no-print-route-deck')
    cpSync(FIXTURE_DIR, projectDirectory, {
      recursive: true,
      filter: source => !['node_modules', ...FIXTURE_STAGING_PATHS].includes(path.relative(FIXTURE_DIR, source)),
    })
    for (const entry of readdirSync(projectDirectory)) {
      if (/^vite\.config\.[cm]?[jt]s$/.test(entry)) rmSync(path.join(projectDirectory, entry))
    }
    symlinkSync(path.join(PLUGIN_ROOT, '..', '..', 'node_modules'), path.join(projectDirectory, 'node_modules'), 'dir')

    // 既定（1 パス方式）を試みさせるため、外側の PECOTV_SINGLE_PASS は引き継がない
    const environment = { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' }
    Reflect.deleteProperty(environment, 'PECOTV_SINGLE_PASS')
    const outputPath = temporaryRoot('no-print-route.pptx')
    const result = spawnSync(BIN_PECOTV, ['slide', 'convert', projectDirectory, '--out', outputPath, '--json'], {
      env: environment,
      encoding: 'utf8',
      timeout: 240_000,
    })

    expect(result.status).toBe(0)
    const doneEvent = doneEventOf(result.stdout)
    expect(doneEvent).toBeDefined()
    // 退避はグループ数（K）でなく run 全体で 1 回。対処（slide_sync）を案内する
    const fallbackWarnings = singlePassFallbackWarnings(doneEvent)
    expect(fallbackWarnings).toHaveLength(1)
    expect(fallbackWarnings[0]).toContain('print ルートがありません')
    expect(fallbackWarnings[0]).toContain('slide_sync')
    expect(doneEvent?.timings?.singlePass).toHaveProperty('kind', 'printRouteMissing')
    expect(doneEvent?.timings?.singlePass).toHaveProperty('fallback', 'デッキの build に print ルートがありません')
    // `#page-root` の出現で即時に判定する。判定の時間切れ（5 s）を待つ形に戻る退行を弾く
    const singlePass = doneEvent?.timings?.singlePass
    const detectMs = typeof singlePass === 'object' && singlePass !== null && 'detectMs' in singlePass ? singlePass.detectMs : undefined
    expect(detectMs).toBeTypeOf('number')
    expect(detectMs).toBeLessThan(CONTAINER_APPEAR_TIMEOUT_MS)
    expect(await slideCountOf(outputPath)).toBe(FIXTURE_STEP_COUNT)
  })
})
