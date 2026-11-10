// @vitest-environment jsdom
/* eslint-disable unicorn/name-replacements -- jsdom と fake で全体フローを検証 */
/* eslint-disable @typescript-eslint/no-explicit-any -- jsdom と fake で全体フローを検証 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { defaultExportToPptxOptions } from '../../../domain/slidev-to-pptx/config.js'
import type { SlideStep } from '../../../domain/slidev-to-pptx/types.js'
import { stepKeyOf } from '../../../domain/slidev-to-pptx/step-index.js'
import type { PrerenderConfig } from '../prerender-config.js'
import {
  containerScopeSelector,
  convertStepsSinglePass,
  groupScopeSelector,
  otherContainersHiddenCss,
  partitionStepsBySlide,
  printContainerId,
  type SinglePassConverted,
  type SinglePassOutcome,
  type SinglePassRequest,
} from '../single-pass-worker.js'
import type { SlideConvertResult, SlideWorkerRunner } from '../slide-worker.js'
import { FakeBrowser, FakeElementHandle, FakePage } from './support/fake-playwright.js'
import { makeLogger } from './support/logger.js'
import { compareStrings } from '../../../domain/_shared/compare-strings.js'

const BASE_URL = 'http://localhost:4001'

const steps: SlideStep[] = [
  { slideNumber: 1, clickStep: null, url: `${BASE_URL}/1` },
  { slideNumber: 2, clickStep: null, url: `${BASE_URL}/2` },
  { slideNumber: 2, clickStep: 1, url: `${BASE_URL}/2?clicks=1` },
]

const prerender: PrerenderConfig = {
  targets: [
    { selector: '.point-number' },
    {
      selector: '.diagram-block',
      waitStrategy: { type: 'selectorState', selector: '.loading-overlay', timeout: 1000, settleDelay: 300 },
    },
    {
      selector: '.terminal-window',
      waitStrategy: { type: 'selectorState', selector: '.loading-overlay', timeout: 2000 },
    },
    { selector: '.absent' },
  ],
  defaultWaitStrategy: { type: 'fixed', delay: 200 },
  deviceScaleFactor: 5,
  pptxImageScale: 2,
}

/**
print ページ相当の DOM。
print.vue のルート（`#page-root`）と PrintContainer.vue（`#print-container`）の下へ置く。
置くのは、各コンテナ 1 つの可視 `.slidev-page`。
*/
function printDom(containers: readonly Readonly<{ id: string, inner?: string }>[]): string {
  const body = containers
    .map(({ id, inner = '' }) => `<div class="print-slide-container" id="${id}"><div class="slidev-page" style="display:block"><span>${id}</span>${inner}</div></div>`)
    .join('')
  return `<div id="page-root"><div id="print-container">${body}</div></div>`
}

/**
print ルートの無い build で print の URL が落ちる play ページ相当の DOM（`#print-container` が無い）。
*/
const PLAY_DOM = '<div id="page-root"><div class="slidev-page" style="display:block"><span>play</span></div></div>'

/**
1 パスで変換した結果だけを受け取る（print ルートの不在の印なら失敗にする）。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Playwright の可変型
async function convertExpectingConverted(request: SinglePassRequest): Promise<SinglePassConverted> {
  const outcome: SinglePassOutcome = await convertStepsSinglePass(request)
  if (outcome.kind === 'printRouteMissing') throw new Error(`print ルートの不在と判定されました: ${outcome.timing.fallback}`)
  return outcome
}

const plainContainers = [{ id: '001-01' }, { id: '002-01' }, { id: '002-02' }]

/**
コンテナの viewport 座標（ページ A は tall viewport で縦積み）を返す getBoundingClientRect の差し替え。
*/
function rectAt(y: number): () => DOMRect {
  return () => ({ x: 0, y, width: 960, height: 540, top: y, left: 0, right: 960, bottom: y + 540, toJSON: () => ({}) })
}

interface ExportCall {
  readonly container: string | undefined
  readonly ignored: readonly string[]
}

/**
`selector` の対象を 1 つ持つスライド要素（`.slidev-page`）の fake。box は対象の boundingBox。
*/
function slideWithTarget(
  selector: string,
  box?: Readonly<{ x: number, y: number, width: number, height: number }>,
): { slide: FakeElementHandle, target: FakeElementHandle } {
  const target = new FakeElementHandle(box === undefined ? {} : { boundingBoxes: [{ ...box }] })
  const slide = new FakeElementHandle({ $$TargetsBySelector: new Map([[selector, [target.asElementHandle()]]]) })
  return { slide, target }
}

function makeResult(step: Readonly<SlideStep>): SlideConvertResult {
  return { step, letterSpacingMap: {}, hrefMap: {}, hasExplicitAnimation: false, prerenderResults: [], elapsed: 999 }
}

describe('printContainerId / containerScopeSelector', () => {
  it('clickStep null は先頭の段 (01)、N は N+1 になり、スライド番号は 3 桁で埋める', () => {
    expect(printContainerId({ slideNumber: 1, clickStep: null, url: '' })).toBe('001-01')
    expect(printContainerId({ slideNumber: 12, clickStep: 2, url: '' })).toBe('012-03')
  })

  it('数字始まりの id を属性セレクタで指す', () => {
    expect(containerScopeSelector('005-02')).toBe('[id="005-02"]')
  })

  it('グループのコンテナを :is() で束ねて指す', () => {
    expect(groupScopeSelector(['001-01', '002-02'])).toBe(':is([id="001-01"], [id="002-02"])')
  })

  it('otherContainersHiddenCss はグループ外のコンテナだけを display: none にする規則を返す (#1161)', () => {
    const css = otherContainersHiddenCss(['001-01', '002-02'])
    expect(css).toBe('.print-slide-container:not([id="001-01"], [id="002-02"]) { display: none !important; }')
    document.body.innerHTML = printDom([{ id: '001-01' }, { id: '002-01' }, { id: '002-02' }, { id: '003-01' }])
    const selector = css.slice(0, css.indexOf(' {'))
    expect([...document.querySelectorAll(selector)].map(element => element.id)).toStrictEqual(['002-01', '003-01'])
  })
})

/**
スライドごとのステップ数からステップ列を作る（clickStep は null, 1, 2, …）。
*/
function stepsOf(counts: readonly number[]): SlideStep[] {
  return counts.flatMap((count, index) => Array.from({ length: count }, (_v, click) => ({
    slideNumber: index + 1,
    clickStep: click === 0 ? null : click,
    url: `${BASE_URL}/${(index + 1).toString()}`,
  })))
}

/**
グループをスライド番号の列で表す（検証用）。
*/
function slidesOfGroups(groups: readonly (readonly SlideStep[])[]): number[][] {
  return groups.map(group => [...new Set(group.map(step => step.slideNumber))])
}

