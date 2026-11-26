// @vitest-environment jsdom
/* eslint-disable unicorn/name-replacements -- jsdom + FakeBrowser/FakePage で convert 全体フローを検証 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultExportToPptxOptions, timeouts } from '../../../domain/slidev-to-pptx/config.js'
import { convertSingleSlideWithRetry } from '../slide-worker.js'
import { FakeBrowser, FakePage } from './support/fake-playwright.js'
import { makeLogger } from './support/logger.js'
import { compareStrings } from '../../../domain/_shared/compare-strings.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('convertSingleSlideWithRetry', () => {
  let outDir: string

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'pecotv-slide-worker-'))
  })

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    vi.stubGlobal('domToPptx', {
      exportToPptx: async () => new Blob([new Uint8Array([1, 2, 3])]),
    })
    // jsdom には document.getAnimations が未実装なので stub する
    document.getAnimations = (): Animation[] => []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('history ルータの URL を、そのまま開く', async () => {
    await explains('1 つのステップを変換する `convertSingleSlideWithRetry` のテストです。`clicks` のクエリ付きの URL（history ルータ）がそのまま開かれ、結果に工程ごとの所要時間のキーが返ることを確認します。')
    const page = new FakePage()
    const browser = new FakeBrowser({ pages: [page] })
    const result = await convertSingleSlideWithRetry(
      browser.asBrowser(),
      { slideNumber: 5, clickStep: 3, url: 'http://localhost:3002/5?clicks=3' },
      { slidePrefix: 'slide-', libPath: '/lib.js', exportOptions: defaultExportToPptxOptions },
      outDir,
      makeLogger(),
    )
    expect(result.step.slideNumber).toBe(5)
    expect(page.gotoCalls[0]?.url).toBe('http://localhost:3002/5?clicks=3')
    // 工程別の所要を同じキーで返す (#1141)
    expect(Object.keys(result.phases ?? {}).toSorted(compareStrings)).toStrictEqual(
      ['convert', 'cssSettle', 'goto', 'iframeLoad', 'inject', 'newPage', 'prerender', 'restore', 'visible'],
    )
  })

  it('hash ルータのフラグメント付きの URL も、そのまま開く', async () => {
    await explains('hash ルータの URL（`#/4?clicks=1`）を渡した場合に、その URL がそのままページで開かれることを確認します。')
    const page = new FakePage()
    const browser = new FakeBrowser({ pages: [page] })
    await convertSingleSlideWithRetry(
      browser.asBrowser(),
      { slideNumber: 4, clickStep: 1, url: 'http://localhost:3002/#/4?clicks=1' },
      { slidePrefix: 'slide-', libPath: '/lib.js', exportOptions: defaultExportToPptxOptions },
      outDir,
      makeLogger(),
    )
    expect(page.gotoCalls[0]?.url).toBe('http://localhost:3002/#/4?clicks=1')
  })

  it('clickStep が null の場合も 3 の場合も、ステップの情報をそのまま結果に含める', async () => {
    await explains('クリック数が `null` のステップと、`3` のステップを変換した場合のテストです。どちらの結果にも、渡したクリック数がそのまま含まれることを確認します。')
    const page1 = new FakePage()
    const browser1 = new FakeBrowser({ pages: [page1] })
    const r1 = await convertSingleSlideWithRetry(
      browser1.asBrowser(),
      { slideNumber: 5, clickStep: null, url: 'http://localhost:3002/5' },
      { slidePrefix: 'slide-', libPath: '/lib.js', exportOptions: defaultExportToPptxOptions },
      outDir,
      makeLogger(),
    )
    expect(r1.step.clickStep).toBeNull()
    // clickStep null → stepIndex = 5*100 = 500
    expect(r1.elapsed).toBeGreaterThanOrEqual(0)

    const page2 = new FakePage()
    const browser2 = new FakeBrowser({ pages: [page2] })
    const r2 = await convertSingleSlideWithRetry(
      browser2.asBrowser(),
      { slideNumber: 5, clickStep: 3, url: 'http://localhost:3002/5?clicks=3' },
      { slidePrefix: 'slide-', libPath: '/lib.js', exportOptions: defaultExportToPptxOptions },
      outDir,
      makeLogger(),
    )
    expect(r2.step.clickStep).toBe(3)
  })

  it('1 回目の変換に失敗しても、リトライして 2 回目で成功する', async () => {
    await explains('1 回目の変換が失敗する場合のテストです。待機時間を短縮してリトライし、2 回目で成功して結果を返し、`conversion failed (attempt 1/2)` を含む警告がログに出力されることを確認します。')
    // setTimeout を即時 resolve に差し替え (timeouts.slideRetryDelay = 2000ms を待たないため)
    const realSetTimeout = setTimeout
    vi.stubGlobal('setTimeout', (cb: () => void, ms?: number): ReturnType<typeof setTimeout> => {
      // リトライ待ちだけを即時にする（dom-to-pptx 注入の上限タイマー等は実時間のまま）
      if (ms !== timeouts.slideRetryDelay) return realSetTimeout(cb, ms)

      void Promise.try(cb)
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    try {
      const page1 = new FakePage()
      page1.waitForFunctionThrows = true // 1 回目は失敗
      const page2 = new FakePage()
      const browser = new FakeBrowser({ pages: [page1, page2] })
      const logger = makeLogger()
      const result = await convertSingleSlideWithRetry(
        browser.asBrowser(),
        { slideNumber: 1, clickStep: null, url: 'http://localhost:3002/1' },
        { slidePrefix: 'slide-', libPath: '/lib.js', exportOptions: defaultExportToPptxOptions },
        outDir,
        logger,
      )
      expect(result.step.slideNumber).toBe(1)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('conversion failed (attempt 1/2)'))
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('すべてのリトライに失敗した場合は、最後のエラーで失敗する', async () => {
    await explains('1 回目と 2 回目のどちらも変換が失敗する場合のテストです。最後のエラー（`waitForFunction timed out`）の例外が発生することを確認します。')
    const realSetTimeout = setTimeout
    vi.stubGlobal('setTimeout', (cb: () => void, ms?: number): ReturnType<typeof setTimeout> => {
      // リトライ待ちだけを即時にする（dom-to-pptx 注入の上限タイマー等は実時間のまま）
      if (ms !== timeouts.slideRetryDelay) return realSetTimeout(cb, ms)

      void Promise.try(cb)
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    try {
      const page1 = new FakePage()
      page1.waitForFunctionThrows = true
      const page2 = new FakePage()
      page2.waitForFunctionThrows = true
      const browser = new FakeBrowser({ pages: [page1, page2] })
      await expect(convertSingleSlideWithRetry(
        browser.asBrowser(),
        { slideNumber: 9, clickStep: 2, url: 'http://localhost:3002/9?clicks=2' },
        { slidePrefix: 'slide-', libPath: '/lib.js', exportOptions: defaultExportToPptxOptions },
        outDir,
        makeLogger(),
      )).rejects.toThrow('waitForFunction timed out')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
