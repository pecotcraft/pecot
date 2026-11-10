// @vitest-environment jsdom
/* eslint-disable unicorn/name-replacements */
/* eslint-disable @typescript-eslint/no-explicit-any -- jsdom + FakePage で検証 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { prerenderComplexElements, restorePrerenderElements } from '../prerender.js'
import type { PrerenderConfig } from '../prerender-config.js'
import { FakeBrowser, FakeElementHandle, FakePage } from './support/fake-playwright.js'
import { makeLogger } from './support/logger.js'

const baseConfig: PrerenderConfig = {
  targets: [],
  defaultWaitStrategy: { type: 'fixed', delay: 0 },
  deviceScaleFactor: 5,
  pptxImageScale: 2,
}

describe('prerenderComplexElements', () => {
  let outDir: string

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'pecotv-prerender-'))
  })

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('elements が 0 件の target はスキップする', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const page = new FakePage()
    page.locatorTargets.set('.slidev-page', [new FakeElementHandle({ $$Targets: [] }).asElementHandle()])
    const browser = new FakeBrowser()
    const logger = makeLogger()
    const config: PrerenderConfig = { ...baseConfig, targets: [{ selector: '.empty' }] }
    const results = await prerenderComplexElements(page.asPage(), browser.asBrowser(), config, 1, outDir, logger)
    expect(results).toHaveLength(0)
    expect(browser.newPageCalls).toHaveLength(0)
  })

  it('fixed 待機戦略で elements を画像化する', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const targetHandle = new FakeElementHandle({
      boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }, { x: 0, y: 0, width: 50, height: 50 }],
      screenshotResults: [Buffer.from('shot')],
    })
    const page = new FakePage()
    page.locatorTargets.set('.slidev-page', [
      new FakeElementHandle({ $$Targets: [targetHandle.asElementHandle()] }).asElementHandle(),
    ])

    const hiResPage = new FakePage()
    hiResPage.locatorTargets.set('.slidev-page', [
      new FakeElementHandle({ $$Targets: [targetHandle.asElementHandle()] }).asElementHandle(),
    ])
    document.getAnimations = (): Animation[] => []

    const browser = new FakeBrowser({ pages: [hiResPage] })
    const logger = makeLogger()
    const config: PrerenderConfig = {
      ...baseConfig,
      targets: [{ selector: '.target', waitStrategy: { type: 'fixed', delay: 1 } }],
    }

    const results = await prerenderComplexElements(page.asPage(), browser.asBrowser(), config, 100, outDir, logger, 'http://test/100')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(hiResPage.gotoCalls[0]?.url).toBe('http://test/100')
    expect(hiResPage.waitForTimeoutCalls).toContain(1)
  })

  it('slideUrl 省略時は page.url() を使う', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const targetHandle = new FakeElementHandle()
    const page = new FakePage({ url: 'http://from-page-url' })
    page.locatorTargets.set('.slidev-page', [
      new FakeElementHandle({ $$Targets: [targetHandle.asElementHandle()] }).asElementHandle(),
    ])
    const hiResPage = new FakePage()
    hiResPage.locatorTargets.set('.slidev-page', [new FakeElementHandle({ $$Targets: [] }).asElementHandle()])
    document.getAnimations = (): Animation[] => []
    const browser = new FakeBrowser({ pages: [hiResPage] })
    const config: PrerenderConfig = { ...baseConfig, targets: [{ selector: '.target' }] }
    await prerenderComplexElements(page.asPage(), browser.asBrowser(), config, 1, outDir, makeLogger())
    expect(hiResPage.gotoCalls[0]?.url).toBe('http://from-page-url')
  })

  it('selectorState 待機戦略を実行する (settleDelay 含む)', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const targetHandle = new FakeElementHandle()
    const page = new FakePage()
    page.locatorTargets.set('.slidev-page', [
      new FakeElementHandle({ $$Targets: [targetHandle.asElementHandle()] }).asElementHandle(),
    ])
    const hiResPage = new FakePage()
    hiResPage.locatorTargets.set('.slidev-page', [new FakeElementHandle({ $$Targets: [targetHandle.asElementHandle()] }).asElementHandle()])
    document.getAnimations = (): Animation[] => []
    const browser = new FakeBrowser({ pages: [hiResPage] })
    const logger = makeLogger()
    const config: PrerenderConfig = {
      ...baseConfig,
      targets: [{
        selector: '.target',
        waitStrategy: { type: 'selectorState', selector: '.loading', state: 'detached', timeout: 1, settleDelay: 50 },
      }],
    }
    await prerenderComplexElements(page.asPage(), browser.asBrowser(), config, 1, outDir, logger)
    expect(hiResPage.waitForTimeoutCalls).toContain(50)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('render completion detected'))
  })

  it('selectorState で waitForFunction が throw すると logger.warn でタイムアウト警告', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const targetHandle = new FakeElementHandle()
    const page = new FakePage()
    page.locatorTargets.set('.slidev-page', [
      new FakeElementHandle({ $$Targets: [targetHandle.asElementHandle()] }).asElementHandle(),
    ])
    const hiResPage = new FakePage()
    hiResPage.locatorTargets.set('.slidev-page', [new FakeElementHandle({ $$Targets: [targetHandle.asElementHandle()] }).asElementHandle()])
    hiResPage.waitForFunctionResolves = [true, false] // 1 回目 (visible) は OK、2 回目 (waitForSelectorInVisibleSlide) で fail
    document.getAnimations = (): Animation[] => []
    const browser = new FakeBrowser({ pages: [hiResPage] })
    const logger = makeLogger()
    const config: PrerenderConfig = {
      ...baseConfig,
      targets: [{
        selector: '.target',
        waitStrategy: { type: 'selectorState', selector: '.loading' },
      }],
    }
    await prerenderComplexElements(page.asPage(), browser.asBrowser(), config, 1, outDir, logger)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })

  it('hiRes と page で elements 数が異なれば mismatch 警告を出す', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const t1 = new FakeElementHandle()
    const t2 = new FakeElementHandle()
    const page = new FakePage()
    page.locatorTargets.set('.slidev-page', [
      new FakeElementHandle({ $$Targets: [t1.asElementHandle(), t2.asElementHandle()] }).asElementHandle(),
    ])
    const hiResPage = new FakePage()
    hiResPage.locatorTargets.set('.slidev-page', [
      new FakeElementHandle({ $$Targets: [t1.asElementHandle()] }).asElementHandle(), // 数が異なる
    ])
    document.getAnimations = (): Animation[] => []
    const browser = new FakeBrowser({ pages: [hiResPage] })
    const logger = makeLogger()
    const config: PrerenderConfig = { ...baseConfig, targets: [{ selector: '.target' }] }
    await prerenderComplexElements(page.asPage(), browser.asBrowser(), config, 1, outDir, logger)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('detected count mismatch'))
  })

  it('deviceScaleFactor が falsy のとき 5 にフォールバック', async () => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    const t = new FakeElementHandle()
    const page = new FakePage()
    page.locatorTargets.set('.slidev-page', [
      new FakeElementHandle({ $$Targets: [t.asElementHandle()] }).asElementHandle(),
    ])
    const hiResPage = new FakePage()
    hiResPage.locatorTargets.set('.slidev-page', [new FakeElementHandle({ $$Targets: [t.asElementHandle()] }).asElementHandle()])
    document.getAnimations = (): Animation[] => []
    const browser = new FakeBrowser({ pages: [hiResPage] })
    const config: PrerenderConfig = { ...baseConfig, deviceScaleFactor: 0, targets: [{ selector: '.target' }] }
    await prerenderComplexElements(page.asPage(), browser.asBrowser(), config, 1, outDir, makeLogger())
    expect(browser.newPageCalls[0]).toMatchObject({ deviceScaleFactor: 5 })
  })

  it('cleanup 後に出力ディレクトリ自体は残る (ベースケース)', async () => {
    const files = await readdir(outDir)
    expect(Array.isArray(files)).toBe(true)
  })
})

describe('restorePrerenderElements', () => {
  it('hidden 要素の display を戻し prerender-img を removed する', async () => {
    document.body.innerHTML = `
      <div data-prerender-hidden="true" style="display:none">orig</div>
      <img data-prerender-img="true" src="x.png" />
    `
    const page = new FakePage()
    const logger = makeLogger()
    await restorePrerenderElements(page.asPage(), logger)
    expect(document.querySelectorAll('[data-prerender-hidden]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-prerender-img]')).toHaveLength(0)
    expect(logger.verbose).toHaveBeenCalledWith('prerender elements restored')
  })

  it('scopeSelector 指定時はその要素の内側だけを戻す (#1141)', async () => {
    document.body.innerHTML = `
      <div id="a"><div data-prerender-hidden="true" style="display:none">a</div><img data-prerender-img="true" src="a.png" /></div>
      <div id="b"><div data-prerender-hidden="true" style="display:none">b</div><img data-prerender-img="true" src="b.png" /></div>
    `
    const logger = makeLogger()
    await restorePrerenderElements(new FakePage().asPage(), logger, '[id="b"]')
    expect(document.querySelectorAll('#b [data-prerender-hidden], #b [data-prerender-img]')).toHaveLength(0)
    expect(document.querySelectorAll('#a [data-prerender-hidden]')).toHaveLength(1)
    expect(document.querySelectorAll('#a [data-prerender-img]')).toHaveLength(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('復元失敗 (要素が残った) ケースで警告を出す', async () => {
    document.body.replaceChildren()
    const page = new FakePage()
    // 2 度目の evaluate (検証) で残存数を返すように stub
    let count = 0
    const origEvaluate = page.evaluate.bind(page)
    page.evaluate = async <R>(fn: any, arg?: unknown): Promise<R> => {
      count++
      return count === 2 ? ({ hidden: 1, imgs: 2 } as unknown as R) : origEvaluate(fn, arg)
    }
    const logger = makeLogger()
    await restorePrerenderElements(page.asPage(), logger)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DOM restore incomplete'))
  })
})