describe('partitionStepsBySlide', () => {
  it('K=1 なら全ステップを入力順のまま 1 グループにする', () => {
    const input = stepsOf([1, 3, 2])
    expect(partitionStepsBySlide(input, 1)).toStrictEqual([input])
  })

  it('スライド順の連続区間に分け、ステップ数で均等に近くする', () => {
    const eightSlides = Array.from({ length: 8 }, () => 1)
    const evenGroups = partitionStepsBySlide(stepsOf(eightSlides), 4)
    expect(slidesOfGroups(evenGroups))
      .toStrictEqual([[1, 2], [3, 4], [5, 6], [7, 8]])
    // ステップ数は 3 / 1 / 1 / 1 / 3 / 1 で計 10。累積が 10/2 を超えたところで切る
    const groups = partitionStepsBySlide(stepsOf([3, 1, 1, 1, 3, 1]), 2)
    expect(slidesOfGroups(groups)).toStrictEqual([[1, 2, 3], [4, 5, 6]])
    expect(groups.map(group => group.length)).toStrictEqual([5, 5])
  })

  it('同じスライドのステップは分けず、各グループ内のステップ順は入力のまま', () => {
    const input = stepsOf([1, 5, 1])
    const groups = partitionStepsBySlide(input, 3)
    expect(slidesOfGroups(groups)).toStrictEqual([[1], [2], [3]])
    expect(groups.flat()).toStrictEqual(input)
  })

  it('大きいスライドが先にあっても、スライド数が足りる限り K 個にする', () => {
    const bigFirst = partitionStepsBySlide(stepsOf([10, 1, 1]), 3)
    const bigLast = partitionStepsBySlide(stepsOf([1, 1, 10]), 3)
    expect(slidesOfGroups(bigFirst)).toStrictEqual([[1], [2], [3]])
    expect(slidesOfGroups(bigLast)).toStrictEqual([[1], [2], [3]])
  })

  it('グループ数はスライド数を超えず、K が 1 未満なら 1 とみなす', () => {
    expect(partitionStepsBySlide(stepsOf([2, 1]), 4)).toHaveLength(2)
    expect(partitionStepsBySlide(stepsOf([2, 1]), 0)).toHaveLength(1)
    expect(partitionStepsBySlide([], 4)).toStrictEqual([])
  })

  it('同じ入力には同じ分け方を返す', () => {
    const input = stepsOf([2, 1, 4, 1, 1, 3, 1])
    expect(partitionStepsBySlide(input, 3)).toStrictEqual(partitionStepsBySlide(input, 3))
  })
})

/**
用意の時点のグループ検出だけを「対象なし」にする（描画前に検出が終わった状況の再現）。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
function missFirstGroupDetection(page: FakePage): void {
  const original = page.evaluate.bind(page)
  let isMissed = false
  page.evaluate = async <R>(fn: any, arg?: unknown): Promise<R> => {
    const container = (arg as { container?: unknown } | undefined)?.container
    if (!isMissed && typeof container === 'string' && container.startsWith(':is(')) {
      isMissed = true
      return [] as R
    }
    return original<R>(fn, arg)
  }
}

/**
遅延ロードする要素の fake。
対象は、IntersectionObserver で viewport に入ってから読み込む LDrawioDiagramBare 等。
最後に scrollIntoView されたコンテナを「viewport 先頭」とする。
待ち戦略の待ち（strategySel を持つ waitForFunction）が実行された時点で、先頭にあるコンテナの overlay だけを外す。
`neverLoads` なら外さない。
`loadsOnWait: n` なら、各コンテナの n 回目の待ちで初めて外す。それまでの待ちは時間切れになる。
待ちの判定が偽なら、時間切れとして投げる。実 Playwright の timeout 相当で、fake の既定は投げない。
戻り値の events にはスクロールと待ちを、timeouts には待ちごとの timeout を順に記録する。
*/
function installLazyLoading(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- test 内 stub
  page: FakePage,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 実装を差し替える vi.fn
  scrollIntoView: Mock,
  options: Readonly<{ neverLoads?: boolean, loadsOnWait?: number }> = {},
): { events: string[], timeouts: unknown[] } {
  const events: string[] = []
  const timeouts: unknown[] = []
  const waitCounts = new Map<string, number>()
  let top: string | undefined
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- this は DOM 要素
  scrollIntoView.mockImplementation(function (this: Element) {
    top = this.id
    events.push(`scroll ${this.id}`)
  })
  const original = page.waitForFunction.bind(page)
  page.waitForFunction = async <R>(fn: any, arg?: unknown, waitOptions?: unknown): Promise<R> => {
    const strategy = arg as { strategySel?: string, pageSel?: string } | undefined
    if (strategy?.strategySel === undefined) return original<R>(fn, arg, waitOptions)
    events.push(`wait ${String(strategy.pageSel)}`)
    timeouts.push((waitOptions as { timeout?: unknown } | undefined)?.timeout)
    if (top !== undefined && options.neverLoads !== true) {
      const count = (waitCounts.get(top) ?? 0) + 1
      waitCounts.set(top, count)
      if (count >= (options.loadsOnWait ?? 1)) {
        for (const overlay of document.querySelectorAll(`[id="${CSS.escape(top)}"] ${strategy.strategySel}`)) overlay.remove()
      }
    }
    const done = await page.evaluate<R>(fn, arg)
    if (done !== true) throw new Error('waitForFunction timed out (fake lazy load)')
    return done
  }
  return { events, timeouts }
}

/**
遅延ロードする要素（`.diagram-block` と読み込み中の `.loading-overlay`）を 002-01 / 002-02 に持つ print ページ。
*/
const lazyDiagramContainers = [
  { id: '001-01' },
  { id: '002-01', inner: '<div class="diagram-block"><div class="loading-overlay">Loading diagram…</div></div>' },
  { id: '002-02', inner: '<div class="diagram-block"><div class="loading-overlay">Loading diagram…</div></div>' },
]

/**
ディレクトリの中身（無ければ空）。
*/
function readdirSyncSafe(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : []
}

