/* eslint-disable unicorn/name-replacements -- slide-worker.ts 踏襲 */
/* eslint-disable security/detect-non-literal-fs-filename -- slide-worker.ts 踏襲 */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- slide-worker.ts 踏襲 */
// 1 パス変換（#1141 で試作、#1147 で既定 on）。
// Slidev の print ルート（`/print` にクエリ `print=clicks` を付けた URL）を 1 回だけ開き、全ステップを同じページから変換する。
// 現行の slide-worker.ts は、ステップごとにページを開き直す。
// prerender 対象があれば、さらに高解像度ページを target ごとに開き直す。
// その構造の費用を省くのが目的。
//
// miss ステップをスライド番号で最大 `concurrency` 個のグループに分ける。
// 同じスライドのステップは、同じグループに入る。
// グループごとに、print ページ A / B のペアを開く。
// グループ内は直列、グループ間は並列に動く。別 document なので、dom-to-pptx を同時に動かせる。
// print ページの `range` クエリは、build 済み SPA では反映されない。
// 常に全スライドのコンテナが DOM に入る（計測済み）。
// そのため各グループは range なしで開き、自グループのステップに対応するコンテナだけを扱う。
//
// 担当外のコンテナは、ページ A / B とも goto の前に入れる init script のスタイルシートで、`display: none` にして描かせない（#1161）。
// 描くと、K 個のグループがそれぞれ全スライド分の描画費用とメモリを払う。
// すると Chromium のメモリが、グループ数に比例して膨らむ。
// コンテナ自体は DOM に残る。
// そのため、コンテナ数と id の突き合わせは、全コンテナに対して行う。
//
// ページは 1 グループにつき 2 つ開く。
// - ページ A は、viewport が 960 × (540 × グループのステップ数)。グループのコンテナを同時に描画する。dom-to-pptx を 1 回だけ注入する。ステップごとに、対象コンテナの `.slidev-page` を exportToPptx に渡す。
// - ページ B は、viewport が 960×540、deviceScaleFactor が 5。prerender 対象があるときだけ開く。自グループのコンテナだけを一度スクロールして、遅延ロード（IntersectionObserver）を発火させる。待ち戦略は、自グループのコンテナに対して 1 回だけ実行する。その後、ステップごとに対象コンテナを viewport 先頭へスクロールして撮影する。
//
// history / hash どちらのルータのデッキも対象にする。
// print ルートの URL は、slide-url.ts の buildPrintUrl で作る。
//
// ページは run で 2 つの BrowserContext から開く。ページ A 用とページ B 用に分ける。
// deviceScaleFactor は context 単位の設定なので、1 つにまとめられない。
// 同じ種類のページは、グループをまたいで HTTP キャッシュを共有する。
// ページ A では、draw.io viewer（viewer.diagrams.net）の取得を遮断する。
// ページ A の draw.io の表示要素は、prerender でページ B の撮影画像に差し替えて、元要素を隠す。
// そのため viewer を必要としない。
// グループのコンテナを同時に描くページ A が図の viewer を取りに行くと、ページ B の取得と競合する。
//
// print ルートが build に入っていない（`__SLIDEV_FEATURE_PRINT__` が false）ことは、各グループがページ A を開いた直後に、並列に判定する。
// 見るのは、print ページと play ページのルート要素（`#page-root`）か、print コンテナの親（`#print-container`）。
// どちらかが出た時点で、後者の有無を見る。
// そのため、5 秒の時間切れを待たない。
// `#page-root` が出て `#print-container` が無ければ、変換を始めずに専用の印（kind `printRouteMissing`）を返す。
// pipeline は、run 全体を現行方式（ステップ単位の並列）で変換する。
// どちらも 5 秒以内に出ない場合は、不在とみなさない。
// 読み込みが遅い等で判定できないだけなので、次の段落のグループ単位の退避にする。
//
// それ以外の前提（判定できる、コンテナが期待どおり出る）が欠けたグループは、変換を始める前に、そのグループのステップだけを現行の worker（fallbackRunner）に回す。
// 変換を始めた後に失敗したステップも、そのステップだけ現行の worker に回す。
// ページ B を用意できないグループで、prerender 対象を持つステップも同様に回す。
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import type { Browser, BrowserContext, Page } from 'playwright'

import { slideViewport, timeouts } from '../../domain/slidev-to-pptx/config.js'
import { errorMessage } from '../../domain/slidev-to-pptx/error-utils.js'
import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import { buildPrintUrl, type SlideUrlFormat } from '../../domain/slidev-to-pptx/slide-url.js'
import { stepIndexOf, stepKeyOf } from '../../domain/slidev-to-pptx/step-index.js'
import type {
  SinglePassFallbackTiming,
  SinglePassGroupsTiming,
  SinglePassGroupTiming,
  SlidePhases,
  SlideStep,
} from '../../domain/slidev-to-pptx/types.js'
import { slideVisibleFunctionSource } from '../../domain/slidev-to-pptx/visibility.js'
import { convertSlide, injectDomToPptx } from './dom-converter.js'
import { restorePrerenderElements } from './prerender.js'
import { captureAndReplaceElements, type PrerenderResult } from './prerender-capture.js'
import { runWithConcurrency } from './concurrency.js'
import {
  prerenderConfig as defaultPrerenderConfig,
  highResolutionDeviceScaleFactor,
  resolveWait,
  type PrerenderConfig,
  type PrerenderTarget,
} from './prerender-config.js'
import { elapsedSince, timed, type SlideConvertResult, type SlideWorkerConfig, type SlideWorkerRunner } from './slide-worker.js'
import {
  disposeHandles,
  locateTargetsInVisibleSlides,
  waitForCssAnimations,
  waitForFontsReady,
  waitForDataWaitfor,
  waitForIframeLoad,
  waitForSelectorInVisibleSlide,
} from './visibility-helpers.js'
import { ignoreRejection } from '../../domain/_shared/ignore-rejection.js'

/**
print ページの 1 ステップ分のコンテナ（Slidev PrintSlideClick.vue の class）
*/
const PRINT_CONTAINER_SELECTOR = '.print-slide-container'
/**
print コンテナ群の親（Slidev PrintContainer.vue）。print ルートが build に入っていれば print ページに同期描画される
*/
const PRINT_ROOT_SELECTOR = '#print-container'
/**
print ルートの有無を判定できる要素。
`#page-root` は print.vue と play.vue の両方のルート要素。
print ルートが無い build では、print の URL が play ルートとして扱われ、`#page-root` だけが出る。
*/
const PRINT_ROUTE_PROBE_SELECTOR = `${PRINT_ROOT_SELECTOR}, #page-root`
/**
print ルートの判定・コンテナの出現を待つ上限。E2E が print ルート無しの判定時間の上限に使う
*/
export const CONTAINER_APPEAR_TIMEOUT_MS = 5000
/**
撮影前の再待ちの上限（ms）。ウォームアップで時間切れになったコンテナで使う。
戦略の timeout（既定 15 s）で待ち直すと、届かない環境では 1 コンテナあたり、ウォームアップと合わせて 2 倍待つため
*/
const PRE_CAPTURE_RECHECK_TIMEOUT_MS = 2000
/**
ページ A で取得を遮断する draw.io viewer の URL
*/
const DRAWIO_VIEWER_URL_PATTERN = 'https://viewer.diagrams.net/**'
/**
html2canvas が document の clone から除外する要素の目印
*/
const HTML2CANVAS_IGNORE_ATTRIBUTE = 'data-html2canvas-ignore'

