// @vitest-environment jsdom
/* eslint-disable unicorn/name-replacements -- DI で fake を注入するテスト */
import type { Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseCacheManifest, type CacheManifest } from '../../../domain/slidev-to-pptx/cache-manifest.js'
import type { PipelineConfig } from '../../../domain/slidev-to-pptx/config.js'
import { PipelineRuntimeError } from '../../../domain/slidev-to-pptx/errors.js'
import { stepIndexOf } from '../../../domain/slidev-to-pptx/step-index.js'
import type { PipelineResult, SlideStep } from '../../../domain/slidev-to-pptx/types.js'
import { convertToPptx, type PipelineDependencies } from '../pipeline.js'
import type { SinglePassRequest, SinglePassRunner } from '../single-pass-worker.js'
import type { SlideConvertResult } from '../slide-worker.js'
import { FakeBrowser, FakePage } from './support/fake-playwright.js'
import { makeLogger, type MockLogger } from './support/logger.js'
import { compareStrings } from '../../../domain/_shared/compare-strings.js'
import { rejectionOf } from '../../../../tests/_helpers/rejection.js'
import { explains } from '../../../../tests/_helpers/explains.js'

function fakeServer(): Server {
  return { close: () => { /* noop */ }, address: () => null } as unknown as Server
}

function makeWorkerResult(slideNumber: number, clickStep: number | null = null): SlideConvertResult {
  return {
    step: { slideNumber, clickStep, url: `/${slideNumber.toString()}` },
    letterSpacingMap: { [`s${slideNumber.toString()}`]: { letterSpacing: '1.0px', fontSize: '14px' } },
    hrefMap: { [`s${slideNumber.toString()}-link`]: 'https://example.com' },
    hasExplicitAnimation: false,
    prerenderResults: [],
    elapsed: 1,
  }
}

const baseConfig = (presDir: string): PipelineConfig => ({
  presDir,
  templatePath: path.join(presDir, 'dist'),
  outputDir: path.join(presDir, 'pptx'),
  slidePrefix: 'slide-',
  port: 4001,
  onlySlide: null,
  concurrency: 2,
  logLevel: 'normal',
})

async function setupPresDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pecotv-pipeline-'))
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await writeFile(path.join(dir, 'slides.md'), '---\ntitle: Pipe Test\n---\n', 'utf8')
  return dir
}

