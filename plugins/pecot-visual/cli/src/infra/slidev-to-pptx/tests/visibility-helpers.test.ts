// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any -- test 用に jsdom DOM と FakePage を直接操作 */
import { describe, expect, it } from 'vitest'

import {
  locateTargetsInVisibleSlides,
  waitForCssAnimations,
  waitForDataWaitfor,
  waitForFontsReady,
  waitForIframeLoad,
  waitForSelectorInVisibleSlide,
} from '../visibility-helpers.js'
import { FakeElementHandle, FakePage } from './support/fake-playwright.js'
import { makeLogger } from './support/logger.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('locateTargetsInVisibleSlides', () => {
  it('表示中のスライドに含まれる対象の要素を、すべて取得する', async () => {
    await explains('表示中のスライドから対象の要素を取得する `locateTargetsInVisibleSlides` のテストです。3 つのスライドのうち表示中の 2 つにある対象の要素 3 件が、すべて取得されることを確認します。')
    document.body.innerHTML = `
      <div class="slidev-page" id="s0" style="display:block"><span></span><div class="target"></div></div>
      <div class="slidev-page" id="s1" style="display:none"><span></span></div>
      <div class="slidev-page" id="s2" style="display:block"><span></span><div class="target"></div></div>
    `
    // jsdom の getComputedStyle は inline style を尊重するが children.length も評価対象。
    // 上記マークアップで visible 判定 (display が none 以外かつ children.length > 0) を満たすのは s0, s2。
    const handle0 = new FakeElementHandle({ $$Targets: [new FakeElementHandle().asElementHandle(), new FakeElementHandle().asElementHandle()] })
    const handle2 = new FakeElementHandle({ $$Targets: [new FakeElementHandle().asElementHandle()] })

    const page = new FakePage()
    page.locatorTargets.set('.slidev-page', [handle0.asElementHandle(), {} as any, handle2.asElementHandle()])

    const handles = await locateTargetsInVisibleSlides(page.asPage(), '.target')
    expect(handles).toHaveLength(3) // s0 の 2 件 + s2 の 1 件
  })

  it('スライド内に対象の要素が存在しない場合は、0 件を返す', async () => {
    await explains('スライド内に対象の要素が存在しない場合に、`locateTargetsInVisibleSlides` が空の結果（0 件）を返すことを確認します。')
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const page = new FakePage()
    // handle 未登録 → fake は空 $$Targets の handle を返す（1.62 の非 null 契約）
    page.locatorTargets.set('.slidev-page', [])
    const handles = await locateTargetsInVisibleSlides(page.asPage(), '.x')
    expect(handles).toHaveLength(0)
  })
})

describe('waitForSelectorInVisibleSlide', () => {
  it('timeout を指定して呼び出すと、待機の処理を実行する', async () => {
    await explains('表示中のスライドの要素を待つ `waitForSelectorInVisibleSlide` のテストです。`timeout` を指定して呼び出した場合に、ページの評価処理が 1 回以上実行されることを確認します。')
    const page = new FakePage()
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    await waitForSelectorInVisibleSlide(page.asPage(), '.target', '.loading', { timeout: 7777 })
    expect(page.evaluateCalls.length).toBeGreaterThan(0)
  })

  it('options を省略しても、待機の処理を実行する', async () => {
    await explains('`options` を省略して呼び出した場合のテストです。既定の待機時間で、ページの評価処理が 1 回以上実行されることを確認します。')
    const page = new FakePage()
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    await waitForSelectorInVisibleSlide(page.asPage(), '.target', '.loading')
    expect(page.evaluateCalls.length).toBeGreaterThan(0)
  })

  it('waitForFunction が失敗した場合は、そのエラーで失敗する', async () => {
    await explains('ページ側の待機処理（`waitForFunction`）がタイムアウトで失敗する場合のテストです。`waitForFunction timed out` を含むメッセージの例外が、そのまま発生することを確認します。')
    const page = new FakePage()
    page.waitForFunctionThrows = true
    await expect(waitForSelectorInVisibleSlide(page.asPage(), '.t', '.s'))
      .rejects.toThrow('waitForFunction timed out')
  })
})