describe('convertStepsSinglePass', () => {
  let slidesDir: string
  let exportCalls: ExportCall[]
  let failContainer: string | undefined
  let scrollIntoView: Mock
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

  beforeAll(async () => {
    slidesDir = await mkdtemp(path.join(tmpdir(), 'pecotv-single-pass-'))
  })

  afterAll(async () => {
    await rm(slidesDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    exportCalls = []
    failContainer = undefined
    document.getAnimations = (): Animation[] => []
    // jsdom は scrollIntoView を持たない
    scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    // jsdom は CSS.escape を持たない。ID は英数字とハイフンだけなのでエスケープ不要。
    vi.stubGlobal('CSS', { escape: (value: string) => value })
    vi.stubGlobal('domToPptx', {
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- DOM 要素の test 内 stub
      exportToPptx: async (element: Readonly<Element>): Promise<Blob> => {
        const container = element.closest('.print-slide-container')?.id
        exportCalls.push({
          container,
          ignored: [...document.querySelectorAll('[data-html2canvas-ignore]')].map(e => e.id),
        })
        if (container !== undefined && container === failContainer) throw new Error(`export failed: ${container}`)
        return new Blob([new Uint8Array([1, 2, 3])])
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalScrollIntoView === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  })

  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- fake は可変な記録を持つ
  function makeRequest(browser: Readonly<FakeBrowser>, overrides: Readonly<Partial<SinglePassRequest>> = {}): SinglePassRequest {
    return {
      browser: browser.asBrowser(),
      baseUrl: BASE_URL,
      urlFormat: { hash: false },
      steps,
      workerConfig: { slidePrefix: 'slide-', libPath: '/lib.js', exportOptions: defaultExportToPptxOptions },
      slidesDir,
      logger: makeLogger(),
      fallbackRunner: vi.fn<SlideWorkerRunner>(async (_b, step) => makeResult(step)),
      prerenderConfig: prerender,
      concurrency: 1,
      totalSteps: steps.length,
      ...overrides,
    }
  }

  it('prerender 対象が無ければページ A だけを開き、goto / addScriptTag 各 1 回で全ステップを順に変換する', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const pageA = new FakePage()
    const browser = new FakeBrowser({ pages: [pageA] })
    const progress: string[] = []
    const request = makeRequest(browser, { onProgress: (label) => { progress.push(label) } })

    const outcome = await convertExpectingConverted(request)

    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    // ページ A 用の context を 1 回だけ作り、draw.io viewer の取得を遮断する。run の終わりに閉じる
    expect(browser.newContextCalls).toStrictEqual([undefined])
    expect(browser.contexts[0]?.routes.map(route => route.url)).toStrictEqual(['https://viewer.diagrams.net/**'])
    const viewerRoute = await browser.contexts[0]!.dispatch('https://viewer.diagrams.net/js/viewer-static.min.js')
    expect(viewerRoute.aborted).toBe(true)
    expect(browser.contexts[0]?.closed).toBe(true)
    expect(browser.newPageCalls).toHaveLength(0)
    expect(browser.createdPages).toStrictEqual([pageA])
    expect(pageA.gotoCalls.map(call => call.url)).toStrictEqual([`${BASE_URL}/print?print=clicks`])
    expect(pageA.viewportSizeValue).toStrictEqual({ width: 960, height: 540 * 3 })
    // goto の前にグループ外のコンテナを隠す init script を入れる（このグループは全コンテナを担当）
    expect(pageA.initScriptCalls.map(({ arg, gotoCount }) => ({ arg, gotoCount }))).toStrictEqual([
      { arg: otherContainersHiddenCss(['001-01', '002-01', '002-02']), gotoCount: 0 },
    ])
    expect(pageA.scriptTagCalls).toStrictEqual([{ path: '/lib.js' }])
    expect(pageA.closed).toBe(true)
    // 対象コンテナの .slidev-page を渡し、対象以外のコンテナだけが除外目印を持つ
    expect(exportCalls).toStrictEqual([
      { container: '001-01', ignored: ['002-01', '002-02'] },
      { container: '002-01', ignored: ['001-01', '002-02'] },
      { container: '002-02', ignored: ['001-01', '002-01'] },
    ])
    expect(document.querySelectorAll('[data-html2canvas-ignore]')).toHaveLength(0)
    expect(existsSync(path.join(slidesDir, 'slide-100.pptx'))).toBe(true)
    expect(existsSync(path.join(slidesDir, 'slide-200.pptx'))).toBe(true)
    expect(existsSync(path.join(slidesDir, 'slide-201.pptx'))).toBe(true)
    const first = outcome.results[0]
    expect(first?.status === 'fulfilled' ? first.value.phases : undefined).toMatchObject({ newPage: 0, goto: 0, inject: 0 })
    expect(outcome.timing.groups).toHaveLength(1)
    expect(outcome.timing.groups[0]?.pageB).toBeUndefined()
    expect(outcome.timing.groups[0]).toMatchObject({ slides: [1, 2], steps: 3 })
    expect(outcome.fallbacks).toStrictEqual([])
    expect(Object.keys(outcome.timing.groups[0]?.pageA ?? {}).toSorted(compareStrings)).toStrictEqual(['cssSettle', 'goto', 'iframeLoad', 'inject', 'visible'])
    expect(outcome.timing.fallbackSteps).toStrictEqual([])
    expect(progress).toContain('slide #2/1 converted')
    expect(request.fallbackRunner).not.toHaveBeenCalled()
  })

  it('prerender 対象があればページ B を dsf 5 で 1 回だけ開き、selectorState の待ちは対象を含むコンテナごと・fixed の待ちは 1 回にまとめる', async () => {
    document.body.innerHTML = printDom([
      { id: '001-01' },
      { id: '002-01', inner: '<div class="point-number">1</div>' },
      { id: '002-02', inner: '<div class="diagram-block"></div><div class="terminal-window"></div>' },
    ])
    document.querySelector('[id="002-01"]')!.getBoundingClientRect = rectAt(540)
    document.querySelector('[id="002-02"]')!.getBoundingClientRect = rectAt(1080)

    const pageA = new FakePage()
    const pageB = new FakePage()
    const a1 = slideWithTarget('.point-number', { x: 30, y: 580, width: 50, height: 20 })
    const b1 = slideWithTarget('.point-number', { x: 30, y: 40, width: 50, height: 20 })
    const a2 = slideWithTarget('.diagram-block', { x: 100, y: 1090, width: 200, height: 100 })
    const b2 = slideWithTarget('.diagram-block', { x: 100, y: 10, width: 200, height: 100 })
    pageA.locatorTargets.set('[id="002-01"] .slidev-page', [a1.slide.asElementHandle()])
    pageB.locatorTargets.set('[id="002-01"] .slidev-page', [b1.slide.asElementHandle()])
    pageA.locatorTargets.set('[id="002-02"] .slidev-page', [a2.slide.asElementHandle()])
    pageB.locatorTargets.set('[id="002-02"] .slidev-page', [b2.slide.asElementHandle()])
    const browser = new FakeBrowser({ pages: [pageA, pageB] })

    const outcome = await convertExpectingConverted(makeRequest(browser))

    // ページ B は dsf 5 の別 context から開く（deviceScaleFactor は context 単位の設定）。viewer は遮断しない
    expect(browser.newContextCalls).toStrictEqual([undefined, { viewport: { width: 960, height: 540 }, deviceScaleFactor: 5 }])
    expect(browser.contexts[1]?.pages).toStrictEqual([pageB])
    expect(browser.contexts[1]?.routes).toStrictEqual([])
    expect(browser.contexts.map(context => context.closed)).toStrictEqual([true, true])
    expect(pageB.gotoCalls).toHaveLength(1)
    expect(pageB.initScriptCalls.map(({ arg, gotoCount }) => ({ arg, gotoCount }))).toStrictEqual([
      { arg: otherContainersHiddenCss(['001-01', '002-01', '002-02']), gotoCount: 0 },
    ])
    expect(pageB.scriptTagCalls).toHaveLength(0)
    expect(pageB.closed).toBe(true)
    // selectorState は待つセレクタごとに対象を束ね、対象を含むコンテナ（002-02）だけで待つ。
    // ウォームアップで 1 回、撮影前の保険で 1 回。fixed / settleDelay は最大値で 1 回
    const strategyCalls = pageB.evaluateCalls
      .map(call => call.arg as { strategySel?: string, targetSel?: string, pageSel?: string } | undefined)
      .filter(arg => arg?.strategySel !== undefined)
    expect(strategyCalls.map(arg => [arg?.targetSel, arg?.pageSel])).toStrictEqual([
      ['.diagram-block, .terminal-window', '[id="002-02"] .slidev-page'],
      ['.diagram-block, .terminal-window', '[id="002-02"] .slidev-page'],
    ])
    expect(pageB.waitForTimeoutCalls).toStrictEqual([300])
    // ウォームアップで全コンテナを 1 つずつ先頭へスクロールし、撮影するステップでも対象コンテナを先頭へスクロールする
    expect(pageB.evaluateCalls.filter(call => typeof call.arg === 'string' && /^\[id="\d{3}-\d{2}"\]$/.test(call.arg)).map(call => call.arg))
      .toStrictEqual(['[id="001-01"]', '[id="002-01"]', '[id="002-02"]', '[id="002-01"]', '[id="002-02"]'])
    expect(scrollIntoView.mock.calls.length).toBe(3 + 2)
    // meta.json の left / top はコンテナ基準。通番はステップごとに 0 から
    const meta200 = JSON.parse(await readFile(path.join(slidesDir, 'prerender-slide200-0.meta.json'), 'utf8')) as Record<string, unknown>
    const meta201 = JSON.parse(await readFile(path.join(slidesDir, 'prerender-slide201-0.meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta200).toMatchObject({ left: 30, top: 40, selector: '.point-number' })
    expect(meta201).toMatchObject({ left: 100, top: 10, selector: '.diagram-block' })
    const second = outcome.results[1]
    expect(second?.status === 'fulfilled' ? second.value.prerenderResults.map(r => r.success) : []).toStrictEqual([true])
    expect(outcome.timing.groups[0]?.pageB).toBeDefined()
    // ページ A / B を使い続けるため、スライド要素と対象のハンドルは処理後に解放する
    for (const handle of [a1.slide, a1.target, b1.slide, b1.target, a2.slide, a2.target, b2.slide, b2.target]) {
      expect(handle.disposed).toBe(true)
    }
  })

  it('対象のセレクタリストはリスト全体をグループのコンテナ内に限って検出する', async () => {
    // `.x, .y` の `.y` はコンテナの外にだけある
    document.body.innerHTML = printDom(plainContainers) + '<div class="y"></div>'
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const config: PrerenderConfig = { ...prerender, targets: [{ selector: '.x, .y' }] }

    const outcome = await convertExpectingConverted(makeRequest(browser, { prerenderConfig: config }))

    expect(browser.createdPages).toHaveLength(1)
    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
  })

  it('print ルートはあるが print コンテナが 5 秒以内に出なければグループごと現行 worker に回し、ページを閉じる', async () => {
    document.body.innerHTML = '<div id="page-root"><div id="print-container"></div></div>'
    const pageA = new FakePage()
    // 1: print ルートの判定 / 2: コンテナ出現（時間切れ）
    pageA.waitForFunctionResolves = [true, false]
    const browser = new FakeBrowser({ pages: [pageA] })
    const request = makeRequest(browser)

    const outcome = await convertExpectingConverted(request)

    expect(outcome.fallbacks).toStrictEqual([expect.stringMatching(/^slide 1,2: print container did not appear within 5 s/)])
    expect(pageA.closed).toBe(true)
    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual(steps)
    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(outcome.timing.groups[0]).toMatchObject({ slides: [1, 2], steps: 3, fallback: expect.stringContaining('print container did not appear') })
    expect(outcome.timing.groups[0]?.pageA).toBeUndefined()
    expect(outcome.timing.fallbackSteps).toStrictEqual(['1', '2', '2/1'])
  })

  it('コンテナ数が期待ステップ数と合わなければ退避する', async () => {
    document.body.innerHTML = printDom([{ id: '001-01' }, { id: '002-01' }])
    const browser = new FakeBrowser({ pages: [new FakePage()] })

    const outcome = await convertExpectingConverted(makeRequest(browser))

    expect(outcome.fallbacks).toStrictEqual([expect.stringContaining('2 containers, 3 steps')])
  })

  it('コンテナの id がステップと対応しなければ退避する', async () => {
    document.body.innerHTML = printDom([{ id: '001-01' }, { id: '002-01' }, { id: '003-01' }])
    const browser = new FakeBrowser({ pages: [new FakePage()] })

    const outcome = await convertExpectingConverted(makeRequest(browser))

    expect(outcome.fallbacks).toStrictEqual([expect.stringContaining('002-02')])
  })

  it('スライドの読み込みが終わらなければ退避する', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const pageA = new FakePage()
    // 1: print ルートの判定 / 2: コンテナ出現 / 3: 期待数到達 / 4: .slidev-slide-loading の消滅
    pageA.waitForFunctionResolves = [true, true, true, false]
    const browser = new FakeBrowser({ pages: [pageA] })

    const outcome = await convertExpectingConverted(makeRequest(browser))

    expect(outcome.fallbacks).toStrictEqual([expect.stringContaining('slide did not finish loading within')])
  })

  it('高解像度ページでコンテナが揃わなければ、prerender 対象を持つステップだけ現行 worker に回し、両ページを閉じる', async () => {
    document.body.innerHTML = printDom([{ id: '001-01', inner: '<div class="point-number">1</div>' }, { id: '002-01' }, { id: '002-02' }])
    const pageA = new FakePage()
    const pageB = new FakePage()
    pageB.waitForFunctionResolves = [false]
    const browser = new FakeBrowser({ pages: [pageA, pageB] })
    const request = makeRequest(browser)

    const outcome = await convertExpectingConverted(request)

    // グループは退避せず、対象の無いステップは 1 パスのまま。ページ B は開き直さない
    expect(outcome.fallbacks).toStrictEqual([expect.stringMatching(/^slide #1: hiRes page: print container did not appear/)])
    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual([steps[0]])
    expect(exportCalls.map(call => call.container)).toStrictEqual(['002-01', '002-02'])
    expect(browser.createdPages).toHaveLength(2)
    expect(outcome.timing.groups[0]?.fallback).toBeUndefined()
    expect(outcome.timing.groups[0]?.pageB).toBeUndefined()
    expect(outcome.timing.fallbackSteps).toStrictEqual(['1'])
    expect(pageA.closed).toBe(true)
    expect(pageB.closed).toBe(true)
  })

  it('高解像度ページを開く途中の例外も、prerender 対象を持つステップだけを現行 worker に回す', async () => {
    document.body.innerHTML = printDom([{ id: '001-01' }, { id: '002-01', inner: '<div class="point-number">1</div>' }, { id: '002-02' }])
    const pageB = new FakePage()
    pageB.goto = async () => { throw new Error('page crashed') }
    const browser = new FakeBrowser({ pages: [new FakePage(), pageB] })
    const logger = makeLogger()
    const request = makeRequest(browser, { logger })

    const outcome = await convertExpectingConverted(request)

    expect(outcome.fallbacks).toStrictEqual(['slide #2: cannot prepare the hiRes page: page crashed'])
    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual([steps[1]])
    expect(logger.warn).toHaveBeenCalledWith('single-pass: cannot prepare the hiRes page: page crashed; steps with prerender targets are converted with the current method')
  })

  it('ページの用意で例外が出たら退避する', async () => {
    const pageA = new FakePage()
    pageA.goto = async () => { throw new Error('net::ERR_CONNECTION_REFUSED') }
    const browser = new FakeBrowser({ pages: [pageA] })

    const outcome = await convertExpectingConverted(makeRequest(browser))

    expect(outcome.fallbacks).toStrictEqual(['slide 1,2: cannot prepare the print page: net::ERR_CONNECTION_REFUSED'])
    expect(pageA.closed).toBe(true)
  })

  it('init script はグループ外のコンテナを隠すスタイルシートを document.adoptedStyleSheets に足す (#1161)', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const existing = new CSSStyleSheet()
    document.adoptedStyleSheets = [existing]
    const pageGroup1 = new FakePage()
    const browser = new FakeBrowser({ pages: [pageGroup1, new FakePage()] })
    try {
      await convertExpectingConverted(makeRequest(browser, { concurrency: 2 }))
      const [call] = pageGroup1.initScriptCalls
      ;(call?.script as (css: unknown) => void)(call?.arg)
      expect(document.adoptedStyleSheets).toHaveLength(2)
      expect(document.adoptedStyleSheets[0]).toBe(existing)
      expect([...document.adoptedStyleSheets[1]!.cssRules].map(rule => rule.cssText)).toStrictEqual([
        '.print-slide-container:not([id="001-01"]) { display: none !important; }',
      ])
    }
    finally {
      document.adoptedStyleSheets = []
    }
  })

  it('各グループは range なしで print ページを開き、グループ外のコンテナを隠して自グループのコンテナだけを変換する', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const pageGroup1 = new FakePage()
    const pageGroup2 = new FakePage()
    const browser = new FakeBrowser({ pages: [pageGroup1, pageGroup2] })
    const request = makeRequest(browser, { concurrency: 2 })

    const outcome = await convertExpectingConverted(request)

    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(outcome.results.map(r => (r.status === 'fulfilled' ? r.value.step : undefined))).toStrictEqual(steps)
    expect(pageGroup1.gotoCalls.map(call => call.url)).toStrictEqual([`${BASE_URL}/print?print=clicks`])
    expect(pageGroup2.gotoCalls.map(call => call.url)).toStrictEqual([`${BASE_URL}/print?print=clicks`])
    // グループ外のコンテナは goto の前に入れる init script で隠し、viewport の高さはグループのステップ数分
    expect(pageGroup1.initScriptCalls.map(({ arg, gotoCount }) => ({ arg, gotoCount }))).toStrictEqual([
      { arg: otherContainersHiddenCss(['001-01']), gotoCount: 0 },
    ])
    expect(pageGroup2.initScriptCalls.map(({ arg, gotoCount }) => ({ arg, gotoCount }))).toStrictEqual([
      { arg: otherContainersHiddenCss(['002-01', '002-02']), gotoCount: 0 },
    ])
    expect(pageGroup1.viewportSizeValue).toStrictEqual({ width: 960, height: 540 * 1 })
    expect(pageGroup2.viewportSizeValue).toStrictEqual({ width: 960, height: 540 * 2 })
    // 各ステップは自グループの 1 回だけ変換され、対象以外の全コンテナ（他グループ分を含む）に除外目印が付く
    expect(exportCalls.map(call => call.container ?? '').toSorted(compareStrings)).toStrictEqual(['001-01', '002-01', '002-02'])
    for (const call of exportCalls) expect(call.ignored).toHaveLength(2)
    expect(pageGroup1.scriptTagCalls).toHaveLength(1)
    expect(pageGroup2.scriptTagCalls).toHaveLength(1)
    // 両グループのページ A は run で 1 つの context から開く（HTTP キャッシュを共有する）
    expect(browser.newContextCalls).toHaveLength(1)
    expect(browser.contexts[0]?.pages).toStrictEqual([pageGroup1, pageGroup2])
    expect(outcome.timing.groups.map(group => ({ slides: group.slides, steps: group.steps }))).toStrictEqual([
      { slides: [1], steps: 1 },
      { slides: [2], steps: 2 },
    ])
    expect(outcome.fallbacks).toStrictEqual([])
    expect(request.fallbackRunner).not.toHaveBeenCalled()
    expect(request.logger.info).toHaveBeenCalledWith('single-pass: converting 3 steps in 2 groups')
  })

  it('1 グループが退避しても、他のグループは 1 パスで変換を続ける', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const pageGroup1 = new FakePage()
    // 1: print ルートの判定 / 2: コンテナ出現（時間切れ）
    pageGroup1.waitForFunctionResolves = [true, false]
    const pageGroup2 = new FakePage()
    const browser = new FakeBrowser({ pages: [pageGroup1, pageGroup2] })
    const request = makeRequest(browser, { concurrency: 2 })

    const outcome = await convertExpectingConverted(request)

    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual([steps[0]])
    expect(exportCalls.map(call => call.container)).toStrictEqual(['002-01', '002-02'])
    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(outcome.fallbacks).toStrictEqual([expect.stringMatching(/^slide 1: print container did not appear within 5 s/)])
    expect(outcome.timing.groups[0]?.fallback).toContain('print container did not appear')
    expect(outcome.timing.groups[1]?.pageA).toBeDefined()
    expect(outcome.timing.groups[1]?.fallback).toBeUndefined()
    expect(outcome.timing.fallbackSteps).toStrictEqual(['1'])
  })

  it('コンテナ数は miss のステップ数でなく、全走査のステップ総数と比べる', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const pageA = new FakePage()
    const browser = new FakeBrowser({ pages: [pageA] })
    // slide 1 はキャッシュ hit、miss は slide 2 の 2 ステップ。print ページには 3 コンテナが出る
    const request = makeRequest(browser, { steps: [steps[1]!, steps[2]!], totalSteps: 3 })

    const outcome = await convertExpectingConverted(request)

    expect(outcome.fallbacks).toStrictEqual([])
    expect(exportCalls.map(call => call.container)).toStrictEqual(['002-01', '002-02'])
    // 隠すのは hit の slide 1 のコンテナ。viewport は miss の 2 ステップ分
    expect(pageA.initScriptCalls.map(({ arg }) => arg)).toStrictEqual([otherContainersHiddenCss(['002-01', '002-02'])])
    expect(pageA.viewportSizeValue).toStrictEqual({ width: 960, height: 540 * 2 })
  })

  it('コンテナ数が全走査のステップ総数と合わなければ退避する', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const browser = new FakeBrowser({ pages: [new FakePage()] })

    const outcome = await convertExpectingConverted(makeRequest(browser, { totalSteps: 4 }))

    expect(outcome.fallbacks).toStrictEqual([expect.stringContaining('print container count does not match the step count of the full scan: 3 containers, 4 steps')])
  })

  it('自グループのステップの id が欠けたグループだけ退避し、他のグループは続ける', async () => {
    // 総数は合うが 002-02 が無い
    document.body.innerHTML = printDom([{ id: '001-01' }, { id: '002-01' }, { id: '099-01' }])
    const browser = new FakeBrowser({ pages: [new FakePage(), new FakePage()] })
    const request = makeRequest(browser, { concurrency: 2 })

    const outcome = await convertExpectingConverted(request)

    expect(outcome.fallbacks).toStrictEqual([expect.stringMatching(/^slide 2: print container not found for steps: 002-02/)])
    expect(exportCalls.map(call => call.container)).toStrictEqual(['001-01'])
    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual([steps[1], steps[2]])
    expect(outcome.timing.fallbackSteps).toStrictEqual(['2', '2/1'])
  })

  it('グループの全コンテナでスライド本体が描かれるまで、prerender 対象の検出に進まない', async () => {
    // 002-02 は .slidev-page に子が無い（非同期コンポーネントの未マウント）
    document.body.innerHTML = printDom([{ id: '001-01' }, { id: '002-01', inner: '<div class="point-number">1</div>' }])
    document.querySelector('#print-container')!.insertAdjacentHTML('beforeend', '<div class="print-slide-container" id="002-02"><div class="slidev-page" style="display:block"></div></div>')
    const pageA = new FakePage()
    // 1: print ルートの判定 / 2: コンテナ出現 / 3: 総数到達 / 4: 描画完了（時間切れ）
    pageA.waitForFunctionResolves = [true, true, true, false]
    const browser = new FakeBrowser({ pages: [pageA] })

    const outcome = await convertExpectingConverted(makeRequest(browser))

    expect(outcome.fallbacks).toStrictEqual([expect.stringContaining('slide did not finish loading within')])
    // 検出（selectors を渡す evaluate）は実行されず、ページ B も開かない
    expect(pageA.evaluateCalls.some(call => (call.arg as { selectors?: unknown } | undefined)?.selectors !== undefined)).toBe(false)
    expect(browser.createdPages).toHaveLength(1)
    expect(browser.newContextCalls).toHaveLength(1)

    // 待ちの判定では、子の無い .slidev-page を未完了とみなす。
    // 読み込み中の目印があるコンテナも、未完了とみなす。
    // （fake は時間切れを積むと判定関数を呼ばずに throw するため、判定関数は別の run で取り出す）
    const probePage = new FakePage()
    await convertStepsSinglePass(makeRequest(new FakeBrowser({ pages: [probePage] })))
    const renderedCall = probePage.evaluateCalls.find(call => (call.arg as { visibleFn?: unknown } | undefined)?.visibleFn !== undefined && (call.arg as { scope?: unknown }).scope !== undefined)
    const judge = (): unknown => (renderedCall?.fn as (argument: unknown) => unknown)(renderedCall?.arg)
    expect((renderedCall?.arg as { scope: string }).scope).toBe(':is([id="001-01"], [id="002-01"], [id="002-02"])')
    expect(judge()).toBe(false)
    document.querySelector('[id="002-02"] .slidev-page')!.innerHTML = '<div class="slidev-slide-loading"></div>'
    expect(judge()).toBe(false)
    document.querySelector('[id="002-02"] .slidev-page')!.innerHTML = '<span>ok</span>'
    expect(judge()).toBe(true)
  })

  it('高解像度ページでスライド本体が描かれなければ、待ちの失敗内容を理由に付けて該当ステップを現行 worker に回す', async () => {
    document.body.innerHTML = printDom([{ id: '001-01', inner: '<div class="point-number">1</div>' }, { id: '002-01' }, { id: '002-02' }])
    const pageB = new FakePage()
    pageB.waitForFunctionResolves = [true, true, false]
    const browser = new FakeBrowser({ pages: [new FakePage(), pageB] })

    const outcome = await convertExpectingConverted(makeRequest(browser))

    expect(outcome.fallbacks).toStrictEqual([
      expect.stringMatching(/^slide #1: hiRes page: slide did not finish loading within .* s: waitForFunction timed out \(fake, queued\)$/),
    ])
  })

  it('用意の時点で対象を検出できなくても、ステップのコンテナに対象があれば、高解像度ページを遅延オープンして撮る', async () => {
    document.body.innerHTML = printDom([{ id: '001-01' }, { id: '002-01', inner: '<div class="point-number">1</div>' }, { id: '002-02' }])
    const pageA = new FakePage()
    missFirstGroupDetection(pageA)
    const pageB = new FakePage()
    pageA.locatorTargets.set('[id="002-01"] .slidev-page', [slideWithTarget('.point-number').slide.asElementHandle()])
    pageB.locatorTargets.set('[id="002-01"] .slidev-page', [slideWithTarget('.point-number').slide.asElementHandle()])
    const browser = new FakeBrowser({ pages: [pageA, pageB] })
    const logger = makeLogger()

    const outcome = await convertExpectingConverted(makeRequest(browser, { logger }))

    expect(browser.newContextCalls[1]).toStrictEqual({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 5 })
    expect(browser.contexts[1]?.pages).toStrictEqual([pageB])
    expect(pageB.gotoCalls).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('container 002-01 has prerender targets, so opening the hiRes page'))
    const second = outcome.results[1]
    expect(second?.status === 'fulfilled' ? second.value.prerenderResults.map(r => r.success) : []).toStrictEqual([true])
    expect(existsSync(path.join(slidesDir, 'prerender-slide200-0.meta.json'))).toBe(true)
    expect(outcome.timing.groups[0]).toMatchObject({ lazyPageB: true, pageB: expect.any(Object) })
    expect(outcome.fallbacks).toStrictEqual([])
  })

  it('遅延オープンに失敗したら該当ステップを現行 worker に回し、以後は開き直さない', async () => {
    document.body.innerHTML = printDom([
      { id: '001-01' },
      { id: '002-01', inner: '<div class="point-number">1</div>' },
      { id: '002-02', inner: '<div class="point-number">2</div>' },
    ])
    const pageA = new FakePage()
    missFirstGroupDetection(pageA)
    const pageB = new FakePage()
    pageB.waitForFunctionResolves = [false]
    const browser = new FakeBrowser({ pages: [pageA, pageB] })
    const request = makeRequest(browser)

    const outcome = await convertExpectingConverted(request)

    expect(browser.createdPages).toHaveLength(2)
    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual([steps[1], steps[2]])
    expect(outcome.timing.fallbackSteps).toStrictEqual(['2', '2/1'])
    expect(outcome.timing.groups[0]?.pageB).toBeUndefined()
    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    // ステップ単位の退避も利用者向けの警告に載る
    expect(outcome.fallbacks).toStrictEqual([
      expect.stringMatching(/^slide #2: hiRes page: print container did not appear/),
      expect.stringMatching(/^slide #2\/1: hiRes page: print container did not appear/),
    ])
  })

  it('失敗したステップだけ現行 worker に回し、除外目印と差し替えは失敗時も戻す', async () => {
    document.body.innerHTML = printDom([
      { id: '001-01' },
      { id: '002-01', inner: '<img data-prerender-img="true" src="x.png"><div data-prerender-hidden="true" style="display:none"></div>' },
      { id: '002-02' },
    ])
    failContainer = '002-01'
    // 失敗ステップが staging に残した成果物は、現行 worker へ回す前に消す
    await writeFile(path.join(slidesDir, 'prerender-slide200-0.png'), 'stale')
    await writeFile(path.join(slidesDir, 'prerender-slide2000-0.png'), 'other-step')
    const existedAtFallback: boolean[] = []
    const fallbackRunner = vi.fn<SlideWorkerRunner>(async (_b, step) => {
      existedAtFallback.push(existsSync(path.join(slidesDir, 'prerender-slide200-0.png')))
      return makeResult(step)
    })
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const logger = makeLogger()

    const outcome = await convertExpectingConverted(makeRequest(browser, { fallbackRunner, logger }))

    expect(fallbackRunner).toHaveBeenCalledTimes(1)
    expect(fallbackRunner.mock.calls[0]?.[1]).toStrictEqual(steps[1])
    expect(existedAtFallback).toStrictEqual([false])
    expect(existsSync(path.join(slidesDir, 'prerender-slide2000-0.png'))).toBe(true)
    const second = outcome.results[1]
    expect(second?.status === 'fulfilled' ? second.value.elapsed : undefined).toBe(999)
    expect(outcome.timing.fallbackSteps).toStrictEqual(['2'])
    expect(document.querySelectorAll('[data-html2canvas-ignore]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-prerender-img], [data-prerender-hidden]')).toHaveLength(0)
    expect(exportCalls.map(call => call.container)).toStrictEqual(['001-01', '002-01', '002-02'])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('slide #2 conversion failed, so converting again with the current method'))
    expect(outcome.fallbacks).toStrictEqual(['slide #2: export failed: 002-01'])
  })

  it('後始末が失敗しても残りの後始末をし、元の失敗を退避理由にする', async () => {
    document.body.innerHTML = printDom([
      { id: '001-01' },
      { id: '002-01', inner: '<img data-prerender-img="true" src="x.png">' },
      { id: '002-02' },
    ])
    failContainer = '002-01'
    const pageA = new FakePage()
    const original = pageA.evaluate.bind(pageA)
    // 除外目印の解除（全コンテナ対象 = id null）だけを失敗させる
    pageA.evaluate = async <R>(fn: any, arg?: unknown): Promise<R> => {
      if ((arg as { id?: unknown } | undefined)?.id === null) throw new Error('target closed')
      return original<R>(fn, arg)
    }
    const browser = new FakeBrowser({ pages: [pageA] })
    const logger = makeLogger()

    const outcome = await convertExpectingConverted(makeRequest(browser, { logger }))

    expect(outcome.fallbacks).toStrictEqual(['slide #2: export failed: 002-01'])
    expect(logger.warn).toHaveBeenCalledWith('single-pass: clearing exclusion marks (container 002-01) failed: target closed')
    // 差し替えの復元は、除外目印の解除の失敗とは無関係に実行される
    expect(document.querySelectorAll('[data-prerender-img]')).toHaveLength(0)
  })

  it('現行 worker でも失敗したステップは rejected として返す', async () => {
    document.body.innerHTML = printDom(plainContainers)
    failContainer = '002-02'
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const progress: string[] = []
    const fallbackRunner = vi.fn<SlideWorkerRunner>(async () => { throw new Error('worker-failed') })

    const outcome = await convertExpectingConverted(makeRequest(browser, { fallbackRunner, onProgress: (label) => { progress.push(label) } }))

    expect(outcome.results[2]).toStrictEqual({ status: 'rejected', reason: new Error('worker-failed') })
    expect(progress).toContain('slide #2/1 conversion failed')
  })

  it('onStepDone は 1 パスで終えたステップと現行 worker で終えたステップを 1 回ずつ報告し、1 パスでの失敗では呼ばない (#1160)', async () => {
    document.body.innerHTML = printDom(plainContainers)
    failContainer = '002-02'
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const done: string[] = []
    const fallbackRunner = vi.fn<SlideWorkerRunner>(async () => { throw new Error('worker-failed') })

    await convertExpectingConverted(makeRequest(browser, { fallbackRunner, onStepDone: (step) => { done.push(stepKeyOf(step)) } }))

    // 2/1 は 1 パスで失敗 → 現行 worker で失敗。報告は現行 worker の完了時の 1 回だけ。
    expect(done.toSorted(compareStrings)).toStrictEqual(['1', '2', '2/1'])
  })

  it('hash ルータのデッキはフラグメントの前に print=clicks を置いた URL で print ページを開く', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const pageA = new FakePage()
    const browser = new FakeBrowser({ pages: [pageA] })

    const outcome = await convertExpectingConverted(makeRequest(browser, { urlFormat: { hash: true } }))

    expect(pageA.gotoCalls.map(call => call.url)).toStrictEqual([`${BASE_URL}/?print=clicks#/print`])
    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(outcome.fallbacks).toStrictEqual([])
  })

  it('print ルートが無ければ各グループが #page-root の出現で即時に判定し、何も変換せず不在の印を返す', async () => {
    document.body.innerHTML = PLAY_DOM
    const pageGroup1 = new FakePage()
    const pageGroup2 = new FakePage()
    const browser = new FakeBrowser({ pages: [pageGroup1, pageGroup2] })
    const request = makeRequest(browser, { concurrency: 2 })

    const outcome = await convertStepsSinglePass(request)

    expect(outcome).toStrictEqual({
      kind: 'printRouteMissing',
      timing: { kind: 'printRouteMissing', fallback: 'the deck build has no print route', detectMs: expect.any(Number) },
    })
    // 判定は各グループで 1 回ずつ（並列）。コンテナ待ち・注入・現行 worker には進まない
    for (const page of [pageGroup1, pageGroup2]) {
      expect(page.gotoCalls).toHaveLength(1)
      expect(page.scriptTagCalls).toHaveLength(0)
      expect(page.closed).toBe(true)
      expect(page.evaluateCalls.filter(call => call.arg === '#print-container, #page-root')).toHaveLength(1)
      expect(page.evaluateCalls.some(call => call.arg === '.print-slide-container')).toBe(false)
    }
    expect(request.fallbackRunner).not.toHaveBeenCalled()
    expect(exportCalls).toHaveLength(0)
  })

  it('print ルートの判定要素が 5 秒以内に出なければ不在とみなさず、グループ単位で現行 worker に回す', async () => {
    document.body.replaceChildren()
    const pageA = new FakePage()
    pageA.waitForFunctionResolves = [false]
    const browser = new FakeBrowser({ pages: [pageA] })
    const request = makeRequest(browser)

    const outcome = await convertExpectingConverted(request)

    const reason = 'cannot detect the print route; #print-container, #page-root did not appear within 5 s'
    expect(outcome.fallbacks).toStrictEqual([`slide 1,2: ${reason}`])
    expect(outcome.timing.groups[0]).toMatchObject({ slides: [1, 2], steps: 3, fallback: reason })
    expect(outcome.timing.fallbackSteps).toStrictEqual(['1', '2', '2/1'])
    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual(steps)
    expect(pageA.closed).toBe(true)
  })

  it('一部のグループだけが print ルートの不在を判定したら、そのグループのステップを現行 worker に回す', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const pageGroup1 = new FakePage()
    const original = pageGroup1.evaluate.bind(pageGroup1)
    pageGroup1.evaluate = async <R>(fn: any, arg?: unknown): Promise<R> => {
      return arg === '#print-container' ? (false as R) : original<R>(fn, arg)
    }
    const browser = new FakeBrowser({ pages: [pageGroup1, new FakePage()] })
    const request = makeRequest(browser, { concurrency: 2 })

    const outcome = await convertExpectingConverted(request)

    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual([steps[0]])
    expect(exportCalls.map(call => call.container)).toStrictEqual(['002-01', '002-02'])
    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(outcome.fallbacks).toStrictEqual(['slide 1: the deck build has no print route'])
    expect(outcome.timing.groups[0]).toMatchObject({ slides: [1], steps: 1, fallback: 'the deck build has no print route' })
    expect(outcome.timing.fallbackSteps).toStrictEqual(['1'])
  })

  it('ウォームアップは、遅延ロードする要素を含むコンテナごとに、viewport 先頭へ入れたまま overlay の消滅を待つ', async () => {
    document.body.innerHTML = printDom(lazyDiagramContainers)
    const pageA = new FakePage()
    const pageB = new FakePage()
    for (const id of ['002-01', '002-02']) {
      pageA.locatorTargets.set(`[id="${id}"] .slidev-page`, [slideWithTarget('.diagram-block').slide.asElementHandle()])
      pageB.locatorTargets.set(`[id="${id}"] .slidev-page`, [slideWithTarget('.diagram-block').slide.asElementHandle()])
    }
    const { events } = installLazyLoading(pageB, scrollIntoView)
    const browser = new FakeBrowser({ pages: [pageA, pageB] })
    const logger = makeLogger()
    const request = makeRequest(browser, { logger })

    const outcome = await convertExpectingConverted(request)

    // スクロールだけでは次へ進まない。そのコンテナが先頭にある間は待つ。
    // 対象の無い 001-01 は待たない
    expect(events).toStrictEqual([
      'scroll 001-01',
      'scroll 002-01',
      'wait [id="002-01"] .slidev-page',
      'scroll 002-02',
      'wait [id="002-02"] .slidev-page',
      // 撮影前の保険（既に消えているので即時に通る）
      'scroll 002-01',
      'wait [id="002-01"] .slidev-page',
      'scroll 002-02',
      'wait [id="002-02"] .slidev-page',
    ])
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('timed out'))
    expect(logger.info).toHaveBeenCalledWith('  container 002-01: render completion detected: .diagram-block')
    expect(request.fallbackRunner).not.toHaveBeenCalled()
    expect(outcome.fallbacks).toStrictEqual([])
    expect(exportCalls.map(call => call.container)).toStrictEqual(['001-01', '002-01', '002-02'])
  })

  it('overlay が消えないコンテナは撮影せずに現行 worker へ回し、コンテナ id 付きで警告する', async () => {
    document.body.innerHTML = printDom(lazyDiagramContainers)
    const pageA = new FakePage()
    const pageB = new FakePage()
    for (const id of ['002-01', '002-02']) {
      pageA.locatorTargets.set(`[id="${id}"] .slidev-page`, [slideWithTarget('.diagram-block').slide.asElementHandle()])
      pageB.locatorTargets.set(`[id="${id}"] .slidev-page`, [slideWithTarget('.diagram-block').slide.asElementHandle()])
    }
    installLazyLoading(pageB, scrollIntoView, { neverLoads: true })
    const browser = new FakeBrowser({ pages: [pageA, pageB] })
    const logger = makeLogger()
    const request = makeRequest(browser, { logger })

    const outcome = await convertExpectingConverted(request)

    // ウォームアップの時間切れはどのコンテナで残ったかを示す
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^ {2}container 002-01: render wait timed out: \.diagram-block: \.loading-overlay did not disappear within 1 s/))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^ {2}container 002-02: render wait timed out/))
    // Loading 状態を撮影・変換せず、該当ステップだけ現行 worker に回す
    expect(exportCalls.map(call => call.container)).toStrictEqual(['001-01'])
    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual([steps[1], steps[2]])
    expect(outcome.results.map(r => r.status)).toStrictEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(outcome.timing.fallbackSteps).toStrictEqual(['2', '2/1'])
    expect(outcome.fallbacks).toStrictEqual([
      expect.stringMatching(/^slide #2: prerender targets did not finish loading on the hiRes page: container 002-01: \.diagram-block: \.loading-overlay did not disappear within 1 s/),
      expect.stringMatching(/^slide #2\/1: prerender targets did not finish loading on the hiRes page: container 002-02: /),
    ])
    expect(readdirSyncSafe(slidesDir).filter(name => /^prerender-slide20[01]-/.test(name))).toStrictEqual([])
  })

  it('ウォームアップで時間切れになったコンテナは、撮影前の再待ちを短い上限（2 秒）に縮める', async () => {
    document.body.innerHTML = printDom(lazyDiagramContainers)
    const pageA = new FakePage()
    const pageB = new FakePage()
    for (const id of ['002-01', '002-02']) {
      pageA.locatorTargets.set(`[id="${id}"] .slidev-page`, [slideWithTarget('.diagram-block').slide.asElementHandle()])
      pageB.locatorTargets.set(`[id="${id}"] .slidev-page`, [slideWithTarget('.diagram-block').slide.asElementHandle()])
    }
    const { events, timeouts } = installLazyLoading(pageB, scrollIntoView, { neverLoads: true })
    const browser = new FakeBrowser({ pages: [pageA, pageB] })
    // 戦略の timeout は既定（15 s）相当
    const config: PrerenderConfig = {
      ...prerender,
      targets: [{ selector: '.diagram-block', waitStrategy: { type: 'selectorState', selector: '.loading-overlay', timeout: 15_000 } }],
    }
    const request = makeRequest(browser, { prerenderConfig: config })

    const outcome = await convertExpectingConverted(request)

    // ウォームアップは戦略の timeout、撮影前の再待ちは 2 秒
    expect(events.filter(event => event.startsWith('wait '))).toHaveLength(4)
    expect(timeouts).toStrictEqual([15_000, 15_000, 2000, 2000])
    expect(outcome.fallbacks).toStrictEqual([
      expect.stringMatching(/^slide #2: prerender targets did not finish loading on the hiRes page: container 002-01: \.diagram-block: \.loading-overlay did not disappear within 2 s/),
      expect.stringMatching(/^slide #2\/1: prerender targets did not finish loading on the hiRes page: container 002-02: \.diagram-block: \.loading-overlay did not disappear within 2 s/),
    ])
    expect(vi.mocked(request.fallbackRunner).mock.calls.map(call => call[1])).toStrictEqual([steps[1], steps[2]])
  })

  it('ウォームアップで時間切れでも撮影前の再待ちで読み込みが終われば、1 パスのまま撮影する', async () => {
    // 遅延ロードする要素は 002-01 だけ。
    // ウォームアップの 1 回目の待ちは時間切れになり、撮影前の 2 回目で消える
    document.body.innerHTML = printDom([
      { id: '001-01' },
      { id: '002-01', inner: '<div class="diagram-block"><div class="loading-overlay">Loading diagram…</div></div>' },
      { id: '002-02' },
    ])
    const pageA = new FakePage()
    const pageB = new FakePage()
    pageA.locatorTargets.set('[id="002-01"] .slidev-page', [slideWithTarget('.diagram-block').slide.asElementHandle()])
    pageB.locatorTargets.set('[id="002-01"] .slidev-page', [slideWithTarget('.diagram-block').slide.asElementHandle()])
    const { events } = installLazyLoading(pageB, scrollIntoView, { loadsOnWait: 2 })
    const browser = new FakeBrowser({ pages: [pageA, pageB] })
    const logger = makeLogger()
    const request = makeRequest(browser, { logger })

    const outcome = await convertExpectingConverted(request)

    expect(events.filter(event => event.startsWith('wait '))).toStrictEqual(['wait [id="002-01"] .slidev-page', 'wait [id="002-01"] .slidev-page'])
    const timeoutWarnings = logger.warn.mock.calls.filter(call => String(call[0]).includes('timed out'))
    expect(timeoutWarnings).toStrictEqual([[expect.stringMatching(/^ {2}container 002-01: render wait timed out/)]])
    expect(request.fallbackRunner).not.toHaveBeenCalled()
    expect(outcome.fallbacks).toStrictEqual([])
    expect(outcome.timing.fallbackSteps).toStrictEqual([])
    expect(exportCalls.map(call => call.container)).toStrictEqual(['001-01', '002-01', '002-02'])
    const second = outcome.results[1]
    expect(second?.status === 'fulfilled' ? second.value.prerenderResults.map(r => r.success) : []).toStrictEqual([true])
  })

  it('selectorState 戦略の対象を含まないコンテナは待たない', async () => {
    // 002-01 は fixed 戦略の対象（.point-number）だけ、002-02 は selectorState 戦略の対象を持つ
    document.body.innerHTML = printDom([
      { id: '001-01' },
      { id: '002-01', inner: '<div class="point-number">1</div>' },
      { id: '002-02', inner: '<div class="diagram-block"><div class="loading-overlay">Loading diagram…</div></div>' },
    ])
    const pageB = new FakePage()
    const { events } = installLazyLoading(pageB, scrollIntoView)
    const browser = new FakeBrowser({ pages: [new FakePage(), pageB] })

    await convertExpectingConverted(makeRequest(browser))

    const warmupWaits = events.slice(0, events.indexOf('scroll 002-02') + 2)
    expect(warmupWaits).toStrictEqual(['scroll 001-01', 'scroll 002-01', 'scroll 002-02', 'wait [id="002-02"] .slidev-page'])
    expect(events.filter(event => event.startsWith('wait ') && !event.includes('002-02'))).toStrictEqual([])
    // fixed 戦略の待ち（.point-number の既定 200 と .diagram-block の settleDelay 300 の最大値）は最後に 1 回
    expect(pageB.waitForTimeoutCalls).toStrictEqual([300])
  })

  it('abort 済みなら変換を始めずに throw し、ページを閉じる', async () => {
    document.body.innerHTML = printDom(plainContainers)
    const pageA = new FakePage()
    const browser = new FakeBrowser({ pages: [pageA] })
    const controller = new AbortController()
    controller.abort()

    await expect(convertStepsSinglePass(makeRequest(browser, { signal: controller.signal }))).rejects.toThrow('aborted')
    expect(pageA.closed).toBe(true)
    expect(exportCalls).toHaveLength(0)
  })

  it('1 パス失敗ステップを回す前に abort されたら throw する', async () => {
    document.body.innerHTML = printDom(plainContainers)
    failContainer = '002-02'
    const controller = new AbortController()
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const fallbackRunner = vi.fn<SlideWorkerRunner>()

    await expect(convertStepsSinglePass(makeRequest(browser, {
      signal: controller.signal,
      fallbackRunner,
      onProgress: (label) => { if (label.includes('single-pass conversion failed')) controller.abort() },
    }))).rejects.toThrow('aborted')
    expect(fallbackRunner).not.toHaveBeenCalled()
  })
})