describe('convertToPptx', () => {
  let presDir: string

  beforeAll(async () => {
    presDir = await setupPresDir()
  })

  afterAll(async () => {
    await rm(presDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    document.getAnimations = (): Animation[] => []
  })

  it('presDir が相対パスの場合は、絶対パスが必要であるエラーで失敗する', async () => {
    await explains('変換パイプライン `convertToPptx` の、入力の検証のテストです。`presDir` に相対パスを渡した場合に、`presDir must be an absolute path` を含むメッセージの例外が発生することを確認します。')
    const config = { ...baseConfig(presDir), presDir: 'relative' }
    await expect(convertToPptx(config)).rejects.toThrow('presDir must be an absolute path')
  })

  it('onlySteps を指定した場合は、指定したステップをサーバーの実際のポートの URL で変換して成功する', async () => {
    await explains('変換するステップを `onlySteps` で指定した場合のテストです。指定した 2 つのステップが、実際のポートの URL で変換され、成功の結果と `letter-spacing.json` などが出力されることを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [1, 2] }
    const browser = new FakeBrowser({ pages: [new FakePage(), new FakePage()] })
    // config.port (4001) ではなく address() の実ポートで baseUrl が組まれることを見る
    const boundServer = {
      close: () => { /* noop */ },
      address: () => ({ port: 45_678, address: '127.0.0.1', family: 'IPv4' }),
    } as unknown as Server
    const stepUrls: string[] = []
    const deps: PipelineDependencies = {
      logger: makeLogger(),
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => boundServer,
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => {
        stepUrls.push(step.url)
        return makeWorkerResult(step.slideNumber, step.clickStep)
      },
    }
    const result = await convertToPptx(config, deps)
    // step.url は常に絶対 URL。worker は baseUrl を受け取らないため、実 bind ポートが
    // 反映されていることは step.url 側で確かめる
    expect(stepUrls).toEqual(['http://127.0.0.1:45678/1', 'http://127.0.0.1:45678/2'])
    expect(result.success).toBe(true)
    expect(result.slideCount).toBe(2)
    expect(result.slidesDirectory).toContain('pptx/slides')
    expect(browser.closed).toBe(true)
    // letter-spacing.json と href-map.json が生成される
    const ls = await readFile(path.join(presDir, 'pptx/slides/letter-spacing.json'), 'utf8')
    expect(JSON.parse(ls)).toMatchObject({ s1: { letterSpacing: '1.0px', fontSize: '14px' } })
    const href = await readFile(path.join(presDir, 'pptx/slides/href-map.json'), 'utf8')
    expect(JSON.parse(href)).toMatchObject({ 's1-link': 'https://example.com' })
  })

  it('onlySlide に click を指定した場合は、1 ステップだけを変換して成功する', async () => {
    await explains('変換対象を `onlySlide`（スライド番号とクリック数）で指定した場合のテストです。ステップが 1 つだけ変換され、`success` が `true`、`slideCount` が 1 になることを確認します。')
    const config: PipelineConfig = {
      ...baseConfig(presDir),
      onlySlide: { slide: 5, click: 3 },
    }
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => makeWorkerResult(step.slideNumber, step.clickStep),
    }
    const result = await convertToPptx(config, deps)
    expect(result.success).toBe(true)
    expect(result.slideCount).toBe(1)
  })

  it('onlySlide の click が null のとき、走査したページの step を変換して成功を返す', async () => {
    await explains('`onlySlide` のクリック数を `null` にした場合のテストです。ページを走査して得たステップが変換され、`success` が `true`、`slideCount` が 1 以上になることを確認します。')
    const config: PipelineConfig = {
      ...baseConfig(presDir),
      onlySlide: { slide: 3, click: null },
    }
    // 1 枚目は routerMode 判定用、2 枚目が buildOnlySteps の走査ページ
    const routerPage = new FakePage()
    const scanPage = new FakePage({ url: 'http://127.0.0.1:4001/3' })
    scanPage.urlQueue = ['http://127.0.0.1:4001/4'] // slide 番号変化で打ち切り
    document.body.innerHTML = '<div class="slidev-page-3"></div>'
    const browser = new FakeBrowser({ pages: [routerPage, scanPage] })
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => makeWorkerResult(step.slideNumber, step.clickStep),
    }
    const result = await convertToPptx(config, deps)
    expect(result.success).toBe(true)
    expect(result.slideCount).toBeGreaterThanOrEqual(1)
  })

  it('全スライドを走査する場合は、見つけたすべてのステップを変換する', async () => {
    await explains('`onlySlide` と `onlySteps` のどちらも指定しない場合のテストです。走査で 2 つのステップが見つかり、すべてが変換されて `slideCount` が 2、`success` が `true` になることを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir) }
    const scanPage = new FakePage({ url: 'http://127.0.0.1:4001/1' })
    scanPage.urlQueue = ['http://127.0.0.1:4001/2'] // 2 step に
    const browser = new FakeBrowser({ pages: [scanPage, new FakePage(), new FakePage()] })
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => makeWorkerResult(step.slideNumber, step.clickStep),
    }
    const result = await convertToPptx(config, deps)
    expect(result.success).toBe(true)
    expect(result.slideCount).toBe(2)
  })

  it('root への goto が `#/` へリダイレクトされたら router=hash と判定する', async () => {
    await explains('ルータの方式の判定のテストです。ルートが `#/1` へリダイレクトされる場合は、`router=hash` をログに出力し、3 つのステップを別々に変換することを確認します。')
    // hash ルータのデッキは、root goto が `#/1` に落ち着く。
    // 判定を誤ると、以降の URL 解析が全ステップを slide 1 にまとめる。
    // すると stepIndex が衝突して、1 枚に上書きされる (#971)。
    const config: PipelineConfig = { ...baseConfig(presDir) }
    const routerPage = new FakePage({ gotoRedirect: url => `${url}/#/1` })
    routerPage.urlQueue = ['http://127.0.0.1:4001/#/2', 'http://127.0.0.1:4001/#/2?clicks=1']
    const browser = new FakeBrowser({ pages: [routerPage] })
    const logger = makeLogger()
    const steps: SlideStep[] = []
    const deps: PipelineDependencies = {
      logger,
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => {
        steps.push(step)
        return makeWorkerResult(step.slideNumber, step.clickStep)
      },
    }
    const result = await convertToPptx(config, deps)

    expect(logger.info).toHaveBeenCalledWith('router detection: router=hash')
    expect(result.slideCount).toBe(3)
    expect(steps.map(step => [step.slideNumber, step.clickStep])).toStrictEqual([[1, null], [2, null], [2, 1]])
  })

  it('リダイレクトが起きない場合は、history ルータと判定し、URL をパス形式で作成する', async () => {
    await explains('リダイレクトが起きない場合の、ルータの方式の判定のテストです。`router=history` とサーバー起動のログを出力し、ステップの URL が `http://127.0.0.1:4001/3` の形になることを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [3] }
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const logger = makeLogger()
    const steps: SlideStep[] = []
    const deps: PipelineDependencies = {
      logger,
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => {
        steps.push(step)
        return makeWorkerResult(step.slideNumber, step.clickStep)
      },
    }
    await convertToPptx(config, deps)

    expect(logger.info).toHaveBeenCalledWith('router detection: router=history')
    // dist 配信サーバの起動ログは console.log でなく logger を通す (--json の stdout を汚さない)
    expect(logger.info).toHaveBeenCalledWith('HTTP server started: http://127.0.0.1:4001')
    expect(steps[0]?.url).toBe('http://127.0.0.1:4001/3')
  })

  it('hash ルータで onlySteps を指定した場合は、URL をフラグメント形式で作成する', async () => {
    await explains('hash ルータと判定された状態で、`onlySteps` を指定した場合のテストです。ステップの URL が `http://127.0.0.1:4001/#/3` の形になり、判定に使ったページが閉じられることを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [3] }
    const routerPage = new FakePage({ gotoRedirect: url => `${url}/#/1` })
    const browser = new FakeBrowser({ pages: [routerPage] })
    const steps: SlideStep[] = []
    const deps: PipelineDependencies = {
      logger: makeLogger(),
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => {
        steps.push(step)
        return makeWorkerResult(step.slideNumber, step.clickStep)
      },
    }
    await convertToPptx(config, deps)

    expect(steps[0]?.url).toBe('http://127.0.0.1:4001/#/3')
    // 判定専用ページは走査に使わないので閉じる
    expect(routerPage.closed).toBe(true)
  })

  it('worker が失敗した場合は、errors に level が slide のエラーを追加し、success を false にする', async () => {
    await explains('スライドを変換する worker が失敗した場合のテストです。`errors` にスライドのエラーが追加され、`success` が `false` になり、`slide conversion failed` を含む警告をログに出力することを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [1, 2] }
    const browser = new FakeBrowser({ pages: [new FakePage(), new FakePage()] })
    const logger = makeLogger()
    const deps: PipelineDependencies = {
      logger,
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => {
        if (step.slideNumber === 1) throw new Error('worker-failed')
        return makeWorkerResult(step.slideNumber, step.clickStep)
      },
    }
    const result = await convertToPptx(config, deps)
    expect(result.success).toBe(false)
    expect(result.errors.some(e => e.level === 'slide' && e.message.includes('worker-failed'))).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('slide conversion failed'))
  })

  it('onProgress は、スキャンの各ステップと、worker の成功・失敗のどちらの完了でも呼ばれる', async () => {
    await explains('進捗を報告する `onProgress` のテストです。スキャンで見つけた各ステップと、worker が成功した場合・失敗した場合のどちらも、それぞれ別のラベルで報告されることを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir) }
    const scanPage = new FakePage({ url: 'http://127.0.0.1:4001/1' })
    scanPage.urlQueue = ['http://127.0.0.1:4001/2'] // 2 step に
    const browser = new FakeBrowser({ pages: [scanPage, new FakePage(), new FakePage()] })
    const labels: string[] = []
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      onProgress: (label) => { labels.push(label) },
      slideWorkerRunner: async (_b, step) => {
        if (step.slideNumber === 1) throw new Error('worker-failed')
        return makeWorkerResult(step.slideNumber, step.clickStep)
      },
    }
    const result = await convertToPptx(config, deps)
    expect(result.success).toBe(false)
    expect(labels.filter(label => label.startsWith('scan: '))).toStrictEqual([
      'scan: step 1 detected',
      'scan: step 2 detected',
    ])
    // 失敗した slide 1 もリトライ尽きの時点で進捗として報告される。成功・失敗でラベルを分ける (F-06)。
    expect(labels.filter(label => label.startsWith('slide #')).toSorted(compareStrings)).toStrictEqual([
      'slide #1 conversion failed',
      'slide #2 converted',
    ])
  })

  it('onStepProgress は、スキャン後に 0 件完了を報告し、以降は成功・失敗のどちらでも 1 件ずつ完了を報告する', async () => {
    await explains('ステップ単位の進捗を報告する `onStepProgress` のテストです。スキャン後に完了数 0 と総数 2 を報告し、その後は worker の成功・失敗にかかわらず完了数を 1 ずつ増やして報告することを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir) }
    const scanPage = new FakePage({ url: 'http://127.0.0.1:4001/1' })
    scanPage.urlQueue = ['http://127.0.0.1:4001/2']
    const browser = new FakeBrowser({ pages: [scanPage, new FakePage(), new FakePage()] })
    const reports: [number, number][] = []
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      onStepProgress: (completed, total) => { reports.push([completed, total]) },
      slideWorkerRunner: async (_b, step) => {
        if (step.slideNumber === 1) throw new Error('worker-failed')
        return makeWorkerResult(step.slideNumber, step.clickStep)
      },
    }
    await convertToPptx(config, deps)
    expect(reports).toStrictEqual([[0, 2], [1, 2], [2, 2]])
  })

  it('プリレンダの結果に失敗がある場合は、level が element のエラーを errors に追加する', async () => {
    await explains('worker が返したプリレンダの結果に、失敗が含まれる場合のテストです。失敗した要素のエラーが `errors` に追加され、`success` は `true` のままであることを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [1] }
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => ({
        step,
        letterSpacingMap: {},
        hrefMap: {},
        hasExplicitAnimation: false,
        prerenderResults: [
          { selector: '.x', slideNumber: step.slideNumber, fileIndex: 0, success: false, error: 'pr-fail' },
          { selector: '.y', slideNumber: step.slideNumber, fileIndex: 1, success: true },
        ],
        elapsed: 1,
      }),
    }
    const result = await convertToPptx(config, deps)
    expect(result.errors.some(e => e.level === 'element' && e.message === 'pr-fail')).toBe(true)
    // level=element のエラーは success を落とさない (#949 の前提)。
    expect(result.success).toBe(true)
  })

  it('変換が終わった後の集計ログに、スライドの失敗と要素のエラーの内訳を出力する', async () => {
    await explains('スライドの失敗と要素のエラーが両方ある場合の、集計ログのテストです。失敗したスライドの件数、要素のエラーの件数と、それぞれの詳細が出力され、`no errors or warnings` は出力されないことを確認します。')
    // この書式は、throw した場合にも引き継がれる対象 (#945)。
    // 抽出の前後で同一であることを、確定した文字列で固定する。
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [1, 2] }
    const browser = new FakeBrowser({ pages: [new FakePage(), new FakePage()] })
    const logger = makeLogger()
    const deps: PipelineDependencies = {
      logger,
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => {
        if (step.slideNumber === 2) throw new Error('worker-failed')
        return {
          step,
          letterSpacingMap: {},
          hrefMap: {},
          hasExplicitAnimation: false,
          prerenderResults: [
            { selector: '.chart', slideNumber: step.slideNumber, fileIndex: 0, success: false, error: 'pr-fail' },
          ],
          elapsed: 1,
        }
      },
    }
    const result = await convertToPptx(config, deps)

    expect(result.success).toBe(false)
    expect(logger.info).toHaveBeenCalledWith('1 slides failed')
    expect(logger.warn).toHaveBeenCalledWith('  [slide] slide 2: worker-failed')
    expect(logger.info).toHaveBeenCalledWith('1 element errors')
    expect(logger.warn).toHaveBeenCalledWith('  [element] slide 1 .chart: pr-fail')
    expect(logger.info).not.toHaveBeenCalledWith('no errors or warnings')
  })

  it('resolveDomToPptx を指定しない場合は、インストール済みの dom-to-pptx を解決して変換に成功する', async () => {
    await explains('`resolveDomToPptx` を指定しない場合のテストです。インストール済みの本物の `dom-to-pptx` が使われ、変換が成功することを確認します。')
    // dom-to-pptx パッケージは cli 配下に install 済 (Step 2 で追加)
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [1] }
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      slideWorkerRunner: async (_b, step) => makeWorkerResult(step.slideNumber, step.clickStep),
    }
    const result = await convertToPptx(config, deps)
    expect(result.success).toBe(true)
  })

  it('logLevel が空文字の場合は、normal のロガーを使って変換に成功する', async () => {
    await explains('`logLevel` が空文字の場合のテストです。`normal` のロガーに切り替わって、変換が成功することを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [1], logLevel: '' }
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => makeWorkerResult(step.slideNumber, step.clickStep),
    }
    const result: PipelineResult = await convertToPptx(config, deps)
    expect(result.success).toBe(true)
  })

  it('templatePath と outputDir が絶対パスのとき、変換に成功する', async () => {
    await explains('`templatePath` と `outputDir` に絶対パスを指定した場合のテストです。変換が成功することを確認します。')
    const config: PipelineConfig = {
      ...baseConfig(presDir),
      templatePath: path.join(presDir, 'dist'),
      outputDir: path.join(presDir, 'pptx'),
      onlySteps: [1],
    }
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    const deps: PipelineDependencies = {
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => fakeServer(),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => makeWorkerResult(step.slideNumber, step.clickStep),
    }
    const r = await convertToPptx(config, deps)
    expect(r.success).toBe(true)
  })

  it('slides.md に title が存在しない場合も、slidesDirectory に outputDir 配下の slides を返す', async () => {
    await explains('`slides.md` に `title` が存在しないデッキを変換する場合のテストです。結果の `slidesDirectory` が、出力先ディレクトリの下の `slides` になることを確認します。')
    const otherDir = await mkdtemp(path.join(tmpdir(), 'pecotv-pipeline-no-title-'))
    await mkdir(path.join(otherDir, 'dist'), { recursive: true })
    try {
      const config: PipelineConfig = {
        ...baseConfig(otherDir),
        templatePath: path.join(otherDir, 'dist'),
        outputDir: path.join(otherDir, 'pptx'),
        onlySteps: [1],
      }
      const browser = new FakeBrowser({ pages: [new FakePage()] })
      const deps: PipelineDependencies = {
        createBrowser: async () => browser.asBrowser(),
        createServer: async () => fakeServer(),
        resolveDomToPptx: () => '/lib.js',
        slideWorkerRunner: async (_b, step) => makeWorkerResult(step.slideNumber, step.clickStep),
      }
      const r = await convertToPptx(config, deps)
      expect(r.slidesDirectory).toBe(path.join(otherDir, 'pptx', 'slides'))
    }
    finally {
      await rm(otherDir, { recursive: true, force: true })
    }
  })

  it('signal が中断済みの場合は、ブラウザとサーバーを起動せずに失敗する', async () => {
    await explains('中断済みの `signal` を渡して `convertToPptx` を呼んだ場合のテストです。`aborted` を含むメッセージの例外が発生し、ブラウザとサーバーのどちらも起動されないことを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [1] }
    const browser = new FakeBrowser({ pages: [new FakePage()] })
    let isServerClosed = false
    const controller = new AbortController()
    controller.abort()
    const deps: PipelineDependencies = {
      logger: makeLogger(),
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => ({ close: () => { isServerClosed = true }, address: () => null } as unknown as Server),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => makeWorkerResult(step.slideNumber, step.clickStep),
      signal: controller.signal,
    }
    await expect(convertToPptx(config, deps)).rejects.toThrow('aborted')
    // abort は server start 前に観測されるため close は呼ばれず、browser も起動されない
    expect(browser.closed).toBe(false)
    expect(isServerClosed).toBe(false)
  })

  it('signal が変換の開始後に中断された場合は、失敗し、ブラウザとサーバーを閉じる', async () => {
    await explains('変換の途中で `signal` が中断された場合のテストです。`aborted` を含むメッセージの例外が発生し、ブラウザとサーバーが閉じられることを確認します。')
    const config: PipelineConfig = { ...baseConfig(presDir), onlySteps: [1, 2, 3] }
    const browser = new FakeBrowser({ pages: [new FakePage(), new FakePage(), new FakePage()] })
    let isServerClosed = false
    const controller = new AbortController()
    const deps: PipelineDependencies = {
      logger: makeLogger(),
      createBrowser: async () => browser.asBrowser(),
      createServer: async () => ({ close: () => { isServerClosed = true }, address: () => null } as unknown as Server),
      resolveDomToPptx: () => '/lib.js',
      slideWorkerRunner: async (_b, step) => {
        // 最初の slide 処理時に abort を発火させる
        controller.abort()
        return makeWorkerResult(step.slideNumber, step.clickStep)
      },
      signal: controller.signal,
    }
    await expect(convertToPptx(config, deps)).rejects.toThrow('aborted')
    // server start / browser launch は完了済なので、cleanup を呼ぶ
    expect(browser.closed).toBe(true)
    expect(isServerClosed).toBe(true)
  })
})
// --- 差分キャッシュ (#896 US1) ---
// 共有 fixture の pptx/cache が run 間で残ると判定が汚れるため、ケースごとに mkdtemp した
// デッキを使う。fake worker は「非空の pptx と prerender PNG/meta」を書く。
// 保存と復元の処理を実際に通す。復元を怠ると、ppt/media が気づかれずに欠ける。

