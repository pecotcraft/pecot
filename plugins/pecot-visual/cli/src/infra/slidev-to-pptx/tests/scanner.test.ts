// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { buildOnlySteps, scanSlideSteps } from '../scanner.js'
import { FakePage } from './support/fake-playwright.js'
import { makeLogger } from './support/logger.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
  it('nav.hasNext が false の場合は、ArrowRight を押さずに走査を終了する', async () => {
    await explains('スライドのステップを走査する `scanSlideSteps` のテストです。Slidev の `nav.hasNext` が `false` の場合に、`ArrowRight` を押さずに 1 ステップで終了し、終了の理由（`hasNext=false`）がログに出力されることを確認します。')
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

  it('page.evaluate が使えないページでも、URL の変化を見て走査する', async () => {
    await explains('`page.evaluate` を使えないページの場合のテストです。`hasNext` を読み取れないため、URL の変化を基準にして 3 ステップを走査し、その終了理由がログに出力されることを確認します。')
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

  it('Slidev の context が存在しないページでは、URL の変化を見て走査する', async () => {
    await explains('Slidev の context が存在しないページの場合のテストです。`hasNext` を読み取れないため、URL の変化を基準にして 2 ステップを走査し、その終了理由がログに出力されることを確認します。')
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2']
    const logger = makeLogger()
    const steps = await scanSlideSteps(page.asPage(), 10, logger)
    expect(steps.map(step => step.slideNumber)).toStrictEqual([1, 2])
    expect(logger.verbose).toHaveBeenCalledWith('  ended at 2 steps: cannot read hasNext and the URL did not change before timeout')
  })

  it('ArrowRight で URL が変化するたびに、ステップを追加する', async () => {
    await explains('`ArrowRight` を押すたびに URL が変化する場合のテストです。スライドの切り替えとクリックによる切り替えが、それぞれ別のステップとして 4 件記録され、`scanned 4 steps` がログに出力されることを確認します。')
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

  it('onProgress は、ステップを 1 つ検出するごとに呼ばれる', async () => {
    await explains('進捗を報告する `onProgress` のテストです。3 つのステップを検出した場合に、`scan: step 1 detected` から `scan: step 3 detected` までのラベルが順に報告されることを確認します。')
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

  it('URL が変化しなくなった場合は、走査を終了する', async () => {
    await explains('`ArrowRight` を押しても URL が変化しなくなった場合のテストです。走査が終了し、検出したステップが 1 件か 2 件になることを確認します。')
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2'] // 1 step だけ
    page.waitForUrlResolves = false // 2 step 目以降は変化なし
    const logger = makeLogger()
    const steps = await scanSlideSteps(page.asPage(), 10, logger)
    // 最初の URL は parseSlideUrl で push、ArrowRight で 1 件 → URL 変化なしで終了
    expect(steps.length).toBeGreaterThanOrEqual(1)
    expect(steps.length).toBeLessThanOrEqual(2)
  })

  it('ステップ数が maxSteps に達した場合は、走査を停止する', async () => {
    await explains('最大ステップ数（`maxSteps`）を 2 にした場合のテストです。URL がさらに変化しても、検出するステップが 2 件で止まることを確認します。')
    const page = new FakePage({ url: 'http://localhost/1' })
    page.urlQueue = ['http://localhost/2', 'http://localhost/3', 'http://localhost/4', 'http://localhost/5']
    const logger = makeLogger()
    const steps = await scanSlideSteps(page.asPage(), 2, logger)
    expect(steps).toHaveLength(2)
  })

  it('hash ルータの URL でも、スライド番号とクリック数を区別して解析する', async () => {
    await explains('hash ルータの URL（`#/2?clicks=1` など）を走査する場合のテストです。スライド番号とクリック数が区別され、すべてのステップが別々に記録されることを確認します。')
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
  it('click に 1 以上を指定した場合は、clicks クエリ付きの URL で 1 ステップを返す', async () => {
    await explains('特定のスライドだけを変換するためのステップを作成する `buildOnlySteps` のテストです。スライド 5 のクリック 3 を指定すると、`clicks=3` のクエリ付きの URL を持つステップが 1 つ返ることを確認します。')
    const steps = await buildOnlySteps({ slide: 5, click: 3 }, 'http://localhost:3002', HISTORY)
    expect(steps).toStrictEqual([{
      slideNumber: 5,
      clickStep: 3,
      url: 'http://localhost:3002/5?clicks=3',
    }])
  })

  it('hash ルータで click を指定した場合は、フラグメントの中にクエリを付けた URL を作成する', async () => {
    await explains('hash ルータで、スライド 5 のクリック 3 を指定した場合のテストです。URL が `#/5?clicks=3` の形（フラグメントの中のクエリ）になることを確認します。')
    const steps = await buildOnlySteps({ slide: 5, click: 3 }, 'http://localhost:3002', HASH)
    expect(steps[0]?.url).toBe('http://localhost:3002/#/5?clicks=3')
  })

  it('click が 0 の場合は、クエリを付けずに 1 ステップを返す', async () => {
    await explains('クリック数に 0 を指定した場合のテストです。`clicks` のクエリが付かない URL（`/7`）で 1 ステップが返ることを確認します。')
    const steps = await buildOnlySteps({ slide: 7, click: 0 }, 'http://localhost:3002', HISTORY)
    expect(steps[0]?.url).toBe('http://localhost:3002/7')
  })

  it('click が null でページを渡さない場合は、1 ステップだけを返す', async () => {
    await explains('クリック数が `null` で、走査用のページを渡さない場合のテストです。スライド 4 の 1 ステップ（クリック数 `null`）だけが返ることを確認します。')
    const steps = await buildOnlySteps({ slide: 4, click: null }, 'http://localhost:3002', HISTORY)
    expect(steps).toStrictEqual([{
      slideNumber: 4,
      clickStep: null,
      url: 'http://localhost:3002/4',
    }])
  })

  it('hash ルータで click が null でページを渡さない場合は、フラグメント付きの URL を返す', async () => {
    await explains('hash ルータで、クリック数が `null` かつ走査用のページを渡さない場合のテストです。URL が `#/4` の形（フラグメント付き）になることを確認します。')
    const steps = await buildOnlySteps({ slide: 4, click: null }, 'http://localhost:3002', HASH)
    expect(steps[0]?.url).toBe('http://localhost:3002/#/4')
  })

  it('click が null でページを渡した場合は、ArrowRight でクリックのステップを収集する', async () => {
    await explains('クリック数が `null` で、走査用のページを渡した場合のテストです。スライド 5 が存在する場合に、`ArrowRight` でクリックごとのステップが収集され、すべてスライド 5 のステップになり、ログにも出力されることを確認します。')
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

  it('hash ルータで click が null でページを渡した場合は、フラグメントの URL でクリックのステップを収集する', async () => {
    await explains('hash ルータで、クリック数が `null` かつ走査用のページを渡した場合のテストです。ページが `#/4` の URL で開かれ、スライド 4 のクリックなしとクリック 1 の 2 ステップが収集されることを確認します。')
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

  it('スライドが DOM に存在しない場合は、例外が発生する', async () => {
    await explains('指定したスライドが DOM に存在しない場合のテストです。`Slide 99 not found` を含むメッセージの例外が発生することを確認します。')
    const page = new FakePage({ url: 'http://localhost:3002/99' })
    document.body.replaceChildren()
    await expect(buildOnlySteps({ slide: 99, click: null }, 'http://localhost:3002', HISTORY, page.asPage()))
      .rejects.toThrow('Slide 99 not found')
  })

  it('logger を省略した場合も、ステップを返す', async () => {
    await explains('`logger` を省略した場合のテストです。ログを出力せずに、スライド 3 のステップが返ることを確認します。')
    const page = new FakePage({ url: 'http://localhost:3002/3' })
    page.urlQueue = ['http://localhost:3002/4'] // 1 ArrowRight で別スライドに
    document.body.innerHTML = '<div class="slidev-page-3">slide 3</div>'
    const steps = await buildOnlySteps({ slide: 3, click: null }, 'http://localhost:3002', HISTORY, page.asPage())
    expect(steps[0]?.slideNumber).toBe(3)
  })
})
