// #897 US2 / T011-b: 実 Chromium での「差分変換の出力 = 全変換の出力」機械検証（SC-003 / FR-008）。
//
// 統合テスト側（tests/integration/commands/slide-convert.test.ts の T011-a）は fake worker で
// キャッシュ論理を検証する。
// ここは実 slidev build + 実 Chromium + 実 dom-to-pptx を通した出力どうしを比較する層。
// 比較には、同じ比較ヘルパ（tests/_helpers/pptx-compare.ts）を使う。
//
// 全変換方式は `<project>/pptx/cache` の削除で作る。
// `--no-cache`（#898）でも全 miss にはなるが、基準側に使うと、その不具合が基準と差分の両方を同じ向きに汚す。
// すると SC-003 の比較が恒真になる。
// 基準は、キャッシュ判定を一切通らない形（キャッシュ不在）に保つ。
// `--no-cache` 自身の挙動は cache-identity-no-cache.test.ts が単独で見る（別ファイルにして並列に動かせる）。
//
// 判定は 2 段構成（quickstart シナリオ 4 の基準手順と同じ）。
//   (1) 対照 — 全変換 vs 全変換。ここで出る差分は、実変換自体の非決定性。
//   (2) 本判定 — 全変換 vs 差分変換。(1) に無い差分だけが、キャッシュ起因。
// media はこの 2 段構成のうち、byte 比較を (1) との差集合で見る。
// 構造（part 名と PNG 寸法）は常に厳密比較する。
//
// 外部 pptx モードでは、環境変数 `PECOTV_CACHE_IDENTITY_A` / `PECOTV_CACHE_IDENTITY_B` を両方与える。
// その場合、デッキ変換は行わず、その 2 ファイルを比較する。
// これは、実デッキの 2 出力へ同じ XPath 比較を当てる、T013 実機検証の入り口。
//
// timeout 階層は vitest.e2e.config.ts のコメントを基準とする。
// 階層は、it 引数 = testTimeout 660_000 > runPecotv spawnSync 600_000 = cli 内部 SLIDEV_BUILD_TIMEOUT_MS。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  diffPptxSnapshots,
  expectPptxOutputsEquivalent,
  slidesInOrder,
  valuesOf,
  type PptxSnapshot,
} from '../_helpers/pptx-compare.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

// hang regression を spawnSync の SIGTERM kill（600s）より手前で落とすための上限。
// テスト末尾で経過時間を assert する事後チェックであり、性能目標でも SLA でもない
// （所要時間そのものの合否は SC-002 の担当で、本テストは同一性のみを見る）。
// 並列計測（vitest.e2e.config.ts の maxWorkers 構成、N=6 の 7 run 全体から最悪を取る）で本 CUJ 最悪 27.6s。
// マージン倍率 4.4 倍は 121.4s だが、E2E 中で最も重い CUJ のため切り上げて 130s を採る。
const DURATION_CEILING_MS = 130_000

const EDITED_SLIDE_KEY = '2'

const externalPair = resolveExternalPair()

const temporaryRoot = useTemporaryDirectory('pecotv-cache-identity-', { hook: 'all' })

const runPecotv = createPecotvRunner({
  logPrefix: 'cache-identity/full-vs-diff',
  // 本ファイルの CUJ はすべて exit 0 を期待するため、0 以外はすべて一次情報を残す。
  isUnexpectedExit: status => status !== 0,
})

/**
差分行のうち `ppt/media/` のものだけを part 名の集合にする。
*/
function differingMediaParts(
  left: Readonly<PptxSnapshot>,
  right: Readonly<PptxSnapshot>,
): ReadonlySet<string> {
  return new Set(
    diffPptxSnapshots(left, right)
      .filter(line => line.startsWith('ppt/media/'))
      .map(line => line.split(':', 1)[0] ?? ''),
  )
}

beforeAll(() => {
  // 外部 pptx モードは変換しないので、dist と Chromium のどちらも要らない。
  if (externalPair === undefined) assertCliBuilt()
})

afterAll(() => {
  if (temporaryRoot() !== '') rmSync(temporaryRoot(), { recursive: true, force: true })
})

// Chromium cache 不在環境では skip する。
// golden-path と違い、playwright install は試みない。
// cold ダウンロードの所要時間が読めず、本テストは 4 回の変換で既に重いため。
// 外部 pptx モードは変換しないので Chromium 不要。
const isChromiumReady = isChromiumCached()