describe('waitForCssAnimations', () => {
  it('すべてのアニメーションが完了した場合は、待機した件数を返す', async () => {
    await explains('CSS アニメーションの完了を待つ `waitForCssAnimations` のテストです。アニメーション 1 件が完了した場合に、`waited` が 1、`timedOut` が `false` になり、`CSS animation wait` を含む情報がログに出力されることを確認します。')
    const finishedAnim = {
      constructor: { name: 'CSSAnimation' },
      effect: { getTiming: () => ({ iterations: 1 }) },
      playState: 'running',
      finished: Promise.resolve(),
    } as unknown as Animation
    document.getAnimations = (): Animation[] => [finishedAnim]

    const page = new FakePage()
    const logger = makeLogger()
    const result = await waitForCssAnimations(page.asPage(), 5000, logger)
    expect(result.timedOut).toBe(false)
    expect(result.waited).toBe(1)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('CSS animation wait'))
  })

  it('無限に繰り返すアニメーションは、待機せずに skipped として数える', async () => {
    await explains('無限に繰り返す CSS アニメーションと、1 回で終わるトランジションがある場合のテストです。無限に繰り返すものは `skipped` が 1 になり、もう一方は `waited` が 1 になることを確認します。')
    const infiniteAnim = {
      constructor: { name: 'CSSAnimation' },
      effect: { getTiming: () => ({ iterations: Infinity }) },
      playState: 'running',
      finished: Promise.resolve(),
    } as unknown as Animation
    const finiteAnim = {
      constructor: { name: 'CSSTransition' },
      effect: { getTiming: () => ({ iterations: 1 }) },
      playState: 'running',
      finished: Promise.resolve(),
    } as unknown as Animation
    document.getAnimations = (): Animation[] => [infiniteAnim, finiteAnim]

    const result = await waitForCssAnimations(new FakePage().asPage(), 5000, makeLogger())
    expect(result.skipped).toBe(1)
    expect(result.waited).toBe(1)
  })

  it('アニメーションの完了待ちが失敗しても、エラーにせず待機済みとして数える', async () => {
    await explains('アニメーションの `finished` が失敗する場合のテストです。エラーとして扱わず、`waited` が 1、`timedOut` が `false` になることを確認します。')
    const failingAnim = {
      constructor: { name: 'CSSTransition' },
      effect: { getTiming: () => ({ iterations: 1 }) },
      playState: 'running',
      finished: Promise.reject(new Error('boom')),
    } as unknown as Animation
    document.getAnimations = (): Animation[] => [failingAnim]
    const result = await waitForCssAnimations(new FakePage().asPage(), 5000, makeLogger())
    expect(result.waited).toBe(1)
    expect(result.timedOut).toBe(false)
  })

  it('待機時間を過ぎた場合は、timedOut が true になり、タイムアウトをログに記録する', async () => {
    await explains('完了しないアニメーションがあり、待機時間（1 ミリ秒）を過ぎる場合のテストです。`timedOut` が `true` になり、`timed out` を含む情報がログに出力されることを確認します。')
    // 解決しない Animation を作る → setTimeout 側が先に resolve
    const stuckAnim = {
      constructor: { name: 'CSSTransition' },
      effect: { getTiming: () => ({ iterations: 1 }) },
      playState: 'running',
      finished: new Promise<void>(() => { /* never */ }),
    } as unknown as Animation
    document.getAnimations = (): Animation[] => [stuckAnim]
    const logger = makeLogger()
    const result = await waitForCssAnimations(new FakePage().asPage(), 1, logger)
    expect(result.timedOut).toBe(true)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })

  it('getTiming が iterations を返さないとき、アニメーション 1 件を待った数として返す', async () => {
    await explains('アニメーションのタイミング情報に `iterations` が含まれない場合のテストです。そのアニメーションも待機の対象として、`waited` が 1 になることを確認します。')
    const anim = {
      constructor: { name: 'CSSAnimation' },
      effect: { getTiming: () => ({}) },
      playState: 'running',
      finished: Promise.resolve(),
    } as unknown as Animation
    document.getAnimations = (): Animation[] => [anim]
    const result = await waitForCssAnimations(new FakePage().asPage(), 5000, makeLogger())
    expect(result.waited).toBe(1)
  })
})