interface CacheDeck {
  readonly dir: string
  readonly bundlePath: string
}

interface CacheRunOptions {
  /**
  スキャンが返すステップ数 (既定 2)
  */
  readonly scanSteps?: number
  /**
  変換を失敗させるスライド番号
  */
  readonly failSlide?: number
  /**
  resolveDomToPptx の戻り値を差し替える (キー算出失敗の再現)
  */
  readonly bundlePath?: string
  /**
  fake worker が書く prerender ファイルの枚数 (既定 1)
  */
  readonly prerenderCount?: number
  /**
  キャッシュ設定を渡さない (旧来動作)
  */
  readonly noCache?: boolean
  /**
  cache.skipRead に渡す値 (`--no-cache` 相当。既定 false)
  */
  readonly skipRead?: boolean
  readonly onlySteps?: readonly number[]
  /**
  cache.theme に渡す値 (既定 null)
  */
  readonly theme?: string | null
  /**
  cache-store 関数の差し替え (F-05: 決定論的な throw 注入用の DI 口)
  */
  readonly cacheStore?: PipelineDependencies['cacheStore']
  /**
  変換途中で abort させる signal (#931: 警告蓄積後に throw する run の再現用)
  */
  readonly signal?: AbortSignal
  /**
  各 worker 呼び出しの先頭で実行する hook (#931: 変換中に abort を発火させる)
  */
  readonly onWorkerCall?: () => void
  /**
  指定スライドの worker 結果に失敗した prerenderResults を 1 件混ぜる
  (#945: level=element のエラーを積ませる注入口)。
  */
  readonly prerenderFailure?: Readonly<{
    slideNumber: number
    selector: string
    message: string
  }>
  /**
  logger の差し替え。convertToPptx が throw する run では runCached の戻り値から
  logger を受け取れないため、呼び出し側で作った mock を渡して出力を検証する。
  */
  readonly logger?: MockLogger
  /**
  指定すると、全ステップの letterSpacingMap がこの単一キーを共有する。
  値は slideNumber に依存する (`${slideNumber}.0px` / `${slideNumber * 10}px`)。
  F-07 の後勝ち集約順の検証用。
  既定のキー割当てはスライドごとにユニークで、衝突しない。
  */
  readonly sharedLetterSpacingKey?: string
  /**
  deps.onProgress の差し替え (F-03: キャッシュ復元/保存/prune・manifest の進捗報告の検証用)。
  */
  readonly onProgress?: (label: string) => void
  /**
  deps.onStepProgress の差し替え (#1160: キャッシュ hit を完了として数える検証用)。
  */
  readonly onStepProgress?: (completed: number, total: number) => void
  /**
  指定すると config.singlePass を有効にし、1 パス変換をこれに差し替える (#1141)
  */
  readonly singlePassRunner?: SinglePassRunner
}

interface CacheRun {
  readonly result: PipelineResult
  readonly calls: SlideStep[]
  readonly logger: MockLogger
}

const cacheDeckDirs: string[] = []

function deckMarkdown(bodies: readonly string[]): string {
  return ['---', 'theme: none', 'title: Cache Deck', '---', '', bodies.join('\n\n---\n\n'), ''].join('\n')
}

async function writeDeck(dir: string, bodies: readonly string[]): Promise<void> {
  await writeFile(path.join(dir, 'slides.md'), deckMarkdown(bodies), 'utf8')
}

async function setupCacheDeck(
  bodies: readonly string[] = ['# スライド1', '# スライド2'],
): Promise<CacheDeck> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pecotv-pipeline-cache-'))
  cacheDeckDirs.push(dir)
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await mkdir(path.join(dir, 'lib'), { recursive: true })
  const bundlePath = path.join(dir, 'lib', 'dom-to-pptx.bundle.js')
  await writeFile(bundlePath, 'globalThis.domToPptx = () => undefined\n', 'utf8')
  await writeDeck(dir, bodies)
  return { dir, bundlePath }
}

/**
logger.warn のうち emitErrorSummary の集約行だけを順序どおり取り出す (#945)。
検出時点の単発行や警告行を数に含めないため、集約が二重に出ていないことを
呼び出し回数の総数に依存せず検証できる。
*/
function aggregatedErrorLines(warnCalls: readonly (readonly unknown[])[]): string[] {
  return warnCalls
    .map(call => String(call[0]))
    .filter(line => /^ {2}\[(?:slide|element)\] /.test(line))
}

/**
prerenderFailure の注入対象スライドでのみ失敗 1 件を返す (#945)。
*/
function prerenderResultsFor(
  failure: CacheRunOptions['prerenderFailure'],
  slideNumber: number,
): SlideConvertResult['prerenderResults'] {
  if (failure?.slideNumber !== slideNumber) return []
  return [{
    selector: failure.selector,
    slideNumber,
    fileIndex: 0,
    success: false,
    error: failure.message,
  }]
}

async function runCached(deck: Readonly<CacheDeck>, options: CacheRunOptions = {}): Promise<CacheRun> {
  const calls: SlideStep[] = []
  const logger = options.logger ?? makeLogger()
  const scanSteps = options.scanSteps ?? 2
  const scanPage = new FakePage()
  scanPage.urlQueue = Array.from(
    { length: scanSteps - 1 },
    (_v, index) => `http://127.0.0.1:4001/${(index + 2).toString()}`,
  )
  const browser = new FakeBrowser({ pages: [scanPage] })
  const deps: PipelineDependencies = {
    logger,
    createBrowser: async () => browser.asBrowser(),
    createServer: async () => fakeServer(),
    resolveDomToPptx: () => options.bundlePath ?? deck.bundlePath,
    slideWorkerRunner: async (_b, step, workerConfig, slidesDir) => {
      calls.push(step)
      options.onWorkerCall?.()
      if (options.failSlide === step.slideNumber) throw new Error('worker-failed')
      const stepIndex = stepIndexOf(step)
      await writeFile(
        path.join(slidesDir, `${workerConfig.slidePrefix}${stepIndex.toString()}.pptx`),
        `pptx-${stepIndex.toString()}`,
      )
      for (let index = 0; index < (options.prerenderCount ?? 1); index++) {
        const stem = `prerender-slide${stepIndex.toString()}-${index.toString()}`
        await writeFile(path.join(slidesDir, `${stem}.png`), 'png-bytes')
        await writeFile(path.join(slidesDir, `${stem}.meta.json`), '{"kind":"fake"}')
      }
      const base: SlideConvertResult = {
        ...makeWorkerResult(step.slideNumber, step.clickStep),
        prerenderResults: prerenderResultsFor(options.prerenderFailure, step.slideNumber),
      }
      if (options.sharedLetterSpacingKey === undefined) return base
      return {
        ...base,
        letterSpacingMap: {
          [options.sharedLetterSpacingKey]: {
            letterSpacing: `${step.slideNumber.toString()}.0px`,
            fontSize: `${(step.slideNumber * 10).toString()}px`,
          },
        },
      }
    },
    ...(options.cacheStore !== undefined && { cacheStore: options.cacheStore }),
    ...(options.signal !== undefined && { signal: options.signal }),
    ...(options.onProgress !== undefined && { onProgress: options.onProgress }),
    ...(options.onStepProgress !== undefined && { onStepProgress: options.onStepProgress }),
    ...(options.singlePassRunner !== undefined && { singlePassRunner: options.singlePassRunner }),
  }
  const config: PipelineConfig = {
    ...baseConfig(deck.dir),
    ...(options.singlePassRunner !== undefined && { singlePass: true }),
    ...(options.onlySteps !== undefined && { onlySteps: options.onlySteps }),
    ...(options.noCache !== true && { cache: { pluginVersion: 'test-1.0.0', theme: options.theme ?? null, skipRead: options.skipRead === true } }),
  }
  const result = await convertToPptx(config, deps)
  return { result, calls, logger }
}

function cacheDirOf(deck: Readonly<CacheDeck>): string {
  return path.join(deck.dir, 'pptx', 'cache')
}

async function listCacheDir(deck: Readonly<CacheDeck>): Promise<string[]> {
  const names = await readdir(cacheDirOf(deck))
  return names.toSorted(compareStrings)
}

async function readManifest(deck: Readonly<CacheDeck>): Promise<CacheManifest | undefined> {
  const text = await readFile(path.join(cacheDirOf(deck), 'manifest.json'), 'utf8')
  return parseCacheManifest(text)
}

async function manifestEntryKeys(deck: Readonly<CacheDeck>): Promise<string[]> {
  const manifest = await readManifest(deck)
  return Object.keys(manifest?.entries ?? {}).toSorted(compareStrings)
}

async function letterSpacingOf(deck: Readonly<CacheDeck>): Promise<unknown> {
  const text = await readFile(path.join(deck.dir, 'pptx', 'slides', 'letter-spacing.json'), 'utf8')
  return JSON.parse(text) as unknown
}

async function doesManifestExist(deck: Readonly<CacheDeck>): Promise<boolean> {
  try {
    await readFile(path.join(cacheDirOf(deck), 'manifest.json'), 'utf8')
    return true
  }
  catch {
    return false
  }
}