/**
ステップに対応する print コンテナの id（PrintSlideClick.vue: スライド番号 3 桁 - クリック段 + 1 の 2 桁）。
clickStep null は先頭の段（クリック 0）。
*/
export function printContainerId(step: Readonly<SlideStep>): string {
  const slidePart = step.slideNumber.toString().padStart(3, '0')
  const clickPart = ((step.clickStep ?? 0) + 1).toString().padStart(2, '0')
  return `${slidePart}-${clickPart}`
}

/**
id が数字で始まり `#` 形式では書けないため、属性セレクタでコンテナを指す。
*/
export function containerScopeSelector(containerId: string): string {
  return `[id="${containerId}"]`
}

/**
ステップをスライド番号で最大 `groupCount` 個のグループに分ける。結果は決定的になる。
- 同じスライドのステップは、同じグループに入る。
- グループはスライドの出現順に連続した区間で、各グループ内のステップ順は入力のまま。
- ステップ数の累積が全体の g/K を超えたところで、次のグループへ移る。ステップ数がほぼ均等になる。
- 残りスライド数が残りグループ数に並んだら、1 スライドずつ割り当てる。スライド数が足りる限り、K 個ちょうどにする。

グループ数はスライド数を超えない。groupCount が 1 未満なら 1 とみなす。
*/
export function partitionStepsBySlide(steps: readonly SlideStep[], groupCount: number): SlideStep[][] {
  const bySlide = new Map<number, SlideStep[]>()
  for (const step of steps) {
    const list = bySlide.get(step.slideNumber)
    if (list === undefined) bySlide.set(step.slideNumber, [step])
    else list.push(step)
  }
  const slides = bySlide.values().toArray()
  const groupLimit = Math.max(1, Math.min(Math.floor(groupCount), slides.length))
  const groups: SlideStep[][] = []
  let current: SlideStep[] = []
  let cumulative = 0
  for (const [index, slideSteps] of slides.entries()) {
    const remainingSlides = slides.length - index
    const remainingGroups = groupLimit - groups.length - 1
    const isReachedShare = cumulative >= (steps.length * (groups.length + 1)) / groupLimit
    if (current.length > 0 && remainingGroups > 0 && (isReachedShare || remainingSlides <= remainingGroups)) {
      groups.push(current)
      current = []
    }
    current.push(...slideSteps)
    cumulative += slideSteps.length
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
グループのコンテナだけを指すセレクタ。他グループのコンテナの要素を待たず、撮らないため。
*/
export function groupScopeSelector(containerIds: readonly string[]): string {
  return `:is(${containerIds.map(id => containerScopeSelector(id)).join(', ')})`
}

/**
グループ外のコンテナを描かせないスタイル（hideOtherContainers がページに足す）。
*/
export function otherContainersHiddenCss(containerIds: readonly string[]): string {
  return `${PRINT_CONTAINER_SELECTOR}:not(${containerIds.map(id => containerScopeSelector(id)).join(', ')}) { display: none !important; }`
}

/**
グループ外のコンテナを `display: none` にする init script をページに入れる。
goto の前に呼ぶ。最初の描画から隠し、担当外のスライドの要素を読み込ませないため。
*/
async function hideOtherContainers(page: Page, containerIds: readonly string[]): Promise<void> {
  await page.addInitScript((css: string) => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  }, otherContainersHiddenCss(containerIds))
}

export interface SinglePassRequest {
  readonly browser: Browser
  /**
  dist 配信サーバの origin（`http://127.0.0.1:<port>`）
  */
  readonly baseUrl: string
  /**
  ルータ判定の結果。print ルートの URL の形を決める
  */
  readonly urlFormat: Readonly<SlideUrlFormat>
  /**
  変換するステップ（キャッシュ miss 分、ステップ順）
  */
  readonly steps: readonly SlideStep[]
  /**
  全走査で見つけたステップの総数（hit を含む）。print ページのコンテナ数と比べる
  */
  readonly totalSteps: number
  readonly workerConfig: SlideWorkerConfig
  readonly slidesDir: string
  readonly logger: Logger
  /**
  1 パス変換で失敗したステップを回す現行 worker
  */
  readonly fallbackRunner: SlideWorkerRunner
  /**
  グループ数の上限（= 同時に開くページ A / B のペア数）。1 なら全ステップを 1 ペアで直列に変換する
  */
  readonly concurrency: number
  readonly onProgress?: (label: string) => void
  /**
  ステップが終わるごとに呼ぶ。終わるとは、1 パス変換の成功か、現行 worker の成功または失敗。
  1 パス変換の失敗は現行 worker でやり直すため、呼ばない
  */
  readonly onStepDone?: (step: SlideStep) => void
  readonly signal?: AbortSignal
  /**
  省略時は prerender-config.ts の既定
  */
  readonly prerenderConfig?: PrerenderConfig
}

/**
1 パス変換で変換した結果。
*/
export interface SinglePassConverted {
  readonly kind: 'converted'
  /**
  steps と同じ順序の結果。現行 worker に回したステップはその結果（成否とも）になる
  */
  readonly results: readonly PromiseSettledResult<SlideConvertResult>[]
  readonly timing: SinglePassGroupsTiming
  /**
  現行 worker に回した理由。
  グループ単位の形式は `スライド 1,2: …`、ステップ単位の形式は `スライド #2/1: …`。
  pipeline が警告として出す
  */
  readonly fallbacks: readonly string[]
}

/**
print ルートが build に無いため、どのステップも変換していない印。
pipeline が run 全体を現行方式（ステップ単位の並列）で変換し、この値を `timing.singlePass` に載せる。
*/
export interface SinglePassPrintRouteMissing {
  readonly kind: 'printRouteMissing'
  readonly timing: SinglePassFallbackTiming
}

export type SinglePassOutcome = SinglePassConverted | SinglePassPrintRouteMissing

export type SinglePassRunner = (request: SinglePassRequest) => Promise<SinglePassOutcome>

/**
run で共有する、ページ A 用とページ B 用の BrowserContext。
どちらも、最初の要求時に 1 回だけ作る。
ページ B 用は、prerender 対象が無い run では作らない。
*/
interface RunContexts {
  readonly forPageA: () => Promise<BrowserContext>
  readonly forPageB: () => Promise<BrowserContext>
  /**
  作った context を閉じる（中のページも閉じる）。失敗は無視する
  */
  readonly close: () => Promise<void>
}

function createRunContexts(browser: Browser, config: Readonly<PrerenderConfig>): RunContexts {
  let pageAContext: Promise<BrowserContext> | undefined
  let pageBContext: Promise<BrowserContext> | undefined
  const openPageAContext = async (): Promise<BrowserContext> => {
    const context = await browser.newContext()
    // ページ A の draw.io の表示要素は prerender の画像で置き換えるため、viewer を取りに行かせない
    await context.route(DRAWIO_VIEWER_URL_PATTERN, async route => route.abort())
    return context
  }
  return {
    forPageA: async () => {
      pageAContext ??= openPageAContext()
      return pageAContext
    },
    forPageB: async () => {
      pageBContext ??= browser.newContext({
        viewport: { width: slideViewport.width, height: slideViewport.height },
        deviceScaleFactor: highResolutionDeviceScaleFactor(config),
      })
      return pageBContext
    },
    close: async () => {
      const settled = await Promise.allSettled([pageAContext, pageBContext].filter(context => context !== undefined))
      for (const context of settled) {
        if (context.status === 'fulfilled') {
          // 閉じられなくても変換結果には影響しない
          await ignoreRejection(context.value.close())
        }
      }
    },
  }
}

/**
変換を始める前に決まる 2 つのページと、全体 1 回分の計時。
*/
interface PreparedPages {
  readonly kind: 'ready'
  readonly contexts: RunContexts
  readonly pageA: Page
  readonly pageATiming: NonNullable<SinglePassGroupTiming['pageA']>
  /**
  高解像度ページ。用意の時点で prerender 対象が無ければ開かず、ステップ処理中に必要となった時点で開く
  */
  pageB: Page | undefined
  pageBTiming: SinglePassGroupTiming['pageB']
  /**
  ステップ処理中に高解像度ページを開いたか
  */
  pageBLazy: boolean
  /**
  高解像度ページを開けなかった理由。以後のステップで開き直さない
  */
  pageBFailure: string | undefined
  /**
  高解像度ページのウォームアップで待つセレクタが消えなかったコンテナ。撮影前の再待ちを短くする
  */
  readonly warmupTimedOut: Set<string>
  readonly url: string
  readonly groupIds: readonly string[]
  readonly groupScope: string
  /**
  開いたページ。成否によらず呼び出し側が閉じる
  */
  readonly opened: Page[]
}

/**
グループの全コンテナでスライド本体が描かれるまで待つ。
Slidev のスライド本体は非同期コンポーネント。
コンテナが出た直後は、`.slidev-page` に子が無く、読み込み中の目印（`.slidev-slide-loading`）もまだ無い瞬間がある。
その間に prerender 対象を検出すると、「対象なし」と誤判定する。
そこで各コンテナについて、次の 2 つをそろって満たすまで待つ。
- `.slidev-page` があり可視。slideVisibleFunctionSource で見る。子要素を持つことを含む。
- コンテナ内に `.slidev-slide-loading` が無い。

時間内に満たさなければ、退避理由を返す。
*/
async function waitForGroupRendered(page: Page, groupScope: string): Promise<string | undefined> {
  try {
    await page.waitForFunction(
      ({ scope, visibleFn }: { scope: string, visibleFn: string }) => {
        /* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- 文字列関数 */
        /* eslint-disable no-restricted-syntax -- 文字列関数 */
        const isVisible = new Function('return ' + visibleFn)() as (element: Element) => boolean
        /* eslint-enable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call */
        /* eslint-enable no-restricted-syntax */
        const containers = [...document.querySelectorAll(scope)]
        return containers.length > 0 && containers.every((container) => {
          const slidePage = container.querySelector('.slidev-page')
          return slidePage !== null && isVisible(slidePage) && container.querySelector('.slidev-slide-loading') === null
        })
      },
      { scope: groupScope, visibleFn: slideVisibleFunctionSource },
      { timeout: timeouts.slideVisibility },
    )
    return undefined
  }
  catch (error) {
    // 時間切れのほか、ページの close / crash もここに来る。原因を理由に残す。
    return `スライドの読み込みが ${(timeouts.slideVisibility / 1000).toString()} 秒以内に終わりません: ${errorMessage(error)}`
  }
}

/**
detectPrintRoute の判定結果。
*/
type PrintRouteProbe
  = | { readonly kind: 'present' }
    /**
    `#page-root` が出たのに `#print-container` が無い（print ルートの無い build）
    */
    | { readonly kind: 'missing', readonly reason: string }
    /**
    時間内にどちらも出ず判定できない（読み込みが遅い等）。グループ単位の退避にする
    */
    | { readonly kind: 'undetermined', readonly reason: string }

/**
print ルートが build に入っているかを判定する。
`#print-container` か `#page-root` のどちらかが出るまで待つ（上限 5 s）。
その時点で `#print-container` が無ければ、不在とする。
print ルートの無い build（`__SLIDEV_FEATURE_PRINT__` が false）では、print の URL が play ルートとして扱われる。
そのため `#page-root` が出た時点で判定できる。
時間内にどちらも出ない場合は、不在とみなさない。
同期済みの deck が高負荷で遅いだけのことがあり、`slide_sync` の案内は誤りになるため。
*/
async function detectPrintRoute(page: Page): Promise<PrintRouteProbe> {
  try {
    await page.waitForFunction(
      (selector: string) => document.querySelector(selector) !== null,
      PRINT_ROUTE_PROBE_SELECTOR,
      { timeout: CONTAINER_APPEAR_TIMEOUT_MS },
    )
  }
  catch {
    return {
      kind: 'undetermined',
      reason: `print ルートを判定できません（${(CONTAINER_APPEAR_TIMEOUT_MS / 1000).toString()} 秒以内に ${PRINT_ROUTE_PROBE_SELECTOR} が出ません）`,
    }
  }
  const isPresent = await page.evaluate((selector: string) => globalThis.document.querySelector(selector) !== null, PRINT_ROOT_SELECTOR)
  return isPresent ? { kind: 'present' } : { kind: 'missing', reason: 'デッキの build に print ルートがありません' }
}

/**
print コンテナが期待どおり揃うまで待つ。揃わなければ退避理由を返す。
print ルートの有無は detectPrintRoute で判定済みの前提で、ここでは数と id を確かめる。
*/
async function waitForContainers(page: Page, totalSteps: number, groupIds: readonly string[]): Promise<string | undefined> {
  try {
    await page.waitForFunction(
      (selector: string) => document.querySelectorAll(selector).length > 0,
      PRINT_CONTAINER_SELECTOR,
      { timeout: CONTAINER_APPEAR_TIMEOUT_MS },
    )
  }
  catch {
    return `print コンテナが ${(CONTAINER_APPEAR_TIMEOUT_MS / 1000).toString()} 秒以内に出ません`
  }
  try {
    // コンテナは Vue の描画に合わせて段階的に増えるため、期待数に届くまで待つ。
    await page.waitForFunction(
      ({ selector, count }: { selector: string, count: number }) => document.querySelectorAll(selector).length >= count,
      { selector: PRINT_CONTAINER_SELECTOR, count: totalSteps },
      { timeout: CONTAINER_APPEAR_TIMEOUT_MS },
    )
  }
  catch {
    // 届かなかった場合は、直後の数の確認で退避理由にする。
  }
  const ids = await page.evaluate(
    (selector: string) => [...globalThis.document.querySelectorAll(selector)].map(element => element.id),
    PRINT_CONTAINER_SELECTOR,
  )
  if (ids.length !== totalSteps) {
    return `print コンテナ数が全走査のステップ数と一致しません（コンテナ ${ids.length.toString()} / ステップ ${totalSteps.toString()}）`
  }
  const present = new Set(ids)
  const missing = groupIds.filter(id => !present.has(id))
  return missing.length > 0 ? `ステップに対応する print コンテナが見つかりません（${missing.slice(0, 5).join(', ')}）` : undefined
}

/**
print ページで変換・撮影の前提が揃うまで待つ。
待つのは、コンテナが期待どおり揃う（waitForContainers）まで。
続けて、グループの全コンテナでスライド本体が描かれる（waitForGroupRendered）まで。
揃わなければ退避理由を返す。
揃ったら Web フォントの読み込みを待つ。layout が済んでから取らないと、読込を待たずに解決済みで返る。
*/
async function awaitPrintPageReady(page: Page, totalSteps: number, groupIds: readonly string[], groupScope: string, logger: Logger): Promise<string | undefined> {
  const notReady = await waitForContainers(page, totalSteps, groupIds) ?? await waitForGroupRendered(page, groupScope)
  if (notReady !== undefined) return notReady
  await waitForFontsReady(page, timeouts.fontsReady)
  await waitForDataWaitfor(page, groupScope, timeouts.dataWaitfor, logger)
  return undefined
}

/**
グループのいずれかのコンテナ内に存在する prerender 対象を返す。
*/
async function findPresentTargets(page: Page, targets: readonly PrerenderTarget[], groupScope: string): Promise<PrerenderTarget[]> {
  const present = await page.evaluate(
    ({ selectors, container }: { selectors: string[], container: string }) =>
      // セレクタリスト（`a, b`）でも全体をコンテナの内側に限るため :is() で包む
      selectors.filter(selector => globalThis.document.querySelector(`${container} :is(${selector})`) !== null),
    { selectors: targets.map(target => target.selector), container: groupScope },
  )
  const presentSet = new Set(present)
  return targets.filter(target => presentSet.has(target.selector))
}

/**
コンテナを viewport 先頭へスクロールし、2 フレーム待つ。
IntersectionObserver で遅延ロードする要素（LDrawioDiagramBare 等）は、交差判定が描画フレームの更新時に行われる。
1 フレーム目の rAF は判定より前に実行されるため、これだけでは読み込みが始まらない。
撮影対象を viewport 内に収めるので、captureAndReplaceElements の「viewport 外なら祖先の transform を外す」分岐にも入らない。
*/
async function scrollContainerToTop(page: Page, containerId: string): Promise<void> {
  await page.evaluate(async (selector: string) => {
    // ブラウザ側へ直列化される関数なので、補助関数も内側に置く。
    const nextFrame = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        if (typeof globalThis.requestAnimationFrame === 'function') {
          globalThis.requestAnimationFrame(() => {
            resolve()
          })
        }
        else {
          setTimeout(resolve, 0)
        }
      })
    }
    globalThis.document.querySelector(selector)?.scrollIntoView({ block: 'start', inline: 'start' })
    await nextFrame()
    await nextFrame()
  }, containerScopeSelector(containerId))
}

