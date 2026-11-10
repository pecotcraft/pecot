// #949: level=element の変換エラーが、成功完走した run の `slide.convert.done` payload から
// 観測できることの機械検証。
//
// 単体・統合テストは、fake pipeline の戻り値でこの流れを再現する。
// 実 CLI では、次の 2 点を通していない。
// 「そもそも prerender が element エラーを積むか」と「success 側の done payload に載るか」。
// level=element は run の成否を変えない。
// そのため、error payload しか見ない #945 の検証では届かない範囲になる。
//
// エラーの注入は DOM の状態だけで行い、ネットワークや権限に依存させない。
// prerender 対象セレクタ（`.point-number`）を持つ要素を、`display: none` で置く。
// すると hiRes 側の `boundingBox()` が null を返す。
// その結果、prerenderResults の success: false が level=element の 1 件になる。
//
// 2 枚構成にするのは、hidden 要素を 1 枚目以外へ置くため。
// 実機で確かめると、hidden 要素が 1 枚目にあると注入が不発（errors 空）で、2 枚目に置くと発火する。
// 1 枚目に可視の `.point-number` があるかどうかは、発火条件ではない。
// 対照要素を置かない 2 枚構成でも、2 枚目で発火することを確かめた。
// 1 枚目だけ不発になる仕組みは、未特定のまま使っている。
// 要素を集める locateTargetsInVisibleSlides は、スライド（`.slidev-page`）の可視性しか見ていない。
// この位置依存を説明できていない。
//
// 1 枚目に置く可視の `.point-number` は対照群。
// 同一 run で同じセレクタの prerender が成功していることを示す。
// 「prerender が全体として失敗して全件エラー」との取り違えを防ぐ。
//
// 同一 it 内で convert を 2 回まわす。
// 1 回目は `--no-cache` で prerender を必ず実行させる。
// 2 回目は、その成果物へのキャッシュヒットを前提にする。run をまたぐ依存があるため分割しない。
// キャッシュヒットしたステップは、prerender 自体が再実行されず、要素診断が空になる。
// そのため 2 回目は、`errors: []` と「診断を再実行していない」旨の警告が対で出る。
// convert.ts の SlideConvertResultSummary.errors の doc コメントを、実 CLI で固定する。
//
// timeout 階層の根拠は、vitest.e2e.config.ts のコメントにある。
// it 引数は testTimeout 660_000 で、runPecotv spawnSync 600_000 より大きい。
// spawnSync 600_000 は、cli 内部の SLIDEV_BUILD_TIMEOUT_MS と同じ。

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
  createFixtureThemeSpec,
  FIXTURE_THEME_NAME,
} from '../_helpers/pecotv-e2e-run.js'
import { readZipEntries } from '../_helpers/zip-entries.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { durationCeilingMs } from '../_helpers/duration-ceiling.js'

const PRERENDER_SELECTOR = '.point-number'
const SLIDE_COUNT = 2

/**
pipeline がキャッシュヒット時に積む警告。途中にヒット数が入るため、前後で判定する。
*/
const CACHE_REUSE_PREFIX = 'element diagnostics were not re-run for'
const CACHE_REUSE_SUFFIX = 'steps because their cache was reused'

function cacheReuseWarnings(warnings: readonly string[] | undefined): readonly string[] {
  return (warnings ?? []).filter(warning => warning.startsWith(CACHE_REUSE_PREFIX) && warning.endsWith(CACHE_REUSE_SUFFIX))
}

// hang regression を spawnSync の SIGTERM kill（600s）より手前で落とすための上限。
// 性能目標ではない。
// かつてはここに、Playwright の screenshot 既定 timeout 由来の固定 30s が乗っていた。
// そのため、可変分にだけマージンを掛ける特別扱いをしていた。
// prerender-capture が boundingBox null の要素を screenshot に渡さなくなり、固定分は消えた。
// よって他の CUJ と同じく、計測値に 4.4 倍のマージンを掛けて引く。
//
// vitest.e2e.config.ts の maxWorkers 構成で、並列に計測した。N=6 の 7 run 全体から最悪を取る。
// 本 CUJ の最悪は 12.2s。マージン倍率 4.4 倍（53.7s）を取り、55s へ切り上げる。
const ELEMENT_ERROR_CEILING_MS = durationCeilingMs(55_000)

const temporaryRoot = useTemporaryDirectory('pecotv-element-error-', { hook: 'all' })
const projectDirectory = (): string => temporaryRoot('element-error-deck')

const runPecotv = createPecotvRunner({
  logPrefix: 'element-error',
  // 本ファイルの CUJ はすべて exit 0 を期待するため、0 以外はすべて一次情報を残す。
  isUnexpectedExit: status => status !== 0,
})

/**
pptx 内のスライドパーツ数。デッキ全体が変換されたことを出力側から確かめる。
*/
async function slidePartCount(pptxPath: string): Promise<number> {
  const entries = await readZipEntries(pptxPath)
  return entries.keys().filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).toArray().length
}

