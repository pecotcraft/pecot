// 旧 lib 由来の Playwright API を扱う scanner のため、命名と push() スタイルを踏襲する。
/* eslint-disable unicorn/name-replacements, unicorn/no-immediate-mutation, unicorn/no-null */
import type { Page } from 'playwright'

import { timeouts, type OnlySlideSpec } from '../../domain/slidev-to-pptx/config.js'
import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import { buildSlideUrl, parseSlideUrl, type SlideUrlFormat } from '../../domain/slidev-to-pptx/slide-url.js'
import type { SlideStep } from '../../domain/slidev-to-pptx/types.js'
import { slidevReadyFunctionSource, readSlidevHasNextFn } from '../../domain/slidev-to-pptx/visibility.js'

/**
Slidev context の `nav.hasNext` を読む。取得できない場合（context 不在・`page.evaluate`
不在・evaluate 例外）は null を返し、呼び出し側を従来の URL 変化ベースの終端判定へ倒す。
*/
async function readSlidevHasNext(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Page は mutable 型
  page: Page,
): Promise<boolean | null> {
  try {
    const reportedHasNext: unknown = await page.evaluate(`(${readSlidevHasNextFn})()`)
    return typeof reportedHasNext === 'boolean' ? reportedHasNext : null
  }
  catch {
    return null
  }
}

/**
ArrowRight を押しても URL が変わらなかったときの終端理由を verbose に残す。
hasNext を読めなかった場合と、読めているのに URL が動かなかった場合を文言で区別する。
*/
function logNavigationStall(logger: Logger | null, hasNext: boolean | null, stepCount: number): void {
  if (!logger) return
  const reason = hasNext === null
    ? 'hasNext を読めず URL も変わらず timeout'
    : 'hasNext は true だが URL が変わらず timeout（例: navViaArrowKeys 無効デッキ、nav 状態の遅延）'
  logger.verbose(`  ${stepCount.toString()}ステップで終端: ${reason}`)
}

/**
ArrowRight を 1 回押して次のステップの URL を返す。終端なら null を返す。
終端は 2 通りあり、どちらも理由を verbose に残す（走査の早期終了を後から追える一次情報）。
  - `nav.hasNext` が false: 最終ステップでの固定待ちを避けるための正常終端
  - 押しても URL が変わらない: waitForURL の timeout による終端
*/
async function advanceToNextStep(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Page は mutable 型
  page: Page,
  logger: Logger | null,
  stepCount: number,
): Promise<string | null> {
  // 最終ステップでは ArrowRight が URL を変えず、waitForURL の timeout を待ち切る。
  // そのため押す前に nav.hasNext を見て、終端なら抜ける。
  // これで convert 1 回あたり 5 秒の固定待ちが消える。
  const hasNext = await readSlidevHasNext(page)
  if (hasNext === false) {
    if (logger) logger.verbose(`  ${stepCount.toString()}ステップで終端: hasNext=false`)
    return null
  }
  const previousUrl = page.url()
  await page.keyboard.press('ArrowRight')
  // waitForURL 自身が timeout option を持つため、外側の Promise.race は冗長。catch で false に縮約。
  let isNavigationChanged = true
  try {
    await page.waitForURL(url => url.href !== previousUrl, { timeout: timeouts.scanStepNavigation })
  }
  catch {
    isNavigationChanged = false
  }
  if (!isNavigationChanged) {
    logNavigationStall(logger, hasNext, stepCount)
    return null
  }
  return page.url()
}

/**
全スライドステップの URL 一覧を ArrowRight で連続スキャンする。
`onProgress` は 1 ステップ検出するごとに呼ぶ (idle timeout の計時やり直し用)。
*/
export async function scanSlideSteps(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Page は mutable 型
  page: Page,
  maxSteps: number,
  logger: Logger,
  onProgress?: (label: string) => void,
): Promise<SlideStep[]> {
  const steps: SlideStep[] = []
  steps.push(parseSlideUrl(page.url()))
  onProgress?.('スキャン: ステップ1 検出')

  for (let i = 1; i < maxSteps; i++) {
    const currentUrl = await advanceToNextStep(page, logger, steps.length)
    if (currentUrl === null) break
    const parsed = parseSlideUrl(currentUrl)
    logger.verbose(`  ステップ${(steps.length + 1).toString()}: slide ${parsed.slideNumber.toString()}, click ${parsed.clickStep === null ? '-' : parsed.clickStep.toString()}`)
    steps.push(parsed)
    onProgress?.(`スキャン: ステップ${steps.length.toString()} 検出`)
  }

  logger.info(`${steps.length.toString()}ステップをスキャン完了`)
  return steps
}

/**
--only 指定に基づいてスライドステップを生成する。
click 指定時は単一ステップ、click 未指定 + page あり時は ArrowRight 探索で全 click ステップを収集する。
*/
export async function buildOnlySteps(
  onlySpec: Readonly<OnlySlideSpec>,
  baseUrl: string,
  format: Readonly<SlideUrlFormat>,
  page: Page | null = null,
  logger: Logger | null = null,
): Promise<SlideStep[]> {
  const { slide, click } = onlySpec

  if (click !== null) {
    // `--only N:0` は clicks を載せずクリック前の URL に倒す（旧挙動の維持）。
    // buildSlideUrl 自体は `clicks: 0` を渡せば `?clicks=0` を組み立てる。
    // そのため 0 を省略に倒す契約は、ここが唯一の置き所になる。
    const url = buildSlideUrl(baseUrl, slide, click === 0 ? format : { ...format, clicks: click })
    return [{ slideNumber: slide, clickStep: click, url }]
  }

  const slideUrl = buildSlideUrl(baseUrl, slide, format)
  if (!page) {
    return [{ slideNumber: slide, clickStep: null, url: slideUrl }]
  }

  await page.goto(slideUrl, { waitUntil: 'networkidle' })
  await page.waitForFunction(`(${slidevReadyFunctionSource})()`, { timeout: timeouts.slidevReady })

  const isSlideExists = await page.evaluate(
    (slideNumber: number) => globalThis.document.querySelector(`.slidev-page-${slideNumber.toString()}`) !== null,
    slide,
  )

  if (!isSlideExists) {
    throw new Error(`Slide ${slide.toString()} not found. Check that the slide number exists in the presentation.`)
  }

  const steps: SlideStep[] = []
  steps.push(parseSlideUrl(page.url()))

  const MAX_CLICK_STEPS = 50
  for (let i = 0; i < MAX_CLICK_STEPS; i++) {
    // hasNext による終端は対象が最終スライドのときだけ働く
    // （それ以外は次スライドへ遷移し、下の URL 基準の判定で抜ける）。
    const currentUrl = await advanceToNextStep(page, logger, steps.length)
    if (currentUrl === null) break

    // 対象スライドを越えたかは URL で判定する（nav.currentPage は URL より遅れる）。
    const parsed = parseSlideUrl(currentUrl)
    if (parsed.slideNumber !== slide) break

    if (logger) logger.verbose(`  click ${parsed.clickStep === null ? '-' : parsed.clickStep.toString()} 検出`)
    steps.push(parsed)
  }

  if (steps.length === 0) {
    throw new Error(`No steps found for slide ${slide.toString()}. The slide may not exist.`)
  }

  if (logger) {
    logger.info(`スライド${slide.toString()}の${steps.length.toString()}ステップをスキャン完了`)
  }
  return steps
}
/* eslint-enable unicorn/name-replacements, unicorn/no-immediate-mutation, unicorn/no-null */