/**
selectorState 戦略を、待つセレクタ（`.loading-overlay` 等）ごとに対象セレクタを束ねたもの。
*/
interface SelectorWaitGroup {
  readonly strategySelector: string
  readonly targetSelector: string
  readonly timeout: number
}

function selectorWaitGroups(targets: readonly PrerenderTarget[], config: Readonly<PrerenderConfig>): SelectorWaitGroup[] {
  const groups = new Map<string, { selectors: string[], timeout: number }>()
  for (const target of targets) {
    const { selectorWait } = resolveWait(target, config.defaultWaitStrategy)
    if (selectorWait === undefined) continue
    const group = groups.get(selectorWait.selector) ?? { selectors: [], timeout: 0 }
    group.selectors.push(target.selector)
    group.timeout = Math.max(group.timeout, selectorWait.timeout)
    groups.set(selectorWait.selector, group)
  }
  return [...groups].map(([strategySelector, group]) => ({
    strategySelector,
    targetSelector: group.selectors.join(', '),
    timeout: group.timeout,
  }))
}

/**
1 コンテナの中で、selectorState の待つセレクタが対象から消えるまで待つ。
消えなかったものの説明を返す（空なら全部消えた）。
コンテナは viewport 内にある前提。遅延ロードする要素は、viewport に入るまで読み込みを始めないため。
`timeoutCap` を渡すと、各戦略の timeout をその値までに縮める。
*/
async function waitSelectorGroupsInContainer(
  page: Page,
  groups: readonly SelectorWaitGroup[],
  containerId: string,
  timeoutCap?: number,
): Promise<string[]> {
  const unresolved: string[] = []
  for (const group of groups) {
    const timeout = timeoutCap === undefined ? group.timeout : Math.min(group.timeout, timeoutCap)
    try {
      await waitForSelectorInVisibleSlide(page, group.targetSelector, group.strategySelector, {
        timeout,
        scopeSelector: containerScopeSelector(containerId),
      })
    }
    catch (error) {
      unresolved.push(`${group.targetSelector} の ${group.strategySelector} が ${(timeout / 1000).toString()} 秒以内に消えません（${errorMessage(error)}）`)
    }
  }
  return unresolved
}

