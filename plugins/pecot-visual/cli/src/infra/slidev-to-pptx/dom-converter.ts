// 旧 lib 由来の Playwright 処理を踏襲するため、次の規則を本ファイル内で無効化する。
/* eslint-disable unicorn/name-replacements, unicorn/no-null, unicorn/import-style */
/* eslint-disable unicorn/no-typeof-undefined, unicorn/prefer-code-point, no-restricted-syntax */
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
/* eslint-disable @typescript-eslint/prefer-optional-chain */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/* eslint-disable unicorn/dom-node-dataset -- 走査対象は dataset を持たない Element */
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Page } from 'playwright'

import { timeouts, type ExportToPptxOptions } from '../../domain/slidev-to-pptx/config.js'
import { errorMessage } from '../../domain/slidev-to-pptx/error-utils.js'
import type { Logger } from '../../domain/slidev-to-pptx/logger.js'
import { slideVisibleFunctionSource } from '../../domain/slidev-to-pptx/visibility.js'
import { readSlidesTitleFromFile } from './slides-title-reader.js'

/**
dom-to-pptx がクラス名から認識する既知アニメーション名の一覧（entrance 17 件 + exit 16 件）。

出典は、dom-to-pptx 2.1.1 の `src/animations/css-parser.js` の `ENTRANCE_NAMES` / `EXIT_NAMES`。
配布物では、`dist/dom-to-pptx.mjs.map` の sourcesContent から読める。
同ライブラリ同梱の `skills/dom-to-pptx-skill/reference/ANIMATIONS_WHITELIST.md` が文書化している、
利用者向けの指定方法も、このクラス名。

dom-to-pptx の版を上げるときは、上記 2 定数と比較し、差分をここへ反映する。
反映抜けは、利用者の明示指定を通知なしに落とす退行を招く。
*/
const knownAnimationNames: readonly string[] = [
  // ENTRANCE_NAMES
  'fade-in',
  'appear',
  'zoom-in',
  'fly-in',
  'wipe-in',
  'split-in',
  'wheel',
  'bounce-in',
  'checkerboard-in',
  'random-bars-in',
  'rise-up',
  'swivel-in',
  'drop-in',
  'fly-in-left',
  'fly-in-right',
  'fly-in-top',
  'fly-in-bottom',
  // EXIT_NAMES
  'fade-out',
  'disappear',
  'zoom-out',
  'fly-out',
  'wipe-out',
  'split-out',
  'wheel-out',
  'bounce-out',
  'checkerboard-out',
  'random-bars-out',
  'swivel-out',
  'drop-out',
  'fly-out-left',
  'fly-out-right',
  'fly-out-top',
  'fly-out-bottom',
]

/**
slides.md の frontmatter から title を読み取る。取得できない場合は null。
ファイル読取 + title 抽出は、共通ヘルパー readSlidesTitleFromFile に委譲する。
ここでは、読取失敗時の warn と自契約 (undefined → null 写像) のみを担う。
*/
export async function readSlidesTitle(distDir: string, logger: Logger): Promise<string | null> {
  const slidesPath = join(dirname(distDir), 'slides.md')
  const title = await readSlidesTitleFromFile(slidesPath, (error) => {
    logger.warn(`slides.md の読み取りをスキップ (${slidesPath}): ${errorMessage(error)}`)
  })
  return title ?? null
}

/**
dom-to-pptx ライブラリをページに注入する。
addScriptTag は script の実行まで待つため、定義の確認は直後の 1 回で足りる。
注入と確認の全体を、Node 側で `timeouts.domToPptxInject` に収める。
ページが応答しないと addScriptTag / evaluate が返らないため、Playwright の待ちに上限を委ねない。
*/
export async function injectDomToPptx(page: Readonly<Page>, libPath: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`dom-to-pptx の注入が ${(timeouts.domToPptxInject / 1000).toString()} 秒以内に終わりません`))
    }, timeouts.domToPptxInject)
  })
  const isDomToPptxInjected = async (): Promise<boolean> => {
    await page.addScriptTag({ path: libPath })
    return page.evaluate(() => typeof (globalThis.window as unknown as { domToPptx?: unknown }).domToPptx !== 'undefined')
  }
  try {
    const isDefined = await Promise.race([isDomToPptxInjected(), timedOut])
    if (!isDefined) {
      throw new Error('dom-to-pptx を注入しましたが window.domToPptx が定義されません（script 内の例外か AMD の define に登録された可能性）')
    }
  }
  finally {
    clearTimeout(timer)
  }
}

