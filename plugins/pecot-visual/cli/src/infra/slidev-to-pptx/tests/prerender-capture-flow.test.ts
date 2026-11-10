// @vitest-environment jsdom
/* eslint-disable unicorn/name-replacements */
/* eslint-disable @typescript-eslint/no-explicit-any -- jsdom + FakePage でテスト */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { captureAndReplaceElements } from '../prerender-capture.js'
import type { PrerenderConfig, PrerenderTarget } from '../prerender-config.js'
import { FakeElementHandle, FakePage, applyDomReplacementOn } from './support/fake-playwright.js'
import { makeLogger } from './support/logger.js'

const baseConfig: PrerenderConfig = {
  targets: [],
  defaultWaitStrategy: { type: 'fixed', delay: 0 },
  deviceScaleFactor: 5,
  pptxImageScale: 2,
}

describe('captureAndReplaceElements', () => {
  let outDir: string

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'pecotv-capture-'))
  })

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('通常 capture: hiRes screenshot → 画像 + meta.json 出力 + DOM 置換', async () => {
    const target: PrerenderTarget = { selector: '.foo' }
    document.body.innerHTML = '<div class="foo">orig</div>'
    const elementOnPage = document.querySelector('.foo')!
    const elementHandle = new FakeElementHandle({
      boundingBoxes: [{ x: 5, y: 5, width: 80, height: 60 }],
    })
    applyDomReplacementOn(elementHandle, elementOnPage)

    const hiResHandle = new FakeElementHandle({
      boundingBoxes: [{ x: 0, y: 0, width: 100, height: 80 }],
      screenshotResults: [Buffer.from('hires-shot')],
    })

    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 960, height: 540 }
    hiResPage.screenshotResults = [Buffer.from('clip-shot')]

    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target,
      config: baseConfig,
      slideNum: 1,
      slidesDir: outDir,
      globalIndex: 0,
      logger: makeLogger(),
    })
    expect(result.count).toBe(1)
    expect(result.errors).toHaveLength(0)
    expect(result.results[0]?.success).toBe(true)
    expect(result.processedCount).toBe(1)
    const files = await readdir(outDir)
    expect(files.some(f => f.endsWith('.png'))).toBe(true)
    expect(files.some(f => f.endsWith('.meta.json'))).toBe(true)

    const metaFile = files.find(f => f.endsWith('.meta.json'))!
    const meta = JSON.parse(await readFile(path.join(outDir, metaFile), 'utf8')) as Record<string, unknown>
    expect(meta['selector']).toBe('.foo')
  })

  it('origin を渡すと meta.json の left / top がその原点基準になる (#1141)', async () => {
    const target: PrerenderTarget = { selector: '.origin' }
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 25, y: 1100, width: 80, height: 60 }] })
    const hiResHandle = new FakeElementHandle({ boundingBoxes: [{ x: 25, y: 20, width: 80, height: 60 }] })
    const hiResPage = new FakePage()

    await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target,
      config: baseConfig,
      slideNum: 701,
      slidesDir: outDir,
      globalIndex: 0,
      logger: makeLogger(),
      origin: { x: 0, y: 1080 },
    })
    const meta = JSON.parse(await readFile(path.join(outDir, 'prerender-slide701-0.meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta).toMatchObject({ left: 25, top: 20, width: 160, height: 120 })
  })

  it('clipPadding 有り: clip 計算込みで screenshot を呼ぶ', async () => {
    document.body.innerHTML = '<div class="foo"></div>'
    const elementOnPage = document.querySelector('.foo')!
    const elementHandle = new FakeElementHandle({
      boundingBoxes: [{ x: 5, y: 5, width: 80, height: 60 }],
    })
    applyDomReplacementOn(elementHandle, elementOnPage)
    const hiResHandle = new FakeElementHandle({
      boundingBoxes: [{ x: 10, y: 10, width: 100, height: 80 }],
    })
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 960, height: 540 }
    hiResPage.screenshotResults = [Buffer.from('clip-shot')]

    const target: PrerenderTarget = { selector: '.foo', clipPadding: { left: 4, right: 4, top: 4, bottom: 4 } }
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target,
      config: baseConfig,
      slideNum: 2,
      slidesDir: outDir,
      globalIndex: 10,
      logger: makeLogger(),
    })
    expect(result.count).toBe(1)
    expect(hiResPage.screenshotCalls[0]?.clip).toMatchObject({ x: 6, y: 6, width: 108, height: 88 })
  })

  it('boundingBox 取得失敗で警告、results に error が含まれる', async () => {
    const failingHandle = new FakeElementHandle()
    failingHandle.boundingBox = async () => { throw new Error('bbox-fail') }
    const hiResHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 960, height: 540 }
    const logger = makeLogger()
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [failingHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.x' },
      config: baseConfig,
      slideNum: 3,
      slidesDir: outDir,
      globalIndex: 0,
      logger,
    })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boundingBox lookup failed'))
    // box が null + screenshot は成功するが phase 3 で「boundingBox is null」となり成功カウント 0
    expect(result.results.some(r => r.error?.includes('boundingBox lookup failed'))).toBe(true)
    // 同一要素に失敗を二重計上しない。Phase 1 の catch が理由を確定させ、hiRes screenshot が
    // 成功して Phase 3 の `!box` 分岐へ落ちても、results は増やさない。
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.error).toBe('boundingBox lookup failed: bbox-fail')
  })

  it('hiRes screenshot 失敗で警告、screenshots[i] = null で skip される', async () => {
    document.body.innerHTML = '<div class="x"></div>'
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    const hiResHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    hiResHandle.screenshot = async () => { throw new Error('shot-fail') }
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 960, height: 540 }
    const logger = makeLogger()
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.x' },
      config: baseConfig,
      slideNum: 4,
      slidesDir: outDir,
      globalIndex: 0,
      logger,
    })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hiRes screenshot failed'))
    expect(result.count).toBe(0)
  })

  it('オフスクリーン要素で transform を一時解除して capture する', async () => {
    document.body.innerHTML = `
      <div style="transform: translateX(10px); overflow: hidden">
        <div class="x">offscreen</div>
      </div>
    `
    const elementOnPage = document.querySelector('.x')!
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    applyDomReplacementOn(elementHandle, elementOnPage)
    // hiRes 側はオフスクリーン (viewport 100x100 の外)、reposition 後は inview
    const hiResHandle = new FakeElementHandle({
      boundingBoxes: [
        { x: -200, y: -200, width: 50, height: 50 }, // 1 回目: offscreen
        { x: 10, y: 10, width: 50, height: 50 }, // reposition 後
      ],
    })
    let invocation = 0
    hiResHandle.evaluate = async <R>(fn: any, arg?: unknown): Promise<R> => {
      invocation++
      if (invocation === 1) {
        // 祖先 transform を walk する saved transforms 戻り値
        return [{ markerId: 'mk-1', originalTransform: 'translateX(10px)', originalOverflow: 'hidden' }] as unknown as R
      }
      // restore evaluate (副作用)
      const originalDoc = document
      const fake = originalDoc.createElement('div')
      fake.dataset['prerenderTransformId'] = 'mk-1'
      originalDoc.body.append(fake)
      try {
        return fn(fake, arg) as R
      }
      finally {
        fake.remove()
      }
    }
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 100, height: 100 }
    hiResPage.screenshotResults = [Buffer.from('reposition-shot')]
    const logger = makeLogger()
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.x' },
      config: baseConfig,
      slideNum: 5,
      slidesDir: outDir,
      globalIndex: 0,
      logger,
    })
    expect(result.count).toBe(1)
    expect(hiResPage.waitForTimeoutCalls).toContain(100)
  })

  it('オフスクリーン + clipPadding ありで clip パラメータが計算される', async () => {
    document.body.innerHTML = `<div class="x"></div>`
    const elementOnPage = document.querySelector('.x')!
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    applyDomReplacementOn(elementHandle, elementOnPage)
    const hiResHandle = new FakeElementHandle({
      boundingBoxes: [
        { x: -200, y: -200, width: 50, height: 50 },
        { x: 10, y: 10, width: 50, height: 50 },
      ],
    })
    hiResHandle.evaluate = async <R>(): Promise<R> => Promise.resolve([] as unknown as R)
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 100, height: 100 }
    hiResPage.screenshotResults = [Buffer.from('shot')]
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.x', clipPadding: { left: 2, top: 2, right: 2, bottom: 2 } },
      config: baseConfig,
      slideNum: 6,
      slidesDir: outDir,
      globalIndex: 0,
      logger: makeLogger(),
    })
    expect(result.count).toBe(1)
    expect(hiResPage.screenshotCalls[0]?.clip).toMatchObject({ x: 8, y: 8, width: 54, height: 54 })
  })

  it('Phase 3 で DOM 置換時の例外を catch して errors に追加', async () => {
    document.body.innerHTML = '<div class="x"></div>'
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    elementHandle.evaluate = async <R>(_fn: any, _arg?: unknown): Promise<R> => {
      throw new Error('replace-fail')
    }
    const hiResHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 960, height: 540 }
    hiResPage.screenshotResults = [Buffer.from('shot')]
    const logger = makeLogger()
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.x' },
      config: baseConfig,
      slideNum: 7,
      slidesDir: outDir,
      globalIndex: 0,
      logger,
    })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.results.some(r => r.error?.includes('replace-fail'))).toBe(true)
  })

  it('hiRes boundingBox が null なら screenshot を呼ばずに不可視として失敗を積む', async () => {
    document.body.innerHTML = '<div class="x"></div>'
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    const hiResHandle = new FakeElementHandle({ boundingBoxes: [null] })
    let screenshotCalls = 0
    hiResHandle.screenshot = async () => {
      screenshotCalls++
      return Promise.resolve(Buffer.from('should-not-be-taken'))
    }
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 960, height: 540 }
    const logger = makeLogger()
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.x' },
      config: baseConfig,
      slideNum: 8,
      slidesDir: outDir,
      globalIndex: 0,
      logger,
    })
    // 撮れないことは box の時点で確定しており、Playwright の可視化待ちに入らせない
    expect(screenshotCalls).toBe(0)
    expect(hiResPage.screenshotCalls).toHaveLength(0)
    expect(result.count).toBe(0)
    expect(result.results.some(r => r.error === 'hiRes screenshot failed: element is not visible (boundingBox is null)')).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hiRes screenshot failed'))
  })

  it('オフスクリーン要素の再計測が null でも savedTransforms を復元してから失敗にする', async () => {
    document.body.innerHTML = '<div class="x"></div>'
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    const hiResHandle = new FakeElementHandle({
      boundingBoxes: [
        { x: -200, y: -200, width: 50, height: 50 }, // 1 回目: offscreen 判定
        null, // 一時移動後も box が返らない
      ],
    })
    let screenshotCalls = 0
    hiResHandle.screenshot = async () => {
      screenshotCalls++
      return Promise.resolve(Buffer.from('should-not-be-taken'))
    }
    const restoreArguments: unknown[] = []
    let invocation = 0
    hiResHandle.evaluate = async <R>(_fn: any, arg?: unknown): Promise<R> => {
      invocation++
      if (invocation === 1) {
        return [{ markerId: 'mk-1', originalTransform: 'translateX(10px)', originalOverflow: 'hidden' }] as unknown as R
      }
      restoreArguments.push(arg)
      return Promise.resolve(undefined as unknown as R)
    }
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 100, height: 100 }
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.x' },
      config: baseConfig,
      slideNum: 9,
      slidesDir: outDir,
      globalIndex: 0,
      logger: makeLogger(),
    })
    expect(screenshotCalls).toBe(0)
    // 復元を飛ばすと同一 hiResPage 上の後続要素が transform 解除のまま破損する
    expect(restoreArguments).toHaveLength(1)
    expect(result.results.some(r => r.error === 'hiRes screenshot failed: element is not visible (boundingBox is null)')).toBe(true)
  })

  it('オフスクリーン要素の screenshot が throw しても savedTransforms を復元する', async () => {
    document.body.innerHTML = '<div class="x"></div>'
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 50, height: 50 }] })
    const hiResHandle = new FakeElementHandle({
      boundingBoxes: [
        { x: -200, y: -200, width: 50, height: 50 }, // 1 回目: offscreen 判定
        { x: 10, y: 10, width: 50, height: 50 }, // 一時移動後は inview なので screenshot まで進む
      ],
    })
    hiResHandle.screenshot = async () => { throw new Error('shot-fail') }
    const restoreArguments: unknown[] = []
    let invocation = 0
    hiResHandle.evaluate = async <R>(_fn: any, arg?: unknown): Promise<R> => {
      invocation++
      if (invocation === 1) {
        return [{ markerId: 'mk-1', originalTransform: 'translateX(10px)', originalOverflow: 'hidden' }] as unknown as R
      }
      restoreArguments.push(arg)
      return Promise.resolve(undefined as unknown as R)
    }
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 100, height: 100 }
    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.x' },
      config: baseConfig,
      slideNum: 10,
      slidesDir: outDir,
      globalIndex: 0,
      logger: makeLogger(),
    })
    // throw で復元を飛ばすと同一 hiResPage 上の後続要素が transform 解除のまま破損する
    expect(restoreArguments).toHaveLength(1)
    expect(result.count).toBe(0)
    expect(result.results.some(r => r.error?.includes('shot-fail'))).toBe(true)
  })
  it('撮影中だけ .marker-overlay を隠し、撮影後に元の visibility へ戻す (#1159)', async () => {
    document.body.innerHTML = '<div class="diagram-bare">図</div><div class="marker-overlay" style="visibility: visible">1</div>'
    const overlay = document.querySelector<HTMLElement>('.marker-overlay')!
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 5, y: 5, width: 80, height: 60 }] })
    applyDomReplacementOn(elementHandle, document.querySelector('.diagram-bare')!)
    const hiResHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 100, height: 80 }] })
    const visibilityAtShot: string[] = []
    hiResHandle.screenshot = async () => {
      visibilityAtShot.push(overlay.style.visibility)
      return Buffer.from('hires-shot')
    }
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 960, height: 540 }

    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.diagram-bare' },
      config: baseConfig,
      slideNum: 1,
      slidesDir: outDir,
      globalIndex: 0,
      logger: makeLogger(),
    })
    expect(result.count).toBe(1)
    expect(visibilityAtShot).toEqual(['hidden'])
    expect(overlay.style.visibility).toBe('visible')
    expect(overlay.dataset['prerenderOverlayVisibility']).toBeUndefined()
  })

  it('撮影が throw しても隠した .marker-overlay を戻す (#1159)', async () => {
    document.body.innerHTML = '<div class="diagram-bare">図</div><div class="marker-overlay">1</div>'
    const overlay = document.querySelector<HTMLElement>('.marker-overlay')!
    const elementHandle = new FakeElementHandle({ boundingBoxes: [{ x: 5, y: 5, width: 80, height: 60 }] })
    const hiResHandle = new FakeElementHandle({ boundingBoxes: [{ x: 0, y: 0, width: 100, height: 80 }] })
    hiResHandle.screenshot = async () => {
      throw new Error('shot-fail')
    }
    const hiResPage = new FakePage()
    hiResPage.viewportSizeValue = { width: 960, height: 540 }

    const result = await captureAndReplaceElements({
      hiResPage: hiResPage.asPage(),
      elements: [elementHandle.asElementHandle()],
      hiResElements: [hiResHandle.asElementHandle()],
      target: { selector: '.diagram-bare' },
      config: baseConfig,
      slideNum: 1,
      slidesDir: outDir,
      globalIndex: 0,
      logger: makeLogger(),
    })
    expect(result.count).toBe(0)
    expect(overlay.style.visibility).toBe('')
    expect(overlay.dataset['prerenderOverlayVisibility']).toBeUndefined()
  })
})
