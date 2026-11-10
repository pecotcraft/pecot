// Issue #971 — routerMode: hash のデッキを変換する場合の e2e。
// `pnpm test:e2e` からのみ起動する重いテスト（実 slidev build + Playwright Chromium）。
//
// hash ルータの URL は `#/2` にクリック数を付けた形になる。
// これを pathname / searchParams だけで解析すると、全ステップが slide 1 / click null にまとまる。
// すると stepIndex が衝突して、1 枚の PPTX を上書きし続ける。
// ステップ数がそのまま出力スライド数に現れるため、
// `ppt/slides/slideN.xml` の件数でこの不具合を直接検出できる。
// 1 スライドの minimal-slidev では衝突が起きず検出できないため、専用 fixture を使う。
//
// 件数だけでは「ファイル名は複数で、中身は全部スライド 1」の状態を見逃す。
// そのため各 slideN.xml のテキストが、fixture のスライド固有文字列とどう分布するかまで確かめる。
//
// urlFormat（hash / history）の判定値は full scan だけでなく onlySteps / onlySlide の
// URL 組み立てでも消費される。CLI 経由の full scan がビルドした dist をそのまま使い回し、
// convertToPptx を直接呼ぶ形で、残り 2 つの URL 組み立ても実デッキで確かめる。

/* eslint-disable security/detect-non-literal-fs-filename */
/* eslint-disable vitest/no-disabled-tests -- context.skip() は Chromium 未 install 時の実行時 skip。
   恒久的に無効化したテストではない */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Logger } from '../../src/domain/slidev-to-pptx/logger.js'
import type { PipelineConfig } from '../../src/domain/slidev-to-pptx/config.js'
import { convertToPptx } from '../../src/infra/slidev-to-pptx/pipeline.js'
import { YauzlYazlPptxArchive } from '../../src/infra/pptx-ooxml/archive.js'
import { formatOutputTails } from '../_helpers/pecotv-e2e-run.js'
import { expectConvertRouteFromEnvironment } from '../_helpers/single-pass-route.js'
import { compareStrings } from '../../src/domain/_shared/compare-strings.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const HERE = import.meta.dirname
const CLI_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')
const CLI_DIST = path.join(CLI_ROOT, 'dist', 'cli.js')
// fixture は元位置で実行する（tmp コピーは pnpm hoist された deps を解決できない）。
// 不変条件: この fixture (hash-slidev) を元位置で書き換え・掃除するのは本ファイルだけに
// する。e2e ファイル間で fixture を共有してはならない — ファイル間並列実行時に一方の
// cleanup が他方の成果物を消すため、新規 e2e は専用 fixture を使うこと。
const FIXTURE_DIR = path.join(CLI_ROOT, 'tests', 'fixtures', 'hash-slidev')
const FIXTURE_DIST = path.join(FIXTURE_DIR, 'dist')
// staging artifact は beforeAll と afterAll で消す。afterEach で消すと full scan がビルドした
// dist が失われ、後続の onlySteps / onlySlide が再ビルドを強いられる。
// `pptx/cache` は convert のキャッシュで run をまたいで残る。途中で止まった run が残すと、
// full scan がキャッシュに当たって変換せず、変換したことを前提にした確認が落ちる。
const FIXTURE_STAGING_PATHS: readonly string[] = ['dist', 'pptx', 'index.html']

function removeFixtureStaging(): void {
  for (const entry of FIXTURE_STAGING_PATHS) {
    rmSync(path.join(FIXTURE_DIR, entry), { recursive: true, force: true })
  }
}

// fixture の 3 スライド + スライド 2 の click 1 段。ArrowRight 走査で 4 ステップになる。
const EXPECTED_STEP_KEYS: readonly string[] = ['1', '2', '2/1', '3']

// fixture の各スライド見出し。空白除去した形で slideN.xml のテキストと比べる
// （PPTX のテキストは複数の `<a:t>` run に割れることがあるため）。
const SLIDE_MARKERS = { one: 'HashOne', two: 'HashTwo', three: 'HashThree' } satisfies Readonly<Record<string, string>>

const temporaryRoot = useTemporaryDirectory('pecotv-971-hash-', { hook: 'all' })

function isChromiumCached(): boolean {
  // Playwright は PLAYWRIGHT_BROWSERS_PATH が指す場所へ install する。未設定時のみ
  // 既定の ~/.cache/ms-playwright を見る。
  const cacheRoot = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? path.join(homedir(), '.cache', 'ms-playwright')
  return existsSync(cacheRoot) && readdirSync(cacheRoot).some(entry => entry.startsWith('chromium-'))
}

