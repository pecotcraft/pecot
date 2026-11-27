// @vitest-environment jsdom
/* eslint-disable unicorn/name-replacements -- jsdom で変換し tmpdir へ書く */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultExportToPptxOptions, timeouts, type ExportToPptxOptions } from '../../../domain/slidev-to-pptx/config.js'
import { convertSlide, injectDomToPptx } from '../dom-converter.js'
import { FakePage } from './support/fake-playwright.js'
import { makeLogger } from './support/logger.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('injectDomToPptx', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('スクリプトを注入した後は、evaluate で定義の有無を 1 回だけ確認し、waitForFunction を使わない', async () => {
    await explains('dom-to-pptx のスクリプトをページへ注入する `injectDomToPptx` のテストです。注入の直後に `window.domToPptx` が定義されている場合に、`evaluate` を 1 回だけ呼び、`waitForFunction` は呼ばないことを確認します。')
    const page = new FakePage()
    page.scriptInjectionTriggers.push(() => {
      vi.stubGlobal('domToPptx', { exportToPptx: () => Promise.resolve() })
    })
    const waitForFunction = vi.spyOn(page, 'waitForFunction')
    await injectDomToPptx(page.asPage(), '/path/to/dom-to-pptx.bundle.js')
    expect(page.scriptTagCalls).toStrictEqual([{ path: '/path/to/dom-to-pptx.bundle.js' }])
    expect(page.evaluateCalls).toHaveLength(1)
    expect(waitForFunction).not.toHaveBeenCalled()
  })

  it('注入後に window.domToPptx が存在しない場合は、待機せずに例外を発生させる', async () => {
    await explains('スクリプトを注入しても `window.domToPptx` が定義されない場合のテストです。待機せずに、定義されていないことを示すメッセージの例外が発生し、`evaluate` が 1 回だけ呼ばれることを確認します。')
    const page = new FakePage()
    await expect(injectDomToPptx(page.asPage(), '/lib.js')).rejects.toThrow(
      'dom-to-pptx was injected but window.domToPptx is not defined (an exception in the script, or it was registered through AMD define)',
    )
    expect(page.evaluateCalls).toHaveLength(1)
  })

  it('ページが応答しない場合は、timeouts.domToPptxInject で処理を打ち切る', async () => {
    await explains('ページが応答しない場合の、注入処理のタイムアウトのテストです。上限の時間（`timeouts.domToPptxInject`）の 1 ミリ秒前までは失敗せず、上限に達した時点で 30 秒を超えた旨の例外が発生し、タイマーが残らないことを確認します。')
    vi.useFakeTimers()
    const page = new FakePage()
    page.evaluate = async () => new Promise<never>(() => { /* 返らない */ })
    const rejected = vi.fn()
    const injected = (async () => {
      try {
        await injectDomToPptx(page.asPage(), '/lib.js')
      }
      catch (error: unknown) {
        rejected(error)
      }
    })()
    await vi.advanceTimersByTimeAsync(timeouts.domToPptxInject - 1)
    expect(rejected).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await injected
    expect(rejected).toHaveBeenCalledWith(new Error('dom-to-pptx injection did not finish within 30 s'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('注入が成功した場合と失敗した場合のどちらでも、タイムアウト用のタイマーを残さない', async () => {
    await explains('注入処理が終わった後のタイマーのテストです。注入に失敗した場合と成功した場合のどちらでも、保留中のタイマーが 0 件になることを確認します。')
    vi.useFakeTimers()
    const page = new FakePage()
    await expect(injectDomToPptx(page.asPage(), '/lib.js')).rejects.toThrow('window.domToPptx is not defined')
    expect(vi.getTimerCount()).toBe(0)
    page.scriptInjectionTriggers.push(() => {
      vi.stubGlobal('domToPptx', { exportToPptx: () => Promise.resolve() })
    })
    await injectDomToPptx(page.asPage(), '/lib.js')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('convertSlide', () => {
  let outDir: string

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'pecotv-convertSlide-'))
  })

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    document.body.replaceChildren()
    // window.domToPptx を整える
    vi.stubGlobal('domToPptx', {
      exportToPptx: async (): Promise<Blob> => {
        const buf = new Uint8Array([1, 2, 3, 4])
        return new Blob([buf], { type: 'application/octet-stream' })
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('letter-spacing を持つテキストと http のリンクを収集し、PPTX ファイルを書き出す', async () => {
    await explains('スライドを PPTX に変換する `convertSlide` のテストです。`letter-spacing` を持つ文字列と `https` のリンクを収集して結果に含め、`#` から始まるリンクは除外して、PPTX ファイルを書き出すことを確認します。')
    document.body.innerHTML = `
      <div class="slidev-page" style="display:block">
        <p style="letter-spacing: 1.4px; font-size: 14px;">spaced text</p>
        <a href="https://example.com">EXAMPLE</a>
        <a href="#anchor">SKIP</a>
      </div>
    `
    const page = new FakePage()
    const logger = makeLogger()
    const result = await convertSlide(page.asPage(), 100, 'slide-', outDir, logger, defaultExportToPptxOptions)
    expect(result.pptxPath).toBe(path.join(outDir, 'slide-100.pptx'))
    const written = await readFile(result.pptxPath)
    expect(written.length).toBeGreaterThan(0)
    expect(result.letterSpacingMap['spaced text']).toEqual({ letterSpacing: '1.4px', fontSize: '14px' })
    expect(result.hrefMap['EXAMPLE']).toBe('https://example.com')
    expect(result.hrefMap['SKIP']).toBeUndefined()
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('letter-spacing'))
    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining('href-map'))
  })

  it('targetSelector を指定した場合は、最初の可視スライドではなく指定した要素を変換する', async () => {
    await explains('変換対象のスライドを `targetSelector` で指定する場合のテストです。最初のスライドではなく指定した要素が `exportToPptx` に渡され、`hrefMap` にも指定した要素のリンクだけが入ることを確認します。')
    document.body.innerHTML = `
      <div class="print-slide-container" id="001-01"><div class="slidev-page" id="first" style="display:block"><a href="https://first.example">FIRST</a></div></div>
      <div class="print-slide-container" id="002-01"><div class="slidev-page" id="second" style="display:block"><a href="https://second.example">SECOND</a></div></div>
    `
    const exportedIds: string[] = []
    vi.stubGlobal('domToPptx', {
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- DOM 要素の test 内 stub
      exportToPptx: async (element: Readonly<Element>): Promise<Blob> => {
        exportedIds.push(element.id)
        return new Blob([new Uint8Array([1])])
      },
    })
    const result = await convertSlide(new FakePage().asPage(), 201, 'slide-', outDir, makeLogger(), defaultExportToPptxOptions, {
      targetSelector: '[id="002-01"] .slidev-page',
    })
    expect(exportedIds).toStrictEqual(['second'])
    expect(result.hrefMap).toStrictEqual({ SECOND: 'https://second.example' })
  })

  it('targetSelector に一致する要素が存在しない場合は、セレクタを含むエラーで失敗する', async () => {
    await explains('`targetSelector` に一致する要素が存在しない場合のテストです。セレクタを含むメッセージの例外が発生することを確認します。')
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span></span></div>'
    await expect(convertSlide(new FakePage().asPage(), 301, 'slide-', outDir, makeLogger(), defaultExportToPptxOptions, {
      targetSelector: '[id="003-01"] .slidev-page',
    })).rejects.toThrow('slide #301: target slide not found: [id="003-01"] .slidev-page')
  })

  it('exportOptions に fileName と skipDownload を加えて、exportToPptx へ渡す', async () => {
    await explains('`convertSlide` に渡した出力オプション（`exportOptions`）の扱いのテストです。疑似要素やフォント埋め込みの設定に、`fileName` と `skipDownload: true` を加えた内容が `exportToPptx` に 1 回渡されることを確認します。')
    // 疑似要素・フォント埋め込みの設定は page.evaluate の引数に載せて渡す。ここが落ちると
    // envHash だけが変わって出力は変わらない (= キャッシュ全ミスなのに結果が同じ) 状態になる。
    const received: Record<string, unknown>[] = []
    vi.stubGlobal('domToPptx', {
      // 第 1 引数の Element は mutable 型のため readonly 化できない。受け取るのは第 2 引数だけ。
      exportToPptx: async (...args: readonly unknown[]): Promise<Blob> => {
        received.push(args[1] as Record<string, unknown>)
        return new Blob([new Uint8Array([1])], { type: 'application/octet-stream' })
      },
    })
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span>x</span></div>'
    const page = new FakePage()
    const exportOptions = {
      includePseudoElements: false,
      autoEmbedFonts: false,
      fonts: [{ name: 'Display Sans', weight: 400, url: 'https://example.invalid/display.woff2' }],
    } as const

    await convertSlide(page.asPage(), 500, 'slide-', outDir, makeLogger(), exportOptions)

    expect(received).toHaveLength(1)
    expect(received[0]).toStrictEqual({
      ...exportOptions,
      fileName: 'slide-500.pptx',
      skipDownload: true,
    })
  })

  it('exportOptions に skipDownload: false が含まれていても、skipDownload は true になる', async () => {
    await explains('出力オプションに `skipDownload: false` と別の `fileName` が含まれている場合のテストです。`exportToPptx` には `skipDownload: true` と、変換結果に合わせた `fileName` が渡されることを確認します。')
    // ExportToPptxOptions 型の変数経由では、excess property check が働かない。
    // そのため spread が後ろにあると、ページ側でダウンロードが始まる。
    // 後勝ちを固定する。
    const received: Record<string, unknown>[] = []
    vi.stubGlobal('domToPptx', {
      // 第 1 引数の Element は mutable 型のため readonly 化できない。受け取るのは第 2 引数だけ。
      exportToPptx: async (...args: readonly unknown[]): Promise<Blob> => {
        received.push(args[1] as Record<string, unknown>)
        return new Blob([new Uint8Array([1])], { type: 'application/octet-stream' })
      },
    })
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span>x</span></div>'
    const page = new FakePage()
    const contaminated = {
      ...defaultExportToPptxOptions,
      fileName: 'contaminated.pptx',
      skipDownload: false,
    } as ExportToPptxOptions

    await convertSlide(page.asPage(), 7, 'slide-', outDir, makeLogger(), contaminated)

    expect(received[0]?.['skipDownload']).toBe(true)
    expect(received[0]?.['fileName']).toBe('slide-7.pptx')
  })

  it('letter-spacing の項目が 5 件を超える場合は、詳細を debug ログに出力する', async () => {
    await explains('`letter-spacing` を持つ要素が 7 件ある場合のテストです。`letter-spacing details` を含むメッセージが `debug` ログに出力されることを確認します。')
    const items = Array.from({ length: 7 }, (_, i) => `<p style="letter-spacing: 1.0px;" id="t${i.toString()}">t${i.toString()}</p>`).join('')
    document.body.innerHTML = `<div class="slidev-page" style="display:block">${items}</div>`
    const page = new FakePage()
    const logger = makeLogger()
    const result = await convertSlide(page.asPage(), 200, 'slide-', outDir, logger, defaultExportToPptxOptions)
    expect(Object.keys(result.letterSpacingMap).length).toBeGreaterThanOrEqual(5)
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('letter-spacing details'))
  })

  // #1070: 明示指定のアニメーションだけを通し、装飾は pptx 後処理で p:timing ごと落とす。
  //
  // 判定は、上流 dom-to-pptx の `parseAnimation` を写したもの。
  // 参照元は node_modules/dom-to-pptx/src/animations/css-parser.js。
  // 名前解決の優先順位のうち 1・2・4 を写し、3 だけを外している。
  // 3 は、computed `animation-name` を使う手順で、装飾 CSS animation が混入する原因になる。
  // 手順は次のとおり。
  // 1 つ目は、data-pptx-animation、data-pptx-animation-type の順で、最初の非空値を取る。
  // 2 つ目は、1 が空なら --pptx-animation-name、--pptx-animation の順で、最初の非空値を取る。
  // 3 つ目は、得た名前が空でも none でもなければ、明示ありとする。
  // 4 つ目は、名前が空か none なら、classList を既知名と比べ、一致すれば明示ありとする。
  // 既知名は ENTRANCE_NAMES 17 件と EXIT_NAMES 16 件。
  // 4 があるため、名前クラス単独（`class="fade-in"`）も明示指定として通る。
  it.each([
    [
      'data-pptx-animation 属性',
      '<div data-pptx-animation="zoom-in">x</div>',
      true,
    ],
    [
      'data-pptx-animation-type 属性',
      '<div data-pptx-animation-type="fly-in">x</div>',
      true,
    ],
    [
      'カスタムプロパティ --pptx-animation-name',
      '<div style="--pptx-animation-name: fade-in">x</div>',
      true,
    ],
    [
      'カスタムプロパティ --pptx-animation',
      '<div style="--pptx-animation: fade-in 600ms">x</div>',
      true,
    ],
    [
      '属性が none（ライブラリ側も未指定として扱う）',
      '<div data-pptx-animation="None">x</div>',
      false,
    ],
    [
      '属性が空文字',
      '<div data-pptx-animation="   ">x</div>',
      false,
    ],
    [
      'カスタムプロパティが none',
      '<div style="--pptx-animation-name: none">x</div>',
      false,
    ],
    [
      '名前クラス単独（上流 ENTRANCE_NAMES に載る名前）',
      '<div class="fade-in">x</div>',
      true,
    ],
    [
      '名前クラス単独（上流 EXIT_NAMES に載る名前）',
      '<div class="fly-out-left">x</div>',
      true,
    ],
    [
      '既知名に無いクラス単独（テーマの装飾クラスはここに該当する）',
      '<div class="section-accent-line">x</div>',
      false,
    ],
    [
      'animate-trigger-with 単独（尺・発火順のユーティリティは単独マーカーにしない）',
      '<div class="animate-trigger-with">x</div>',
      false,
    ],
    [
      // 描画されない要素でも走査対象。明示ありへ倒れるだけで、誤って除去する側には振れない。
      'display:none の要素に付いたマーカー',
      '<div style="display:none" data-pptx-animation="zoom-in">x</div>',
      true,
    ],
    [
      'マーカー無し',
      '<div>x</div>',
      false,
    ],
  ])('$0 の場合は、明示的なアニメーション指定の有無が $2 になる', async (_name, markup, expected) => {
    await explains(`\`slidev-page\` に「${_name}」の要素がある場合のテストです。\`convertSlide\` の結果の \`hasExplicitAnimation\` が \`${expected.toString()}\` になることを確認します。`)
    document.body.innerHTML = `<div class="slidev-page" style="display:block">${markup}</div>`
    const page = new FakePage()
    const result = await convertSlide(page.asPage(), 600, 'slide-', outDir, makeLogger(), defaultExportToPptxOptions)
    expect(result.hasExplicitAnimation).toBe(expected)
  })

  it('スライドのルート要素自身にアニメーションの指定がある場合も、明示指定として検出する', async () => {
    await explains('アニメーションの指定（`data-pptx-animation`）をスライドのルート要素自身に付けた場合のテストです。子要素に指定がなくても、`hasExplicitAnimation` が `true` になることを確認します。')
    // 走査対象はスライド自身 + 子孫。マーカーを子要素にしか置かないケースだけでは
    // 走査の先頭（スライド自身）を落とす退行を捕らえられない。
    document.body.innerHTML = '<div class="slidev-page" style="display:block" data-pptx-animation="zoom-in"><span>x</span></div>'
    const page = new FakePage()
    const result = await convertSlide(page.asPage(), 602, 'slide-', outDir, makeLogger(), defaultExportToPptxOptions)
    expect(result.hasExplicitAnimation).toBe(true)
  })

  it('スライドの外側の要素にカスタムプロパティを指定した場合も、継承して明示指定として検出する', async () => {
    await explains('スライドの外側の祖先要素に `--pptx-animation-name` を指定した場合のテストです。カスタムプロパティが継承されるため、`hasExplicitAnimation` が `true` になることを確認します。')
    // カスタムプロパティは継承するため、スライドの外側で宣言しても getComputedStyle から
    // 読める。上流 dom-to-pptx も同じ値を見て効果を付けるので、明示ありは意図した結果。
    document.body.innerHTML = `
      <div style="--pptx-animation-name: fade-in">
        <div class="slidev-page" style="display:block"><span>x</span></div>
      </div>
    `
    const page = new FakePage()
    const result = await convertSlide(page.asPage(), 603, 'slide-', outDir, makeLogger(), defaultExportToPptxOptions)
    expect(result.hasExplicitAnimation).toBe(true)
  })

  it('アニメーションの明示指定と装飾が混在するスライドは、明示指定ありと判定する', async () => {
    await explains('明示的なアニメーションの指定と、装飾用のクラスだけの要素が同じスライドにある場合のテストです。`hasExplicitAnimation` が `true` になることを確認します。')
    // 粒度はスライド単位。混在時は p:timing をまるごと残すため、装飾分の効果も残る。
    document.body.innerHTML = `
      <div class="slidev-page" style="display:block">
        <div class="section-accent-line">装飾のみ</div>
        <div data-pptx-animation="fly-in">明示</div>
      </div>
    `
    const page = new FakePage()
    const result = await convertSlide(page.asPage(), 601, 'slide-', outDir, makeLogger(), defaultExportToPptxOptions)
    expect(result.hasExplicitAnimation).toBe(true)
  })

  it('表示中のスライドが存在しない場合は、例外が発生する', async () => {
    await explains('すべてのスライドが `display:none` の場合のテストです。`no visible slide found` を含むメッセージの例外が発生することを確認します。')
    document.body.innerHTML = '<div class="slidev-page" style="display:none"><span></span></div>'
    const page = new FakePage()
    await expect(convertSlide(page.asPage(), 1, 'slide-', outDir, makeLogger(), defaultExportToPptxOptions))
      .rejects.toThrow('no visible slide found')
  })

  it('リンクが存在しない場合は、hrefMap が空になり、href-map のログを出力しない', async () => {
    await explains('リンクを含まないスライドを変換する場合のテストです。`hrefMap` が空になり、`href-map:` を含む `verbose` ログが出力されないことを確認します。')
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span>no link</span></div>'
    const page = new FakePage()
    const logger = makeLogger()
    const result = await convertSlide(page.asPage(), 300, 'slide-', outDir, logger, defaultExportToPptxOptions)
    expect(Object.keys(result.hrefMap)).toHaveLength(0)
    const verboseMessages = logger.verbose.mock.calls.map(c => c[0] as string)
    expect(verboseMessages.some(m => m.includes('href-map:'))).toBe(false)
  })

  it('リンクと letter-spacing のどちらも存在しない場合は、2 つのマップが空になる', async () => {
    await explains('リンクと `letter-spacing` のどちらも含まないスライドを変換する場合のテストです。`letterSpacingMap` と `hrefMap` の両方が空になることを確認します。')
    document.body.innerHTML = '<div class="slidev-page" style="display:block"><span>plain</span></div>'
    const page = new FakePage()
    const logger = makeLogger()
    const result = await convertSlide(page.asPage(), 400, 'slide-', outDir, logger, defaultExportToPptxOptions)
    expect(Object.keys(result.letterSpacingMap)).toHaveLength(0)
    expect(Object.keys(result.hrefMap)).toHaveLength(0)
  })
})
