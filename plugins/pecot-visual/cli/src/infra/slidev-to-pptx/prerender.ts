// 旧 lib 由来の Playwright/PrerenderConfig 命名を踏襲するため、次の規則を本ファイル内で無効化する。
/* eslint-disable unicorn/name-replacements, no-restricted-syntax */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
import type { Page, Browser } from 'playwright'

import { timeouts } from '../../domain/slidev-to-pptx/config.js'
import { errorMessage } from '../../domain/slidev-to-pptx/error-utils.js'
import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import { slideVisibleFunctionSource } from '../../domain/slidev-to-pptx/visibility.js'
import { captureAndReplaceElements, type PrerenderResult } from './prerender-capture.js'
import { highResolutionDeviceScaleFactor, resolveWait, type PrerenderConfig, type PrerenderTarget, type ResolvedWait } from './prerender-config.js'
import { locateTargetsInVisibleSlides, waitForSelectorInVisibleSlide, waitForCssAnimations, waitForFontsReady, waitForDataWaitfor } from './visibility-helpers.js'

async function executeWaitStrategy(
  hiResPage: Readonly<Page>,
  target: Readonly<PrerenderTarget>,
  wait: Readonly<ResolvedWait>,
  logger: Logger,
): Promise<void> {
  logger.verbose(`  ${target.selector}: wait strategy: ${wait.type}`)
  if (wait.selectorWait !== undefined) {
    try {
      await waitForSelectorInVisibleSlide(hiResPage, target.selector, wait.selectorWait.selector, {
        state: wait.selectorWait.state,
        timeout: wait.selectorWait.timeout,
      })
      logger.info(`  ${target.selector}: render completion detected`)
    }
    catch (error) {
      logger.warn(`  ${target.selector}: render wait timed out: ${errorMessage(error)}`)
    }
  }
  if (wait.delay > 0) {
    await hiResPage.waitForTimeout(wait.delay)
  }
}

export async function prerenderComplexElements(
  page: Readonly<Page>,
  browser: Readonly<Browser>,
  config: Readonly<PrerenderConfig>,
  slideNum: number,
  slidesDir: string,
  logger: Logger,
  slideUrl?: string,
): Promise<PrerenderResult[]> {
  const allResults: PrerenderResult[] = []
  let globalIndex = 0
  for (const target of config.targets) {
    const elements = await locateTargetsInVisibleSlides(page, target.selector)
    logger.verbose(`  ${target.selector}: ${elements.length.toString()} found`)

    if (elements.length === 0) {
      continue
    }

    const hiResPage = await browser.newPage({
      viewport: { width: 960, height: 540 },
      deviceScaleFactor: highResolutionDeviceScaleFactor(config),
    })

    try {
      const targetUrl = slideUrl ?? page.url()
      await hiResPage.goto(targetUrl, { waitUntil: 'load' })
      await hiResPage.waitForFunction(
        (visibleFn: string) => {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
          const isVisible = new Function('return ' + visibleFn)() as (el: Element) => boolean
          return [...document.querySelectorAll('.slidev-page')].some(s => isVisible(s))
        },
        slideVisibleFunctionSource,
        { timeout: 30_000 },
      )
      await waitForFontsReady(hiResPage, timeouts.fontsReady)
      await waitForDataWaitfor(hiResPage, undefined, timeouts.dataWaitfor, logger)

      await executeWaitStrategy(hiResPage, target, resolveWait(target, config.defaultWaitStrategy), logger)

      await waitForCssAnimations(hiResPage, timeouts.cssAnimationSettle, logger)

      const hiResElements = await locateTargetsInVisibleSlides(hiResPage, target.selector)
      logger.verbose(`  ${target.selector}: ${hiResElements.length.toString()} found (hiRes)`)
      if (elements.length !== hiResElements.length) {
        logger.warn(`  ${target.selector}: detected count mismatch (page: ${elements.length.toString()}, hiRes: ${hiResElements.length.toString()})`)
      }

      const captureResult = await captureAndReplaceElements({ hiResPage, elements, hiResElements, target, config, slideNum, slidesDir, globalIndex, logger })
      allResults.push(...captureResult.results)
      globalIndex += captureResult.processedCount

      if (captureResult.count > 0) {
        logger.info(`  prerender: ${target.selector} → ${captureResult.count.toString()} rendered to images (${config.deviceScaleFactor.toString()}x)`)
      }
      if (captureResult.errors.length > 0) {
        logger.warn(`  ${target.selector}: ${captureResult.errors.length.toString()} errors`)
        for (const error of captureResult.errors) logger.warn(`    - ${error}`)
      }
    }
    finally {
      await hiResPage.close()
    }
  }
  return allResults
}

/**
prerender で差し替えた要素を元に戻す。`scopeSelector` 指定時はその要素の内側だけを戻す
（1 パス方式で 1 コンテナ分だけを戻すため。省略時は document 全体）。
*/
export async function restorePrerenderElements(page: Readonly<Page>, logger: Logger, scopeSelector?: string): Promise<void> {
  const prefix = scopeSelector === undefined ? '' : `${scopeSelector} `
  await page.evaluate((scopePrefix: string) => {
    for (const element of globalThis.document.querySelectorAll(`${scopePrefix}[data-prerender-hidden]`)) {
      const htmlElement = element as HTMLElement
      htmlElement.style.display = ''
      delete htmlElement.dataset['prerenderHidden']
    }
    for (const img of globalThis.document.querySelectorAll(`${scopePrefix}[data-prerender-img]`)) {
      img.remove()
    }
  }, prefix)

  const remaining = await page.evaluate((scopePrefix: string) => ({
    hidden: globalThis.document.querySelectorAll(`${scopePrefix}[data-prerender-hidden]`).length,
    imgs: globalThis.document.querySelectorAll(`${scopePrefix}[data-prerender-img]`).length,
  }), prefix)
  if (remaining.hidden > 0 || remaining.imgs > 0) {
    logger.warn(`  DOM restore incomplete; remaining: hidden=${remaining.hidden.toString()}, img=${remaining.imgs.toString()}`)
  }

  logger.verbose('prerender elements restored')
}
/* eslint-enable unicorn/name-replacements, no-restricted-syntax */
/* eslint-enable @typescript-eslint/prefer-readonly-parameter-types */
