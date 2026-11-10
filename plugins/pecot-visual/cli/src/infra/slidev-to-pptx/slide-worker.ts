// 旧 lib 由来の Playwright + 並列制御の命名・スタイルを踏襲する。
/* eslint-disable unicorn/name-replacements, no-restricted-syntax */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
/* eslint-disable @stylistic/max-statements-per-line */
import { performance } from 'node:perf_hooks'

import type { Browser } from 'playwright'

import { slideViewport, timeouts, type ExportToPptxOptions } from '../../domain/slidev-to-pptx/config.js'
import { errorMessage } from '../../domain/slidev-to-pptx/error-utils.js'
import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import { stepIndexOf, stepKeyOf } from '../../domain/slidev-to-pptx/step-index.js'
import type { SlidePhases, SlideStep } from '../../domain/slidev-to-pptx/types.js'
import { convertSlide, injectDomToPptx } from './dom-converter.js'
import { prerenderComplexElements, restorePrerenderElements } from './prerender.js'
import { prerenderConfig } from './prerender-config.js'
import type { PrerenderResult } from './prerender-capture.js'
import { slideVisibleFunctionSource } from '../../domain/slidev-to-pptx/visibility.js'
import { waitForCssAnimations, waitForFontsReady, waitForDataWaitfor, waitForIframeLoad } from './visibility-helpers.js'

export interface SlideWorkerConfig {
  readonly slidePrefix: string
  readonly libPath: string
  /**
  exportToPptx へ渡す変換オプション。pipeline が config から解決した値をそのまま流す。
  */
  readonly exportOptions: Readonly<ExportToPptxOptions>
}

export interface SlideConvertResult {
  readonly step: SlideStep
  readonly letterSpacingMap: Readonly<Record<string, { letterSpacing: string, fontSize: string }>>
  readonly hrefMap: Readonly<Record<string, string>>
  /**
  当該ステップのスライドが明示指定のアニメーションを持つか（#1070）
  */
  readonly hasExplicitAnimation: boolean
  readonly prerenderResults: readonly PrerenderResult[]
  readonly elapsed: number
  /**
  工程別の所要（ms）。test の fake worker は省略し得る
  */
  readonly phases?: SlidePhases
}

/**
1 ステップを変換する worker。pipeline と 1 パス方式の失敗ステップの受け皿が共有する。
*/
export type SlideWorkerRunner = (
  browser: Readonly<Browser>,
  step: Readonly<SlideStep>,
  workerConfig: Readonly<SlideWorkerConfig>,
  slidesDir: string,
  logger: Logger,
) => Promise<SlideConvertResult>

/**
区間の開始時刻を受け取り、そこからの経過 ms を返す計時ヘルパ。
*/
export function elapsedSince(start: number): number {
  return performance.now() - start
}

/**
fn を実行し、戻り値と所要 ms の組を返す計時ヘルパ。
*/
export async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now()
  const value = await fn()
  return [value, elapsedSince(start)]
}

async function convertSingleSlide(
  browser: Readonly<Browser>,
  step: Readonly<SlideStep>,
  config: Readonly<SlideWorkerConfig>,
  slidesDir: string,
  logger: Logger,
): Promise<SlideConvertResult> {
  const slideStart = performance.now()
  logger.info(`\nconverting slide #${stepKeyOf(step)}...`)

  // step.url は scanner と buildSlideUrl のどちらの処理でも、baseUrl 込みの絶対 URL。
  const slideUrl = step.url
  const [page, newPageMs] = await timed(async () => browser.newPage())

  try {
    const [, gotoMs] = await timed(async () => {
      await page.setViewportSize(slideViewport)
      await page.goto(slideUrl, { waitUntil: 'load' })
    })
    // 「いずれかの .slidev-page が可視」では、URL 解析を誤って全ステップが同じスライドを
    // 開いていても待機が通ってしまう。要求スライド番号のページが可視であることまで求める。
    const [, visibleMs] = await timed(async () => {
      await page.waitForFunction(
        (argument: { visibleFn: string, selector: string }) => {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
          const isVisible = new Function('return ' + argument.visibleFn)() as (el: Element) => boolean
          return [...document.querySelectorAll(argument.selector)].some(s => isVisible(s))
        },
        { visibleFn: slideVisibleFunctionSource, selector: `.slidev-page-${step.slideNumber.toString()}` },
        { timeout: timeouts.slideVisibility },
      )
      // layout が済んでから取らないと、フォントの読込を待たずに解決済みで返る。可視待ちの段に含める
      await waitForFontsReady(page, timeouts.fontsReady)
      await waitForDataWaitfor(page, undefined, timeouts.dataWaitfor, logger)
    })

    const [, cssSettleMs] = await timed(async () => waitForCssAnimations(page, timeouts.cssAnimationSettle, logger))
    const [, iframeLoadMs] = await timed(async () => waitForIframeLoad(page, '.artifact-iframe', timeouts.iframeLoad, logger))
    const [, injectMs] = await timed(async () => injectDomToPptx(page, config.libPath))

    const stepIndex = stepIndexOf(step)

    const [prerenderResults, prerenderMs] = await timed(async () =>
      prerenderComplexElements(page, browser, prerenderConfig, stepIndex, slidesDir, logger, slideUrl))
    const [{ letterSpacingMap, hrefMap, hasExplicitAnimation }, convertMs] = await timed(async () =>
      convertSlide(page, stepIndex, config.slidePrefix, slidesDir, logger, config.exportOptions))
    const [, restoreMs] = await timed(async () => restorePrerenderElements(page, logger))

    const elapsed = performance.now() - slideStart
    const phases: SlidePhases = {
      newPage: newPageMs,
      goto: gotoMs,
      visible: visibleMs,
      cssSettle: cssSettleMs,
      iframeLoad: iframeLoadMs,
      inject: injectMs,
      prerender: prerenderMs,
      convert: convertMs,
      restore: restoreMs,
    }
    return { step, letterSpacingMap, hrefMap, hasExplicitAnimation, prerenderResults, elapsed, phases }
  }
  finally {
    await page.close()
  }
}

export async function convertSingleSlideWithRetry(
  browser: Readonly<Browser>,
  step: Readonly<SlideStep>,
  config: Readonly<SlideWorkerConfig>,
  slidesDir: string,
  logger: Logger,
): Promise<SlideConvertResult> {
  const maxRetries = timeouts.slideRetryCount
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await convertSingleSlide(browser, step, config, slidesDir, logger)
    }
    catch (error) {
      lastError = error
      if (attempt < maxRetries) {
        logger.warn(`slide #${stepKeyOf(step)} conversion failed (attempt ${(attempt + 1).toString()}/${(maxRetries + 1).toString()}): ${errorMessage(error)}`)
        logger.warn(`  retrying in ${timeouts.slideRetryDelay.toString()}ms...`)
        await new Promise<void>(resolve => setTimeout(() => { resolve() }, timeouts.slideRetryDelay))
      }
      else {
        throw error
      }
    }
  }
  throw lastError
}
/* eslint-enable unicorn/name-replacements, no-restricted-syntax */
/* eslint-enable @typescript-eslint/prefer-readonly-parameter-types */
/* eslint-enable @stylistic/max-statements-per-line */