const CHROMIUM_SKIP_NOTE
  = 'Playwright Chromium 未 install（`pnpm --filter @pecot/pecotv-cli exec playwright install chromium`）'

interface DoneEvent {
  readonly event?: string
  readonly errors?: readonly unknown[]
  readonly warnings?: readonly string[]
  readonly timings?: Readonly<{
    readonly perSlide?: readonly Readonly<{ key: string }>[]
    readonly singlePass?: unknown
  }>
}

function parseJsonEvents(stdout: string): DoneEvent[] {
  const events: DoneEvent[] = []
  for (const line of stdout.trim().split('\n')) {
    if (line === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) events.push(parsed)
    }
    catch {
      // ignore non-JSON lines
    }
  }
  return events
}

function discardLog(): void {
  // 変換ログは e2e の出力を埋めるだけなので捨てる
}

/**
info ログを配列に溜める Logger。ルータ判定の結果を assert するために使う。
*/
function capturingLogger(): { logger: Logger, infos: string[] } {
  const infos: string[] = []
  const logger: Logger = {
    info: (...arguments_) => { infos.push(arguments_.map(String).join(' ')) },
    verbose: discardLog,
    debug: discardLog,
    warn: discardLog,
    error: discardLog,
  }
  return { logger, infos }
}

function programmaticConfig(outputDirectory: string): PipelineConfig {
  return {
    presDir: FIXTURE_DIR,
    templatePath: FIXTURE_DIST,
    outputDir: outputDirectory,
    slidePrefix: 'slide-',
    port: 0,
    // eslint-disable-next-line unicorn/no-null -- onlySlide 未指定は null で表す (PipelineConfig の仕様)
    onlySlide: null,
    concurrency: 2,
    logLevel: 'normal',
    skipPostprocess: true,
  }
}

/**
PPTX の各 `ppt/slides/slideN.xml` について、`<a:t>` run を連結し空白を除いた
テキストを返す。part 名の連番順にソートして返す。
*/
async function slideTexts(pptxPath: string): Promise<string[]> {
  const archive = new YauzlYazlPptxArchive()
  const reader = await archive.read(pptxPath)
  try {
    const parts: { index: number, text: string }[] = []
    for await (const entry of reader.entries()) {
      const matched = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.part)
      if (!matched) continue
      const buffer = await entry.read()
      const xml = buffer.toString('utf8')
      const runs = xml.matchAll(/<a:t>([^<]*)<\/a:t>/g).map(m => m[1] ?? '').toArray()
      parts.push({ index: Number(matched[1]), text: runs.join('').replaceAll(/\s+/g, '') })
    }
    return parts.toSorted((a, b) => a.index - b.index).map(part => part.text)
  }
  finally {
    await reader.close()
  }
}

/**
単一ステップの PPTX（Phase 1 出力）のテキスト。
*/
async function stepText(slidesDirectory: string, stepIndex: number): Promise<string> {
  const pptxPath = path.join(slidesDirectory, `slide-${stepIndex.toString()}.pptx`)
  expect(existsSync(pptxPath), `${pptxPath} が生成されていません`).toBe(true)
  const texts = await slideTexts(pptxPath)
  return texts.join('')
}

/**
full scan がビルドした dist を後続テストが使えることを保証する。
*/
function requireFixtureDistribution(): void {
  if (!existsSync(FIXTURE_DIST)) {
    throw new Error(
      `fixture の dist が存在しません: ${FIXTURE_DIST}\n`
      + '先行する full scan テストがビルドを残していません（単体実行なら full scan と同時に実行してください）',
    )
  }
}

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_DIST}\n先に \`npm run build\` を実行してください`)
  }
  removeFixtureStaging()
})

afterAll(() => {
  if (temporaryRoot() && existsSync(temporaryRoot())) {
    rmSync(temporaryRoot(), { recursive: true, force: true })
  }
  removeFixtureStaging()
})