describe('waitForIframeLoad', () => {
  it('iframe が存在しない場合は、待機せずに終了する', async () => {
    await explains('iframe の読み込みを待つ `waitForIframeLoad` のテストです。対象の iframe が存在しない場合に、待機せずに終了し、`none found` を含む情報がログに出力されることを確認します。')
    document.body.replaceChildren()
    const page = new FakePage()
    const logger = makeLogger()
    await waitForIframeLoad(page.asPage(), '.artifact-iframe', 5000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('none found'))
  })

  it('iframe があり、読み込みが完了した場合は、完了をログに記録する', async () => {
    await explains('iframe が存在し、読み込みの待機が成功する場合のテストです。`to finish loading` を含む情報がログに出力されることを確認します。')
    document.body.innerHTML = '<iframe class="artifact-iframe"></iframe>'
    const page = new FakePage()
    const logger = makeLogger()
    await waitForIframeLoad(page.asPage(), '.artifact-iframe', 5000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('to finish loading'))
  })

  it('読み込みの待機が失敗した場合は、タイムアウトをログに記録する', async () => {
    await explains('iframe が存在し、読み込みの待機が失敗する場合のテストです。例外を発生させずに、`timed out` を含む情報がログに出力されることを確認します。')
    document.body.innerHTML = '<iframe class="artifact-iframe"></iframe>'
    const page = new FakePage()
    page.waitForFunctionThrows = true
    const logger = makeLogger()
    await waitForIframeLoad(page.asPage(), '.artifact-iframe', 5000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })
})

describe('スコープ付き locate / wait (#1141)', () => {
  const printDom = `
    <div class="print-slide-container" id="001-01"><div class="slidev-page" style="display:block"><span></span><div class="target"><div class="loading"></div></div></div></div>
    <div class="print-slide-container" id="002-01"><div class="slidev-page" style="display:block"><span></span><div class="target"></div></div></div>
  `

  it('scope を指定した場合は、その範囲の .slidev-page だけを対象にして要素を取得する', async () => {
    await explains('取得の範囲をスコープ（`[id="002-01"]`）で指定した場合のテストです。範囲の外のスライドの要素は取得されず、範囲の中の 1 件だけが取得されることを確認します。')
    document.body.innerHTML = printDom
    const inScope = new FakeElementHandle({ $$Targets: [new FakeElementHandle().asElementHandle()] })
    const outOfScope = new FakeElementHandle({ $$Targets: [new FakeElementHandle().asElementHandle(), new FakeElementHandle().asElementHandle()] })
    const page = new FakePage()
    page.locatorTargets.set('[id="002-01"] .slidev-page', [inScope.asElementHandle()])
    page.locatorTargets.set('.slidev-page', [outOfScope.asElementHandle(), inScope.asElementHandle()])

    const handles = await locateTargetsInVisibleSlides(page.asPage(), '.target', '[id="002-01"]')

    expect(handles).toHaveLength(1)
    expect(page.evaluateCalls[0]?.arg).toMatchObject({ pageSel: '[id="002-01"] .slidev-page' })
  })

  it('scope を指定した場合は、範囲の外のコンテナの待機対象を見ない', async () => {
    await explains('待機の範囲をスコープで指定した場合のテストです。`002-01` を指定すると待機の条件が満たされ、`001-01` を指定した場合とスコープなしの場合は満たされないことを確認します。')
    document.body.innerHTML = printDom
    const page = new FakePage()
    const judge = (): unknown => {
      const call = page.evaluateCalls.at(-1)
      return (call?.fn as (argument: unknown) => unknown)(call?.arg)
    }

    await waitForSelectorInVisibleSlide(page.asPage(), '.target', '.loading', { scopeSelector: '[id="002-01"]' })
    expect(judge()).toBe(true)
    await waitForSelectorInVisibleSlide(page.asPage(), '.target', '.loading', { scopeSelector: '[id="001-01"]' })
    expect(judge()).toBe(false)
    await waitForSelectorInVisibleSlide(page.asPage(), '.target', '.loading')
    expect(judge()).toBe(false)
  })
})

describe('waitForFontsReady', () => {
  it('document.fonts が存在しない環境では、待機せずに終了する', async () => {
    await explains('フォントの読み込みを待つ `waitForFontsReady` のテストです。`document.fonts` が存在しない環境（jsdom）では、待機せずに返り、ページの評価処理が 1 回だけ実行されることを確認します。')
    const page = new FakePage()
    await waitForFontsReady(page.asPage(), 5000)
    expect(page.evaluateCalls).toHaveLength(1)
  })

  it('document.fonts.ready が完了した場合は、処理を終了する', async () => {
    await explains('`document.fonts.ready` が完了する場合のテストです。ページの評価処理が 1 回だけ実行され、正常に終了することを確認します。')
    const page = new FakePage()
    Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true })
    try {
      await waitForFontsReady(page.asPage(), 5000)
      expect(page.evaluateCalls).toHaveLength(1)
    }
    finally {
      Reflect.deleteProperty(document, 'fonts')
    }
  })
})

