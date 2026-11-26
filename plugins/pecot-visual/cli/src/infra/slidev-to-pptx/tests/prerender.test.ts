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
import { explains } from '../../../../tests/_helpers/explains.js'

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

  it('対象の要素が 0 件の場合は、処理をスキップする', async () => {
    await explains('プリレンダの処理 `prerenderComplexElements` の、対象要素の検出のテストです。対象のセレクタに一致する要素が 0 件の場合に、結果が空になり、高解像度用のページを作成しないことを確認します。')
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

  it('待機方法が fixed の場合は、指定した時間だけ待機して、要素を画像にする', async () => {
    await explains('待機方法に `fixed`（固定時間）を指定した場合のテストです。スライドの URL が高解像度用のページで開かれ、指定した時間（1 ミリ秒）だけ待機して、要素の結果が 1 件以上返ることを確認します。')
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

  it('slideUrl を省略した場合は、page.url() の URL を開く', async () => {
    await explains('スライドの URL（`slideUrl`）を省略した場合のテストです。現在のページの URL（`page.url()`）が、高解像度用のページで開かれることを確認します。')
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

  it('待機方法が selectorState の場合は、描画の完了を検出し、settleDelay の時間も待機する', async () => {
    await explains('待機方法に `selectorState` を指定し、`settleDelay` を 50 ミリ秒にした場合のテストです。50 ミリ秒の待機が行われ、`render completion detected` を含む情報がログに出力されることを確認します。')
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

  it('待機方法が selectorState で、待機がタイムアウトした場合は、警告を出力する', async () => {
    await explains('待機方法に `selectorState` を指定し、セレクタの状態を待つ処理が失敗する場合のテストです。`timed out` を含む警告が出力されることを確認します。')
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

  it('高解像度用のページと元のページで要素の数が異なる場合は、不一致の警告を出力する', async () => {
    await explains('元のページでは 2 件、高解像度用のページでは 1 件の要素が見つかる場合のテストです。`detected count mismatch` を含む警告が出力されることを確認します。')
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

  it('deviceScaleFactor が 0 の場合は、5 を使って高解像度用のページを作成する', async () => {
    await explains('`deviceScaleFactor` に 0 を指定した場合のテストです。高解像度用のページが、既定の倍率である 5 で作成されることを確認します。')
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

  it('出力ディレクトリを読み取ると、ファイルの一覧を配列で取得できる', async () => {
    await explains('プリレンダの出力先ディレクトリのテストです。処理の後でもディレクトリが存在し、ファイルの一覧を配列として取得できることを確認します。')
    const files = await readdir(outDir)
    expect(Array.isArray(files)).toBe(true)
  })
})

describe('restorePrerenderElements', () => {
  it('復元処理では、非表示にした要素の表示を戻し、プリレンダの画像を削除する', async () => {
    await explains('プリレンダ後の DOM を元に戻す `restorePrerenderElements` のテストです。`data-prerender-hidden` と `data-prerender-img` の要素が残らず、`prerender elements restored` をログに出力することを確認します。')
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

  it('scopeSelector を指定した場合は、その要素の内側だけを元に戻す', async () => {
    await explains('復元の範囲を `scopeSelector` で指定した場合のテストです。指定した要素の内側だけが元に戻り、ほかの要素の内側は変更されず、警告も出力されないことを確認します。')
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

  it('復元後も要素が残っている場合は、復元が完了していない旨の警告を出力する', async () => {
    await explains('復元の後の検証で、非表示の要素と画像が残っていると判定される場合のテストです。`DOM restore incomplete` を含む警告が出力されることを確認します。')
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