/**
高解像度ページで、グループのコンテナを 1 つずつ viewport 先頭へ入れて、prerender 対象の読み込みを済ませる。
現行方式は、ターゲットごと・ステップごとに高解像度ページを開いて待つ。
ここでは次のようにまとめる。
- selectorState 戦略の対象を含むコンテナは、viewport に入れたまま、待つセレクタ（`.loading-overlay` 等）が消えるまで待つ。その後に次のコンテナへ進む。遅延ロードする要素（IntersectionObserver）は、viewport に入っている間しか読み込みを始めない。スクロールだけで次へ進むと、CPU 競合下で読み込みが始まらないまま外れる。#1147 の実機 CUJ で、Loading 状態の撮影として観測した。
- 対象を含まないコンテナは、viewport に入れて 2 フレーム待つだけ。
- fixed の delay と selectorState の settleDelay は、最大値で最後に 1 回待つ。

他グループのコンテナは扱わない。
待つセレクタが時間内に消えなかったコンテナを、`timedOut` に返す。撮影前の再待ちを短くするため。
*/
async function warmupPageB(
  page: Page,
  groupIds: readonly string[],
  targets: readonly PrerenderTarget[],
  config: Readonly<PrerenderConfig>,
  logger: Logger,
): Promise<{ readonly scrollMs: number, readonly waitMs: number, readonly timedOut: readonly string[] }> {
  let scrollMs = 0
  let waitMs = 0
  const timedOut: string[] = []
  for (const containerId of groupIds) {
    const [, scrolled] = await timed(async () => scrollContainerToTop(page, containerId))
    scrollMs += scrolled
    const [, waited] = await timed(async () => {
      const containerTargets = await findPresentTargets(page, targets, containerScopeSelector(containerId))
      const groups = selectorWaitGroups(containerTargets, config)
      if (groups.length === 0) return
      const unresolved = await waitSelectorGroupsInContainer(page, groups, containerId)
      if (unresolved.length > 0) timedOut.push(containerId)
      for (const description of unresolved) logger.warn(`  警告: コンテナ ${containerId} のレンダリング待機がタイムアウト: ${description}`)
      if (unresolved.length === 0) logger.info(`  コンテナ ${containerId}: ${groups.map(group => group.targetSelector).join(', ')} のレンダリング完了を検出`)
    })
    waitMs += waited
  }
  const [, settled] = await timed(async () => {
    const delay = Math.max(0, ...targets.map(target => resolveWait(target, config.defaultWaitStrategy).delay))
    if (delay > 0) await page.waitForTimeout(delay)
    await waitForCssAnimations(page, timeouts.cssAnimationSettle, logger)
  })
  return { scrollMs, waitMs: waitMs + settled, timedOut }
}

