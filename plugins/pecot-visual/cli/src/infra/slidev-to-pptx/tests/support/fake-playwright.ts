// test fixture のため、Playwright API surface 互換の any cast を限定的に許容する。
/* eslint-disable unicorn/name-replacements, security/detect-object-injection */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
/* eslint-disable @typescript-eslint/no-explicit-any */

// 軽量な Fake Playwright Page / Browser / ElementHandle 実装。
// infra/slidev-to-pptx/ の各関数が実際に呼び出す API のみを実装する。
//
// `evaluate(fn, arg)` は test 環境 (jsdom) の `document` / `window` を利用して
// fn(arg) を直接実行する。これにより browser-side JS をそのまま実行できる。

import type { Page, Browser, BrowserContext, ElementHandle } from 'playwright'

interface EvaluateCall {
  fn: ((...args: unknown[]) => unknown) | string
  arg?: unknown
}

interface ScreenshotCall {
  type?: 'png' | 'jpeg'
  clip?: { x: number, y: number, width: number, height: number }
}

export interface FakePageOptions {
  viewport?: { width: number, height: number } | null
  url?: string
  gotoRedirect?: (url: string) => string
}

/**
scanner / pipeline 用に、テストごとに変更したい URL 履歴を順次返す stub
*/
export class FakePage {
  public urlQueue: string[] = []
  public currentUrl: string
  public viewportSizeValue: { width: number, height: number } | null
  public closed = false
  public evaluateCalls: EvaluateCall[] = []
  public scriptTagCalls: { path: string }[] = []
  /**
  addInitScript に渡した関数と引数（実行はしない。goto より前に呼んだかは gotoCount（呼んだ時点の goto 回数）で見る）
  */
  public initScriptCalls: { script: unknown, arg?: unknown, gotoCount: number }[] = []
  public keyboardPresses: string[] = []
  public screenshotCalls: ScreenshotCall[] = []
  public screenshotResults: Buffer[] = []
  public waitForTimeoutCalls: number[] = []
  public waitForFunctionResolves: boolean[] = []
  public waitForFunctionThrows = false
  public waitForUrlResolves = true
  public locatorTargets = new Map<string, ElementHandle<SVGElement | HTMLElement>[]>()
  public gotoCalls: { url: string, options?: unknown }[] = []
  public scriptInjectionTriggers: (() => void)[] = []
  public keyboard = {
    press: async (key: string): Promise<void> => {
      this.keyboardPresses.push(key)
      // ArrowRight: 次の URL を queue から取り出す。queue が空なら URL を変えず、
      // 続く waitForURL を reject させて scan ループを終了させる。
      if (key === 'ArrowRight') {
        if (this.urlQueue.length > 0) {
          this.currentUrl = this.urlQueue.shift() ?? this.currentUrl
          this.waitForUrlResolves = true
        }
        else {
          this.waitForUrlResolves = false
        }
      }
      await Promise.resolve()
    },
  }

  /**
  goto 後に落ち着く URL を差し替える。Slidev の hash ルータは root への遷移を
  `#/1` へリダイレクトするため、その挙動を模擬して routerMode 判定を踏む。
  未指定なら goto した URL のまま（history ルータ相当）。
  */
  public gotoRedirect: (url: string) => string

  public constructor(options: FakePageOptions = {}) {
    this.currentUrl = options.url ?? 'http://localhost:3002/'
    this.viewportSizeValue = options.viewport ?? { width: 960, height: 540 }
    this.gotoRedirect = options.gotoRedirect ?? ((url: string) => url)
  }

  public url(): string {
    return this.currentUrl
  }

  public viewportSize(): { width: number, height: number } | null {
    return this.viewportSizeValue
  }

  public async setViewportSize(size: { width: number, height: number }): Promise<void> {
    this.viewportSizeValue = size
    await Promise.resolve()
  }

  public async goto(url: string, options?: unknown): Promise<void> {
    this.gotoCalls.push({ url, options })
    this.currentUrl = this.gotoRedirect(url)
    await Promise.resolve()
  }

  public async close(): Promise<void> {
    this.closed = true
    await Promise.resolve()
  }

  public async addInitScript(script: unknown, arg?: unknown): Promise<void> {
    this.initScriptCalls.push({ script, arg, gotoCount: this.gotoCalls.length })
    await Promise.resolve()
  }

  public async addScriptTag(options: { path: string }): Promise<void> {
    this.scriptTagCalls.push(options)
    for (const trigger of this.scriptInjectionTriggers) trigger()
    await Promise.resolve()
  }