function deckMarkdown(): string {
  return [
    '---',
    `theme: "${FIXTURE_THEME_NAME}"`,
    'title: Element Error Observability E2E',
    'canvasWidth: 960',
    'aspectRatio: \'16/9\'',
    '---',
    '',
    '# 制御群: 可視の point-number',
    '',
    `<div class="${PRERENDER_SELECTOR.slice(1)}">1</div>`,
    '',
    '先頭スライドの本文。',
    '',
    '---',
    '',
    '# 実験群: display:none の point-number',
    '',
    `<div class="${PRERENDER_SELECTOR.slice(1)}" style="display: none">2</div>`,
    '',
    '末尾スライドの本文。',
    '',
  ].join('\n')
}

beforeAll(() => {
  assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

// Chromium cache 不在環境では skip する（cache-identity 系と同じ方針）。
const isChromiumReady = isChromiumCached()

describe.skipIf(!isChromiumReady)('CUJ: element エラーが成功 run の done payload から観測できる', () => {
  it('CUJ: prerender 対象が不可視のスライドを含む run は exit 0 のまま、done payload に level=element を 1 件載せる。キャッシュヒット run では errors が空になり、警告で置き換わる', async () => {
    const itT0 = performance.now()
    const outPath = temporaryRoot('element-error.pptx')
    const cachedOutPath = temporaryRoot('element-error-cached.pptx')

    // 追跡下の fixture を書き換えないよう mkdtemp 配下へ `slide create` する。
    // create が plugin-root の node_modules への symlink を張るので tmp でも build が通る。
    const themeSpec = createFixtureThemeSpec(temporaryRoot('theme'))
    expect(runPecotv('create', ['slide', 'create', projectDirectory(), '--theme', themeSpec]).status).toBe(0)
    writeFileSync(path.join(projectDirectory(), 'slides.md'), deckMarkdown())

    const converted = runPecotv('convert', [
      'slide', 'convert', projectDirectory(), '--out', outPath, '--json', '--no-cache',
    ])
    // element エラーは run の成否を落とさない。pptx も全枚数ぶん生成される。
    expect(converted.status).toBe(0)
    expect(existsSync(outPath)).toBe(true)
    expect(await slidePartCount(outPath)).toBe(SLIDE_COUNT)

    const done = lastEvent(converted.stdout, 'slide.convert.done')
    expect(done).toBeDefined()
    // フィールド不在（旧版）と区別するため、配列として取り出せることまで見る
    expect(done?.errors).toBeInstanceOf(Array)
    // スライド番号はデッキ構成の変更で動くため、level と selector で絞る
    const elementErrors = (done?.errors ?? []).filter(
      entry => entry.level === 'element' && entry.selector === PRERENDER_SELECTOR,
    )
    expect(elementErrors).toHaveLength(1)
    // prerender-capture は boundingBox 取得失敗と hiRes スクリーンショット失敗を出し分ける。
    // display:none の要素では boundingBox() が throw せず null を返すだけなので、
    // hiRes 側の null 判定が、「要素が不可視」として失敗を積む。
    // pipeline 側が 'unknown error' へ退化した場合も、ここで検知できる。
    // 接頭辞だけでは、screenshot() の 30 秒 timeout へ戻った場合と区別できない。
    // 所要の 12 + 30 秒は、ceiling 55 秒に収まる。
    // そのため、理由まで含めて実 CLI で固定する。
    expect(elementErrors[0]?.message).toBe('hiRes screenshot failed: element is not visible (boundingBox is null)')
    // 値は構成依存なので型だけ見る（不在のまま JSON 化されていないことの確認）
    expect(typeof elementErrors[0]?.slideNumber).toBe('number')
    // Playwright の call log は message に載せない（機械可読 payload としての可読性）
    expect(elementErrors[0]?.message).not.toContain('Call log:')
    // 今回の errors は計測した値（キャッシュ再利用で診断を飛ばした run ではない）
    expect(cacheReuseWarnings(done?.warnings)).toStrictEqual([])

    // 2 回目は `--no-cache` を外し、1 回目が残したキャッシュにヒットさせる。
    const cached = runPecotv('convert-cached', [
      'slide', 'convert', projectDirectory(), '--out', cachedOutPath, '--json',
    ])
    expect(cached.status).toBe(0)
    expect(existsSync(cachedOutPath)).toBe(true)
    expect(await slidePartCount(cachedOutPath)).toBe(SLIDE_COUNT)

    const cachedDone = lastEvent(cached.stdout, 'slide.convert.done')
    expect(cachedDone?.cache).toMatchObject({ enabled: true, hits: SLIDE_COUNT, misses: 0 })
    // 同じデッキでも errors は空になる。「errors: [] はデッキに要素エラーが無いことを
    // 意味しない」（convert.ts）を実 CLI で固定する。
    expect(cachedDone?.errors).toStrictEqual([])
    // 代わりに、診断を再実行していない旨がヒット数つきで警告に出る
    expect(cacheReuseWarnings(cachedDone?.warnings))
      .toStrictEqual([`${CACHE_REUSE_PREFIX} ${String(SLIDE_COUNT)} ${CACHE_REUSE_SUFFIX}`])

    const totalMs = performance.now() - itT0
    console.info(`[element-error] CUJ 合計 ${(totalMs / 1000).toFixed(1)}s (ceiling ${String(ELEMENT_ERROR_CEILING_MS / 1000)}s)`)
    expect(totalMs).toBeLessThan(ELEMENT_ERROR_CEILING_MS)
  }, 660_000)
})