/**
高解像度ページ（ページ B）を開いて撮影の前提を揃え、`prepared` に載せる。揃わなければ理由を返す
（開いたページは `prepared.opened` に積まれ、呼び出し側が閉じる）。
*/
async function openPageB(
  request: SinglePassRequest,
  config: Readonly<PrerenderConfig>,
  prepared: PreparedPages,
  targets: readonly PrerenderTarget[],
): Promise<{ readonly page: Page } | { readonly reason: string }> {
  const { logger } = request
  // viewport と deviceScaleFactor は context（createRunContexts）で決まる
  const contextB = await prepared.contexts.forPageB()
  const pageB = await contextB.newPage()
  prepared.opened.push(pageB)
  await hideOtherContainers(pageB, prepared.groupIds)
  const [, gotoB] = await timed(async () => pageB.goto(prepared.url, { waitUntil: 'load' }))
  const notReadyB = await awaitPrintPageReady(pageB, request.totalSteps, prepared.groupIds, prepared.groupScope, logger)
  if (notReadyB !== undefined) return { reason: `高解像度ページ: ${notReadyB}` }
  const warmup = await warmupPageB(pageB, prepared.groupIds, targets, config, logger)
  for (const containerId of warmup.timedOut) prepared.warmupTimedOut.add(containerId)
  logger.info(`1 パス: 高解像度ページを用意しました（prerender 対象 ${targets.map(target => target.selector).join(', ')}）`)
  request.onProgress?.('1 パス: 高解像度ページの用意完了')
  prepared.pageB = pageB
  prepared.pageBTiming = { goto: gotoB, wait: warmup.waitMs, scrollWarmup: warmup.scrollMs }
  return { page: pageB }
}

/**
ページ B を開く。開けなければ（例外を含む）理由を `prepared.pageBFailure` に記録し、以後は
開き直さない。用意の時点と遅延オープンの両方がこれを通り、失敗の扱いを揃える
（prerender 対象を持つステップだけを現行 worker に回す）。
*/
async function tryOpenPageB(
  request: SinglePassRequest,
  config: Readonly<PrerenderConfig>,
  prepared: PreparedPages,
  targets: readonly PrerenderTarget[],
): Promise<{ readonly page: Page } | { readonly reason: string }> {
  let reason: string
  try {
    const openedB = await openPageB(request, config, prepared, targets)
    if ('page' in openedB) return openedB
    reason = openedB.reason
  }
  catch (error) {
    reason = `高解像度ページを用意できません: ${errorMessage(error)}`
  }
  prepared.pageBFailure = reason
  request.logger.warn(`1 パス: ${reason}（prerender 対象を含むステップは現行方式で変換します）`)
  return { reason }
}

/**
preparePages で前提が欠けた結果。`printRouteMissing` は print ルートの無い build、`notReady` はそれ以外。
*/
type NotPrepared
  = | { readonly kind: 'printRouteMissing', readonly reason: string }
    | { readonly kind: 'notReady', readonly reason: string }

/**
ページ A（と必要ならページ B）を開いて変換の前提を揃える。print ルートが無ければ
kind `printRouteMissing`、ページ A のそれ以外の前提が欠けたら kind `notReady` の退避理由を返す。
ページ B を開けなければ、`pageBFailure` に記録して先へ進む。
開いたページは、成否を問わず `opened` に積み、呼び出し側が閉じる。
*/
async function preparePages(
  request: SinglePassRequest,
  steps: readonly SlideStep[],
  config: Readonly<PrerenderConfig>,
  contexts: RunContexts,
  opened: Page[],
): Promise<PreparedPages | NotPrepared> {
  const { logger } = request
  const url = buildPrintUrl(request.baseUrl, request.urlFormat)
  const groupIds = steps.map(step => printContainerId(step))
  const groupScope = groupScopeSelector(groupIds)

  const contextA = await contexts.forPageA()
  const pageA = await contextA.newPage()
  opened.push(pageA)
  await hideOtherContainers(pageA, groupIds)
  const [, gotoA] = await timed(async () => {
    await pageA.setViewportSize({ width: slideViewport.width, height: slideViewport.height * groupIds.length })
    await pageA.goto(url, { waitUntil: 'load' })
  })

  const printRoute = await detectPrintRoute(pageA)
  if (printRoute.kind === 'missing') return { kind: 'printRouteMissing', reason: printRoute.reason }
  if (printRoute.kind === 'undetermined') return { kind: 'notReady', reason: printRoute.reason }

  const [notReadyA, visibleA] = await timed(async () => awaitPrintPageReady(pageA, request.totalSteps, groupIds, groupScope, logger))
  if (notReadyA !== undefined) return { kind: 'notReady', reason: notReadyA }

  const [, cssSettleA] = await timed(async () => waitForCssAnimations(pageA, timeouts.cssAnimationSettle, logger))
  const [, iframeLoadA] = await timed(async () => waitForIframeLoad(pageA, '.artifact-iframe', timeouts.iframeLoad, logger))
  const [, injectA] = await timed(async () => injectDomToPptx(pageA, request.workerConfig.libPath))
  logger.info(`1 パス: 変換ページを用意しました（${steps.length.toString()} ステップ）`)
  request.onProgress?.('1 パス: 変換ページの用意完了')

  const prepared: PreparedPages = {
    kind: 'ready',
    contexts,
    pageA,
    pageATiming: { goto: gotoA, visible: visibleA, cssSettle: cssSettleA, iframeLoad: iframeLoadA, inject: injectA },
    pageB: undefined,
    pageBTiming: undefined,
    pageBLazy: false,
    pageBFailure: undefined,
    warmupTimedOut: new Set(),
    url,
    groupIds,
    groupScope,
    opened,
  }
  const presentTargets = await findPresentTargets(pageA, config.targets, groupScope)
  // ページ B を開けなくてもグループは退避しない。対象を持たないステップは 1 パスのまま変換できる
  if (presentTargets.length > 0) await tryOpenPageB(request, config, prepared, presentTargets)
  return prepared
}

/**
ステップのコンテナに prerender 対象があるのに高解像度ページが無ければ、その時点で開く（保険）。
用意の時点の検出が、スライド本体の描画より先に終わる場合がある。
その場合でも、撮影を落とさないため。
開けなければ例外にし、そのステップを現行 worker に回す。
用意の時点を含め、一度失敗したら開き直さない。
*/
async function ensurePageB(
  request: SinglePassRequest,
  config: Readonly<PrerenderConfig>,
  prepared: PreparedPages,
  containerId: string,
): Promise<Page> {
  if (prepared.pageB !== undefined) return prepared.pageB
  if (prepared.pageBFailure !== undefined) throw new Error(prepared.pageBFailure)
  request.logger.warn(`1 パス: コンテナ ${containerId} に prerender 対象があるため高解像度ページを開きます（用意の時点では未検出）`)
  const groupTargets = await findPresentTargets(prepared.pageA, config.targets, prepared.groupScope)
  const openedB = await tryOpenPageB(request, config, prepared, groupTargets)
  if ('reason' in openedB) throw new Error(openedB.reason)
  prepared.pageBLazy = true
  return openedB.page
}