describe('Issue #971 — routerMode: hash デッキの PPTX 変換', () => {
  it('full scan: 全ステップが個別スライドとして出力される (Chromium 必須)', { timeout: 240_000 }, async (context) => {
    if (!isChromiumCached()) context.skip(CHROMIUM_SKIP_NOTE)

    const outputPath = temporaryRoot('hash.pptx')
    const result = spawnSync(BIN_PECOTV, ['slide', 'convert', FIXTURE_DIR, '--out', outputPath, '--json', '--log-level', 'verbose'], {
      env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' },
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024,
    })

    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const stderr = typeof result.stderr === 'string' ? result.stderr : ''
    // 異常終了は一次情報（--json の失敗理由が載る stdout と stderr）が無いと原因を特定できない。
    // spawnSync timeout（status null）と cli の異常終了（非 0）のどちらでも tail を残す。
    if (result.status !== 0) {
      console.error(
        `[hash-router] slide convert 失敗: exit=${String(result.status)}\n`
        + formatOutputTails(stdout, stderr),
      )
    }
    expect(result.status).toBe(0)
    expect(existsSync(outputPath)).toBe(true)

    // stale dist 由来の false pass を防ぐ: hash と判定できていない run は不合格。
    // 進捗の行は --log-level verbose のとき stderr に note: で出る。
    expect(stderr).toContain('note: router detection: router=hash')

    const events = parseJsonEvents(stdout)
    const doneEvent = events.find(event => event.event === 'slide.convert.done')
    expect(doneEvent).toBeDefined()
    expect(doneEvent?.errors).toStrictEqual([])
    // 変換方式の assert（#1147）: hash ルータのデッキも、既定は 1 パス方式（print ルート）で変換する。
    // PECOTV_SINGLE_PASS=0 なら現行の方式で変換している
    expectConvertRouteFromEnvironment(doneEvent)
    const stepKeys = (doneEvent?.timings?.perSlide ?? []).map(entry => entry.key)
    expect(stepKeys.toSorted(compareStrings)).toStrictEqual([...EXPECTED_STEP_KEYS].toSorted(compareStrings))

    // マージ後の PPTX のスライド数がステップ数と一致すること。hash の解析に失敗すると、
    // stepIndex が全件衝突して 1 枚にまとまるため、ここが直接の検出点になる。
    const texts = await slideTexts(outputPath)
    expect(texts).toHaveLength(EXPECTED_STEP_KEYS.length)

    // 件数だけでは「4 枚とも中身はスライド 1」を見逃す。fixture の見出しの分布で中身を確かめる。
    // 期待は slide 1 が 1 枚、slide 2 が 2 枚（click 前後）、slide 3 が 1 枚。
    expect(texts.filter(text => text.includes(SLIDE_MARKERS.one))).toHaveLength(1)
    expect(texts.filter(text => text.includes(SLIDE_MARKERS.two))).toHaveLength(2)
    expect(texts.filter(text => text.includes(SLIDE_MARKERS.three))).toHaveLength(1)
  })

  it('onlySteps: 指定スライドだけを hash URL で変換する (Chromium 必須)', { timeout: 240_000 }, async (context) => {
    if (!isChromiumCached()) context.skip(CHROMIUM_SKIP_NOTE)
    requireFixtureDistribution()

    const { logger, infos } = capturingLogger()
    const result = await convertToPptx(
      { ...programmaticConfig(temporaryRoot('only-steps')), onlySteps: [2, 3] },
      { logger },
    )

    expect(infos).toContain('router detection: router=hash')
    expect(result.errors).toStrictEqual([])
    expect(result.slideCount).toBe(2)
    expect(Object.keys(result.timing.perSlide).toSorted(compareStrings)).toStrictEqual(['2', '3'])

    // stepIndex = slideNumber * 100（clickStep null）。ファイル名だけでなく中身も確認する。
    expect(await stepText(result.slidesDirectory, 200)).toContain(SLIDE_MARKERS.two)
    expect(await stepText(result.slidesDirectory, 300)).toContain(SLIDE_MARKERS.three)
  })

  it('onlySlide: click 段を走査して該当スライドの全ステップを変換する (Chromium 必須)', { timeout: 240_000 }, async (context) => {
    if (!isChromiumCached()) context.skip(CHROMIUM_SKIP_NOTE)
    requireFixtureDistribution()

    const { logger, infos } = capturingLogger()
    const result = await convertToPptx(
      // eslint-disable-next-line unicorn/no-null -- OnlySlideSpec.click は click 未指定を null で表す
      { ...programmaticConfig(temporaryRoot('only-slide')), onlySlide: { slide: 2, click: null } },
      { logger },
    )

    expect(infos).toContain('router detection: router=hash')
    expect(result.errors).toStrictEqual([])
    // fixture のスライド 2 は v-click 1 段。走査で `2` と `2/1` の 2 ステップになる。
    expect(Object.keys(result.timing.perSlide).toSorted(compareStrings)).toStrictEqual(['2', '2/1'])
    expect(result.slideCount).toBe(2)

    // clickStep null → 200、clickStep 1 → 201。どちらもスライド 2 の中身であること。
    expect(await stepText(result.slidesDirectory, 200)).toContain(SLIDE_MARKERS.two)
    expect(await stepText(result.slidesDirectory, 201)).toContain(SLIDE_MARKERS.two)
  })
})