describe('convertToPptx の差分キャッシュ', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    document.getAnimations = (): Animation[] => []
  })

  afterAll(async () => {
    for (const dir of cacheDeckDirs) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('初回の変換では、すべてのステップが miss になり、manifest とキャッシュの成果物を作成する', async () => {
    await explains('差分キャッシュの初回の変換のテストです。2 つのステップがともに `miss` になって変換され、`invalidated` が `none` で、manifest と各ステップの成果物がキャッシュに保存されることを確認します。')
    const deck = await setupCacheDeck()
    const { result, calls } = await runCached(deck)

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
    expect(result.cache).toMatchObject({ enabled: true, hits: 0, misses: 2, invalidated: 'none' })
    expect(result.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'miss' },
      { stepIndex: 200, key: '2', cache: 'miss' },
    ])
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200'])
    expect(await listCacheDir(deck)).toStrictEqual([
      'manifest.json',
      'prerender-slide100-0.meta.json',
      'prerender-slide100-0.png',
      'prerender-slide200-0.meta.json',
      'prerender-slide200-0.png',
      'slide-100.pptx',
      'slide-200.pptx',
    ])
  })

  it('内容を変更せずに 2 回目を実行すると、すべてのステップが hit になり、worker を呼ばずに成果物とマップを復元する', async () => {
    await explains('内容を変更せずに 2 回続けて変換する場合のテストです。2 回目はすべてのステップが `hit` になり、worker を呼ばずに、成果物と `letter-spacing.json`・`href-map.json` が復元され、進捗も報告されることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck)
    const labels: string[] = []
    const reports: [number, number][] = []
    const second = await runCached(deck, {
      onProgress: (label) => { labels.push(label) },
      onStepProgress: (completed, total) => { reports.push([completed, total]) },
    })

    expect(second.calls).toStrictEqual([])
    // キャッシュ復元したステップも完了として数える (#1160)。
    expect(reports).toStrictEqual([[0, 2], [1, 2], [2, 2]])
    // キャッシュ復元 (decideSteps) と prune/manifest 書き込みの前後も進捗として報告される (F-03)。
    expect(labels.filter(label => label.startsWith('cache restore: #')).toSorted(compareStrings)).toStrictEqual([
      'cache restore: #1',
      'cache restore: #2',
    ])
    expect(labels).toContain('cache cleanup: prune/manifest started')
    expect(labels).toContain('cache cleanup: prune/manifest done')
    expect(second.result.cache).toMatchObject({ enabled: true, hits: 2, misses: 0, invalidated: 'none' })
    // 全ヒット run でも「成功: 0 スライド」にはしない
    expect(second.result.slideCount).toBe(2)

    const slidesDirectory = path.join(deck.dir, 'pptx', 'slides')
    const staged = await readdir(slidesDirectory)
    expect(staged.toSorted(compareStrings)).toStrictEqual([
      'animation-policy.json',
      'href-map.json',
      'letter-spacing.json',
      'prerender-slide100-0.meta.json',
      'prerender-slide100-0.png',
      'prerender-slide200-0.meta.json',
      'prerender-slide200-0.png',
      'slide-100.pptx',
      'slide-200.pptx',
    ])
    // デッキ全体のマップは cache の断片から再集約される
    const letterSpacing = JSON.parse(await readFile(path.join(slidesDirectory, 'letter-spacing.json'), 'utf8'))
    expect(letterSpacing).toStrictEqual({
      s1: { letterSpacing: '1.0px', fontSize: '14px' },
      s2: { letterSpacing: '1.0px', fontSize: '14px' },
    })
    const href = JSON.parse(await readFile(path.join(slidesDirectory, 'href-map.json'), 'utf8'))
    expect(href).toStrictEqual({ 's1-link': 'https://example.com', 's2-link': 'https://example.com' })
  })

  it('hit したステップがある場合は、要素の診断を再実行していない旨を warnings に追加する', async () => {
    await explains('キャッシュを再利用して変換する場合の、警告のテストです。1 回目は警告がなく、2 回目は 2 ステップ分のキャッシュを再利用したため、要素の診断を再実行していない旨が `warnings` に追加されることを確認します。')
    // hit したステップは worker/prerender を再実行しないため要素エラーが再検出されない。
    // 出さないと再実行のたびに「エラー・警告なし」と誤認する。
    const deck = await setupCacheDeck()
    const first = await runCached(deck)
    expect(first.result.warnings).toStrictEqual([])

    const second = await runCached(deck)
    expect(second.result.warnings).toStrictEqual(['element diagnostics were not re-run for 2 steps because their cache was reused'])
  })

  it('スライドを 1 つだけ変更した場合は、変更したステップだけを変換する', async () => {
    await explains('2 つのスライドのうち、2 つ目だけを変更して再変換する場合のテストです。変更した 2 つ目のステップだけが変換され、1 つ目は `hit` になり、`invalidated` が `partial` になることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck)
    await writeDeck(deck.dir, ['# スライド1', '# スライド2 を修正'])
    const second = await runCached(deck)

    expect(second.calls.map(step => step.slideNumber)).toStrictEqual([2])
    expect(second.result.cache).toMatchObject({ hits: 1, misses: 1, invalidated: 'partial' })
    expect(second.result.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'miss' },
    ])
  })

  it('同じキーが複数のスライドにある場合は、hit と miss の組み合わせにかかわらず、後のスライドの値を採用する', async () => {
    await explains('同じキーを持つ `letterSpacingMap` が複数のスライドにある場合のテストです。すべて `miss` の場合も、片方だけ `hit` の場合も、スライド 2 の値が採用されることを確認します。')
    // 集約は plan（ステップ）順の Object.assign による後勝ちで、テキスト内容がキーのため
    // スライド 2 が常に勝つはず。fake のキーがスライドごとにユニークだと衝突が発生せず、
    // 集約順を hit/miss で分けて壊しても全テストが pass してしまう（元の finding の再現条件）。
    const SHARED_KEY = '共通見出し'
    const expectedWinner = { [SHARED_KEY]: { letterSpacing: '2.0px', fontSize: '20px' } }

    // 1. 全 miss
    const allMissDeck = await setupCacheDeck()
    await runCached(allMissDeck, { sharedLetterSpacingKey: SHARED_KEY })
    expect(await letterSpacingOf(allMissDeck)).toStrictEqual(expectedWinner)

    // 2. スライド 1 のみ hit（スライド 2 を編集して miss にする）
    const slide1HitDeck = await setupCacheDeck()
    await runCached(slide1HitDeck, { sharedLetterSpacingKey: SHARED_KEY })
    await writeDeck(slide1HitDeck.dir, ['# スライド1', '# スライド2 を修正'])
    const slide1HitRun = await runCached(slide1HitDeck, { sharedLetterSpacingKey: SHARED_KEY })
    expect(slide1HitRun.result.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'miss' },
    ])
    expect(await letterSpacingOf(slide1HitDeck)).toStrictEqual(expectedWinner)

    // 3. スライド 2 のみ hit（スライド 1 を編集して miss にする）
    const slide2HitDeck = await setupCacheDeck()
    await runCached(slide2HitDeck, { sharedLetterSpacingKey: SHARED_KEY })
    await writeDeck(slide2HitDeck.dir, ['# スライド1 を修正', '# スライド2'])
    const slide2HitRun = await runCached(slide2HitDeck, { sharedLetterSpacingKey: SHARED_KEY })
    expect(slide2HitRun.result.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'miss' },
      { stepIndex: 200, key: '2', cache: 'hit' },
    ])
    expect(await letterSpacingOf(slide2HitDeck)).toStrictEqual(expectedWinner)
  })

  it('キャッシュのキーを算出できない場合は、警告を出力してすべてを変換し、manifest を書き込まない', async () => {
    await explains('キャッシュのキーを算出できない場合（dom-to-pptx のバンドルが存在しない場合）のテストです。すべてのステップを変換して警告を 1 件記録し、`invalidated` を `all:key` にして、manifest を書き込まないことを確認します。')
    const deck = await setupCacheDeck()
    const { result, calls, logger } = await runCached(deck, {
      bundlePath: path.join(deck.dir, 'lib', 'missing.bundle.js'),
    })

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
    // 警告は warnings 経由で観測できる。`--json` の done payload にも載る (#931)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('cannot compute the cache key, so converting everything')
    // stderr へは末尾のサマリー集約でインデント付き 1 回だけ出す（即時出力との二重を作らない）
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^ {2}cannot compute the cache key, so converting everything: /),
    )
    expect(logger.info).toHaveBeenCalledWith('1 warnings')
    expect(logger.info).not.toHaveBeenCalledWith('no errors or warnings')
    // enabled: false は #898 の --no-cache と共通。
    // ただし invalidated: 'all:key' により、JSON 上で「キー算出失敗による退避」と「意図的な無効化」を区別できる。
    expect(result.cache).toMatchObject({ enabled: false, hits: 0, misses: 2, invalidated: 'all:key' })
    expect(await doesManifestExist(deck)).toBe(false)
  })

  it('キーの算出で想定外の例外が発生した場合は、警告を出力してすべてを変換する', async () => {
    await explains('キーの算出処理が想定外の例外で失敗した場合のテストです。警告が 1 件だけ記録されてすべてのステップが変換され、`invalidated` が `all:error` になり、manifest が書き込まれないことを確認します。')
    // computeDeckCacheKeys の ok:false は、想定内の失敗。
    // それとは別に、prepareCache/decideSteps の呼び出し全体を包む外側 catch を、決定論的に通す。
    // 外側 catch は、cache-store 由来の予期しない throw の最終防波堤になる。
    // cacheStore DI がないと、ENOSPC 等の実 I/O エラーでしか再現できない。
    const deck = await setupCacheDeck()
    const { result, calls, logger } = await runCached(deck, {
      cacheStore: {
        computeDeckCacheKeys: async () => { throw new Error('boom-compute-keys') },
      },
    })

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
    expect(result.warnings).toStrictEqual([
      'cannot use the cache, so converting everything: boom-compute-keys',
    ])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      '  cannot use the cache, so converting everything: boom-compute-keys',
    )
    // enabled: false は --no-cache と共通のため、例外による退避は invalidated で区別する
    expect(result.cache).toMatchObject({ enabled: false, hits: 0, misses: 2, invalidated: 'all:error' })
    expect(await doesManifestExist(deck)).toBe(false)
  })

  it('manifest が破損していて、掃除でも例外が発生した場合は、manifest の警告とキャッシュを使えない旨の警告をどちらも残す', async () => {
    await explains('manifest が破損していて、既存の成果物の掃除も失敗する場合のテストです。manifest を読めない旨の警告と、キャッシュを使えない旨の警告の 2 件が記録され、`invalidated` が `all:error` になることを確認します。')
    // clearOrphanedCacheArtifacts は、既知パターンのファイルを rm する。
    // 同名のディレクトリを置くと、rm が EISDIR で throw する。
    // すると readCacheState の途中から、外側 catch（3 番目の分岐）へ移る。
    // 警告を掃除より前に積んでいないと、この run で manifest 破損の事実が消える。
    const deck = await setupCacheDeck()
    await runCached(deck)
    await writeFile(path.join(cacheDirOf(deck), 'manifest.json'), '{"schemaVersion":1,"envHash":', 'utf8')
    await rm(path.join(cacheDirOf(deck), 'slide-100.pptx'), { force: true })
    await mkdir(path.join(cacheDirOf(deck), 'slide-100.pptx'), { recursive: true })

    const { result, logger } = await runCached(deck)

    expect(result.success).toBe(true)
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toBe('cannot read the cache manifest; cleaning existing artifacts and rebuilding')
    expect(result.warnings[1]).toContain('cannot use the cache, so converting everything')
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith('2 warnings')
    // readCacheState の戻り値は throw で捨てられるため、破損時の all:manifest は invalidated に
    // 反映されない。報告されるのは退避の理由である all:error で、破損の事実は warnings 側に残る。
    expect(result.cache).toMatchObject({ enabled: false, hits: 0, misses: 2, invalidated: 'all:error' })
  })

  it('キャッシュの復元で例外が発生した場合は、警告を出力して該当のステップを miss として変換する', async () => {
    await explains('キャッシュからの成果物の復元が例外で失敗する場合のテストです。2 つのステップについて復元失敗の警告が 1 件ずつ記録され、どちらも `miss` として変換されることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck)
    const { result, calls, logger } = await runCached(deck, {
      cacheStore: {
        materializeCacheEntry: async () => { throw new Error('boom-materialize') },
      },
    })

    expect(calls.map(step => step.slideNumber)).toStrictEqual([1, 2])
    // 2 ステップとも復元に失敗するため警告は 2 件。stderr もインデント付きで 2 回だけ。
    expect(result.warnings).toHaveLength(2)
    for (const warning of result.warnings) {
      expect(warning).toContain('cache restore failed')
    }
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^ {2}cache restore failed: #1: boom-materialize$/),
    )
    expect(logger.info).toHaveBeenCalledWith('2 warnings')
    expect(result.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'partial' })
  })

  it('環境のハッシュ（envHash）が一致しない場合は、すべてのステップを miss として変換する', async () => {
    await explains('manifest に保存された `envHash` が、今回の環境と一致しない場合のテストです。すべてのステップが `miss` になり、`invalidated` が `all:env` で、新しい `envHash` で manifest が書き直されることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck)
    const manifestPath = path.join(cacheDirOf(deck), 'manifest.json')
    const manifest = await readManifest(deck)
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, envHash: 'f'.repeat(64) }, null, 2),
      'utf8',
    )
    const second = await runCached(deck)

    expect(second.calls).toHaveLength(2)
    expect(second.result.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:env' })
    // 新しい envHash で書き直される
    const rewritten = await readManifest(deck)
    expect(rewritten?.envHash).not.toBe('f'.repeat(64))
  })

  it('キャッシュの成果物が存在しないステップだけを、miss として変換する', async () => {
    await explains('キャッシュの成果物（`slide-200.pptx`）を削除した場合のテストです。成果物が存在しない 2 つ目のステップだけが `miss` として変換され、`invalidated` が `partial` になることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck)
    await rm(path.join(cacheDirOf(deck), 'slide-200.pptx'), { force: true })
    const second = await runCached(deck)

    expect(second.calls.map(step => step.slideNumber)).toStrictEqual([2])
    expect(second.result.cache).toMatchObject({ hits: 1, misses: 1, invalidated: 'partial' })
  })

  it('manifest が不正な場合は、すべてのステップを miss として変換し、警告を記録する', async () => {
    await explains('manifest が破損した JSON の場合のテストです。すべてのステップが `miss` になり、`invalidated` が `all:manifest` で、manifest を読めない旨の警告が 1 回だけ出力されることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck)
    await writeFile(path.join(cacheDirOf(deck), 'manifest.json'), '{"schemaVersion":1,"envHash":', 'utf8')
    const second = await runCached(deck)

    expect(second.calls).toHaveLength(2)
    expect(second.result.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:manifest' })
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200'])
    // stderr の logger.warn だけでなく warnings にも積む。破損 run は全 miss で
    // F-09 警告（hit>0 が条件）が出ないため、warnings はこの 1 件だけになる (#929)。
    expect(second.result.warnings).toStrictEqual([
      'cannot read the cache manifest; cleaning existing artifacts and rebuilding',
    ])
    // 人間可読サマリーが警告発生 run で「エラー・警告なし」と矛盾しないこと
    expect(second.logger.info).toHaveBeenCalledWith('1 warnings')
    expect(second.logger.info).not.toHaveBeenCalledWith('no errors or warnings')
    // manifest 警告は、末尾のサマリー集約ループでのみ出力する。
    // readCacheState 内での即時出力と、二重にならないこと。
    // F-01 の回帰検知で、プレフィックス無し 1 回とインデント付き 1 回の二重出力を一本化した。
    expect(second.logger.warn).toHaveBeenCalledTimes(1)
    expect(second.logger.warn).toHaveBeenCalledWith(
      '  cannot read the cache manifest; cleaning existing artifacts and rebuilding',
    )
  })

  it('--no-cache を指定して manifest が破損している場合は、invalidated を none のまま、警告だけを記録する', async () => {
    await explains('`skipRead`（`--no-cache`）を指定し、かつ manifest が破損している場合のテストです。`invalidated` は `none` のままで、manifest を読めない旨の警告だけが記録されることを確認します。')
    // invalidated からの導出では表現できない組み合わせ。--no-cache は判定を飛ばすため
    // 種別が none に倒れるが、manifest 破損自体は起きており警告は出す必要がある (#929)。
    // none への切り捨てはキャッシュ層が throw しなかった run に限られる（次テスト参照）。
    const deck = await setupCacheDeck()
    await runCached(deck)
    await writeFile(path.join(cacheDirOf(deck), 'manifest.json'), '{"schemaVersion":1,"envHash":', 'utf8')
    const second = await runCached(deck, { skipRead: true })

    expect(second.result.cache).toMatchObject({ enabled: false, hits: 0, misses: 2, invalidated: 'none' })
    expect(second.result.warnings).toStrictEqual([
      'cannot read the cache manifest; cleaning existing artifacts and rebuilding',
    ])
  })

  it('--no-cache を指定しても、キャッシュの処理で例外が発生した場合は、invalidated を all:error にする', async () => {
    await explains('`skipRead` を指定し、キーの算出が例外で失敗する場合のテストです。警告が記録され、`invalidated` が `all:error` になり、manifest が書き込まれないことを確認します。')
    // skipRead が none へ倒すのは prepareCache が正常に返った run だけで、外側 catch は
    // skipRead を見ない。`--no-cache` の enabled: false と同じ表示になっても、invalidated で
    // 「読まなかった」(none) と「例外で退避した」(all:error) を区別できる。
    const deck = await setupCacheDeck()
    const { result, calls } = await runCached(deck, {
      skipRead: true,
      cacheStore: {
        computeDeckCacheKeys: async () => { throw new Error('boom-compute-keys') },
      },
    })

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
    expect(result.warnings).toStrictEqual([
      'cannot use the cache, so converting everything: boom-compute-keys',
    ])
    expect(result.cache).toMatchObject({ enabled: false, hits: 0, misses: 2, invalidated: 'all:error' })
    expect(await doesManifestExist(deck)).toBe(false)
  })

  it('manifest が破損している場合は、削除済みのスライドの成果物を掃除し、キャッシュに残さない', async () => {
    await explains('manifest が破損していて、すでに存在しないステップ（999）の成果物が残っている場合のテストです。再変換の後で、その成果物がキャッシュから削除され、manifest には 2 つのステップだけが記録されることを確認します。')
    // FR-010: manifest が読めないと previous:undefined になり、prune と孤児削除が行われない。
    // 今は無い stepIndex 999（削除済みスライド相当）の残骸を使う。
    // この残骸が manifest 破損後も、cache/ の中で永久に生き残らないことを検証する。
    const deck = await setupCacheDeck()
    await runCached(deck)
    await writeFile(path.join(cacheDirOf(deck), 'slide-999.pptx'), 'stale-pptx', 'utf8')
    await writeFile(path.join(cacheDirOf(deck), 'prerender-slide999-0.png'), 'stale-png', 'utf8')
    await writeFile(path.join(cacheDirOf(deck), 'manifest.json'), '{"schemaVersion":1,"envHash":', 'utf8')

    const second = await runCached(deck)

    expect(second.result.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:manifest' })
    const remaining = await listCacheDir(deck)
    expect(remaining.some(name => name.includes('999'))).toBe(false)
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200'])
  })

  it('スライドを末尾に追加した場合は、既存のステップが hit になり、追加したステップだけを変換する', async () => {
    await explains('2 つのスライドに 3 つ目を追加して再変換する場合のテストです。既存の 2 つは `hit`、追加した 3 つ目だけが変換され、`invalidated` が `none` で、manifest に 3 つのステップが記録されることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck)
    await writeDeck(deck.dir, ['# スライド1', '# スライド2', '# スライド3'])
    const second = await runCached(deck, { scanSteps: 3 })

    expect(second.calls.map(step => step.slideNumber)).toStrictEqual([3])
    expect(second.result.cache).toMatchObject({ hits: 2, misses: 1, invalidated: 'none' })
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200', '300'])
  })

  it('スライドを削除して再変換した場合は、削除したステップの manifest のエントリと成果物を削除する', async () => {
    await explains('3 つのスライドから 3 つ目を削除して再変換する場合のテストです。残った 2 つは `hit` で変換せず、3 つ目の manifest のエントリと成果物がキャッシュから削除されることを確認します。')
    // 既存テストは追加系（末尾追加）のみで、削除（ステップ数減少）で prune が実際に
    // エントリ・成果物を消すことを踏むテストが無かった。
    const deck = await setupCacheDeck(['# スライド1', '# スライド2', '# スライド3'])
    await runCached(deck, { scanSteps: 3 })
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200', '300'])
    const beforeDeletion = await listCacheDir(deck)
    expect(beforeDeletion.some(name => name.includes('300'))).toBe(true)

    await writeDeck(deck.dir, ['# スライド1', '# スライド2'])
    const second = await runCached(deck, { scanSteps: 2 })

    expect(second.calls).toStrictEqual([])
    expect(second.result.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })
    expect(second.result.cache?.perStep).toStrictEqual([
      { stepIndex: 100, key: '1', cache: 'hit' },
      { stepIndex: 200, key: '2', cache: 'hit' },
    ])
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200'])
    const afterDeletion = await listCacheDir(deck)
    expect(afterDeletion.some(name => name.includes('300'))).toBe(false)
    expect(afterDeletion).not.toContain('slide-300.pptx')
  })

  it('変換に失敗したステップは新しいエントリを作成せず、以前のエントリを引き継ぐ', async () => {
    await explains('スライドを変更したうえで、2 つ目のスライドの変換が失敗する場合のテストです。`success` が `false` になり、manifest に 2 つ目の以前のエントリがそのまま残ることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck)
    const before = await readManifest(deck)
    await writeDeck(deck.dir, ['# スライド1', '# スライド2 を修正'])
    const second = await runCached(deck, { failSlide: 2 })

    expect(second.result.success).toBe(false)
    const after = await readManifest(deck)
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200'])
    expect(after?.entries['200']).toStrictEqual(before?.entries['200'])
  })

  it('--no-cache を指定しても、変換に失敗したステップは以前のエントリと成果物を引き継ぐ', async () => {
    await explains('`skipRead`（`--no-cache`）を指定して、2 つ目のスライドの変換が失敗する場合のテストです。manifest の 2 つ目のエントリと成果物（`slide-200.pptx`）が、削除されずに残ることを確認します。')
    // skipRead は hit 判定だけを飛ばし、reusable（前回エントリが今回の envHash 下で有効か）は
    // 据え置く。ここを reusable: false へ倒すと、失敗ステップの新エントリが作られないまま
    // 旧エントリも引き継がれず、removeUnreferencedArtifacts が生きている成果物を消す。
    const deck = await setupCacheDeck()
    await runCached(deck)
    const before = await readManifest(deck)

    const second = await runCached(deck, { skipRead: true, failSlide: 2 })

    expect(second.result.success).toBe(false)
    expect(second.result.cache).toMatchObject({ enabled: false, hits: 0, misses: 2, invalidated: 'none' })
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200'])
    const after = await readManifest(deck)
    expect(after?.entries['200']).toStrictEqual(before?.entries['200'])
    // エントリだけ残って実体が消えると、次回の materialize が通知なしでミスになる。
    expect(await listCacheDir(deck)).toContain('slide-200.pptx')
  })

  it('プリレンダの画像の枚数が減った場合は、参照されなくなった以前のファイルを削除する', async () => {
    await explains('プリレンダのファイルが 2 枚から 1 枚に減る場合のテストです。変更したステップの余分なファイルが削除され、`hit` したステップのファイルは残ることを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck, { prerenderCount: 2 })
    const initial = await listCacheDir(deck)
    expect(initial.filter(name => name.startsWith('prerender-slide200-'))).toHaveLength(4)

    await writeDeck(deck.dir, ['# スライド1', '# スライド2 を修正'])
    await runCached(deck, { prerenderCount: 1 })

    const remaining = await listCacheDir(deck)
    // 生存 stepIndex は prune 対象外のため、差集合を消さないと孤児が堆積する (FR-010)
    expect(remaining.filter(name => name.startsWith('prerender-slide200-'))).toStrictEqual([
      'prerender-slide200-0.meta.json',
      'prerender-slide200-0.png',
    ])
    // hit したステップの成果物は残る
    expect(remaining.filter(name => name.startsWith('prerender-slide100-'))).toHaveLength(4)
  })

  it('onlySteps 指定時はキャッシュを読み書きしない', async () => {
    await explains('`onlySteps` を指定した場合のテストです。キャッシュの結果（`result.cache`）が `undefined` になり、manifest が書き込まれないことを確認します。')
    const deck = await setupCacheDeck()
    const { result, calls } = await runCached(deck, { onlySteps: [1, 2] })

    expect(calls).toHaveLength(2)
    expect(result.cache).toBeUndefined()
    expect(await doesManifestExist(deck)).toBe(false)
  })

  it('スキャンで得たステップ数と slides.md のスライド数が食い違う場合は、manifest を書き込まない', async () => {
    await explains('`slides.md` が 2 枚なのに、スキャンが 3 ステップを返す場合のテストです。3 ステップとも変換され、manifest とキャッシュの成果物が保存されないことを確認します。')
    const deck = await setupCacheDeck()
    // slides.md は 2 枚だがスキャンは 3 ステップ返す（3 枚目の slideHash が引けない）
    const { result, calls } = await runCached(deck, { scanSteps: 3 })

    expect(calls).toHaveLength(3)
    expect(result.cache).toMatchObject({ enabled: true, hits: 0, misses: 3 })
    expect(await doesManifestExist(deck)).toBe(false)
    // manifest を書かない run では成果物も保存しない（参照元のない孤児になるため）
    await expect(listCacheDir(deck)).rejects.toThrow('ENOENT')
  })

  it('cache ディレクトリを作成できない場合も、変換は成功し、警告だけを出力する', async () => {
    await explains('`cache` の位置にファイルがあり、ディレクトリを作成できない場合のテストです。変換は成功し、manifest の読み取り・成果物の保存・manifest の更新の失敗が、警告として 4 件記録されることを確認します。')
    const deck = await setupCacheDeck()
    // cache/ の位置にファイルを置き、保存・manifest 書換えの双方を失敗させる
    await mkdir(path.join(deck.dir, 'pptx'), { recursive: true })
    await writeFile(path.join(deck.dir, 'pptx', 'cache'), 'not a directory', 'utf8')
    const { result, calls, logger } = await runCached(deck)

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
    // manifest 読み取り失敗 (ENOTDIR) 1 件 + 保存失敗 2 件 + 更新失敗 1 件。
    // 保存・更新の警告も warnings 経由で観測できる (#931)。
    expect(result.warnings).toHaveLength(4)
    expect(result.warnings[0]).toBe('cannot read the cache manifest; cleaning existing artifacts and rebuilding')
    expect(result.warnings.filter(w => w.includes('cache save failed'))).toHaveLength(2)
    expect(result.warnings.filter(w => w.includes('cache update failed'))).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledTimes(4)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^ {2}cache save failed/))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^ {2}cache update failed/))
    expect(logger.info).toHaveBeenCalledWith('4 warnings')
    expect(logger.info).not.toHaveBeenCalledWith('no errors or warnings')
  })

  it('警告を記録した後に失敗する場合も、警告を出力し、PipelineRuntimeError に含める', async () => {
    await explains('警告が記録された後に、処理の中断で失敗する場合のテストです。`PipelineRuntimeError` の `warnings` に警告が含まれ、警告が成功時と同じ形で 1 回だけ出力されることを確認します。')
    // 変換が失敗したときに警告ごと失われると、`--json` 側と stderr 側のどちらも原因を観測できない。
    // 3 番目の分岐の警告を積ませる。
    // そのうえで、worker 実行中に abort させ、Phase 2 の直前で throw させる。
    const deck = await setupCacheDeck()
    const controller = new AbortController()
    const logger = makeLogger()
    const run = runCached(deck, {
      logger,
      cacheStore: {
        computeDeckCacheKeys: async () => { throw new Error('boom-compute-keys') },
      },
      signal: controller.signal,
      onWorkerCall: () => { controller.abort() },
    })

    await expect(run).rejects.toThrow(PipelineRuntimeError)
    const error = await rejectionOf(run)
    expect(error).toBeInstanceOf(PipelineRuntimeError)
    expect((error as PipelineRuntimeError).warnings).toStrictEqual([
      'cannot use the cache, so converting everything: boom-compute-keys',
    ])
    // 失敗した run でも stderr への集約出力は成功時と同じ形で一度だけ出す
    expect(logger.info).toHaveBeenCalledWith('1 warnings')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      '  cannot use the cache, so converting everything: boom-compute-keys',
    )
  })

  it('エラーを記録した後に失敗する場合も、内訳を出力し、PipelineRuntimeError に含める', async () => {
    await explains('スライドの失敗と要素のエラーが記録された後に、処理の中断で失敗する場合のテストです。`PipelineRuntimeError` の `errors` に両方が含まれ、内訳が `=== conversion errors ===` の見出し付きで 1 回だけ出力されることを確認します。')
    // 変換が失敗したときに errors ごと失われると、どのスライド・要素が落ちたのかを観測できない。
    // 観測できないのは、stderr 側と `--json` 側の両方。
    // slide と element の双方を積ませる。
    // そのうえで、worker 実行中に abort させ、Phase 2 の直前で throw させる。
    const deck = await setupCacheDeck()
    const controller = new AbortController()
    const logger = makeLogger()
    let workerCallCount = 0
    const run = runCached(deck, {
      logger,
      failSlide: 2,
      prerenderFailure: { slideNumber: 1, selector: '.chart', message: 'pr-fail' },
      signal: controller.signal,
      // 2 回目 (= slide 1 / slide 2 の両 task が起動済み) まで abort を遅らせる。
      // Phase 1 task wrapper は、開始前に abort 済みなら runSlide を呼ばず即 reject する (F-01)。
      // 1 回目の呼び出しで即 abort すると、concurrency 上限内で同時に起動する slide 2 の task がキューのまま reject される。
      // すると、本テストの検証対象である worker-failed 自体が起きなくなる。
      onWorkerCall: () => {
        workerCallCount++
        if (workerCallCount >= 2) controller.abort()
      },
    })

    await expect(run).rejects.toThrow(PipelineRuntimeError)
    const error = await rejectionOf(run)
    expect((error as PipelineRuntimeError).errors).toStrictEqual([
      { level: 'element', slideNumber: 1, selector: '.chart', message: 'pr-fail' },
      { level: 'slide', slideNumber: 2, message: 'worker-failed' },
    ])
    // 失敗した run でも、stderr への集約出力は成功時と同じ書式で出す。
    // 成功時の `=== 変換結果サマリー ===` へ到達していないため、内訳には専用の見出しが付く
    expect(logger.info).toHaveBeenCalledWith('\n=== conversion errors ===')
    expect(logger.info).toHaveBeenCalledWith('1 slides failed')
    expect(logger.info).toHaveBeenCalledWith('1 element errors')
    // 集約行は run につき一度だけ。無関係な warn の増減で落ちないよう、集約の書式
    // （先頭 2 スペース + [slide] / [element]）に一致する行だけを数える
    expect(aggregatedErrorLines(logger.warn.mock.calls)).toStrictEqual([
      '  [slide] slide 2: worker-failed',
      '  [element] slide 1 .chart: pr-fail',
    ])
    // slideCount が未確定の run で「成功: 0スライド」を出さない
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('slides succeeded'))
  })
})

