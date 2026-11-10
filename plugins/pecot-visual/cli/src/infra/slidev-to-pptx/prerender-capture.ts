// 旧 lib 由来の Playwright スクリーンショット処理を踏襲するため、次の規則を本ファイル内で無効化する。
/* eslint-disable unicorn/name-replacements, unicorn/import-style, unicorn/prefer-global-this */
/* eslint-disable unicorn/no-null, unicorn/prefer-modern-dom-apis, no-restricted-syntax */
/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Page, ElementHandle } from 'playwright'

import { sanitizeErrorMessage } from '../../domain/slidev-to-pptx/error-utils.js'
import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import type { PrerenderTarget, PrerenderConfig } from './prerender-config.js'

interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PrerenderResult {
  readonly selector: string
  readonly slideNumber: number
  readonly fileIndex: number
  readonly success: boolean
  readonly error?: string
  readonly imagePath?: string
  readonly imageSize?: number
}

export interface CaptureResult {
  readonly count: number
  readonly errors: readonly string[]
  readonly results: readonly PrerenderResult[]
  readonly processedCount: number
}

/**
要素がビューポート外にあるかを判定する純粋関数。
*/
export function isElementOffscreen(
  box: Readonly<{ x: number, y: number, width: number, height: number }>,
  viewport: Readonly<{ width: number, height: number }>,
): boolean {
  return (
    box.x + box.width <= 0
    || box.y + box.height <= 0
    || box.x >= viewport.width
    || box.y >= viewport.height
  )
}

/**
ラスタ化する要素の上に重なる装飾のうち、DOM から native shape として別に描かれるもの。
要素のスクリーンショットは上に重なるものごと撮るため、写り込むと PPTX で同じ図形が画像と native shape の二重になる。
高解像度ページで撮影している間だけ隠す。
- `.marker-overlay`: annotated-image / annotated-terminal / annotated-diagram のマーカーと引き線。
  図・ターミナル窓の上に重なる。
*/
export const CAPTURE_HIDDEN_OVERLAY_SELECTORS: readonly string[] = ['.marker-overlay']

/**
重なりの装飾を隠す。元の visibility は data 属性に退避し、restoreCaptureOverlays で戻す
*/
async function hideCaptureOverlays(page: Readonly<Page>): Promise<void> {
  await page.evaluate((selectors: readonly string[]) => {
    const matchedElements = globalThis.document.querySelectorAll<HTMLElement>(selectors.join(','))
    for (const element of matchedElements) {
      element.dataset['prerenderOverlayVisibility'] = element.style.visibility
      element.style.visibility = 'hidden'
    }
  }, CAPTURE_HIDDEN_OVERLAY_SELECTORS)
}

async function restoreCaptureOverlays(page: Readonly<Page>): Promise<void> {
  await page.evaluate(() => {
    for (const element of globalThis.document.querySelectorAll<HTMLElement>('[data-prerender-overlay-visibility]')) {
      element.style.visibility = element.dataset['prerenderOverlayVisibility'] ?? ''
      delete element.dataset['prerenderOverlayVisibility']
    }
  })
}

interface SavedTransformEntry {
  markerId: string
  originalTransform: string
  originalOverflow: string | null
}

/**
captureAndReplaceElements の入力。
*/
export interface CaptureRequest {
  readonly hiResPage: Readonly<Page>
  /**
  差し替える要素（変換ページ側）。hiResElements と同じ順序で対応する
  */
  readonly elements: readonly ElementHandle<SVGElement | HTMLElement>[]
  /**
  撮影する要素（高解像度ページ側）
  */
  readonly hiResElements: readonly ElementHandle<SVGElement | HTMLElement>[]
  readonly target: Readonly<PrerenderTarget>
  readonly config: Readonly<PrerenderConfig>
  /**
  成果物のファイル名に使うステップ番号（stepIndex）
  */
  readonly slideNum: number
  readonly slidesDir: string
  /**
  ステップ内の通番の開始値
  */
  readonly globalIndex: number
  readonly logger: Logger
  /**
  meta.json の left / top の原点（変換ページの viewport 座標）。既定 (0, 0) は 1 ステップ
  1 ページの現行方式でスライドが viewport 左上にある前提。1 パス方式は print ページの
  対象コンテナの左上を渡し、スライド基準の座標にする。
  */
  readonly origin?: Readonly<{ x: number, y: number }>
}