/**
ページ A でのコンテナの左上（viewport 座標）。meta.json の座標をスライド基準にする原点。
*/
async function containerOrigin(page: Page, containerId: string): Promise<{ x: number, y: number }> {
  const origin = await page.evaluate((selector: string) => {
    const rect = globalThis.document.querySelector(selector)?.getBoundingClientRect()
    return rect === undefined ? undefined : { x: rect.x, y: rect.y }
  }, containerScopeSelector(containerId))
  if (origin === undefined) throw new Error(`ステップに対応する print コンテナが見つかりません（${containerId}）`)
  return origin
}

/**
prerenderInContainer の入力。
*/
interface ContainerPrerenderRequest {
  readonly pageA: Page
  readonly pageB: Page
  /**
  対象コンテナに存在する prerender 対象
  */
  readonly targets: readonly PrerenderTarget[]
  readonly containerId: string
  readonly stepIndex: number
  readonly config: Readonly<PrerenderConfig>
  readonly slidesDir: string
  readonly logger: Logger
  /**
  ウォームアップで待つセレクタが消えなかったコンテナ（PreparedPages.warmupTimedOut）
  */
  readonly warmupTimedOut: ReadonlySet<string>
}

/**
対象コンテナ内の prerender 対象を撮影し、ページ A の要素を画像に差し替える。
*/
async function prerenderInContainer(request: Readonly<ContainerPrerenderRequest>): Promise<PrerenderResult[]> {
  const { pageA, pageB, targets, containerId, stepIndex, config, slidesDir, logger, warmupTimedOut } = request
  const scope = containerScopeSelector(containerId)
  const results: PrerenderResult[] = []
  let globalIndex = 0
  let origin: { x: number, y: number } | undefined
  let isScrolled = false
  for (const target of targets) {
    const elements = await locateTargetsInVisibleSlides(pageA, target.selector, scope)
    let hiResElements: Awaited<ReturnType<typeof locateTargetsInVisibleSlides>> = []
    // ページ A / B はグループ全体で使い続けるため、ターゲットごとにハンドルを解放する
    try {
      logger.verbose(`  ${target.selector}: ${elements.length.toString()}件検出`)
      if (elements.length === 0) continue
      origin ??= await containerOrigin(pageA, containerId)
      if (!isScrolled) {
        await scrollContainerToTop(pageB, containerId)
        isScrolled = true
        // 撮影前の保険。
        // コンテナを viewport 先頭へ入れ直し、待つセレクタ（`.loading-overlay` 等）が残っていないかを確かめる。
        // ウォームアップで消えたコンテナは、即時に通る。
        // ウォームアップで時間切れになったコンテナは、遅れて読み込みが終わった分だけを拾う。
        // そのため、短い上限（PRE_CAPTURE_RECHECK_TIMEOUT_MS）で待ち直す。
        // LDrawioDiagramBare 等は、最初の交差で読み込みを始めた後は、viewport を外れても止まらない。
        // 待ち直しで読み込みが始まるわけではない。
        // それでも残っていれば、撮影せずに投げ、このステップを現行 worker に回す。
        // 保証するのは、1 パス変換の側で Loading 状態を撮影しないことまで。
        // 現行 worker は、時間切れでも撮影する。
        const recheckCap = warmupTimedOut.has(containerId) ? PRE_CAPTURE_RECHECK_TIMEOUT_MS : undefined
        const unresolved = await waitSelectorGroupsInContainer(pageB, selectorWaitGroups(targets, config), containerId, recheckCap)
        if (unresolved.length > 0) {
          throw new Error(`高解像度ページで prerender 対象の読み込みが終わりません（コンテナ ${containerId}: ${unresolved.join(' / ')}）`)
        }
      }
      hiResElements = await locateTargetsInVisibleSlides(pageB, target.selector, scope)
      logger.verbose(`  ${target.selector}: ${hiResElements.length.toString()}件検出 (hiRes)`)
      if (elements.length !== hiResElements.length) {
        logger.warn(`  警告: ${target.selector} の検出数が不一致 (page: ${elements.length.toString()}, hiRes: ${hiResElements.length.toString()})`)
      }
      const capture = await captureAndReplaceElements({
        hiResPage: pageB,
        elements,
        hiResElements,
        target,
        config,
        slideNum: stepIndex,
        slidesDir,
        globalIndex,
        logger,
        origin,
      })
      results.push(...capture.results)
      globalIndex += capture.processedCount
      if (capture.count > 0) {
        logger.info(`  プリレンダリング: ${target.selector} → ${capture.count.toString()}件を画像化 (${config.deviceScaleFactor.toString()}x)`)
      }
      if (capture.errors.length > 0) {
        logger.warn(`  警告: ${target.selector} で ${capture.errors.length.toString()}件のエラー`)
        for (const error of capture.errors) logger.warn(`    - ${error}`)
      }
    }
    finally {
      await disposeHandles([...elements, ...hiResElements])
    }
  }
  return results
}

/**
html2canvas の除外目印を付け直す。
dom-to-pptx は要素ごとに html2canvas を呼ぶ。
html2canvas は毎回 document 全体を clone する。
そのため、変換中は対象以外のコンテナを clone から外す。
- `targetId` を指定したとき: 対象以外のコンテナに目印を付ける。対象コンテナからは、前ステップの後始末が失敗していても外す。
- 省略したとき: 全コンテナから外す（ステップの後始末）。
*/
async function setIgnoredMarks(page: Page, targetId?: string): Promise<void> {
  await page.evaluate(({ selector, id, attribute }: { selector: string, id: string | null, attribute: string }) => {
    for (const container of globalThis.document.querySelectorAll(selector)) {
      container.toggleAttribute(attribute, !(id === null || container.id === id))
    }
    // eslint-disable-next-line unicorn/no-null -- page.evaluate の引数は直列化されるため undefined でなく null で渡す
  }, { selector: PRINT_CONTAINER_SELECTOR, id: targetId ?? null, attribute: HTML2CANVAS_IGNORE_ATTRIBUTE })
}

/**
後始末を 1 つ実行し、失敗は警告に留める（finally から投げて元の例外を上書きしないため）。
*/
async function cleanupBestEffort(logger: Logger, label: string, cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup()
  }
  catch (error) {
    logger.warn(`1 パス: ${label}に失敗しました: ${errorMessage(error)}`)
  }
}