const workerPhases = { newPage: 1, goto: 2, visible: 3, cssSettle: 4, iframeLoad: 5, inject: 6, prerender: 7, convert: 8, restore: 9 }
const singlePassTiming = { kind: 'converted' as const, groups: [{ slides: [1, 2], steps: 2, pageA: { goto: 1, visible: 1, cssSettle: 1, iframeLoad: 1, inject: 1 } }], fallbackSteps: [] }

/**
2 ステップの全走査 deck（routerPage をそのまま走査に使う）。
*/
function fullScanBrowser(options: Readonly<{ hash?: boolean }> = {}): FakeBrowser {
  const routerPage = new FakePage(options.hash === true ? { gotoRedirect: url => `${url}/#/1` } : { url: 'http://127.0.0.1:4001/1' })
  routerPage.urlQueue = [options.hash === true ? 'http://127.0.0.1:4001/#/2' : 'http://127.0.0.1:4001/2']
  return new FakeBrowser({ pages: [routerPage] })
}

/**
現行 worker の呼び出しを記録する deps。worker の結果は工程別所要を持つ。
*/
function singlePassDeps(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- fake は可変な記録を持つ
  browser: Readonly<FakeBrowser>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 同上
  logger: Readonly<MockLogger>,
  singlePassRunner?: SinglePassRunner,
): { deps: PipelineDependencies, workerCalls: SlideStep[] } {
  const workerCalls: SlideStep[] = []
  const deps: PipelineDependencies = {
    logger,
    createBrowser: async () => browser.asBrowser(),
    createServer: async () => fakeServer(),
    resolveDomToPptx: () => '/lib.js',
    slideWorkerRunner: async (_b, step) => {
      workerCalls.push(step)
      return { ...makeWorkerResult(step.slideNumber, step.clickStep), phases: workerPhases }
    },
    ...(singlePassRunner !== undefined && { singlePassRunner }),
  }
  return { deps, workerCalls }
}