export async function captureAndReplaceElements(request: Readonly<CaptureRequest>): Promise<CaptureResult> {
  const { hiResPage, elements, hiResElements, target, config, slideNum, slidesDir, globalIndex, logger, origin } = request
  const originX = origin?.x ?? 0
  const originY = origin?.y ?? 0
  let count = 0
  const errors: string[] = []
  const results: PrerenderResult[] = []

  /**
  同一要素に失敗エントリが二重に積まれるのを防ぐ。
  boundingBox() が throw した要素でも、hiRes 側の screenshot は成功し得る。
  そのため、同じ fileIndex に別文言で 2 件積む場合がある。
  1 件は Phase 1 の catch（`boundingBox取得失敗: …`）、もう 1 件は Phase 3 の `!box`（`boundingBox is null`）。
  `--json` の errors[] は要素単位の一覧として読まれるので、先に確定した具体的な理由だけ残す。
  診断用の warn ログは各分岐でそのまま出す（重複の抑止対象は results だけ）。
  */
  const failedIndexes = new Set<number>()
  const recordFailure = (index: number, error: string): void => {
    if (failedIndexes.has(index)) return
    failedIndexes.add(index)
    results.push({ selector: target.selector, slideNumber: slideNum, fileIndex: globalIndex + index, success: false, error })
  }

  const boxes: (BoundingBox | null)[] = []
  for (const [i, element] of elements.entries()) {
    try {
      const box = await element.boundingBox()
      if (box && target.clipPadding) {
        box.x -= (target.clipPadding.left ?? 0)
        box.y -= (target.clipPadding.top ?? 0)
        box.width += (target.clipPadding.left ?? 0) + (target.clipPadding.right ?? 0)
        box.height += (target.clipPadding.top ?? 0) + (target.clipPadding.bottom ?? 0)
      }
      logger.debug(`  [${i.toString()}] boundingBox: ${box ? `x=${box.x.toFixed(1)} y=${box.y.toFixed(1)} w=${box.width.toFixed(1)} h=${box.height.toFixed(1)}` : 'null'}`)
      boxes.push(box)
    }
    catch (error) {
      const message = sanitizeErrorMessage(error)
      logger.warn(`  ${target.selector}[${i.toString()}] (slide ${slideNum.toString()}): boundingBox lookup failed: ${message}`)
      recordFailure(i, `boundingBox lookup failed: ${message}`)
      boxes.push(null)
    }
  }

  const screenshots: (Buffer | null)[] = []
  const hiResBoxes: (BoundingBox | null)[] = []
  const viewportSize = hiResPage.viewportSize()

  /**
  boundingBox が null の要素を、screenshot を呼ばずに失敗として積む。
  `display: none` の要素で boundingBox() は throw せず、null を返すだけ。
  そのまま screenshot() へ渡すと、Playwright が可視化を既定 timeout（計測 30 秒）まで待ってから throw する。
  撮れないことは box の時点で確定しているため、待つ意味がない。
  記録の形（warn 文言・error 接頭辞・3 配列への push）は下の catch と揃える。
  */
  const recordInvisible = (index: number): void => {
    const reason = 'element is not visible (boundingBox is null)'
    logger.warn(`  ${target.selector}[${index.toString()}] (slide ${slideNum.toString()}): hiRes screenshot failed: ${reason}`)
    recordFailure(index, `hiRes screenshot failed: ${reason}`)
    screenshots.push(null)
    hiResBoxes.push(null)
  }

  // 撮影ループの途中で throw しても、隠した装飾は finally で必ず戻す
  await hideCaptureOverlays(hiResPage)
  try {
    for (const [i, hiResElement] of hiResElements.entries()) {
      try {
        let hiResBox = await hiResElement.boundingBox()
        const offscreen = hiResBox && viewportSize && isElementOffscreen(hiResBox, viewportSize)

        if (offscreen) {
          logger.debug(`  [${i.toString()}] outside the viewport; moving temporarily to capture at hiRes`)
          const savedTransforms = await hiResElement.evaluate((element_: HTMLElement) => {
            const saved: SavedTransformEntry[] = []
            let ancestor: HTMLElement | null = element_.parentElement
            let index = 0
            while (ancestor && ancestor !== document.body) {
              const cs = window.getComputedStyle(ancestor)
              if (cs.transform && cs.transform !== 'none') {
                const markerId = `prtf-${Date.now().toString()}-${(index++).toString()}`
                ancestor.dataset['prerenderTransformId'] = markerId
                const entry: SavedTransformEntry = {
                  markerId,
                  originalTransform: ancestor.style.transform,
                  originalOverflow: null,
                }
                if (cs.overflow === 'hidden' || cs.overflow === 'clip') {
                  entry.originalOverflow = ancestor.style.overflow
                  ancestor.style.overflow = 'visible'
                }
                ancestor.style.transform = 'none'
                saved.push(entry)
              }
              ancestor = ancestor.parentElement
            }
            return saved
          })

          // 祖先の transform を解除したまま抜けると、同一 hiResPage 上の後続要素が破損する。
          // そのため、ここから先は失敗パス（box が null / screenshot の throw）でも finally の復元を必ず通す。
          try {
            await hiResPage.waitForTimeout(100)
            hiResBox = await hiResElement.boundingBox()
            logger.debug(`  [${i.toString()}] hiRes boundingBox after temporary move: ${hiResBox ? `w=${hiResBox.width.toFixed(1)} h=${hiResBox.height.toFixed(1)}` : 'null'}`)

            // 一時移動しても box が返らない要素は、撮らずに失敗とする（screenshot の可視化待ちを回避）。
            if (hiResBox === null) {
              recordInvisible(i)
            }
            else if (target.clipPadding) {
              const clip = {
                x: hiResBox.x - (target.clipPadding.left ?? 0),
                y: hiResBox.y - (target.clipPadding.top ?? 0),
                width: hiResBox.width + (target.clipPadding.left ?? 0) + (target.clipPadding.right ?? 0),
                height: hiResBox.height + (target.clipPadding.top ?? 0) + (target.clipPadding.bottom ?? 0),
              }
              screenshots.push(await hiResPage.screenshot({ type: 'png', clip }))
              hiResBoxes.push(clip)
            }
            else {
              screenshots.push(await hiResElement.screenshot({ type: 'png' }))
              hiResBoxes.push(hiResBox)
            }
          }
          finally {
            if (savedTransforms.length > 0) {
              await hiResElement.evaluate((_element, transforms: SavedTransformEntry[]) => {
                for (const { markerId, originalTransform, originalOverflow } of transforms) {
                  const restored = document.querySelector<HTMLElement>(`[data-prerender-transform-id="${CSS.escape(markerId)}"]`)
                  if (!restored) {
                    continue
                  }

                  restored.style.transform = originalTransform
                  if (originalOverflow !== null) {
                    restored.style.overflow = originalOverflow
                  }
                  delete restored.dataset['prerenderTransformId']
                }
              }, savedTransforms)
            }
          }
        }
        else {
          logger.debug(`  [${i.toString()}] hiRes boundingBox: ${hiResBox ? `x=${hiResBox.x.toFixed(1)} y=${hiResBox.y.toFixed(1)} w=${hiResBox.width.toFixed(1)} h=${hiResBox.height.toFixed(1)}` : 'null'}`)
          if (hiResBox === null) {
            recordInvisible(i)
          }
          else if (target.clipPadding) {
            const clip = {
              x: hiResBox.x - (target.clipPadding.left ?? 0),
              y: hiResBox.y - (target.clipPadding.top ?? 0),
              width: hiResBox.width + (target.clipPadding.left ?? 0) + (target.clipPadding.right ?? 0),
              height: hiResBox.height + (target.clipPadding.top ?? 0) + (target.clipPadding.bottom ?? 0),
            }
            screenshots.push(await hiResPage.screenshot({ type: 'png', clip }))
            hiResBoxes.push(clip)
          }
          else {
            screenshots.push(await hiResElement.screenshot({ type: 'png' }))
            hiResBoxes.push(hiResBox)
          }
        }
      }
      catch (error) {
        const message = sanitizeErrorMessage(error)
        logger.warn(`  ${target.selector}[${i.toString()}] (slide ${slideNum.toString()}): hiRes screenshot failed: ${message}`)
        recordFailure(i, `hiRes screenshot failed: ${message}`)
        screenshots.push(null)
        hiResBoxes.push(null)
      }
    }
  }
  finally {
    await restoreCaptureOverlays(hiResPage)
  }

  const maxLen = Math.min(elements.length, screenshots.length)
  for (let i = maxLen - 1; i >= 0; i--) {
    try {
      const screenshot = screenshots[i]
      if (!screenshot) continue

      const fileIndex = globalIndex + i
      const hiResPath = join(slidesDir, `prerender-slide${slideNum.toString()}-${fileIndex.toString()}.png`)
      await writeFile(hiResPath, screenshot)
      logger.info(`  hiRes image: prerender-slide${slideNum.toString()}-${fileIndex.toString()}.png (${(screenshot.length / 1024).toFixed(0)} KB)`)

      const base64 = screenshot.toString('base64')
      const dataUrl = `data:image/png;base64,${base64}`

      const box = boxes[i]
      if (!box) {
        logger.warn(`  ${target.selector}[${i.toString()}] (slide ${slideNum.toString()}): boundingBox is null; element is not visible or has zero size`)
        recordFailure(i, 'boundingBox is null')
        continue
      }

      const metaPath = join(slidesDir, `prerender-slide${slideNum.toString()}-${fileIndex.toString()}.meta.json`)
      const left = box.x - originX
      const top = box.y - originY
      await writeFile(metaPath, JSON.stringify({
        width: Math.round(box.width * config.pptxImageScale),
        height: Math.round(box.height * config.pptxImageScale),
        left,
        top,
        selector: target.selector,
      }))
      logger.debug(`  meta: width=${Math.round(box.width * config.pptxImageScale).toString()} height=${Math.round(box.height * config.pptxImageScale).toString()} left=${left.toString()} top=${top.toString()}`)

      const hiResBox = hiResBoxes[i]
      if (!hiResBox) {
        logger.warn(`  ${target.selector}[${i.toString()}] (slide ${slideNum.toString()}): hiRes boundingBox is null`)
        recordFailure(i, 'hiRes boundingBox is null')
        continue
      }
      const actualWidth = Math.round(hiResBox.width * config.deviceScaleFactor)
      const actualHeight = Math.round(hiResBox.height * config.deviceScaleFactor)

      logger.debug(`  DOM replaced: ${target.selector}[${i.toString()}] → img (${actualWidth.toString()}x${actualHeight.toString()})`)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- elements[i] は上限内で non-null
      await elements[i]!.evaluate((element_: HTMLElement, { dataUrl: dataUrlInner, cssWidth, cssHeight, actualWidth: actualW, actualHeight: actualH, clipPadding }) => {
        const cs = window.getComputedStyle(element_)
        const layoutProperties: Record<string, string> = {}
        for (const property of ['position', 'top', 'right', 'bottom', 'left',
          'margin', 'zIndex', 'flexShrink', 'flexGrow', 'alignSelf']) {
          // CSSStyleDeclaration の keyof にはメソッドも含まれ unbound-method になるため、文字列索引へキャストする
          layoutProperties[property] = (cs as unknown as Record<string, string>)[property] ?? ''
        }

        const img = document.createElement('img')
        img.src = dataUrlInner
        img.width = actualW
        img.height = actualH
        img.style.width = `${cssWidth.toString()}px`
        img.style.height = `${cssHeight.toString()}px`
        img.style.display = 'block'
        for (const [property, value] of Object.entries(layoutProperties)) {
          (img.style as unknown as Record<string, string>)[property] = value
        }
        if (clipPadding) {
          if (clipPadding.top) img.style.marginTop = `-${clipPadding.top.toString()}px`
          if (clipPadding.left) img.style.marginLeft = `-${clipPadding.left.toString()}px`
        }
        element_.style.display = 'none'
        element_.dataset['prerenderHidden'] = 'true'
        img.dataset['prerenderImg'] = 'true'
        element_.insertAdjacentElement('afterend', img)
      }, { dataUrl, cssWidth: box.width, cssHeight: box.height, actualWidth, actualHeight, clipPadding: target.clipPadding ?? null })

      results.push({ selector: target.selector, slideNumber: slideNum, fileIndex, success: true, imagePath: hiResPath, imageSize: screenshot.length })
      count++
    }
    catch (error) {
      const message = sanitizeErrorMessage(error)
      logger.warn(`  ${target.selector}[${i.toString()}] (slide ${slideNum.toString()}): ${message}`)
      recordFailure(i, message)
      errors.push(message)
    }
  }

  return { count, errors, results, processedCount: maxLen }
}
/* eslint-enable unicorn/name-replacements, unicorn/import-style, unicorn/prefer-global-this */
/* eslint-enable unicorn/no-null, unicorn/prefer-modern-dom-apis, no-restricted-syntax */
/* eslint-enable security/detect-object-injection, security/detect-non-literal-fs-filename */
/* eslint-enable @typescript-eslint/prefer-readonly-parameter-types */
