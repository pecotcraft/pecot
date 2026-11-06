// #931 CUJ-A: 掃除が throw する manifest 破損（分岐 3 = all:error）が実 CLI の
// `--json` payload から観測できることの機械検証。
//
// 単体・統合テストは fake worker / DI 注入でこの流れを踏む。
// 実 CLI では、「そもそも cache-store がその errno で throw するか」「done payload に載るか」を通していない。
// ここは、実 slidev build + 実 Chromium を通した流れだけを見る。
//
// 警告の注入は fs の状態だけで行い、権限（chmod / root 実行の差）に依存させない。
// 具体的には `cache/slide-<N>.pptx` を同名ディレクトリに置換する。
// すると clearOrphanedCacheArtifacts の `rm`（recursive なし）が EISDIR で throw する。
//
// 文言 assert は errno を含まない接頭辞一致にする（メッセージ末尾は環境依存）。
//
// 保存・更新の失敗（all:manifest）は cache-warning-save-failure.test.ts が見る。
// 変換後に失敗した run の error payload は、cache-warning-merge-failure.test.ts が見る。
// 3 CUJ は独立した mkdtemp project を使い、別ファイルで並列に動く。
//
// timeout 階層は vitest.e2e.config.ts のコメントを基準とする。
// 階層は、it 引数 = testTimeout 660_000 > runPecotv spawnSync 600_000 = cli 内部 SLIDEV_BUILD_TIMEOUT_MS。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  assertCliBuilt,
  createPecotvRunner,
  isChromiumCached,
  lastEvent,
  warningsStartingWith,
  createFixtureThemeSpec,
} from '../_helpers/pecotv-e2e-run.js'
import {
  CACHE_UNUSABLE_PREFIX,
  MANIFEST_INVALID_PREFIX,
  SLIDE_COUNT,
  cacheDirectoryOf,
  deckMarkdown,
} from '../_helpers/cache-warning.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { durationCeilingMs } from '../_helpers/duration-ceiling.js'

// hang regression を spawnSync の SIGTERM kill（600s）より手前で落とすための上限。
// 性能目標ではない。
// 並列計測（vitest.e2e.config.ts の maxWorkers 構成、N=6 の 7 run 全体から最悪を取る）で、本 CUJ 最悪は 13.8s。
// これにマージン倍率 4.4 倍（60.7s）を取り、62s へ切り上げる。
const TWO_CONVERT_CEILING_MS = durationCeilingMs(62_000)

const temporaryRoot = useTemporaryDirectory('pecotv-cache-warning-a-', { hook: 'all' })
const projectDirectory = (): string => temporaryRoot('cache-warning-deck')

const runPecotv = createPecotvRunner({
  logPrefix: 'cache-warning/cleanup',
  // 本ファイルの CUJ は exit 0 を期待するため、0 以外はすべて一次情報を残す。
  isUnexpectedExit: status => status !== 0,
})

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

// Chromium cache 不在環境では skip する（cache-identity 系と同じ方針。cold ダウンロードの
// 所要時間が読めず、本テストは 2 回の変換で既に重い）。
const isChromiumReady = isChromiumCached()

describe.skipIf(!isChromiumReady)('CUJ: キャッシュ系警告が --json payload から観測できる', () => {
  it('CUJ-A: 掃除が throw する manifest 破損は done payload に警告 2 件 + all:error として出る', () => {
    const itT0 = performance.now()
    const warmOut = temporaryRoot('warning-warm.pptx')
    const brokenOut = temporaryRoot('warning-broken.pptx')
    const convertArguments = (out: string): readonly string[] =>
      ['slide', 'convert', projectDirectory(), '--out', out, '--json']

    // 追跡下の fixture を書き換えないよう mkdtemp 配下へ `slide create` する。
    // create が plugin-root の node_modules への symlink を張るので tmp でも build が通る。
    const themeSpec = createFixtureThemeSpec(temporaryRoot('theme'))
    expect(runPecotv('create', ['slide', 'create', projectDirectory(), '--theme', themeSpec]).status).toBe(0)
    writeFileSync(path.join(projectDirectory(), 'slides.md'), deckMarkdown())

    // 1. キャッシュ生成。ここで cache/manifest.json と cache/slide-<N>.pptx が揃う。
    const warm = runPecotv('warm', convertArguments(warmOut))
    expect(warm.status).toBe(0)
    expect(lastEvent(warm.stdout, 'slide.convert.done')?.cache).toMatchObject({
      enabled: true,
      hits: 0,
      misses: SLIDE_COUNT,
    })

    // 2. manifest を破損させ、掃除対象の成果物 1 件をディレクトリへ置換する。
    //    clearOrphanedCacheArtifacts の rm（recursive なし）が EISDIR で throw する。
    //    その結果、readCacheState の途中から pipeline の外側 catch（分岐 3）へ抜ける。
    const cacheDirectory = cacheDirectoryOf(projectDirectory())
    writeFileSync(path.join(cacheDirectory, 'manifest.json'), '{')
    const artifactPath = path.join(cacheDirectory, 'slide-100.pptx')
    expect(existsSync(artifactPath)).toBe(true)
    rmSync(artifactPath, { force: true })
    mkdirSync(artifactPath, { recursive: true })

    const broken = runPecotv('broken-cleanup', convertArguments(brokenOut))
    // キャッシュ由来の失敗で変換自体は落とさない（SC-004）
    expect(broken.status).toBe(0)
    expect(existsSync(brokenOut)).toBe(true)

    const done = lastEvent(broken.stdout, 'slide.convert.done')
    expect(done).toBeDefined()
    // 掃除より前に積んだ manifest 警告と、退避の理由である外側 catch の警告が両方残る
    expect(warningsStartingWith(done?.warnings, MANIFEST_INVALID_PREFIX)).toHaveLength(1)
    expect(warningsStartingWith(done?.warnings, CACHE_UNUSABLE_PREFIX)).toHaveLength(1)
    // enabled: false は --no-cache と同じ表示になるため、退避の理由は invalidated で区別する
    expect(done?.cache).toMatchObject({ enabled: false, invalidated: 'all:error' })
    // 変換エラーは無い。フィールド不在（旧版）と区別するため空配列であることまで見る (#949)
    expect(done?.errors).toStrictEqual([])

    const totalMs = performance.now() - itT0
    console.info(`[cache-warning/cleanup] CUJ-A 合計 ${(totalMs / 1000).toFixed(1)}s (ceiling ${String(TWO_CONVERT_CEILING_MS / 1000)}s)`)
    expect(totalMs).toBeLessThan(TWO_CONVERT_CEILING_MS)
  }, 660_000)
})
