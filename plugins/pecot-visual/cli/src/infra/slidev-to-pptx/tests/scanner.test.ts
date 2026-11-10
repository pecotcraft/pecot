// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { buildOnlySteps, scanSlideSteps } from '../scanner.js'
import { FakePage } from './support/fake-playwright.js'
import { makeLogger } from './support/logger.js'

const HISTORY = { hash: false } as const
const HASH = { hash: true } as const

/**
build 済み Slidev アプリ相当の DOM を作る。FakePage の string evaluate は jsdom の
document をそのまま使うため、readSlidevHasNextFn が実際にこの構造を辿る。
*/
function installSlidevContext(hasNext: boolean): void {
  document.body.innerHTML = '<div id="app"></div>'
  const app = document.querySelector('#app')
  if (!app) throw new Error('#app の生成に失敗')
  Object.assign(app, { __vue_app__: { _context: { provides: { '$$slidev-context': { nav: { hasNext } } } } } })
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('scanSlideSteps', () => {
  it('nav.hasNext が false なら ArrowRight を押さずに走査を終える', async () => {
    installSlidevContext(false)
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2']
    const logger = makeLogger()
    const steps = await scanSlideSteps(page.asPage(), 10, logger)
    expect(page.keyboardPresses).toStrictEqual([])
    expect(steps).toHaveLength(1)
    // 正常終端も verbose に残す（走査の早期終了を後から追える一次情報）
    expect(logger.verbose).toHaveBeenCalledWith('  ended at 1 steps: hasNext=false')
  })

  it('page.evaluate を持たない page でも従来どおり URL 変化で走査する', async () => {
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2', 'http://localhost/3']
    // evaluate が無いと、呼び出し時点で TypeError になる。
    // scanner の try/catch が拾って従来の方式へ切り替えることを、メソッドを隠した Page で確かめる。
    const withoutEvaluate = new Proxy(page.asPage(), {
      get: (target, property, receiver) =>
        property === 'evaluate' ? undefined : Reflect.get(target, property, receiver),
    })
    const logger = makeLogger()
    const steps = await scanSlideSteps(withoutEvaluate, 10, logger)
    expect(steps.map(step => step.slideNumber)).toStrictEqual([1, 2, 3])
    expect(logger.verbose).toHaveBeenCalledWith('  ended at 3 steps: cannot read hasNext and the URL did not change before timeout')
  })

  it('Slidev context が無いページは従来どおり URL 変化で走査する', async () => {
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2']
    const logger = makeLogger()
    const steps = await scanSlideSteps(page.asPage(), 10, logger)
    expect(steps.map(step => step.slideNumber)).toStrictEqual([1, 2])
    expect(logger.verbose).toHaveBeenCalledWith('  ended at 2 steps: cannot read hasNext and the URL did not change before timeout')
  })

  it('ArrowRight で URL が変化するたびにステップを追加する', async () => {
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2', 'http://localhost/2?clicks=1', 'http://localhost/3']
    const logger = makeLogger()
    const steps = await scanSlideSteps(page.asPage(), 10, logger)
    expect(steps).toHaveLength(4)
    expect(steps[0]?.slideNumber).toBe(1)
    expect(steps[1]?.slideNumber).toBe(2)
    expect(steps[2]?.clickStep).toBe(1)
    expect(steps[3]?.slideNumber).toBe(3)
    expect(logger.info).toHaveBeenCalledWith('scanned 4 steps')
  })

  it('onProgress は 1 ステップ検出するごとに呼ばれる (#1097)', async () => {
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2', 'http://localhost/3']
    const labels: string[] = []
    const steps = await scanSlideSteps(page.asPage(), 10, makeLogger(), (label) => { labels.push(label) })
    expect(steps).toHaveLength(3)
    expect(labels).toStrictEqual([
      'scan: step 1 detected',
      'scan: step 2 detected',
      'scan: step 3 detected',
    ])
  })

  it('URL 変化が無ければ走査を終了する', async () => {
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2'] // 1 step だけ
    page.waitForUrlResolves = false // 2 step 目以降は変化なし
    const logger = makeLogger()
    const steps = await scanSlideSteps(page.asPage(), 10, logger)
    // 最初の URL は parseSlideUrl で push、ArrowRight で 1 件 → URL 変化なしで終了
    expect(steps.length).toBeGreaterThanOrEqual(1)
    expect(steps.length).toBeLessThanOrEqual(2)
  })

  it('maxSteps に達したら停止する', async () => {
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2', 'http://localhost/3', 'http://localhost/4', 'http://localhost/5']
    const logger = makeLogger()
    const steps = await scanSlideSteps(page.asPage(), 2, logger)
    expect(steps).toHaveLength(2)
  })

  it('hash ルータの URL でもステップが潰れずに解析される', async () => {
    // 失敗すると、全ステップが slide 1 / click null になり、stepIndex が衝突する (#971)。
    const page = new FakePage({ url: 'http://localhost:3002/#/1' })
    page.urlQueue = [
      'http://localhost:3002/#/2',
      'http://localhost:3002/#/2?clicks=1',
      'http://localhost:3002/#/3',
    ]
    const steps = await scanSlideSteps(page.asPage(), 10, makeLogger())
    expect(steps.map(step => [step.slideNumber, step.clickStep])).toStrictEqual([
      [1, null],
      [2, null],
      [2, 1],
      [3, null],
    ])
  })
})

describe('buildOnlySteps', () => {
  it('click 指定 (>0) のときは clicks クエリ付き URL を 1 step 返す', async () => {
    const steps = await buildOnlySteps({ slide: 5, click: 3 }, 'http://localhost:3002', HISTORY)
    expect(steps).toStrictEqual([{
      slideNumber: 5,
      clickStep: 3,
      url: 'http://localhost:3002/5?clicks=3',
    }])
  })

  it('hash ルータの click 指定はフラグメント内 query で組み立てる', async () => {
    const steps = await buildOnlySteps({ slide: 5, click: 3 }, 'http://localhost:3002', HASH)
    expect(steps[0]?.url).toBe('http://localhost:3002/#/5?clicks=3')
  })

  it('click=0 はクエリ無しで 1 step', async () => {
    const steps = await buildOnlySteps({ slide: 7, click: 0 }, 'http://localhost:3002', HISTORY)
    expect(steps[0]?.url).toBe('http://localhost:3002/7')
  })

  it('click=null かつ page なし時は単一 step を返す', async () => {
    const steps = await buildOnlySteps({ slide: 4, click: null }, 'http://localhost:3002', HISTORY)
    expect(steps).toStrictEqual([{
      slideNumber: 4,
      clickStep: null,
      url: 'http://localhost:3002/4',
    }])
  })

  it('hash ルータの click=null + page なしはフラグメント付き URL を返す', async () => {
    const steps = await buildOnlySteps({ slide: 4, click: null }, 'http://localhost:3002', HASH)
    expect(steps[0]?.url).toBe('http://localhost:3002/#/4')
  })

  it('click=null + page あり: スライド存在 → click step を ArrowRight で収集', async () => {
    const page = new FakePage({ url: 'http://localhost:3002/5' })
    page.urlQueue = [
      'http://localhost:3002/5?clicks=1',
      'http://localhost:3002/5?clicks=2',
      'http://localhost:3002/6', // slide 番号が変わる→ループ終了
    ]
    // querySelector('.slidev-page-5') が non-null を返すよう DOM を整える
    document.body.innerHTML = '<div class="slidev-page-5">slide 5</div>'

    const logger = makeLogger()
    const steps = await buildOnlySteps({ slide: 5, click: null }, 'http://localhost:3002', HISTORY, page.asPage(), logger)
    expect(steps.length).toBeGreaterThanOrEqual(1)
    expect(steps.every(s => s.slideNumber === 5)).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('of slide 5'))
  })

  it('hash ルータの click=null + page あり: フラグメント URL で click step を収集', async () => {
    const page = new FakePage({ url: 'http://localhost:3002/#/4' })
    page.urlQueue = [
      'http://localhost:3002/#/4?clicks=1',
      'http://localhost:3002/#/5', // slide 番号が変わる→ループ終了
    ]
    document.body.innerHTML = '<div class="slidev-page-4">slide 4</div>'

    const steps = await buildOnlySteps({ slide: 4, click: null }, 'http://localhost:3002', HASH, page.asPage())
    expect(page.gotoCalls[0]?.url).toBe('http://localhost:3002/#/4')
    expect(steps.map(step => [step.slideNumber, step.clickStep])).toStrictEqual([[4, null], [4, 1]])
  })

  it('スライドが DOM に存在しなければ Error を throw', async () => {
    const page = new FakePage({ url: 'http://localhost:3002/99' })
    document.body.replaceChildren()
    await expect(buildOnlySteps({ slide: 99, click: null }, 'http://localhost:3002', HISTORY, page.asPage()))
      .rejects.toThrow('Slide 99 not found')
  })

  it('logger 省略時も動作する (logger=null)', async () => {
    const page = new FakePage({ url: 'http://localhost:3002/3' })
    page.urlQueue = ['http://localhost:3002/4'] // 1 ArrowRight で別スライドに
    document.body.innerHTML = '<div class="slidev-page-3">slide 3</div>'
    const steps = await buildOnlySteps({ slide: 3, click: null }, 'http://localhost:3002', HISTORY, page.asPage())
    expect(steps[0]?.slideNumber).toBe(3)
  })
})