export interface ConvertSlideResult {
  readonly pptxPath: string
  readonly letterSpacingMap: Readonly<Record<string, { letterSpacing: string, fontSize: string }>>
  readonly hrefMap: Readonly<Record<string, string>>
  /**
  当該ステップのスライドが明示指定のアニメーションを持つか（#1070 の判定結果）
  */
  readonly hasExplicitAnimation: boolean
}

export interface ConvertSlideOptions {
  /**
  変換対象の `.slidev-page` を指すセレクタ。省略時は「最初の可視 `.slidev-page`」を使う
  （1 ステップ 1 ページの現行方式）。1 パス方式は print ページの全ステップが同時に
  可視なため、対象コンテナ内の `.slidev-page` をこれで指定する。
  */
  readonly targetSelector?: string
}

export async function convertSlide(
  page: Readonly<Page>,
  slideNum: number,
  slidePrefix: string,
  slidesDir: string,
  logger: Logger,
  exportOptions: Readonly<ExportToPptxOptions>,
  options: Readonly<ConvertSlideOptions> = {},
): Promise<ConvertSlideResult> {
  logger.debug(`  DOM→PPTX変換開始: slideNum=${slideNum.toString()}`)
  const targetSelector = options.targetSelector ?? null
  const { pptxData, letterSpacingMap, hasExplicitAnimation } = await page.evaluate(async ({ slideNum: slideNumInner, prefix, visibleFn, exportOptions: exportOptionsInner, knownNames, targetSel }) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    const isVisible = new Function('return ' + visibleFn)() as (el: Element) => boolean
    let slide: Element | null = null
    if (targetSel === null) {
      for (const s of globalThis.document.querySelectorAll('.slidev-page')) {
        if (isVisible(s)) {
          slide = s
          break
        }
      }
    }
    else {
      slide = globalThis.document.querySelector(targetSel)
    }

    if (!slide) {
      throw new Error(targetSel === null
        ? `スライド #${slideNumInner.toString()}: 表示中のスライドが見つかりません`
        : `スライド #${slideNumInner.toString()}: 対象のスライドが見つかりません (${targetSel})`)
    }

    const letterSpacingMap: Record<string, { letterSpacing: string, fontSize: string }> = {}
    // NodeFilter.SHOW_TEXT。ブラウザ側のグローバル NodeFilter は isolated-functions に未定義と判定されるため値で書く。
    const SHOW_TEXT = 4
    const walker = globalThis.document.createTreeWalker(slide, SHOW_TEXT)

    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? '').trim()
      if (!text) continue

      const parent = node.parentElement
      if (!parent) continue

      const style = globalThis.getComputedStyle(parent)
      const letterSpacing = style.letterSpacing
      const fontSize = style.fontSize

      if (letterSpacing !== 'normal' && letterSpacing !== '0px') {
        letterSpacingMap[text] = { letterSpacing, fontSize }
      }
    }

    // 当該スライドが「明示指定のアニメーション」を持つかを判定する（#1070）。この値が真の
    // スライドだけ pptx の `p:timing` を残す。方針の本文（何を消し何を残すか・粒度・
    // 要素単位にしない理由）は commands/slidev-to-pptx/convert.ts の除去箇所に置く。
    //
    // 判定は上流 `parseAnimation`（css-parser.js）の名前解決をそのままなぞり、装飾由来の分岐だけを外す。
    // 上流の優先順位は次のとおり。
    //   1. `data-pptx-animation` → `data-pptx-animation-type` 属性。
    //   2. 1 が空のときだけ、カスタムプロパティ `--pptx-animation-name` → `--pptx-animation`。
    //   3. 2 までが空か `none` のとき、computed の `animation-name`。
    //   4. なお空なら、classList を既知アニメーション名と比較する。
    // このうち 3 だけを除外する。
    // Slidev のテーマや装飾クラスの与えるアニメーションが、ここに乗る。
    // すると、装飾しか無いスライドが明示ありに倒れるため。
    // 4 のクラス名の分岐は残す。
    // ライブラリ同梱の ANIMATIONS_WHITELIST.md が、利用者向けに文書化している指定方法だからだ。
    // 落とすと、文書どおりに書かれた明示指定が全て消える。
    // クラスが書かれた時点で作者の意図は明示なので、computed `animation-name` の値に関わらず明示と扱う。
    // 次のユーティリティクラスは名前を与えないので、単独のマーカーにはしない。
    // `animate-duration-*` / `animate-delay-*` / `animate-trigger-*` / `animate-build-*`。
    // 名前を別途与えたうえでの尺・遅延・発火順の指定としては、従来どおりライブラリ側で働く。
    //
    // 1 と 2 は先勝ち。上流は `||` の OR チェーンで名前を解決する。
    // そのため `data-pptx-animation="none"` は truthy として採用され、カスタムプロパティは参照されない。
    // この先勝ちを写すことで、属性で打ち消した要素が、カスタムプロパティで明示ありに戻らない。
    //
    // カスタムプロパティは CSS のデフォルトで継承される。
    // スライド外の祖先（`:root` / `body` 等）に `--pptx-animation-name` を置くと、全スライドが明示ありになる。
    // その状況では、上流の parseAnimation も同じ優先順位 2 で全要素を拾い、実際にアニメーションを生成する。
    // よって全スライドの timing を残すのは、上流の挙動と一致した、意図どおりの結果。
    //
    // 判定は属性・クラスの有無だけを見る。
    // そのため `display:none` の要素や図形化されない要素にマーカーがあっても、そのスライドは明示ありになる。
    // 上流はそれらに効果を生成しないため、残るのは装飾由来の timing だけ。
    // 明示指定を誤って消す側には倒れない。
    //
    // v-click と併用したスライドは、クリック段階ごとに別スライドへ変換される。
    // そのため明示アニメーションは、各段階のスライドに重複して載る。
    const attributeSelector = '[data-pptx-animation], [data-pptx-animation-type]'
    const attributeName = (element: Element): string => {
      const direct = (element.getAttribute('data-pptx-animation') ?? '').trim().toLowerCase()
      return direct === '' ? (element.getAttribute('data-pptx-animation-type') ?? '').trim().toLowerCase() : direct
    }

    // 属性の分岐とクラスの分岐は、querySelector で安価に判定できるので先に済ませる。
    // computed style の全要素走査はカスタムプロパティの分岐だけに絞り、マーカー無しの既定ケースの費用を下げる。
    const attributeElements = [
      ...(slide.matches(attributeSelector) ? [slide] : []),
      ...slide.querySelectorAll(attributeSelector),
    ]
    let hasExplicitAnimation = attributeElements.some((element) => {
      const name = attributeName(element)
      return name !== '' && name !== 'none'
    })

    if (!hasExplicitAnimation) {
      const classSelector = knownNames.map(name => `.${name}`).join(', ')
      hasExplicitAnimation = slide.matches(classSelector) || slide.querySelector(classSelector) !== null
    }

    if (!hasExplicitAnimation) {
      for (const element of [slide, ...slide.querySelectorAll('*')]) {
        // ここに到達する時点で属性値があれば `none`。上流はその要素のカスタムプロパティを見ない
        if (attributeName(element) !== '') continue
        const elementStyle = globalThis.getComputedStyle(element)
        const customName = [
          elementStyle.getPropertyValue('--pptx-animation-name'),
          elementStyle.getPropertyValue('--pptx-animation'),
        ].map(value => value.trim().toLowerCase()).find(value => value !== '') ?? ''
        if (customName !== '' && customName !== 'none') {
          hasExplicitAnimation = true
          break
        }
      }
    }

    const blob = await (globalThis.window as unknown as {
      domToPptx: { exportToPptx: (slide: Element, opts: Record<string, unknown>) => Promise<Blob> }
    }).domToPptx.exportToPptx(slide, {
      // spread を先頭に置き、呼び出しごとに決まる fileName / skipDownload を後勝ちで固定する。
      // excess property check は変数経由の代入に働かない。
      // そのため exportOptions に skipDownload が紛れ込むと、ページ側でダウンロードが動く。
      ...exportOptionsInner,
      fileName: `${prefix}${slideNumInner.toString()}.pptx`,
      skipDownload: true,
    })

    const arrayBuffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return {
      pptxData: btoa(binary),
      letterSpacingMap,
      hasExplicitAnimation,
    }
  }, { slideNum, prefix: slidePrefix, visibleFn: slideVisibleFunctionSource, exportOptions, knownNames: knownAnimationNames, targetSel: targetSelector })

  const hrefMap = await page.evaluate(({ visibleFn, targetSel }: { visibleFn: string, targetSel: string | null }) => {
    const map: Record<string, string> = {}
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    const isVisible = new Function('return ' + visibleFn)() as (el: Element) => boolean
    let slideElement: Element | null = null
    if (targetSel === null) {
      for (const s of globalThis.document.querySelectorAll('.slidev-page')) {
        if (isVisible(s)) {
          slideElement = s
          break
        }
      }
    }
    else {
      slideElement = globalThis.document.querySelector(targetSel)
    }
    if (!slideElement) return map
    for (const a of slideElement.querySelectorAll('a[href]')) {
      const text = (a.textContent ?? '').trim()
      const href = a.getAttribute('href')
      if (text && href && href.startsWith('http')) {
        map[text] = href
      }
    }
    return map
  }, { visibleFn: slideVisibleFunctionSource, targetSel: targetSelector })

  const buffer = Buffer.from(pptxData, 'base64')
  logger.debug(`  PPTXデータ: ${(buffer.length / 1024).toFixed(0)} KB (base64: ${pptxData.length.toString()} chars)`)
  const slidePath = join(slidesDir, `${slidePrefix}${slideNum.toString()}.pptx`)
  await writeFile(slidePath, buffer)
  logger.verbose(`  slides/${slidePrefix}${slideNum.toString()}.pptx (${(buffer.length / 1024).toFixed(2)} KB)`)

  const spacingCount = Object.keys(letterSpacingMap).length
  if (spacingCount > 0) {
    logger.verbose(`  letter-spacing: ${spacingCount.toString()}件`)
    const entries = Object.entries(letterSpacingMap)
    const preview = entries.slice(0, 5)
    logger.debug(`  letter-spacing詳細: ${JSON.stringify(Object.fromEntries(preview))}${entries.length > 5 ? ` ... (${entries.length.toString()}件中5件)` : ''}`)
  }

  const hrefCount = Object.keys(hrefMap).length
  if (hrefCount > 0) {
    logger.verbose(`  href-map: ${hrefCount.toString()}件`)
    const hrefEntries = Object.entries(hrefMap)
    const hrefPreview = hrefEntries.slice(0, 5)
    logger.debug(`  href-map詳細: ${JSON.stringify(Object.fromEntries(hrefPreview))}${hrefEntries.length > 5 ? ` ... (${hrefEntries.length.toString()}件中5件)` : ''}`)
  }

  if (hasExplicitAnimation) {
    logger.verbose('  明示指定のアニメーション: あり（このスライドの p:timing は残す）')
  }

  return { pptxPath: slidePath, letterSpacingMap, hrefMap, hasExplicitAnimation }
}
/* eslint-enable unicorn/name-replacements, unicorn/no-null, unicorn/import-style */
/* eslint-enable unicorn/no-typeof-undefined, unicorn/prefer-code-point, no-restricted-syntax */
/* eslint-enable security/detect-non-literal-fs-filename, security/detect-object-injection */
/* eslint-enable @typescript-eslint/prefer-readonly-parameter-types */
/* eslint-enable @typescript-eslint/prefer-optional-chain */
/* eslint-enable @typescript-eslint/no-unnecessary-condition */
/* eslint-enable unicorn/dom-node-dataset */
