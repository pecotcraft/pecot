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

  it('presDir が相対パスなら Error を throw', async () => {
    const config = { ...baseConfig(presDir), presDir: 'relative' }
    await expect(convertToPptx(config)).rejects.toThrow('presDir must be an absolute path')
  })

  it('onlySteps 指定で各 step を slideWorkerRunner で変換し、result.success=true', async () => {
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

  it('onlySlide.click 指定 (>0) で buildOnlySteps を 1 step で実行', async () => {
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

  it('全 slide scan: scanSlideSteps で複数 step 取得 → 全 step 変換', async () => {
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

  it('リダイレクトが起きなければ router=history と判定し、URL をパス形式で組み立てる', async () => {
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

  it('hash ルータの onlySteps はフラグメント形式で URL を組み立てる', async () => {
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

  it('worker が reject すると errors[] に level=slide entry が追加され success=false', async () => {
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

  it('onProgress はスキャンの各ステップと、成功・失敗どちらの worker 完了でも呼ばれる (#1097)', async () => {
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

  it('onStepProgress はスキャン後に 0/総数、以降は成功・失敗どちらの完了でも 1 ずつ報告する (#1160)', async () => {
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

  it('prerenderResults の失敗が level=element で errors に追加される', async () => {
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

  it('成功時の集約出力にスライド失敗・要素エラーの内訳が出る', async () => {
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

  it('resolveDomToPptx 省略時は createRequire 経由 (本物の dom-to-pptx) で解決', async () => {
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

  it('logLevel が "" のとき createLogger("normal") にフォールバック', async () => {
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

  it('slides.md の title が無くても slidesDirectory は <outputDir>/slides を返す', async () => {
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

  it('signal が abort 済の状態で呼ぶと早期 throw + browser/server は閉じられる', async () => {
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

  it('signal が Phase 1 開始後に abort されると AbortError を throw し、cleanup も行う', async () => {
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

  it('初回は全 miss で manifest を作る (invalidated=none)', async () => {
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

  it('無変更の 2 回目は全 hit で slideWorkerRunner を呼ばず、成果物とマップを復元する', async () => {
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

  it('hit したステップがあれば「要素診断を再実行していない」旨を warnings に積む (F-09)', async () => {
    // hit したステップは worker/prerender を再実行しないため要素エラーが再検出されない。
    // 出さないと再実行のたびに「エラー・警告なし」と誤認する。
    const deck = await setupCacheDeck()
    const first = await runCached(deck)
    expect(first.result.warnings).toStrictEqual([])

    const second = await runCached(deck)
    expect(second.result.warnings).toStrictEqual(['element diagnostics were not re-run for 2 steps because their cache was reused'])
  })

  it('1 ブロックだけ変更すると変換されるのは該当ステップのみ (invalidated=partial)', async () => {
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

  it('letterSpacingMap の後勝ち集約はステップ順を維持し、hit/miss の組み合わせで結果が変わらない (F-07, SC-003)', async () => {
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

  it('キー算出に失敗したら警告して全変換し、manifest を書かない (invalidated=all:key)', async () => {
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

  it('computeDeckCacheKeys が予期せず throw したら警告して全変換にフォールバックする (F-05, SC-004 最終防波堤)', async () => {
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

  it('manifest 破損の掃除で throw しても、manifest 警告と外側 catch の警告が両方残る (#931)', async () => {
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

  it('materializeCacheEntry が throw したら警告して当該ステップを miss に降格する (F-05)', async () => {
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

  it('envHash が一致しなければ全 miss (invalidated=all:env)', async () => {
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

  it('キャッシュ成果物が欠けていれば該当ステップだけ miss (invalidated=partial)', async () => {
    const deck = await setupCacheDeck()
    await runCached(deck)
    await rm(path.join(cacheDirOf(deck), 'slide-200.pptx'), { force: true })
    const second = await runCached(deck)

    expect(second.calls.map(step => step.slideNumber)).toStrictEqual([2])
    expect(second.result.cache).toMatchObject({ hits: 1, misses: 1, invalidated: 'partial' })
  })

  it('manifest が不正なら全 miss (invalidated=all:manifest。不在と区別する)', async () => {
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

  it('--no-cache × throw を伴わない manifest 破損では invalidated は none のまま警告だけ積む', async () => {
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

  it('--no-cache でもキャッシュ層の例外で退避した run は all:error を報告する (#931)', async () => {
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

  it('manifest 破損時は既知パターンの旧成果物を掃除し、削除済みスライドの孤児が残留しない (F-03)', async () => {
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

  it('末尾にスライドを足しても既存は hit、新規のみ miss で invalidated=none', async () => {
    const deck = await setupCacheDeck()
    await runCached(deck)
    await writeDeck(deck.dir, ['# スライド1', '# スライド2', '# スライド3'])
    const second = await runCached(deck, { scanSteps: 3 })

    expect(second.calls.map(step => step.slideNumber)).toStrictEqual([3])
    expect(second.result.cache).toMatchObject({ hits: 2, misses: 1, invalidated: 'none' })
    expect(await manifestEntryKeys(deck)).toStrictEqual(['100', '200', '300'])
  })

  it('スライドを削除した再変換では prune が manifest エントリと成果物を実際に消す (F-08)', async () => {
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

  it('変換に失敗したステップはエントリを作らず、旧エントリを引き継ぐ', async () => {
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

  it('--no-cache でも変換に失敗したステップは旧エントリと成果物を引き継ぐ', async () => {
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

  it('prerender の枚数が減った再変換で、参照されなくなった旧ファイルを消す', async () => {
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
    const deck = await setupCacheDeck()
    const { result, calls } = await runCached(deck, { onlySteps: [1, 2] })

    expect(calls).toHaveLength(2)
    expect(result.cache).toBeUndefined()
    expect(await doesManifestExist(deck)).toBe(false)
  })

  it('スキャン結果とパーサのスライド数が食い違う run では manifest を書き換えない', async () => {
    const deck = await setupCacheDeck()
    // slides.md は 2 枚だがスキャンは 3 ステップ返す（3 枚目の slideHash が引けない）
    const { result, calls } = await runCached(deck, { scanSteps: 3 })

    expect(calls).toHaveLength(3)
    expect(result.cache).toMatchObject({ enabled: true, hits: 0, misses: 3 })
    expect(await doesManifestExist(deck)).toBe(false)
    // manifest を書かない run では成果物も保存しない（参照元のない孤児になるため）
    await expect(listCacheDir(deck)).rejects.toThrow('ENOENT')
  })

  it('cache ディレクトリを作れなくても変換は成功し、警告のみ出す', async () => {
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

  it('警告を積んだ後に throw する run でも、警告を出力し PipelineRuntimeError に載せる (#931)', async () => {
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

  it('エラーを積んだ後に throw する run でも、内訳を出力し PipelineRuntimeError に載せる (#945)', async () => {
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

  it('config.singlePass かつ全走査なら 1 パス変換の結果を使い、現行 worker を呼ばない', async () => {
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

  it('1 パス変換で終えたステップを現行方式でやり直しても onStepProgress は二重に数えない (#1160)', async () => {
    const reports: [number, number][] = []
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), makeLogger(), firstStepThenBrokenRunner)
    await convertToPptx(
      { ...baseConfig(presDir), singlePass: true },
      { ...deps, onStepProgress: (completed, total) => { reports.push([completed, total]) } },
    )

    expect(workerCalls).toHaveLength(2)
    expect(reports).toStrictEqual([[0, 2], [1, 2], [2, 2]])
  })

  it('config.singlePass が無ければ 1 パス変換を呼ばず、timing.singlePass も載らない', async () => {
    const { deps, workerCalls } = singlePassDeps(fullScanBrowser(), makeLogger(), notCalledRunner)
    const result = await convertToPptx(baseConfig(presDir), deps)

    expect(workerCalls).toHaveLength(2)
    expect(result.timing).not.toHaveProperty('singlePass')
    expect(result.timing.perSlidePhases).toStrictEqual({ 1: workerPhases, 2: workerPhases })
  })

  it('グループ単位の退避は警告として積み、1 パス変換の結果と timing はそのまま使う', async () => {
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

  it('config.singlePassConcurrency があればそれをグループ数として渡す', async () => {
    const requests: SinglePassRequest[] = []
    const runner: SinglePassRunner = async (request) => {
      requests.push(request)
      return fallbackRunner(request)
    }
    const { deps } = singlePassDeps(fullScanBrowser(), makeLogger(), runner)
    await convertToPptx({ ...baseConfig(presDir), singlePass: true, singlePassConcurrency: 1 }, deps)

    expect(requests[0]?.concurrency).toBe(1)
  })

  it('hash ルータのデッキもルータ判定の結果を渡して 1 パス変換で変換する (#1147)', async () => {
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

  it('print ルートの不在の印を受けたら警告を 1 回だけ出し、全 miss を現行方式で変換して timing に理由と判定時間を載せる (#1147)', async () => {
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

  it('print ルートの判定の時間切れはグループ単位の退避として警告し、slide_sync の案内を付けない (#1147)', async () => {
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

  it('全走査でない run (onlySteps) では 1 パス変換を呼ばずに警告する', async () => {
    const runner = vi.fn<SinglePassRunner>()
    const { deps, workerCalls } = singlePassDeps(new FakeBrowser({ pages: [new FakePage()] }), makeLogger(), runner)
    const result = await convertToPptx({ ...baseConfig(presDir), singlePass: true, onlySteps: [3] }, deps)

    expect(runner).not.toHaveBeenCalled()
    expect(workerCalls).toHaveLength(1)
    expect(result.warnings).toStrictEqual(['not using single-pass conversion; converting with the current method: not a full-scan run (e.g. --only)'])
  })

  it('1 パス変換が例外を投げたら途中の成果物を消して現行方式で変換し直す', async () => {
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

  it('abort 後に 1 パス変換が throw したら現行方式へ退避せずに打ち切る', async () => {
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

  it('一部 hit の run では miss のステップだけを渡し、コンテナ数の確認に使う総数は hit を含む全ステップ数にする', async () => {
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

  it('全件 hit の run では 1 パス変換を呼ばない', async () => {
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

  it('変換方式を切り替えた run は envHash が変わり、全変換になる (#1147)', async () => {
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

  it('ステップ単位の退避も警告として積む', async () => {
    const deck = await setupCacheDeck()

    const { result } = await runCached(deck, { singlePassRunner: stepFallbackSinglePassRunner })

    expect(result.warnings).toStrictEqual(['not using single-pass conversion; converting with the current method: slide #2: export failed'])
  })
})