const notCalledRunner: SinglePassRunner = async () => { throw new Error('should not be called') }
/**
1 ステップ目を終えた後に失敗する 1 パス変換（全 miss が現行方式でやり直される）
*/
const firstStepThenBrokenRunner: SinglePassRunner = async (request) => {
  const first = request.steps[0]
  if (first !== undefined) request.onStepDone?.(first)
  throw new Error('single-pass broke')
}
const singlePassTimingWithFallback = { kind: 'converted' as const, groups: [{ slides: [1, 2], steps: 2, fallback: 'print container did not appear within 5 s' }], fallbackSteps: ['1', '2'] }
/**
グループごと退避した 1 パス変換（そのグループは現行 worker で変換済み、という結果を返す）
*/
const fallbackRunner: SinglePassRunner = async request => ({
  kind: 'converted',
  results: request.steps.map(step => ({ status: 'fulfilled', value: makeWorkerResult(step.slideNumber, step.clickStep) })),
  timing: singlePassTimingWithFallback,
  fallbacks: ['slide 1,2: print container did not appear within 5 s'],
})

describe('convertToPptx の 1 パス変換 (#1141)', () => {
  let presDir: string

  beforeAll(async () => {
    presDir = await setupPresDir()
  })

  afterAll(async () => {
    await rm(presDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    document.getAnimations = (): Animation[] => []
  })

  it('全スライドを走査する場合に singlePass が有効なら、1 パス変換の結果を使い、ステップごとの worker を呼ばない', async () => {
    await explains('`singlePass` が有効で全スライドを走査する場合のテストです。1 パス変換に全ステップと同時実行数が渡され、ステップごとの worker は呼ばれず、`timing` に 1 パス変換の情報が載ることを確認します。')
    const requests: SinglePassRequest[] = []
    const runner: SinglePassRunner = async (request) => {
      requests.push(request)
      return {
        kind: 'converted',
        fallbacks: [],
        results: request.steps.map(step => ({ status: 'fulfilled', value: { ...makeWorkerResult(step.slideNumber, step.clickStep), phases: workerPhases } })),
        timing: singlePassTiming,
      }
    }
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), makeLogger(), runner)
    const result = await convertToPptx({ ...baseConfig(presDir), singlePass: true }, deps)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.baseUrl).toBe('http://127.0.0.1:4001')
    expect(requests[0]?.urlFormat).toStrictEqual({ hash: false })
    expect(requests[0]?.steps.map(step => step.slideNumber)).toStrictEqual([1, 2])
    // グループ数は singlePassConcurrency 未指定なら concurrency
    expect(requests[0]?.concurrency).toBe(2)
    // コンテナ数の確認に使う全走査のステップ総数
    expect(requests[0]?.totalSteps).toBe(2)
    expect(workerCalls).toHaveLength(0)
    expect(result.slideCount).toBe(2)
    expect(result.timing.singlePass).toStrictEqual(singlePassTiming)
    expect(result.timing.perSlidePhases).toStrictEqual({ 1: workerPhases, 2: workerPhases })
    expect(result.warnings).toStrictEqual([])
  })

  it('1 パス変換で完了したステップをやり直しても、onStepProgress は完了を二重に数えない', async () => {
    await explains('1 パス変換が 1 つ目のステップの完了後に失敗し、ステップごとの変換でやり直す場合のテストです。2 つのステップが再変換されても、`onStepProgress` の報告が `0/2`・`1/2`・`2/2` の 3 回だけになることを確認します。')
    const reports: [number, number][] = []
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), makeLogger(), firstStepThenBrokenRunner)
    await convertToPptx(
      { ...baseConfig(presDir), singlePass: true },
      { ...deps, onStepProgress: (completed, total) => { reports.push([completed, total]) } },
    )

    expect(workerCalls).toHaveLength(2)
    expect(reports).toStrictEqual([[0, 2], [1, 2], [2, 2]])
  })

  it('singlePass が無効な場合は、1 パス変換を呼ばず、timing に singlePass を含めない', async () => {
    await explains('`singlePass` を指定しない場合のテストです。1 パス変換は呼ばれず、2 つのステップがステップごとの worker で変換され、`timing` に `singlePass` が含まれないことを確認します。')
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), makeLogger(), notCalledRunner)
    const result = await convertToPptx(baseConfig(presDir), deps)

    expect(workerCalls).toHaveLength(2)
    expect(result.timing).not.toHaveProperty('singlePass')
    expect(result.timing.perSlidePhases).toStrictEqual({ 1: workerPhases, 2: workerPhases })
  })

  it('グループ単位で 1 パス変換を退避した場合は、警告を記録し、1 パス変換の結果と timing をそのまま使う', async () => {
    await explains('1 パス変換が、グループ単位でステップごとの変換へ切り替えた旨を報告する場合のテストです。警告が `warnings` とログに記録され、再変換は行われず、結果の `timing` が 1 パス変換の値のままになることを確認します。')
    const logger = makeLogger()
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), logger, fallbackRunner)
    const result = await convertToPptx({ ...baseConfig(presDir), singlePass: true }, deps)

    // 退避したグループは 1 パス変換の中で現行 worker に回っているため、pipeline は再変換しない
    expect(workerCalls).toHaveLength(0)
    expect(result.slideCount).toBe(2)
    expect(result.warnings).toStrictEqual(['not using single-pass conversion; converting with the current method: slide 1,2: print container did not appear within 5 s'])
    expect(logger.warn).toHaveBeenCalledWith('not using single-pass conversion; converting with the current method: slide 1,2: print container did not appear within 5 s')
    expect(result.timing.singlePass).toStrictEqual(singlePassTimingWithFallback)
  })

  it('singlePassConcurrency を指定した場合は、その値を 1 パス変換のグループ数として渡す', async () => {
    await explains('`singlePassConcurrency` を 1 に指定した場合のテストです。1 パス変換に渡す同時実行数が、`concurrency` ではなく指定した値の 1 になることを確認します。')
    const requests: SinglePassRequest[] = []
    const runner: SinglePassRunner = async (request) => {
      requests.push(request)
      return fallbackRunner(request)
    }
    const { deps } = singlePassDeps(fullScanBrowser(), makeLogger(), runner)
    await convertToPptx({ ...baseConfig(presDir), singlePass: true, singlePassConcurrency: 1 }, deps)

    expect(requests[0]?.concurrency).toBe(1)
  })

  it('hash ルータのデッキでも、ルータの判定結果を渡して、1 パス変換で変換する', async () => {
    await explains('hash ルータのデッキで `singlePass` が有効な場合のテストです。URL の形式として `hash: true` が 1 パス変換に渡され、ステップごとの worker は呼ばれず、警告も記録されないことを確認します。')
    const requests: SinglePassRequest[] = []
    const runner: SinglePassRunner = async (request) => {
      requests.push(request)
      return {
        kind: 'converted',
        fallbacks: [],
        results: request.steps.map(step => ({ status: 'fulfilled', value: makeWorkerResult(step.slideNumber, step.clickStep) })),
        timing: singlePassTiming,
      }
    }
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser({ hash: true }), makeLogger(), runner)
    const result = await convertToPptx({ ...baseConfig(presDir), singlePass: true }, deps)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.urlFormat).toStrictEqual({ hash: true })
    expect(requests[0]?.steps.map(step => step.slideNumber)).toStrictEqual([1, 2])
    expect(workerCalls).toHaveLength(0)
    expect(result.warnings).toStrictEqual([])
    expect(result.timing.singlePass).toStrictEqual(singlePassTiming)
  })

  it('print ルートが存在しない場合は、警告を 1 回だけ出力し、ステップごとの worker で変換して、timing に理由と判定時間を載せる', async () => {
    await explains('1 パス変換が、デッキに print ルートが存在しない旨を返す場合のテストです。警告が 1 回だけ出力され、すべてのステップがステップごとの worker で変換され、`slide_sync` の案内が含まれることを確認します。')
    const missing = { kind: 'printRouteMissing' as const, fallback: 'the deck build has no print route', detectMs: 12 }
    const runner = vi.fn<SinglePassRunner>(async () => ({ kind: 'printRouteMissing', timing: missing }))
    const logger = makeLogger()
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), logger, runner)
    const result = await convertToPptx({ ...baseConfig(presDir), singlePass: true }, deps)

    expect(runner).toHaveBeenCalledTimes(1)
    expect(workerCalls.map(step => step.slideNumber)).toStrictEqual([1, 2])
    expect(result.slideCount).toBe(2)
    const warning = 'not using single-pass conversion; converting with the current method: the deck build has no print route; run `slide_sync` to add the print route to the deck'
    expect(result.warnings).toStrictEqual([warning])
    expect(logger.warn.mock.calls.filter(call => String(call[0]).startsWith('not using single-pass conversion'))).toStrictEqual([[warning]])
    expect(result.timing.singlePass).toStrictEqual(missing)
    expect(result.timing.perSlidePhases).toStrictEqual({ 1: workerPhases, 2: workerPhases })
  })

  it('print ルートの判定が時間切れになった場合は、グループ単位の退避として警告し、slide_sync の案内を含めない', async () => {
    await explains('print ルートの判定が時間切れで、グループ単位に切り替わる場合のテストです。時間切れの理由を含む警告が記録され、再変換は行われず、警告に `slide_sync` の案内が含まれないことを確認します。')
    const reason = 'slide 1,2: cannot detect the print route; #print-container, #page-root did not appear within 5 s'
    const timing = { kind: 'converted' as const, groups: [{ slides: [1, 2], steps: 2, fallback: reason.slice('slide 1,2: '.length) }], fallbackSteps: ['1', '2'] }
    const runner: SinglePassRunner = async request => ({
      kind: 'converted',
      results: request.steps.map(step => ({ status: 'fulfilled', value: makeWorkerResult(step.slideNumber, step.clickStep) })),
      timing,
      fallbacks: [reason],
    })
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), makeLogger(), runner)
    const result = await convertToPptx({ ...baseConfig(presDir), singlePass: true }, deps)

    // 退避したグループは 1 パス変換の中で現行 worker に回っているため、pipeline は再変換しない
    expect(workerCalls).toHaveLength(0)
    expect(result.warnings).toStrictEqual([`not using single-pass conversion; converting with the current method: ${reason}`])
    expect(result.warnings.some(warning => warning.includes('slide_sync'))).toBe(false)
    expect(result.timing.singlePass).toStrictEqual(timing)
  })

  it('全スライドを走査しない場合（onlySteps を指定した場合）は、1 パス変換を呼ばずに警告を記録する', async () => {
    await explains('`singlePass` を有効にして `onlySteps` を指定した場合のテストです。1 パス変換は呼ばれず、指定したステップがステップごとの worker で変換され、全走査ではない旨の警告が記録されることを確認します。')
    const runner = vi.fn<SinglePassRunner>()
    const { deps, workerCalls } = singlePassDeps(new FakeBrowser({ pages: [new FakePage()] }), makeLogger(), runner)
    const result = await convertToPptx({ ...baseConfig(presDir), singlePass: true, onlySteps: [3] }, deps)

    expect(runner).not.toHaveBeenCalled()
    expect(workerCalls).toHaveLength(1)
    expect(result.warnings).toStrictEqual(['not using single-pass conversion; converting with the current method: not a full-scan run (e.g. --only)'])
  })

  it('1 パス変換で例外が発生した場合は、途中の成果物を削除して、ステップごとの worker で変換し直す', async () => {
    await explains('1 パス変換が成果物を一部書き出した後に、例外で失敗する場合のテストです。途中の成果物が削除され、すべてのステップがステップごとの worker で変換し直され、失敗の理由を示す警告が記録されることを確認します。')
    const runner: SinglePassRunner = async (request) => {
      await writeFile(path.join(request.slidesDir, 'prerender-slide100-3.png'), 'partial')
      throw new Error('unexpected')
    }
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), makeLogger(), runner)
    const result = await convertToPptx({ ...baseConfig(presDir), singlePass: true }, deps)

    expect(workerCalls).toHaveLength(2)
    expect(result.warnings).toStrictEqual(['not using single-pass conversion; converting with the current method: single-pass conversion failed: unexpected'])
    const names = await readdir(path.join(presDir, 'pptx', 'slides'))
    expect(names).not.toContain('prerender-slide100-3.png')
  })

  it('中断された後に 1 パス変換が例外を発生させた場合は、ステップごとの変換へ切り替えずに打ち切る', async () => {
    await explains('1 パス変換の途中で `signal` が中断され、例外が発生する場合のテストです。`aborted` を含むメッセージの例外が発生し、ステップごとの worker は呼ばれないことを確認します。')
    const controller = new AbortController()
    const runner: SinglePassRunner = async () => {
      controller.abort()
      throw new Error('aborted')
    }
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), makeLogger(), runner)

    await expect(convertToPptx({ ...baseConfig(presDir), singlePass: true }, { ...deps, signal: controller.signal })).rejects.toThrow('aborted')
    expect(workerCalls).toHaveLength(0)
  })
})

