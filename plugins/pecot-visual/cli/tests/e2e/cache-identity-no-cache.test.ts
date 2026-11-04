// #898 US3: `--no-cache`。
// 「読まない」が全 miss として観測でき、かつ「保存は動く」ことが次の run の全ヒットとして観測できることを、
// 実 Chromium で確かめる。
// 統合テスト側は fake worker のため、実変換でも判定が同じであることは、ここでしか担保されない。
//
// 対になる「差分変換の出力 = 全変換の出力」（#897 SC-003）は、cache-identity-full-vs-diff.test.ts が見る。
// 同じ 3 枚デッキを使うが run は独立しており、別ファイルにして並列に動かせる。
// 外部 pptx モードは変換しないので対象外。
//
// timeout 階層は vitest.e2e.config.ts のコメントを基準とする。
// 階層は、it 引数 = testTimeout 660_000 > runPecotv spawnSync 600_000 = cli 内部 SLIDEV_BUILD_TIMEOUT_MS。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  assertCliBuilt,
  createPecotvRunner,
  isChromiumCached,
  lastEvent,
  missKeysOf,
  createFixtureThemeSpec,
} from '../_helpers/pecotv-e2e-run.js'
import { SLIDE_COUNT, deckMarkdown, resolveExternalPair } from '../_helpers/cache-identity.js'
import { expectConvertRouteFromEnvironment } from '../_helpers/single-pass-route.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

// hang regression を spawnSync の SIGTERM kill（600s）より手前で落とすための上限。
// 性能目標ではない。
// 並列計測（vitest.e2e.config.ts の maxWorkers 構成、N=6 の 7 run 全体から最悪を取る）で、本 CUJ 最悪は 17.3s。
// これにマージン倍率 4.4 倍（76.1s）を取り、80s へ切り上げる。
const NO_CACHE_DURATION_CEILING_MS = 80_000

const externalPair = resolveExternalPair()

const temporaryRoot = useTemporaryDirectory('pecotv-no-cache-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'cache-identity/no-cache',
  // 本ファイルの CUJ はすべて exit 0 を期待するため、0 以外はすべて一次情報を残す。
  isUnexpectedExit: status => status !== 0,
})

beforeAll(() => {
  // 外部 pptx モードでは describe が全 skip され、変換しないので dist を要求しない。
  // cache-identity-full-vs-diff.test.ts の beforeAll と対称。
  if (externalPair === undefined) assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

// Chromium cache 不在環境では skip する（cache-identity-full-vs-diff.test.ts と同じ方針）。
const isChromiumReady = isChromiumCached()

describe.skipIf(externalPair !== undefined || !isChromiumReady)('CUJ: --no-cache', () => {
  it('warm cache でも全ステップを変換し、完了時の再構築で次の run が全ヒットする', () => {
    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('no-cache-deck')
    const slidesPath = path.join(projectDirectory, 'slides.md')
    const warmOut = temporaryRoot('no-cache-warm.pptx')
    const noCacheOut = temporaryRoot('no-cache-run.pptx')
    const afterOut = temporaryRoot('no-cache-after.pptx')

    const themeSpec = createFixtureThemeSpec(temporaryRoot('theme'))
    expect(runPecotv('no-cache/create', ['slide', 'create', projectDirectory, '--theme', themeSpec]).status).toBe(0)
    writeFileSync(slidesPath, deckMarkdown('# --no-cache 2 枚目'))

    const warm = runPecotv('no-cache/warm', ['slide', 'convert', projectDirectory, '--out', warmOut, '--json'])
    expect(warm.status).toBe(0)
    expect(lastEvent(warm.stdout, 'slide.convert.done')?.cache).toMatchObject({ enabled: true, hits: 0, misses: SLIDE_COUNT })

    // 直前の run でキャッシュは埋まっている。--no-cache はそれを読まずに全ステップ変換する。
    // enabled: false と invalidated: none の組で「無効化の検知」ではなく「読まなかった」を表す。
    const noCache = runPecotv(
      'no-cache/run',
      ['slide', 'convert', projectDirectory, '--out', noCacheOut, '--no-cache', '--json'],
    )
    expect(noCache.status).toBe(0)
    const noCacheDone = lastEvent(noCache.stdout, 'slide.convert.done')
    expect(noCacheDone?.cache).toMatchObject({
      enabled: false,
      hits: 0,
      misses: SLIDE_COUNT,
      invalidated: 'none',
    })
    expect(missKeysOf(noCacheDone)).toStrictEqual(
      Array.from({ length: SLIDE_COUNT }, (_value, index) => String(index + 1)),
    )
    // 方式 assert（#1147）: --no-cache の全変換も、env が決める方式で変換している。
    expectConvertRouteFromEnvironment(noCacheDone)
    expect(existsSync(noCacheOut)).toBe(true)

    // 保存・prune・manifest 更新は通常どおり動くため、続く通常 run は全ヒットになる（FR-007）。
    const after = runPecotv('no-cache/after', ['slide', 'convert', projectDirectory, '--out', afterOut, '--json'])
    expect(after.status).toBe(0)
    const afterDone = lastEvent(after.stdout, 'slide.convert.done')
    expect(afterDone?.cache).toMatchObject({
      enabled: true,
      hits: SLIDE_COUNT,
      misses: 0,
      invalidated: 'none',
    })
    expect(missKeysOf(afterDone)).toStrictEqual([])

    const totalMs = performance.now() - itT0
    console.info(`[cache-identity/no-cache] --no-cache 合計 ${(totalMs / 1000).toFixed(1)}s (ceiling ${String(NO_CACHE_DURATION_CEILING_MS / 1000)}s)`)
    expect(totalMs).toBeLessThan(NO_CACHE_DURATION_CEILING_MS)
  }, 660_000)
})