/**
1 ステップを変換する。DOM の書き換え（差し替え・除外目印）は成否によらず finally で戻す。
*/
async function convertStepInPrintPage(
  prepared: PreparedPages,
  step: Readonly<SlideStep>,
  request: SinglePassRequest,
  config: Readonly<PrerenderConfig>,
): Promise<SlideConvertResult> {
  const { logger, slidesDir, workerConfig } = request
  const stepStart = performance.now()
  const containerId = printContainerId(step)
  const scope = containerScopeSelector(containerId)
  const stepIndex = stepIndexOf(step)
  logger.info(`\nスライド #${stepKeyOf(step)} を変換中（1 パス、コンテナ ${containerId}）...`)

  let prerenderMs: number
  let convertMs: number
  let restoreMs: number
  let prerenderResults: PrerenderResult[]
  let converted: Awaited<ReturnType<typeof convertSlide>>
  try {
    [prerenderResults, prerenderMs] = await timed(async () => {
      // 対象はコンテナごとに検出し直す（用意の時点の検出がスライド本体の描画より先に終わっても落とさない）
      const containerTargets = await findPresentTargets(prepared.pageA, config.targets, scope)
      if (containerTargets.length === 0) return []
      const pageB = await ensurePageB(request, config, prepared, containerId)
      return prerenderInContainer({
        pageA: prepared.pageA,
        pageB,
        targets: containerTargets,
        containerId,
        stepIndex,
        config,
        slidesDir,
        logger,
        warmupTimedOut: prepared.warmupTimedOut,
      })
    })
    ;[converted, convertMs] = await timed(async () => {
      await setIgnoredMarks(prepared.pageA, containerId)
      return convertSlide(
        prepared.pageA,
        stepIndex,
        workerConfig.slidePrefix,
        slidesDir,
        logger,
        workerConfig.exportOptions,
        { targetSelector: `${scope} .slidev-page` },
      )
    })
  }
  finally {
    // 2 つの後始末は互いに独立させ、失敗しても try 内の元の例外を優先する
    ;[, restoreMs] = await timed(async () => {
      await cleanupBestEffort(logger, `除外目印の解除（コンテナ ${containerId}）`, async () => setIgnoredMarks(prepared.pageA))
      await cleanupBestEffort(logger, `prerender 差し替えの復元（コンテナ ${containerId}）`, async () => restorePrerenderElements(prepared.pageA, logger, scope))
    })
  }

  const phases: SlidePhases = {
    newPage: 0,
    goto: 0,
    visible: 0,
    cssSettle: 0,
    iframeLoad: 0,
    inject: 0,
    prerender: prerenderMs,
    convert: convertMs,
    restore: restoreMs,
  }
  return {
    step,
    letterSpacingMap: converted.letterSpacingMap,
    hrefMap: converted.hrefMap,
    hasExplicitAnimation: converted.hasExplicitAnimation,
    prerenderResults,
    elapsed: elapsedSince(stepStart),
    phases,
  }
}

/**
失敗したステップが staging に残した成果物を消す。
対象は `<prefix><stepIndex>.pptx` と `prerender-slide<stepIndex>-*`。
キャッシュ保存は staging を readdir で拾う。
そのため、現行 worker の再変換で枚数が減ると、古い prerender が紛れ込む。
staging は 1 回だけ読み、対象ステップの分をまとめて消す。
*/
export async function removeStepArtifacts(slidesDir: string, stepIndices: readonly number[], slidePrefix: string): Promise<void> {
  if (stepIndices.length === 0) return
  const pptxNames = new Set(stepIndices.map(stepIndex => `${slidePrefix}${stepIndex.toString()}.pptx`))
  const prerenderPrefixes = stepIndices.map(stepIndex => `prerender-slide${stepIndex.toString()}-`)
  const names = await readdir(slidesDir)
  const targets = names.filter(name => pptxNames.has(name) || prerenderPrefixes.some(prefix => name.startsWith(prefix)))
  await Promise.all(targets.map(async name => rm(path.join(slidesDir, name), { force: true })))
}

/**
1 グループ分の変換結果。settled は group の steps と同じ順序。
*/
interface GroupOutcome {
  readonly settled: readonly PromiseSettledResult<SlideConvertResult>[]
  readonly timing: SinglePassGroupTiming
  /**
  現行 worker に回したステップ
  */
  readonly fallbackSteps: readonly SlideStep[]
  /**
  ステップ単位で現行 worker に回した理由（`スライド #2/1: …`）
  */
  readonly stepFallbacks: readonly string[]
  /**
  print ルートが無いと判定した理由。あればどのステップも変換していない（settled は空）
  */
  readonly printRouteMissing?: string
}

/**
ステップを現行 worker で直列に変換し、結果を `settled` に書き込む（index は group 内の添字）。
現行 worker は自前のリトライを持つ。
*/
async function runFallbackSteps(
  request: SinglePassRequest,
  failed: readonly { readonly index: number, readonly step: SlideStep }[],
  settled: Map<number, PromiseSettledResult<SlideConvertResult>>,
): Promise<void> {
  for (const { index, step } of failed) {
    if (request.signal?.aborted === true) throw new Error('aborted')
    try {
      const value = await request.fallbackRunner(request.browser, step, request.workerConfig, request.slidesDir, request.logger)
      settled.set(index, { status: 'fulfilled', value })
      request.onProgress?.(`スライド #${stepKeyOf(step)} 変換完了`)
    }
    catch (error) {
      settled.set(index, { status: 'rejected', reason: error })
      request.onProgress?.(`スライド #${stepKeyOf(step)} 変換失敗`)
    }
    request.onStepDone?.(step)
  }
}

/**
settled を steps の順に並べる。全ステップは、1 パス変換の結果か現行 worker の結果のどちらかを必ず持つ。
*/
function orderedSettled(
  steps: readonly SlideStep[],
  settled: ReadonlyMap<number, PromiseSettledResult<SlideConvertResult>>,
): PromiseSettledResult<SlideConvertResult>[] {
  return steps.map((step, index): PromiseSettledResult<SlideConvertResult> =>
    settled.get(index)
    /* c8 ignore next -- 全ステップは 1 パス変換か現行 worker の結果を必ず持つ。防御網 */
    ?? { status: 'rejected', reason: new Error(`スライド #${stepKeyOf(step)} が未変換です`) },
  )
}