// jsdom の getBoundingClientRect は常に 0 を返すため、描画済みの印を幅と高さを持つ要素として扱わせる
function markRendered(selector: string): void {
  for (const element of document.querySelectorAll(selector)) {
    ;(element as HTMLElement).getBoundingClientRect = () => ({ width: 1, height: 1 } as DOMRect)
  }
}

describe('waitForDataWaitfor', () => {
  it('data-waitfor の要素が存在しない場合は、0 件として即座に終了する', async () => {
    await explains('`data-waitfor` で描画の完了を待つ `waitForDataWaitfor` のテストです。`data-waitfor` を持つ要素が存在しない場合に、`0 done` を含む情報がログに出力され、警告は出力されないことを確認します。')
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const page = new FakePage()
    const logger = makeLogger()
    await waitForDataWaitfor(page.asPage(), undefined, 1000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('0 done'))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('表示中のスライドの待機対象が描画済みの場合は、完了した件数をログに記録する', async () => {
    await explains('表示中のスライドの待機対象の要素が描画済みの場合のテストです。表示されていないスライドは数えず、`1 done` を含む情報がログに出力され、警告は出力されないことを確認します。')
    document.body.innerHTML = `
      <div class="slidev-page" style="display:block">
        <div data-waitfor=".is-ready"><div class="is-ready"></div></div>
      </div>
      <div class="slidev-page" style="display:none">
        <div data-waitfor=".is-ready"></div>
      </div>
    `
    markRendered('.is-ready')
    const page = new FakePage()
    const logger = makeLogger()
    await waitForDataWaitfor(page.asPage(), undefined, 1000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('1 done'))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('待機対象が描画されないまま上限の時間を過ぎた場合は、警告を出力して処理を続ける', async () => {
    await explains('待機対象の要素が描画されないまま、待機の上限（120 ミリ秒）を過ぎる場合のテストです。`timed out (120ms)` を含む警告が出力され、例外は発生しないことを確認します。')
    document.body.innerHTML = `
      <div class="slidev-page" style="display:block">
        <div data-waitfor=".is-ready"><span></span></div>
      </div>
    `
    const page = new FakePage()
    const logger = makeLogger()
    await waitForDataWaitfor(page.asPage(), undefined, 120, logger)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out (120ms)'))
  })

  it('scope を渡した場合は、その範囲の待機対象だけを見る', async () => {
    await explains('範囲（`#g1`）を指定した場合のテストです。範囲の中の描画済みの要素だけが数えられ、`1 done` を含む情報がログに出力され、警告は出力されないことを確認します。')
    document.body.innerHTML = `
      <div id="g1"><div data-waitfor=".is-ready"><div class="is-ready"></div></div></div>
      <div id="g2"><div data-waitfor=".is-ready"></div></div>
    `
    markRendered('#g1 .is-ready')
    const page = new FakePage()
    const logger = makeLogger()
    await waitForDataWaitfor(page.asPage(), '#g1', 1000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('1 done'))
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
