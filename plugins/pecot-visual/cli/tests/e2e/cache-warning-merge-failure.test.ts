// #931 CUJ-C: 変換後に失敗した run でも、キャッシュ系警告が error payload に載ることの
// 機械検証。#945 の error payload 側の観測点を実 CLI で固定する。
//
// 注入は 2 つ重ねる。どちらも fs の状態だけで作り、権限に依存させない。
// 1 つ目は、`pptx/cache` を通常ファイルに置換すること。保存と更新が throw する。警告の内訳は CUJ-B と同種になる。
// 2 つ目は、`--out` に既存ディレクトリを指定すること。pipeline の完走後の書き出しが EISDIR で失敗する。
//
// assert は当該 run の警告だけを見る（他 CUJ の状態を引き継がない独立 project）。
//
// 掃除の throw（all:error）は、cache-warning-cleanup-failure.test.ts が見る。
// 成功 run の done payload は、cache-warning-save-failure.test.ts が見る。
// 3 つの CUJ は別ファイルで、並列に実行される。
//
// timeout 階層の根拠は、vitest.e2e.config.ts のコメントにある。
// it 引数は testTimeout 660_000 で、runPecotv spawnSync 600_000 より大きい。
// spawnSync 600_000 は、cli 内部の SLIDEV_BUILD_TIMEOUT_MS と同じ。

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
// vitest.e2e.config.ts の maxWorkers 構成で、並列に計測した。N=6 の 7 run 全体から最悪を取る。
// 本 CUJ の最悪は 7.5s。マージン倍率 4.4 倍（33.0s）を取り、35s へ切り上げる。
const SINGLE_CONVERT_CEILING_MS = 35_000

const temporaryRoot = useTemporaryDirectory('pecotv-cache-warning-c-', { hook: 'all' })
const projectDirectory = (): string => temporaryRoot('cache-warning-deck')

const runPecotv = createPecotvRunner({
  logPrefix: 'cache-warning/merge',
  // 本ファイルは exit 1 を期待する CUJ を含むため、tail は spawnSync timeout のときだけ出す。
  isUnexpectedExit: status => status === null,
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
  it('CUJ-C: 変換の後で失敗した run でも、error payload に同じ警告が載る', () => {
    const itT0 = performance.now()

    const themeSpec = createFixtureThemeSpec(temporaryRoot('theme'))
    expect(runPecotv('create', ['slide', 'create', projectDirectory(), '--theme', themeSpec]).status).toBe(0)
    writeFileSync(path.join(projectDirectory(), 'slides.md'), deckMarkdown())

    const cacheDirectory = cacheDirectoryOf(projectDirectory())
    mkdirSync(path.dirname(cacheDirectory), { recursive: true })
    writeFileSync(cacheDirectory, 'not-a-directory')
    expect(existsSync(cacheDirectory)).toBe(true)

    // --out に既存ディレクトリを指定すると、pipeline 完走後の書き出しが EISDIR で失敗する。
    const outAsDirectory = temporaryRoot('warning-out-dir')
    mkdirSync(outAsDirectory, { recursive: true })

    const failed = runPecotv('merge-fail', ['slide', 'convert', projectDirectory(), '--out', outAsDirectory, '--json'])
    expect(failed.status).toBe(1)

    const error = lastEvent(failed.stdout, 'slide.convert.error')
    expect(error).toBeDefined()
    // pipeline 到達後の生 Error は merge-failed へ wrap される（unknown にならない）
    expect(error?.reason).toBe('merge-failed')
    expect(warningsStartingWith(error?.warnings, MANIFEST_INVALID_PREFIX)).toHaveLength(1)
    expect(warningsStartingWith(error?.warnings, SAVE_FAILED_PREFIX)).toHaveLength(SLIDE_COUNT)
    expect(warningsStartingWith(error?.warnings, UPDATE_FAILED_PREFIX)).toHaveLength(1)
    // pipeline は完走しており変換エラーは無い。フィールド不在（旧版）と区別するため
    // 空配列であることまで見る (#945)
    expect(error?.errors).toStrictEqual([])

    const totalMs = performance.now() - itT0
    console.info(`[cache-warning/merge] CUJ-C 合計 ${(totalMs / 1000).toFixed(1)}s (ceiling ${String(SINGLE_CONVERT_CEILING_MS / 1000)}s)`)
    expect(totalMs).toBeLessThan(SINGLE_CONVERT_CEILING_MS)
  }, 660_000)
})
