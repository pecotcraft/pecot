// #931 CUJ-B: 保存先が作れない run（分岐 = all:manifest）が実 CLI の `--json` payload から
// 観測できることの機械検証。
//
// 警告の注入は fs の状態だけで行い、権限（chmod / root 実行の差）に依存させない。
// 具体的には `pptx/cache` を通常ファイルに置換する。
// すると saveSlideToCache / writeCacheManifest の `mkdir(recursive: true)` が EEXIST で throw する。
// 一方 readCacheManifest は ENOTDIR を「読めない manifest」として扱う。
// そのため invalidated は all:manifest になる。
//
// `slide create` 直後の project に `pptx/` は無いので、置換の前に親を作る。
// warm 変換は要らない（保存・更新の失敗は全 miss の初回 run でそのまま出る）。
//
// 文言 assert は errno を含まない接頭辞一致にする（メッセージ末尾は環境依存）。
//
// 掃除の throw（all:error）は cache-warning-cleanup-failure.test.ts が見る。
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
  SAVE_FAILED_PREFIX,
  SLIDE_COUNT,
  UPDATE_FAILED_PREFIX,
  cacheDirectoryOf,
  deckMarkdown,
} from '../_helpers/cache-warning.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

// hang regression を spawnSync の SIGTERM kill（600s）より手前で落とすための上限。
// 性能目標ではない。
// 並列計測（vitest.e2e.config.ts の maxWorkers 構成、N=6 の 7 run 全体から最悪を取る）で、本 CUJ 最悪は 7.4s。
// これにマージン倍率 4.4 倍（32.6s）を取り、35s へ切り上げる。
const SINGLE_CONVERT_CEILING_MS = 35_000

const temporaryRoot = useTemporaryDirectory('pecotv-cache-warning-b-', { hook: 'all' })
const projectDirectory = (): string => temporaryRoot('cache-warning-deck')

const runPecotv = createPecotvRunner({
  logPrefix: 'cache-warning/save',
  // 本ファイルの CUJ は exit 0 を期待するため、0 以外はすべて一次情報を残す。
  isUnexpectedExit: status => status !== 0,
})

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

// Chromium cache 不在環境では skip する（cache-identity 系と同じ方針）。
const isChromiumReady = isChromiumCached()

describe.skipIf(!isChromiumReady)('CUJ: キャッシュ系警告が --json payload から観測できる', () => {
  it('CUJ-B: 保存先が作れない run は保存・更新の失敗が done payload に出る (all:manifest)', () => {
    const itT0 = performance.now()
    const saveFailOut = temporaryRoot('warning-save-fail.pptx')

    // 追跡下の fixture を書き換えないよう mkdtemp 配下へ `slide create` する。
    const themeSpec = createFixtureThemeSpec(temporaryRoot('theme'))
    expect(runPecotv('create', ['slide', 'create', projectDirectory(), '--theme', themeSpec]).status).toBe(0)
    writeFileSync(path.join(projectDirectory(), 'slides.md'), deckMarkdown())

    const cacheDirectory = cacheDirectoryOf(projectDirectory())
    mkdirSync(path.dirname(cacheDirectory), { recursive: true })
    writeFileSync(cacheDirectory, 'not-a-directory')

    const saveFail = runPecotv('save-fail', ['slide', 'convert', projectDirectory(), '--out', saveFailOut, '--json'])
    expect(saveFail.status).toBe(0)
    expect(existsSync(saveFailOut)).toBe(true)

    const done = lastEvent(saveFail.stdout, 'slide.convert.done')
    expect(done).toBeDefined()
    expect(warningsStartingWith(done?.warnings, MANIFEST_INVALID_PREFIX)).toHaveLength(1)
    // 保存はステップごとに失敗するため枚数分、manifest 更新は終端 1 回だけ
    expect(warningsStartingWith(done?.warnings, SAVE_FAILED_PREFIX)).toHaveLength(SLIDE_COUNT)
    expect(warningsStartingWith(done?.warnings, UPDATE_FAILED_PREFIX)).toHaveLength(1)
    // 掃除は readdir 失敗で無害に抜けるため、分岐 3（all:error）へは入らない
    expect(warningsStartingWith(done?.warnings, CACHE_UNUSABLE_PREFIX)).toStrictEqual([])
    expect(done?.cache).toMatchObject({ invalidated: 'all:manifest' })
    // 変換エラーは無い。フィールド不在（旧版）と区別するため空配列であることまで見る (#949)
    expect(done?.errors).toStrictEqual([])

    const totalMs = performance.now() - itT0
    console.info(`[cache-warning/save] CUJ-B 合計 ${(totalMs / 1000).toFixed(1)}s (ceiling ${String(SINGLE_CONVERT_CEILING_MS / 1000)}s)`)
    expect(totalMs).toBeLessThan(SINGLE_CONVERT_CEILING_MS)
  }, 660_000)
})
