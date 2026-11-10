// Playwright Page を直接触る可視性ヘルパー。
// 文字列定数は domain/slidev-to-pptx/visibility.ts 側に置く。
// 対象は slideVisibleFunctionSource / slidevReadyFunctionSource。
// ここでは、page.evaluate / waitForFunction を用いる副作用関数のみを実装する。

// 旧 lib 由来の Playwright 内 evaluate/page API 命名・as cast を踏襲する。
/* eslint-disable unicorn/name-replacements, no-restricted-syntax */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
import type { Page, ElementHandle } from 'playwright'

import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import { slideVisibleFunctionSource } from '../../domain/slidev-to-pptx/visibility.js'
import { DEFAULT_SELECTOR_TIMEOUT_MS } from './prerender-config.js'
import { ignoreRejection } from '../../domain/_shared/ignore-rejection.js'

/**
可視スライド（`.slidev-page`）を選ぶセレクタ。`scopeSelector` 指定時はその要素の内側に
限る（1 パス方式で print ページの 1 コンテナだけを対象にするため）。
*/
function slidePageSelector(scopeSelector: string | undefined): string {
  return scopeSelector === undefined ? '.slidev-page' : `${scopeSelector} .slidev-page`
}

/**
可視スライド内の対象要素のハンドルを返す。返したハンドルの解放（dispose）は呼び出し側の責務。
*/
export async function locateTargetsInVisibleSlides(
  page: Readonly<Page>,
  targetSelector: string,
  scopeSelector?: string,
): Promise<ElementHandle<SVGElement | HTMLElement>[]> {
  const pageSelector = slidePageSelector(scopeSelector)
  const visibleIndices = await page.evaluate(({ visibleFn, pageSel }: { visibleFn: string, pageSel: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    const isVisible = new Function('return ' + visibleFn)() as (el: Element) => boolean
    const slides = globalThis.document.querySelectorAll(pageSel)
    const indices: number[] = []
    slides.forEach((slide, i) => {
      if (isVisible(slide)) indices.push(i)
    })
    return indices
  }, { visibleFn: slideVisibleFunctionSource, pageSel: pageSelector })

  const handles: ElementHandle<SVGElement | HTMLElement>[] = []
  for (const index of visibleIndices) {
    const slideElement = await page.locator(pageSelector).nth(index).elementHandle()
    try {
      handles.push(...await slideElement.$$(targetSelector))
    }
    finally {
      // スライド要素のハンドルは対象の検出にしか使わない。ページを使い続ける 1 パス方式で
      // ハンドルが積み上がらないよう、ここで解放する（返す対象のハンドルは呼び出し側が解放する）。
      await slideElement.dispose()
    }
  }
  return handles
}

/**
ハンドルをまとめて解放する。解放の失敗（ページが閉じた等）は無視する。
*/
export async function disposeHandles(handles: readonly ElementHandle[]): Promise<void> {
  await Promise.all(handles.map(async (handle) => {
    // 解放できなくても変換結果には影響しない
    await ignoreRejection(handle.dispose())
  }))
}

export interface WaitForSelectorOptions {
  readonly state?: string
  readonly timeout?: number
  /**
  指定時はこの要素の内側の可視スライドだけを見る（省略時は document 全体）
  */
  readonly scopeSelector?: string
}

export async function waitForSelectorInVisibleSlide(
  page: Readonly<Page>,
  targetSelector: string,
  strategySelector: string,
  options: WaitForSelectorOptions = {},
): Promise<void> {
  const { timeout = DEFAULT_SELECTOR_TIMEOUT_MS, scopeSelector } = options
  await page.waitForFunction(
    ({ visibleFn, targetSel, strategySel, pageSel }) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
      const isVisible = new Function('return ' + visibleFn)() as (el: Element) => boolean
      const slides = document.querySelectorAll(pageSel)
      for (const slide of slides) {
        if (!isVisible(slide)) continue
        const targets = slide.querySelectorAll(targetSel)
        for (const target of targets) {
          if (target.querySelector(strategySel)) return false
        }
      }
      return true
    },
    { visibleFn: slideVisibleFunctionSource, targetSel: targetSelector, strategySel: strategySelector, pageSel: slidePageSelector(scopeSelector) },
    { timeout },
  )
}

export interface CssAnimationsResult {
  readonly waited: number
  readonly skipped: number
  readonly timedOut: boolean
}

export async function waitForCssAnimations(
  page: Readonly<Page>,
  timeout: number,
  logger: Logger,
): Promise<CssAnimationsResult> {
  const result = await Promise.race<CssAnimationsResult>([
    page.evaluate(async () => {
      const animations = globalThis.document.getAnimations()
      let skipped = 0
      const finite = animations.filter((animation) => {
        if (animation.constructor.name === 'CSSAnimation') {
          const iterations = animation.effect?.getTiming().iterations
          if (iterations === Infinity) {
            skipped++
            return false
          }
        }
        return animation.playState === 'running' || animation.playState === 'paused'
      })
      await Promise.allSettled(finite.map(async a => a.finished))
      return { waited: finite.length, skipped, timedOut: false }
    }),
    new Promise<CssAnimationsResult>(resolve =>
      setTimeout(() => { resolve({ waited: -1, skipped: -1, timedOut: true }) }, timeout),
    ),
  ])

  logger.verbose(
    result.timedOut
      ? `  CSS animation wait: timed out (${timeout.toString()}ms)`
      : `  CSS animation wait: ${result.waited.toString()} done, ${result.skipped.toString()} skipped (infinite)`,
  )
  return result
}