describe.skipIf(externalPair === undefined && !isChromiumReady)('CUJ: 差分変換の出力 = 全変換の出力', () => {
  it('中央 1 枚を編集した差分変換の出力が、同一ソースの全変換の出力と XPath 抽出値レベルで一致する', async () => {
    if (externalPair !== undefined) {
      // T013 実機検証: 外部から渡された 2 つの pptx を同じ観点で比較する。
      // 実デッキは枚数が事前に確定せず、画像のみのスライド（a:t と xfrm を持たない）が混じる。
      // そのため、退化の判定はデッキ単位へ緩める。
      // media には実変換の非決定性があるため、寸法比較にする。
      // quickstart の計測では、svg が全変換どうしでも不一致だった。
      await expectPptxOutputsEquivalent(externalPair.a, externalPair.b, {
        degeneracyGate: 'deck',
        mediaComparison: 'dimensions',
      })
      return
    }

    const itT0 = performance.now()
    const projectDirectory = temporaryRoot('cache-identity-deck')
    const slidesPath = path.join(projectDirectory, 'slides.md')
    const cacheDirectory = path.join(projectDirectory, 'pptx', 'cache')
    const warmOut = temporaryRoot('identity-warm.pptx')
    const diffOut = temporaryRoot('identity-diff.pptx')
    const fullOut = temporaryRoot('identity-full.pptx')
    const controlOut = temporaryRoot('identity-full-control.pptx')
    const convertArguments = (out: string): readonly string[] =>
      ['slide', 'convert', projectDirectory, '--out', out, '--json']

    // 追跡下の fixture を元位置で書き換えると異常終了時に dirty が残るため、
    // mkdtemp 配下へ `slide create` してから slides.md を差し替える。
    // create が plugin-root の node_modules への symlink を張るので tmp でも build が通る。
    const themeSpec = createFixtureThemeSpec(temporaryRoot('theme'))
    expect(runPecotv('create', ['slide', 'create', projectDirectory, '--theme', themeSpec]).status).toBe(0)
    writeFileSync(slidesPath, deckMarkdown('# キャッシュ同一性 2 枚目（初版）'))

    // 1. 初回変換（キャッシュ生成）
    const warm = runPecotv('warm', convertArguments(warmOut))
    expect(warm.status).toBe(0)
    const warmDone = lastEvent(warm.stdout, 'slide.convert.done')
    expect(warmDone?.cache).toMatchObject({ enabled: true, hits: 0, misses: SLIDE_COUNT })
    // 方式 assert（#1147）: 全変換・差分変換とも、env が決める方式で変換している。
    // 差分変換は miss の 1 ステップだけを、1 パス方式に渡す。
    expectConvertRouteFromEnvironment(warmDone)

    // 2. 中央 1 枚だけ編集 → 差分変換（hit + miss 混在）
    writeFileSync(slidesPath, deckMarkdown('# キャッシュ同一性 2 枚目（改訂）'))
    const diff = runPecotv('diff', convertArguments(diffOut))
    expect(diff.status).toBe(0)
    const diffDone = lastEvent(diff.stdout, 'slide.convert.done')
    // 方式モード assert: 差分方式であること。
    // 通知なしに全 miss へ降格した場合、全変換 run と同モードになる。
    // すると比較が通っても、SC-003 を検証したことにならない。
    expect(diffDone?.cache).toMatchObject({ enabled: true, hits: SLIDE_COUNT - 1, misses: 1 })
    expect(missKeysOf(diffDone)).toStrictEqual([EDITED_SLIDE_KEY])
    expectConvertRouteFromEnvironment(diffDone)

    // 3. キャッシュを消して同一ソースを全変換（基準に --no-cache は使わない。冒頭コメント参照）
    rmSync(cacheDirectory, { recursive: true, force: true })
    expect(existsSync(cacheDirectory)).toBe(false)
    const full = runPecotv('full', convertArguments(fullOut))
    expect(full.status).toBe(0)
    const fullDone = lastEvent(full.stdout, 'slide.convert.done')
    expect(fullDone?.cache).toMatchObject({ enabled: true, hits: 0, misses: SLIDE_COUNT })
    expectConvertRouteFromEnvironment(fullDone)

    // 4. 対照: もう一度キャッシュ無しで全変換する。
    //    ここで出る差分は実変換の非決定性を示し、キャッシュ回帰と区別するための基準になる。
    rmSync(cacheDirectory, { recursive: true, force: true })
    const control = runPecotv('full-control', convertArguments(controlOut))
    expect(control.status).toBe(0)
    expect(lastEvent(control.stdout, 'slide.convert.done')?.cache).toMatchObject({ enabled: true, hits: 0, misses: SLIDE_COUNT })

    // 対照の一致を先に確認する。
    // ここで落ちるなら実変換自体は非決定的で、本判定の差分をキャッシュ欠陥と言い切れない。
    const controlPair = await expectPptxOutputsEquivalent(fullOut, controlOut, {
      expectedSlideCount: SLIDE_COUNT,
      mediaComparison: 'dimensions',
    })
    const unstableMediaParts = differingMediaParts(controlPair.a, controlPair.b)
    console.info(`[cache-identity/full-vs-diff] 対照で内容が揺れた media part: ${String(unstableMediaParts.size)} 件`)

    // 本判定。退化検知（枚数一致・抽出値非空・media 非 0）は比較ヘルパの絶対値の判定が担う。
    const judgedPair = await expectPptxOutputsEquivalent(fullOut, diffOut, {
      expectedSlideCount: SLIDE_COUNT,
      mediaComparison: 'dimensions',
    })
    // media のバイト差は「対照でも揺れた part」だけを許容する。
    // 決定論的な環境では対照が空集合になるので、キャッシュ経由の変換にはバイト一致まで要求される。
    const judgedMediaParts = [...differingMediaParts(judgedPair.a, judgedPair.b)]
    expect(judgedMediaParts.filter(part => !unstableMediaParts.has(part))).toStrictEqual([])

    // 編集内容が両出力に実際に反映されていること（キャッシュ由来の旧本文が残らない）
    const diffTexts = slidesInOrder(judgedPair.b).flatMap(slide => valuesOf(slide, 'text')).join('\n')
    expect(diffTexts).toContain('改訂')
    expect(diffTexts).not.toContain('初版')
    expect(readFileSync(slidesPath, 'utf8')).toContain('改訂')

    const totalMs = performance.now() - itT0
    console.info(`[cache-identity/full-vs-diff] 合計 ${(totalMs / 1000).toFixed(1)}s (ceiling ${String(DURATION_CEILING_MS / 1000)}s)`)
    expect(totalMs).toBeLessThan(DURATION_CEILING_MS)
  }, 660_000)
})
