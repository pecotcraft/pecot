// LCodeBlock 等の複雑なコンポーネントを Playwright スクリーンショットで画像化する infra 設定。
// domain 純粋層から切り出して infra 配下に配置する (Playwright 依存を引き連れる infra の責務)。

export type WaitStrategy
  = | { readonly type: 'fixed', readonly delay?: number }
    | {
      readonly type: 'selectorState'
      readonly selector: string
      readonly state?: 'detached' | 'visible' | 'hidden' | 'attached'
      readonly timeout?: number
      readonly settleDelay?: number
    }

export interface PrerenderTarget {
  readonly selector: string
  readonly waitStrategy?: WaitStrategy
  readonly clipPadding?: Readonly<{ top?: number, right?: number, bottom?: number, left?: number }>
}

export interface PrerenderConfig {
  readonly targets: readonly PrerenderTarget[]
  readonly defaultWaitStrategy: WaitStrategy
  readonly deviceScaleFactor: number
  readonly pptxImageScale: number
}

/**
selectorState の timeout 省略時の待ち上限（ms）。現行方式と 1 パス方式で共有する
*/
export const DEFAULT_SELECTOR_TIMEOUT_MS = 15_000
/**
fixed の delay 省略時、および待ち戦略が 1 つも決まらないときの待ち時間（ms）
*/
export const DEFAULT_FIXED_DELAY_MS = 500
/**
config.deviceScaleFactor が 0 のときに使う高解像度ページの倍率
*/
export const DEFAULT_DEVICE_SCALE_FACTOR = 5

/**
高解像度ページの deviceScaleFactor。0（未設定相当）なら既定値にする。
*/
export function highResolutionDeviceScaleFactor(config: Readonly<PrerenderConfig>): number {
  return config.deviceScaleFactor || DEFAULT_DEVICE_SCALE_FACTOR
}

/**
待ち戦略を「セレクタの状態待ち」と「固定の待ち時間」に解いた形。既定値は適用済み。
*/
export interface ResolvedWait {
  readonly type: WaitStrategy['type']
  /**
  selectorState のときだけ持つ
  */
  readonly selectorWait?: {
    readonly selector: string
    readonly state: NonNullable<Extract<WaitStrategy, { type: 'selectorState' }>['state']>
    readonly timeout: number
  }
  /**
  状態待ちの後に置く待ち時間（fixed の delay / selectorState の settleDelay）。0 なら待たない
  */
  readonly delay: number
}

/**
ターゲットの待ち戦略を解決する。target.waitStrategy → defaultStrategy → fixed（既定 delay）の
順で選び、省略値に既定値を入れる。現行方式（ターゲットごと）と 1 パス方式（まとめて 1 回）が
同じ解決結果を使う。
*/
export function resolveWait(
  target: Readonly<PrerenderTarget>,
  defaultStrategy: Readonly<WaitStrategy> | undefined,
): ResolvedWait {
  const strategy = target.waitStrategy ?? defaultStrategy ?? { type: 'fixed', delay: DEFAULT_FIXED_DELAY_MS }
  if (strategy.type === 'selectorState') {
    return {
      type: strategy.type,
      selectorWait: {
        selector: strategy.selector,
        state: strategy.state ?? 'detached',
        timeout: strategy.timeout ?? DEFAULT_SELECTOR_TIMEOUT_MS,
      },
      delay: strategy.settleDelay ?? 0,
    }
  }
  return { type: strategy.type, delay: strategy.delay ?? DEFAULT_FIXED_DELAY_MS }
}

export const prerenderConfig: PrerenderConfig = {
  targets: [
    {
      selector: '.terminal-window',
      // consumer は 2 つある。
      // LCodeBlock では、fetch + Shiki highlight が完了すると loading ref が false になる。
      // その時点で .loading-overlay が除去される。これはコンポーネント側の契約。
      // LAnnotatedTerminal は、frontmatter 直渡しで待つ対象が無く .loading-overlay を持たない。
      // そのため detached 待ちは、要素不在としてただちに解決する。
      waitStrategy: {
        type: 'selectorState',
        selector: '.loading-overlay',
        state: 'detached',
        timeout: 15_000,
      },
    },
    { selector: '.point-number' },
    {
      selector: '.diagram-bare',
      // iframe 内 MutationObserver が SVG 描画完了を検出すると、親に postMessage('drawio:rendered') を発火する。
      // その時点で .loading-overlay が除去される。これはコンポーネント側の契約。
      waitStrategy: {
        type: 'selectorState',
        selector: '.loading-overlay',
        state: 'detached',
        timeout: 15_000,
        settleDelay: 1000,
      },
    },
    { selector: '.section-badge' },
    { selector: '.donut-wrapper' },
    { selector: '.step-nav-bar' },
    { selector: '.topic-number' },
    { selector: '.gantt-prerender' },
    {
      selector: '.artifact-iframe',
      waitStrategy: { type: 'fixed', delay: 2000 },
    },
  ],
  defaultWaitStrategy: { type: 'fixed', delay: 500 },
  deviceScaleFactor: 5,
  pptxImageScale: 2,
}