/**
1 グループを 1 ペアのページで変換する。
前提が欠けたら、グループのステップをすべて現行 worker へ回す。
変換で失敗したら、そのステップだけを現行 worker へ回す。
どちらも、ページを閉じた後に回す。
print ルートが無ければ、何も変換せず `printRouteMissing` を返す。
この場合は現行 worker にも回さない。
判定の時間切れはここに含めず、前提の欠けとして退避する。
*/
async function convertGroup(
  request: SinglePassRequest,
  steps: readonly SlideStep[],
  config: Readonly<PrerenderConfig>,
  contexts: RunContexts,
): Promise<GroupOutcome> {
  const { logger } = request
  const slides = [...new Set(steps.map(step => step.slideNumber))].toSorted((a, b) => a - b)
  const settled = new Map<number, PromiseSettledResult<SlideConvertResult>>()
  const failed: { readonly index: number, readonly step: SlideStep }[] = []
  const stepFallbacks: string[] = []
  const opened: Page[] = []
  let timing: SinglePassGroupTiming = { slides, steps: steps.length }
  let printRouteMissing: string | undefined

  try {
    let prepared: Awaited<ReturnType<typeof preparePages>>
    try {
      prepared = await preparePages(request, steps, config, contexts, opened)
    }
    catch (error) {
      prepared = { kind: 'notReady', reason: `print ページを用意できません: ${errorMessage(error)}` }
    }
    if (prepared.kind === 'printRouteMissing') {
      printRouteMissing = prepared.reason
    }
    else if (prepared.kind === 'notReady') {
      timing = { ...timing, fallback: prepared.reason }
      for (const [index, step] of steps.entries()) failed.push({ index, step })
    }
    else {
      timing = { ...timing, pageA: prepared.pageATiming }
      for (const [index, step] of steps.entries()) {
        if (request.signal?.aborted === true) throw new Error('aborted')
        try {
          const value = await convertStepInPrintPage(prepared, step, request, config)
          settled.set(index, { status: 'fulfilled', value })
          request.onProgress?.(`スライド #${stepKeyOf(step)} 変換完了`)
          request.onStepDone?.(step)
        }
        catch (error) {
          logger.warn(`1 パス: スライド #${stepKeyOf(step)} の変換に失敗したため現行方式で変換し直します: ${errorMessage(error)}`)
          failed.push({ index, step })
          stepFallbacks.push(`スライド #${stepKeyOf(step)}: ${errorMessage(error)}`)
          request.onProgress?.(`スライド #${stepKeyOf(step)} 1 パス変換失敗`)
        }
      }
      // 高解像度ページはステップ処理中に開くことがあるため、ループの後で載せる
      if (prepared.pageBTiming !== undefined) {
        timing = { ...timing, pageB: prepared.pageBTiming, ...(prepared.pageBLazy && { lazyPageB: true }) }
      }
    }
  }
  finally {
    for (const page of opened.toReversed()) {
      // 閉じられなくても変換結果には影響しない
      await ignoreRejection(page.close())
    }
  }

  if (printRouteMissing !== undefined) {
    return { settled: [], timing, fallbackSteps: [], stepFallbacks, printRouteMissing }
  }

  // ページを閉じてから現行 worker に回す。
  // ページ A の tall viewport を抱えたまま、新しいページを開かないため。
  if (failed.length > 0 && request.signal?.aborted !== true) {
    await removeStepArtifacts(request.slidesDir, failed.map(({ step }) => stepIndexOf(step)), request.workerConfig.slidePrefix)
  }
  await runFallbackSteps(request, failed, settled)

  return {
    settled: orderedSettled(steps, settled),
    timing,
    fallbackSteps: failed.map(({ step }) => step),
    stepFallbacks,
  }
}

/**
print ルートが無いと判定したグループを、他のグループが変換できた run で現行 worker に回す。
同じ build を開くため、全グループの判定は揃うのが通常。
食い違ったときの防御網になる。
*/
async function fallbackMissingGroup(request: SinglePassRequest, steps: readonly SlideStep[], timing: SinglePassGroupTiming, reason: string): Promise<GroupOutcome> {
  const settled = new Map<number, PromiseSettledResult<SlideConvertResult>>()
  const failed = steps.map((step, index) => ({ index, step }))
  await runFallbackSteps(request, failed, settled)
  return { settled: orderedSettled(steps, settled), timing: { ...timing, fallback: reason }, fallbackSteps: steps, stepFallbacks: [] }
}

/**
1 パス変換の本体。
pipeline の Phase 1 から、全走査かつ `config.singlePass` のときだけ呼ばれる。
グループの処理が例外（abort 等）で終わったら、その例外をそのまま投げる。
全グループが print ルートの不在を判定したら、何も変換せず kind `printRouteMissing` を返す。
*/
export async function convertStepsSinglePass(request: SinglePassRequest): Promise<SinglePassOutcome> {
  const startedAt = performance.now()
  const config = request.prerenderConfig ?? defaultPrerenderConfig
  const groups = partitionStepsBySlide(request.steps, request.concurrency)
  request.logger.info(`1 パス: ${request.steps.length.toString()} ステップを ${groups.length.toString()} グループに分けて変換します`)
  const contexts = createRunContexts(request.browser, config)
  let settledGroups: PromiseSettledResult<GroupOutcome>[]
  // 全グループの settle までの経過時間。print ルートの不在で退避する run の detectMs に使う
  let settledMs: number
  try {
    settledGroups = await runWithConcurrency(
      groups.map(steps => async () => convertGroup(request, steps, config, contexts)),
      groups.length,
    )
    settledMs = elapsedSince(startedAt)
  }
  finally {
    // ページはグループごとに閉じ済み。print ルートの不在で現行 worker に回すグループは context を使わない
    await contexts.close()
  }

  const outcomes: GroupOutcome[] = []
  for (const groupResult of settledGroups) {
    if (groupResult.status === 'rejected') throw groupResult.reason
    outcomes.push(groupResult.value)
  }
  const missingReason = outcomes.find(outcome => outcome.printRouteMissing !== undefined)?.printRouteMissing
  if (missingReason !== undefined && outcomes.every(outcome => outcome.printRouteMissing !== undefined)) {
    return { kind: 'printRouteMissing', timing: { kind: 'printRouteMissing', fallback: missingReason, detectMs: settledMs } }
  }
  for (const [groupIndex, outcome] of outcomes.entries()) {
    if (outcome.printRouteMissing === undefined) continue
    // eslint-disable-next-line security/detect-object-injection -- groupIndex は outcomes の添字で groups と同じ長さ
    outcomes[groupIndex] = await fallbackMissingGroup(request, groups[groupIndex] ?? [], outcome.timing, outcome.printRouteMissing)
  }

  const resultOf = new Map<SlideStep, PromiseSettledResult<SlideConvertResult>>()
  const groupTimings: SinglePassGroupTiming[] = []
  const fallbackStepSet = new Set<SlideStep>()
  const fallbacks: string[] = []
  for (const [groupIndex, { settled, timing, fallbackSteps, stepFallbacks }] of outcomes.entries()) {
    // eslint-disable-next-line security/detect-object-injection -- groupIndex は outcomes の添字で groups と同じ長さ
    const groupSteps = (groups[groupIndex] ?? []).entries()
    for (const [index, step] of groupSteps) {
      // eslint-disable-next-line security/detect-object-injection -- index は同じグループの添字
      const result = settled[index]
      if (result !== undefined) resultOf.set(step, result)
    }
    groupTimings.push(timing)
    for (const step of fallbackSteps) fallbackStepSet.add(step)
    if (timing.fallback !== undefined) fallbacks.push(`スライド ${timing.slides.join(',')}: ${timing.fallback}`)
    fallbacks.push(...stepFallbacks)
  }

  const results = request.steps.map((step): PromiseSettledResult<SlideConvertResult> =>
    resultOf.get(step)
    /* c8 ignore next -- 各ステップはちょうど 1 つのグループに属し結果を持つ。防御網 */
    ?? { status: 'rejected', reason: new Error(`スライド #${stepKeyOf(step)} が未変換です`) },
  )
  return {
    kind: 'converted',
    results,
    timing: {
      kind: 'converted',
      groups: groupTimings,
      fallbackSteps: request.steps.filter(step => fallbackStepSet.has(step)).map(step => stepKeyOf(step)),
    },
    fallbacks,
  }
}
/* eslint-enable unicorn/name-replacements, security/detect-non-literal-fs-filename */
/* eslint-enable @typescript-eslint/prefer-readonly-parameter-types */
