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

describe('locateTargetsInVisibleSlides', () => {
  it('可視 slide 内の target をすべて回収する', async () => {
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

  it('slide 内に対象要素がなければ 0 件', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const page = new FakePage()
    // handle 未登録 → fake は空 $$Targets の handle を返す（1.62 の非 null 契約）
    page.locatorTargets.set('.slidev-page', [])
    const handles = await locateTargetsInVisibleSlides(page.asPage(), '.x')
    expect(handles).toHaveLength(0)
  })
})

describe('waitForSelectorInVisibleSlide', () => {
  it('指定 timeout で waitForFunction を呼ぶ', async () => {
    const page = new FakePage()
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    await waitForSelectorInVisibleSlide(page.asPage(), '.target', '.loading', { timeout: 7777 })
    expect(page.evaluateCalls.length).toBeGreaterThan(0)
  })

  it('options 省略時は default 15000ms', async () => {
    const page = new FakePage()
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    await waitForSelectorInVisibleSlide(page.asPage(), '.target', '.loading')
    expect(page.evaluateCalls.length).toBeGreaterThan(0)
  })

  it('waitForFunction が throw すると propagate', async () => {
    const page = new FakePage()
    page.waitForFunctionThrows = true
    await expect(waitForSelectorInVisibleSlide(page.asPage(), '.t', '.s'))
      .rejects.toThrow('waitForFunction timed out')
  })
})

describe('waitForCssAnimations', () => {
  it('animations 全完了で waited 件数を返す', async () => {
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
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('CSSアニメーション待機'))
  })

  it('infinite iteration の CSSAnimation は skipped としてカウントされる', async () => {
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

  it('animation.finished が reject しても catch で握り潰す', async () => {
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

  it('timeout 経過で timedOut=true を返し logger.verbose にタイムアウトを記録', async () => {
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
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('タイムアウト'))
  })

  it('effect.getTiming() の iterations が undefined でも動作する', async () => {
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
  it('iframe が 0 件なら早期 return', async () => {
    document.body.replaceChildren()
    const page = new FakePage()
    const logger = makeLogger()
    await waitForIframeLoad(page.asPage(), '.artifact-iframe', 5000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('0件'))
  })

  it('iframe ありで waitForFunction が成功するとロード完了ログ', async () => {
    document.body.innerHTML = '<iframe class="artifact-iframe"></iframe>'
    const page = new FakePage()
    const logger = makeLogger()
    await waitForIframeLoad(page.asPage(), '.artifact-iframe', 5000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('ロード完了を待機'))
  })

  it('waitForFunction が throw した場合はタイムアウトログを出す', async () => {
    document.body.innerHTML = '<iframe class="artifact-iframe"></iframe>'
    const page = new FakePage()
    page.waitForFunctionThrows = true
    const logger = makeLogger()
    await waitForIframeLoad(page.asPage(), '.artifact-iframe', 5000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('タイムアウト'))
  })
})

describe('スコープ付き locate / wait (#1141)', () => {
  const printDom = `
    <div class="print-slide-container" id="001-01"><div class="slidev-page" style="display:block"><span></span><div class="target"><div class="loading"></div></div></div></div>
    <div class="print-slide-container" id="002-01"><div class="slidev-page" style="display:block"><span></span><div class="target"></div></div></div>
  `

  it('locateTargetsInVisibleSlides は scope 内の .slidev-page だけを走査する', async () => {
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

  it('waitForSelectorInVisibleSlide は scope 外のコンテナの待ち対象を見ない', async () => {
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
  it('document.fonts が無い環境（jsdom）では待たずに返す', async () => {
    const page = new FakePage()
    await waitForFontsReady(page.asPage(), 5000)
    expect(page.evaluateCalls).toHaveLength(1)
  })

  it('document.fonts.ready が解決すると返る', async () => {
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
  it('[data-waitfor] が無ければ 0 件で即座に返す', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const page = new FakePage()
    const logger = makeLogger()
    await waitForDataWaitfor(page.asPage(), undefined, 1000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('0件完了'))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('可視スライドの印が描画済みなら件数を verbose に出す', async () => {
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
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('1件完了'))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('印が出ないまま上限を超えると warn を出して続行する', async () => {
    document.body.innerHTML = `
      <div class="slidev-page" style="display:block">
        <div data-waitfor=".is-ready"><span></span></div>
      </div>
    `
    const page = new FakePage()
    const logger = makeLogger()
    await waitForDataWaitfor(page.asPage(), undefined, 120, logger)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('タイムアウト (120ms)'))
  })

  it('scope を渡すと、その範囲の印だけを見る', async () => {
    document.body.innerHTML = `
      <div id="g1"><div data-waitfor=".is-ready"><div class="is-ready"></div></div></div>
      <div id="g2"><div data-waitfor=".is-ready"></div></div>
    `
    markRendered('#g1 .is-ready')
    const page = new FakePage()
    const logger = makeLogger()
    await waitForDataWaitfor(page.asPage(), '#g1', 1000, logger)
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('1件完了'))
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