/**
Web フォントの読み込み完了まで待つ。`document.fonts.ready` は layout 前に取ると読込を待たずに
解決済みで返るため、呼び出し側はスライドの可視を待ってから呼ぶ。取得が滞る環境で変換が止まらないよう、
`timeoutMs` で打ち切る（打ち切りは失敗にしない）。`document.fonts` を持たない環境では待たずに返す。
*/
export async function waitForFontsReady(
  page: Readonly<Page>,
  timeoutMs: number,
): Promise<void> {
  await page.evaluate(async (ms: number) => {
    const fonts = (globalThis.document as unknown as { fonts?: FontFaceSet }).fonts
    if (fonts === undefined) return
    // FontFaceSet を evaluate の戻り値にしないため、await で値を捨てる
    const fontsLoaded = async (): Promise<void> => {
      await fonts.ready
    }
    await Promise.race([
      fontsLoaded(),
      new Promise<void>((resolve) => { setTimeout(resolve, ms) }),
    ])
  }, timeoutMs)
}

/**
範囲内の `[data-waitfor]` の示す子孫がすべて描画済み（空でない bounding box で `visibility: hidden` でない）になるまで待つ。
Slidev export が撮影前に行う待ちと同じ契約で、コンポーネントが描画完了を伝える印として使う。
範囲は `scopeSelector` の要素の内側。省略時は可視スライドの内側。`[data-waitfor]` が無ければ即座に返す。
待ちはブラウザ側の 1 回の evaluate の中で行う（Playwright の waitForFunction を使わない）。
上限（`timeoutMs`）で打ち切り、警告を出して続行する（失敗にしない）。
*/
export async function waitForDataWaitfor(
  page: Readonly<Page>,
  scopeSelector: string | undefined,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  const startedAt = Date.now()
  const result = await page.evaluate(
    async ({ visibleFn, scopeSel, ms }: { visibleFn: string, scopeSel: string | undefined, ms: number }) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
      const isVisible = new Function('return ' + visibleFn)() as (el: Element) => boolean
      const pending = (): { count: number, waiting: number } => {
        const roots = scopeSel === undefined
          ? [...globalThis.document.querySelectorAll('.slidev-page')].filter(s => isVisible(s))
          : [...globalThis.document.querySelectorAll(scopeSel)]
        const owners = roots.flatMap(root => [...root.querySelectorAll('[data-waitfor]')])
        let waiting = 0
        for (const owner of owners) {
          const childSelector = (owner as HTMLElement).dataset['waitfor']
          if (childSelector === undefined || childSelector === '') continue
          const child = owner.querySelector(childSelector)
          if (child === null) {
            waiting += 1
            continue
          }
          const rect = child.getBoundingClientRect()
          const isHidden = globalThis.getComputedStyle(child).visibility === 'hidden'
          if (isHidden || rect.width <= 0 || rect.height <= 0) waiting += 1
        }
        return { count: owners.length, waiting }
      }
      const deadline = Date.now() + ms
      let state = pending()
      while (state.waiting > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50)
        })
        state = pending()
      }
      return { count: state.count, ready: state.waiting === 0 }
    },
    { visibleFn: slideVisibleFunctionSource, scopeSel: scopeSelector, ms: timeoutMs },
  )
  if (result.ready) {
    logger.verbose(`  data-waitfor wait: ${String(result.count)} done (${(Date.now() - startedAt).toString()}ms)`)
  }
  else {
    logger.warn(`  data-waitfor wait: timed out (${timeoutMs.toString()}ms); continuing without confirming render completion`)
  }
}

export async function waitForIframeLoad(
  page: Readonly<Page>,
  selector: string,
  timeout: number,
  logger: Logger,
): Promise<void> {
  const count = await page.evaluate((sel: string) => globalThis.document.querySelectorAll(sel).length, selector)
  if (count === 0) {
    logger.verbose(`  iframe wait: ${selector}: none found, skipped`)
    return
  }
  logger.verbose(`  iframe wait: ${selector}: waiting for ${count.toString()} to finish loading`)
  try {
    await page.waitForFunction(
      (sel: string) => {
        const iframes = document.querySelectorAll(sel)
        return [...iframes].every(iframe => (iframe as HTMLIFrameElement).contentDocument?.readyState === 'complete')
      },
      selector,
      { timeout },
    )
    logger.verbose(`  iframe wait: ${selector}: loaded`)
  }
  catch {
    logger.verbose(`  iframe wait: ${selector}: timed out (${timeout.toString()}ms)`)
  }
}
/* eslint-enable unicorn/name-replacements, no-restricted-syntax */
/* eslint-enable @typescript-eslint/prefer-readonly-parameter-types */