  public async evaluate<R>(
    fn: ((...args: any[]) => R | Promise<R>) | string,
    arg?: unknown,
  ): Promise<R> {
    this.evaluateCalls.push({ fn, arg })
    if (typeof fn === 'string') {
      // string evaluate: scanner.ts の `(${slidevReadyFunctionSource})()` のように既に IIFE 済の式が来る。
      // 単に式を eval して結果を返す。テスト側で document を整えておけば動作。
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const f = new Function(`return (${fn})`) as () => R | Promise<R>
      return await f()
    }
    return await fn(arg)
  }

  public async waitForFunction<R>(
    fn: ((...args: any[]) => R | Promise<R>) | string,
    arg?: unknown,
    _options?: unknown,
  ): Promise<R> {
    if (this.waitForFunctionThrows) {
      throw new Error('waitForFunction timed out (fake)')
    }
    if (this.waitForFunctionResolves.length > 0) {
      const resolved = this.waitForFunctionResolves.shift()
      if (!resolved) throw new Error('waitForFunction timed out (fake, queued)')
    }
    return await this.evaluate(fn as never, arg)
  }

  public async waitForURL(
    predicate: ((url: URL) => boolean) | string,
    _options?: unknown,
  ): Promise<void> {
    if (!this.waitForUrlResolves) {
      throw new Error('waitForURL timed out (fake)')
    }
    if (typeof predicate === 'function') {
      predicate(new URL(this.currentUrl))
    }
    await Promise.resolve()
  }

  public async waitForTimeout(ms: number): Promise<void> {
    this.waitForTimeoutCalls.push(ms)
    await Promise.resolve()
  }

  public async screenshot(opts: ScreenshotCall = {}): Promise<Buffer> {
    this.screenshotCalls.push(opts)
    return this.screenshotResults.shift() ?? Buffer.from('fake-png')
  }

  public locator(selector: string): {
    nth: (index: number) => {
      elementHandle: () => Promise<ElementHandle<SVGElement | HTMLElement>>
    }
  } {
    const handles = this.locatorTargets.get(selector) ?? []
    return {
      nth: (index: number) => ({
        // playwright 1.62 の elementHandle() は非 null を返す。未出現時の挙動は throw。
        // 未登録 index に対しては、空 handle を返す（対象なしの扱い）。
        elementHandle: async () =>
          Promise.resolve(handles[index] ?? new FakeElementHandle({ $$Targets: [] }).asElementHandle()),
      }),
    }
  }

  /**
  Playwright Page interface 用キャスト
  */
  public asPage(): Page {
    return this as unknown as Page
  }
}

export interface FakeElementHandleOptions {
  boundingBoxes?: ({ x: number, y: number, width: number, height: number } | null)[]
  evaluateResults?: unknown[]
  screenshotResults?: Buffer[]
  $$Targets?: ElementHandle<SVGElement | HTMLElement>[]
  /**
  selector ごとに `$$` の戻りを変える。未登録の selector は `$$Targets` を返す
  */
  $$TargetsBySelector?: Map<string, ElementHandle<SVGElement | HTMLElement>[]>
}

export class FakeElementHandle {
  public boundingBoxQueue: ({ x: number, y: number, width: number, height: number } | null)[]
  public evaluateResults: unknown[]
  public screenshotResults: Buffer[]
  public $$Targets: ElementHandle<SVGElement | HTMLElement>[]
  public $$TargetsBySelector: Map<string, ElementHandle<SVGElement | HTMLElement>[]>
  public evaluateCalls: { fn: unknown, arg: unknown }[] = []
  public disposed = false

  public constructor(options: FakeElementHandleOptions = {}) {
    this.boundingBoxQueue = [...(options.boundingBoxes ?? [{ x: 10, y: 10, width: 100, height: 50 }])]
    this.evaluateResults = [...(options.evaluateResults ?? [])]
    this.screenshotResults = [...(options.screenshotResults ?? [Buffer.from('fake-element')])]
    this.$$Targets = options.$$Targets ?? []
    this.$$TargetsBySelector = options.$$TargetsBySelector ?? new Map()
  }

  public async boundingBox(): Promise<{ x: number, y: number, width: number, height: number } | null> {
    return this.boundingBoxQueue.length === 0 ? { x: 10, y: 10, width: 100, height: 50 } : this.boundingBoxQueue.shift() ?? null
  }

  public async $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]> {
    return Promise.resolve(this.$$TargetsBySelector.get(selector) ?? this.$$Targets)
  }

  public async evaluate<R>(fn: (el: HTMLElement, arg?: unknown) => R, arg?: unknown): Promise<R> {
    this.evaluateCalls.push({ fn, arg })
    if (this.evaluateResults.length > 0) {
      return this.evaluateResults.shift() as R
    }
    // 引数なし version はそのまま実行 (jsdom 環境想定)
    const fakeElement = (globalThis as unknown as { document?: Document }).document?.createElement('div') ?? ({} as HTMLElement)
    return fn(fakeElement, arg)
  }

  public async screenshot(_opts: ScreenshotCall = {}): Promise<Buffer> {
    return this.screenshotResults.shift() ?? Buffer.from('fake-element-png')
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    await Promise.resolve()
  }

  public asElementHandle(): ElementHandle<SVGElement | HTMLElement> {
    return this as unknown as ElementHandle<SVGElement | HTMLElement>
  }
}