/**
受け取った request を記録し、各ステップを request の現行 worker で変換して返す 1 パス変換。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 記録先
function recordingSinglePassRunner(requests: SinglePassRequest[]): SinglePassRunner {
  return async (request) => {
    requests.push(request)
    const results: PromiseSettledResult<SlideConvertResult>[] = []
    for (const step of request.steps) {
      const value = await request.fallbackRunner(request.browser, step, request.workerConfig, request.slidesDir, request.logger)
      results.push({ status: 'fulfilled', value })
    }
    return { kind: 'converted', results, timing: { kind: 'converted', groups: [], fallbackSteps: [] }, fallbacks: [] }
  }
}

/**
変換は現行 worker で行い、ステップ単位の退避を 1 件報告する 1 パス変換。
*/
const stepFallbackSinglePassRunner: SinglePassRunner = async (request) => {
  const outcome = await recordingSinglePassRunner([])(request)
  return { ...outcome, fallbacks: ['slide #2: export failed'] }
}

describe('convertToPptx の 1 パス変換と差分キャッシュ (#1141)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    document.getAnimations = (): Animation[] => []
  })

  it('一部のステップだけ hit した場合は、miss のステップだけを 1 パス変換に渡し、ステップの総数には hit も含める', async () => {
    await explains('1 パス変換とキャッシュを併用し、2 つ目のスライドだけを変更した場合のテストです。1 パス変換に渡すステップは 2 つ目だけで、ステップの総数（`totalSteps`）は `hit` を含む 2 になることを確認します。')
    const deck = await setupCacheDeck()
    // 変換方式は envHash の材料なので、1 回目も 1 パス変換で保存する
    await runCached(deck, { singlePassRunner: recordingSinglePassRunner([]) })
    await writeDeck(deck.dir, ['# スライド1', '# スライド2 を修正'])
    const requests: SinglePassRequest[] = []

    const second = await runCached(deck, { singlePassRunner: recordingSinglePassRunner(requests) })

    expect(second.result.cache).toMatchObject({ hits: 1, misses: 1, invalidated: 'partial' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.steps.map(step => step.slideNumber)).toStrictEqual([2])
    // print ページは hit のスライドも描く。
    // そのため、miss の件数でなく全走査の総数と比べさせる
    expect(requests[0]?.totalSteps).toBe(2)
    expect(second.calls.map(step => step.slideNumber)).toStrictEqual([2])
    expect(second.result.slideCount).toBe(2)
    expect(second.result.warnings.filter(warning => warning.startsWith('not using single-pass'))).toStrictEqual([])
  })

  it('すべてのステップが hit した場合は、1 パス変換を呼ばない', async () => {
    await explains('1 パス変換とキャッシュを併用し、内容を変更せずに再変換した場合のテストです。2 つのステップがともに `hit` になり、1 パス変換が呼ばれず、`timing` に `singlePass` が含まれないことを確認します。')
    const deck = await setupCacheDeck()
    await runCached(deck, { singlePassRunner: recordingSinglePassRunner([]) })
    const runner = vi.fn<SinglePassRunner>()

    const second = await runCached(deck, { singlePassRunner: runner })

    expect(second.result.cache).toMatchObject({ hits: 2, misses: 0 })
    expect(runner).not.toHaveBeenCalled()
    expect(second.calls).toStrictEqual([])
    expect(second.result.warnings.filter(warning => warning.startsWith('not using single-pass'))).toStrictEqual([])
    expect(second.result.timing).not.toHaveProperty('singlePass')
  })

  it('変換方式をステップごとの変換と 1 パス変換で切り替えた場合は、envHash が変わり、すべてのステップを変換する', async () => {
    await explains('ステップごとの変換と 1 パス変換を交互に実行する場合のテストです。方式を切り替えた回は `invalidated` が `all:env` になり、同じ方式で続けた回は `hit` になることを確認します。')
    const deck = await setupCacheDeck()
    const perStep = await runCached(deck)
    const singlePass = await runCached(deck, { singlePassRunner: recordingSinglePassRunner([]) })
    const singlePassAgain = await runCached(deck, { singlePassRunner: recordingSinglePassRunner([]) })
    const backToPerStep = await runCached(deck)

    expect(perStep.result.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'none' })
    expect(singlePass.result.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:env' })
    expect(singlePassAgain.result.cache).toMatchObject({ hits: 2, misses: 0, invalidated: 'none' })
    expect(backToPerStep.result.cache).toMatchObject({ hits: 0, misses: 2, invalidated: 'all:env' })
  })

  it('ステップ単位で 1 パス変換を退避した場合も、警告を記録する', async () => {
    await explains('1 パス変換が、ステップ単位でステップごとの変換へ切り替えた旨を報告する場合のテストです。その理由を含む警告が `warnings` に記録されることを確認します。')
    const deck = await setupCacheDeck()

    const { result } = await runCached(deck, { singlePassRunner: stepFallbackSinglePassRunner })

    expect(result.warnings).toStrictEqual(['not using single-pass conversion; converting with the current method: slide #2: export failed'])
  })
})