/**
`captureAndReplaceElements` の DOM 置換 evaluate だけを jsdom 上の実要素に適用させる。
FakeElementHandle.evaluate の既定は、detached な `document.createElement('div')` を渡す。
そのため insertAdjacentElement の結果を見たいテストは、これを噛ませる。
`dataUrl` を持たない呼び出し（祖先 transform の退避など）は、既定の evaluate に委ねる。
*/
export function applyDomReplacementOn(handle: FakeElementHandle, elementOnPage: Element): void {
  const fallback = handle.evaluate.bind(handle)
  handle.evaluate = async <R>(fn: (el: HTMLElement, arg?: unknown) => R, arg?: unknown): Promise<R> => {
    return arg && typeof arg === 'object' && 'dataUrl' in arg ? fn(elementOnPage as HTMLElement, arg) : fallback<R>(fn, arg)
  }
}

/**
`context.route` の handler に渡す route の fake。abort / continue の呼び出しを記録する
*/
export class FakeRoute {
  public aborted = false
  public continued = false

  public async abort(): Promise<void> {
    this.aborted = true
    await Promise.resolve()
  }

  public async continue(): Promise<void> {
    this.continued = true
    await Promise.resolve()
  }
}

/**
`browser.newContext()` の戻り値の fake。ページは生成元 FakeBrowser の pageQueue から順に取り出す
（browser.newPage と同じ列を共有するため、テストはページを開く順に積めばよい）。
*/
export class FakeBrowserContext {
  public routes: { url: string, handler: (route: FakeRoute) => unknown }[] = []
  public pages: FakePage[] = []
  public closed = false

  public constructor(private readonly browser: FakeBrowser, public readonly options: unknown) {}

  public async newPage(): Promise<Page> {
    const page = this.browser.takePage()
    this.pages.push(page)
    return page.asPage()
  }

  public async route(url: string, handler: (route: FakeRoute) => unknown): Promise<void> {
    this.routes.push({ url, handler })
    await Promise.resolve()
  }

  /**
  登録済みの handler のうち url が一致するものに route を渡す（glob は末尾 `**` だけ扱う）
  */
  public async dispatch(url: string): Promise<FakeRoute> {
    const route = new FakeRoute()
    const entry = this.routes.find(({ url: pattern }) => pattern.endsWith('**') ? url.startsWith(pattern.slice(0, -2)) : url === pattern)
    if (entry !== undefined) await entry.handler(route)
    return route
  }

  public async close(): Promise<void> {
    this.closed = true
    for (const page of this.pages) page.closed = true
    await Promise.resolve()
  }

  public asBrowserContext(): BrowserContext {
    return this as unknown as BrowserContext
  }
}

export interface FakeBrowserOptions {
  pages?: FakePage[]
  /**
  browser.version() の戻り値。pipeline がキャッシュキーの材料に使う
  */
  version?: string
}

export class FakeBrowser {
  public pageQueue: FakePage[]
  public closed = false
  public newPageCalls: unknown[] = []
  /**
  browser.newPage と context.newPage の両方で開いたページ（開いた順）
  */
  public createdPages: FakePage[] = []
  public newContextCalls: unknown[] = []
  public contexts: FakeBrowserContext[] = []
  public versionValue: string

  public constructor(options: FakeBrowserOptions = {}) {
    this.pageQueue = [...(options.pages ?? [])]
    this.versionValue = options.version ?? '141.0.7390.37'
  }

  public version(): string {
    return this.versionValue
  }

  public async newPage(opts?: unknown): Promise<Page> {
    this.newPageCalls.push(opts)
    return this.takePage().asPage()
  }

  /**
  pageQueue の先頭（空なら新しい FakePage）を取り出して createdPages に記録する
  */
  public takePage(): FakePage {
    const next = this.pageQueue.shift() ?? new FakePage()
    this.createdPages.push(next)
    return next
  }

  public async newContext(opts?: unknown): Promise<BrowserContext> {
    this.newContextCalls.push(opts)
    const context = new FakeBrowserContext(this, opts)
    this.contexts.push(context)
    await Promise.resolve()
    return context.asBrowserContext()
  }

  public async close(): Promise<void> {
    this.closed = true
    await Promise.resolve()
  }

  public asBrowser(): Browser {
    return this as unknown as Browser
  }
}
