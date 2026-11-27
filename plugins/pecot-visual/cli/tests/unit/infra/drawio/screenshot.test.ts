// capturePng（viewer で描いて撮る方式）と exportViaEmbed（embed API を使う方式）を pin する単体テスト。
// 実 Playwright 起動は重いため、playwright launch を mock して呼び出しの形と順序のみ検証する。
// PNG smoke は PECOTV_PLAYWRIGHT_AVAILABLE ガード付きで tests/integration 側に置く。

/* eslint-disable security/detect-non-literal-fs-filename -- 自リポ test fixture / 既知 tmp パス */
import { existsSync, readFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { rejectionOf } from '../../../_helpers/rejection.js'
import { explains } from '../../../_helpers/explains.js'

const SCREENSHOT_SRC = path.resolve(
  import.meta.dirname,
  '..', '..', '..', '..', 'src', 'infra', 'drawio', 'screenshot.ts',
)

// 起動した headless Chromium が CDP の Browser.getVersion で名乗る User-Agent の例
const HEADLESS_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.7339.16 Safari/537.36'

// Playwright page の最小 mock。
// 実装では、handshake を install する evaluate の後に export 応答が届く。
// そのため __pecotvOnExport の解決も evaluate 時点で行う。
// setContent 時点で解決すると、実装と逆順のまま通るテストになる。
function mockPlaywright(dataUri?: string) {
  const exposeFunction = vi.fn<(name: string, function_: (data: string) => void) => Promise<void>>(
    () => Promise.resolve(),
  )
  const setContent = vi.fn<(html: string) => Promise<void>>(() => Promise.resolve())
  const evaluate = vi.fn<(function_: unknown, argument: unknown) => Promise<void>>(() => {
    // dataUri が undefined のときは export 応答が届かない（embed が応答しない）状況を作る。
    if (dataUri !== undefined) {
      const exposed = exposeFunction.mock.calls.find(([name]) => name === '__pecotvOnExport')
      exposed?.[1](dataUri)
    }
    return Promise.resolve()
  })
  const newPage = vi.fn(() => Promise.resolve({
    setViewportSize: vi.fn(() => Promise.resolve()),
    exposeFunction,
    setContent,
    evaluate,
  }))
  const detach = vi.fn(() => Promise.resolve())
  const newBrowserCDPSession = vi.fn(() => Promise.resolve({
    send: vi.fn(() => Promise.resolve({ userAgent: HEADLESS_UA })),
    detach,
  }))
  const launch = vi.fn(() => Promise.resolve({ newPage, newBrowserCDPSession, close: vi.fn(() => Promise.resolve()) }))
  return { launch, evaluate, newPage, detach, exposeFunction, setContent }
}

// 返らない Promise
function hang(): Promise<void> {
  return new Promise<void>(() => { /* 返らない */ })
}

// setContent / evaluate が返らないまま時間切れになる状況。dataUriPromise に handler が無いと、
// 時間切れの reject が unhandled rejection になりプロセスが落ちる (F-09)。
function mockHangingStage(stage: 'setContent' | 'evaluate') {
  const base = mockPlaywright()
  const newPage = vi.fn(() => Promise.resolve({
    setViewportSize: vi.fn(() => Promise.resolve()),
    exposeFunction: base.exposeFunction,
    setContent: stage === 'setContent' ? hang : base.setContent,
    evaluate: stage === 'evaluate' ? hang : base.evaluate,
  }))
  const launch = vi.fn(() => Promise.resolve({
    newPage,
    newBrowserCDPSession: vi.fn(() => Promise.resolve({
      send: vi.fn(() => Promise.resolve({ userAgent: HEADLESS_UA })),
      detach: vi.fn(() => Promise.resolve()),
    })),
    close: vi.fn(() => Promise.resolve()),
  }))
  return { launch }
}

// signature + IHDR(1x1) + IEND だけの最小 PNG
function tinyPng(): Buffer {
  const chunk = (type: string, data: Readonly<Buffer>): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([length, typed, crc])
  }
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))])
}

// capturePng を viewer の mock で通し、ページの HTML と preload の書体を返す
async function captureWithFonts(fonts: readonly string[]): Promise<{ readonly html: string, readonly preloaded: readonly string[] }> {
  let html = ''
  let preloaded: readonly string[] = []
  const setContent = vi.fn<(content: string) => Promise<void>>((content) => {
    html = content
    return Promise.resolve()
  })
  const evaluate = vi.fn<(function_: Readonly<{ name: string }>, argument?: unknown) => Promise<void>>((function_, argument) => {
    if (function_.name === 'preloadFonts') preloaded = z.array(z.string()).parse(argument)
    return Promise.resolve()
  })
  const diagram = { waitFor: vi.fn(() => Promise.resolve()), screenshot: vi.fn(() => Promise.resolve(tinyPng())) }
  const page = { setContent, evaluate, addScriptTag: vi.fn(() => Promise.resolve()), locator: vi.fn(() => ({ first: () => diagram })) }
  const launch = vi.fn(() => Promise.resolve({ newPage: vi.fn(() => Promise.resolve(page)), close: vi.fn(() => Promise.resolve()) }))
  vi.doMock('playwright', () => ({ chromium: { launch } }))
  const { capturePng } = await import('../../../../src/infra/drawio/screenshot.js')
  await capturePng('<mxfile/>', path.join(tmpdir(), `pecotv-screenshot-fonts-${String(process.pid)}.png`), fonts)
  return { html, preloaded }
}

describe('capturePng / exportViaEmbed', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('PECOTV_FORCE_PNG_FAIL に 1 を指定すると、Playwright を起動する前に失敗する', async () => {
    await explains('draw.io の図を PNG にする `capturePng` のテストです。`PECOTV_FORCE_PNG_FAIL=1` を指定した場合に、`forced XMLPNG failure` を含む例外が発生することを確認します。')
    vi.stubEnv('PECOTV_FORCE_PNG_FAIL', '1')
    const { capturePng } = await import('../../../../src/infra/drawio/screenshot.js')
    await expect(capturePng('<root/>', '/tmp/x.png', ['Test Sans'])).rejects.toThrow(
      /forced XMLPNG failure/,
    )
  })

  it('書き出しに失敗した場合は、出力ディレクトリを作成しない', async () => {
    await explains('draw.io の図を PNG にする `capturePng` のテストです。`PECOTV_FORCE_PNG_FAIL=1` を指定して失敗させた場合に、出力先のディレクトリが作成されないことを確認します。')
    vi.stubEnv('PECOTV_FORCE_PNG_FAIL', '1')
    const { capturePng } = await import('../../../../src/infra/drawio/screenshot.js')
    const outputDirectory = path.join(tmpdir(), `pecotv-capture-fail-${String(process.pid)}`)

    await expect(capturePng('<root/>', path.join(outputDirectory, 'x.png'), ['Test Sans'])).rejects.toThrow()

    expect(existsSync(outputDirectory)).toBe(false)
  })

  it('PECOTV_FORCE_SVG_FAIL に 1 を指定すると、SVG の書き出しだけを失敗させ、PNG の書き出しには影響しない', async () => {
    await explains('embed API で図を書き出す `exportViaEmbed` のテストです。`PECOTV_FORCE_SVG_FAIL=1` の場合に、`svg` 形式は `forced SVG failure` で失敗し、`xmlpng` 形式は影響を受けないことを確認します。')
    vi.stubEnv('PECOTV_FORCE_SVG_FAIL', '1')
    vi.doMock('playwright', () => ({
      chromium: { launch: () => Promise.reject(new Error('launch-attempted')) },
    }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')

    await expect(exportViaEmbed('<root/>', { format: 'svg' })).rejects.toThrow(
      /forced SVG failure/,
    )
    // PNG (xmlpng) 側は同じ env で止まらず、Playwright 起動まで進む
    await expect(exportViaEmbed('<root/>', { format: 'xmlpng' })).rejects.toThrow(
      /launch-attempted/,
    )
  })

  it('宣言とは別の書体を渡すと、その書体だけを読み込み、Inter と Noto Sans JP は読み込まない', async () => {
    await explains('draw.io の図を PNG にする `capturePng` のテストです。書体に `Caveat` を渡した場合に、ページの HTML が `Caveat` の 4 つの太さを読み込む指定を含み、`Inter` と `Noto` を含まないことを確認します。')
    const { html, preloaded } = await captureWithFonts(['Caveat'])
    expect(html).toContain('family=Caveat:wght@400;500;600;700')
    expect(html).not.toContain('Inter')
    expect(html).not.toContain('Noto')
    expect(preloaded).toEqual(['400 16px "Caveat"', '500 16px "Caveat"', '600 16px "Caveat"', '700 16px "Caveat"'])
  })

  it('書体が総称の `sans-serif` だけの場合は、@import を作らず、事前に読み込む書体も空にする', async () => {
    await explains('draw.io の図を PNG にする `capturePng` のテストです。書体に `sans-serif` だけを渡した場合に、ページの HTML が `@import` と `fonts.googleapis.com` を含まず、事前に読み込む書体が空になることを確認します。')
    const { html, preloaded } = await captureWithFonts(['sans-serif'])
    expect(html).not.toContain('@import')
    expect(html).not.toContain('fonts.googleapis.com')
    expect(preloaded).toEqual([])
  })

  it('書体名にアポストロフィがあっても、URL にはエンコードして出力し、@import の引用符を壊さない', async () => {
    await explains('draw.io の図を PNG にする `capturePng` のテストです。書体名に `O\'Neil` を渡した場合に、URL では `O%27Neil` にエンコードし、`@import` の引用符を壊さないことを確認します。')
    const { html } = await captureWithFonts(['O\'Neil'])
    expect(html).toContain('family=O%27Neil')
    expect(html).toContain('@import url(\'https://fonts.googleapis.com/css2?family=O%27Neil')
  })

  it('viewer で図を描き、渡した書体を読み込んでから撮影し、PNG に XML を埋め込む', async () => {
    await explains('draw.io の図を PNG にする `capturePng` のテストです。書体に `Test Sans` と `Test Sans JP` を渡した場合に、その 2 つだけを読み込み、出力した PNG に XML が `mxfile` として埋め込まれることを確認します。')
    const callOrder: string[] = []
    let html = ''
    const setContent = vi.fn<(content: string) => Promise<void>>((content) => {
      callOrder.push('setContent')
      html = content
      return Promise.resolve()
    })
    let preloaded: readonly string[] = []
    const evaluate = vi.fn<(function_: Readonly<{ name: string }>, argument?: unknown) => Promise<void>>((function_, argument) => {
      callOrder.push(`evaluate:${function_.name}`)
      if (function_.name === 'preloadFonts') preloaded = z.array(z.string()).parse(argument)
      return Promise.resolve()
    })
    const addScriptTag = vi.fn<(options: Readonly<{ url: string }>) => Promise<void>>(() => {
      callOrder.push('addScriptTag')
      return Promise.resolve()
    })
    const screenshot = vi.fn(() => {
      callOrder.push('screenshot')
      return Promise.resolve(tinyPng())
    })
    const diagram = { waitFor: vi.fn(() => Promise.resolve()), screenshot }
    const locator = vi.fn(() => ({ first: () => diagram }))
    const close = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const newPage = vi.fn(() => Promise.resolve({ setContent, evaluate, addScriptTag, locator }))
    const launch = vi.fn(() => Promise.resolve({ newPage, close }))
    vi.doMock('playwright', () => ({ chromium: { launch } }))

    const { capturePng } = await import('../../../../src/infra/drawio/screenshot.js')
    const outPath = path.join(tmpdir(), `pecotv-screenshot-viewer-${String(process.pid)}.png`)
    await capturePng('<mxfile/>', outPath, ['Test Sans', 'Test Sans JP'])

    // 渡した書体の Web フォントをページに読み込む
    expect(html).toContain('fonts.googleapis.com')
    expect(html).toContain('family=Test+Sans:wght@400;500;600;700&family=Test+Sans+JP:wght@400;500;600;700')
    expect(html).not.toContain('Inter')
    expect(html).not.toContain('Noto')
    // 描く前に読み込みを済ませる書体も、渡した 2 書体だけ
    expect(preloaded).toHaveLength(8)
    expect(preloaded.every(font => font.endsWith('"Test Sans"') || font.endsWith('"Test Sans JP"'))).toBe(true)
    expect(addScriptTag).toHaveBeenCalledWith({ url: 'https://viewer.diagrams.net/js/viewer-static.min.js' })
    // 書体の読み込み → viewer の設定 → viewer の読み込み → 描画 → 撮影 の順
    expect(callOrder).toEqual([
      'setContent', 'evaluate:preloadFonts', 'evaluate:mountViewerConfig', 'addScriptTag',
      'evaluate:processViewerElements', 'evaluate:waitFontsReady', 'screenshot',
    ])
    expect(close).toHaveBeenCalledTimes(1)

    // IHDR の直後に tEXt `mxfile` が入り、値は encodeURIComponent した XML、CRC が合う
    const written = readFileSync(outPath)
    const chunkStart = 8 + 25
    const length = written.readUInt32BE(chunkStart)
    const body = written.subarray(chunkStart + 4, chunkStart + 8 + length)
    expect(body.toString('latin1')).toBe(`tEXtmxfile\0${encodeURIComponent('<mxfile/>')}`)
    expect(written.readUInt32BE(chunkStart + 8 + length)).toBe(crc32(body))
  })

  it('ページを開くときは、User-Agent の HeadlessChrome だけを Chrome に置き換え、バージョンの数字は起動した Chromium のものを使う', async () => {
    await explains('embed API で図を書き出す `exportViaEmbed` のテストです。User-Agent が `HeadlessChrome/140.0.7339.16` の場合に、ページを `Chrome/140.0.7339.16` で開くことを確認します。')
    const { launch, newPage, detach } = mockPlaywright('data:image/png;base64,aGVsbG8=')

    vi.doMock('playwright', () => ({ chromium: { launch } }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')
    await exportViaEmbed('<root/>', { format: 'xmlpng' })

    expect(newPage).toHaveBeenCalledWith({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.16 Safari/537.36',
    })
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('形式に svg を指定すると、svg を書き出す指示を送り、デコードした SVG の文字列を返す', async () => {
    await explains('embed API で図を書き出す `exportViaEmbed` のテストです。`format: \'svg\'` を指定した場合に、ページに渡す指示の `format` が `svg` になり、受け取った data URI をデコードした `<svg/>` を返すことを確認します。')
    const { launch, evaluate } = mockPlaywright('data:image/svg+xml;base64,PHN2Zy8+')

    vi.doMock('playwright', () => ({ chromium: { launch } }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')
    const exported = await exportViaEmbed('<root/>', { format: 'svg' })

    // eslint-disable-next-line no-restricted-syntax -- mock 引数を読み取って object 形を pin する narrowing
    const payload = evaluate.mock.calls[0]?.[1] as Readonly<{ format: string }>
    expect(payload.format).toBe('svg')
    expect(exported.toString('utf8')).toBe('<svg/>')
  })

  it('iframe は src を付けずに載せ、embed の URL はイベントの待ち受けを設定した後で、ページの中で設定する', async () => {
    await explains('embed API で図を書き出す `exportViaEmbed` のテストです。ページの HTML が `src` のない `<iframe id="d">` を持ち、`embed.diagrams.net` を含まないことを確認します。')
    // embed.diagrams.net は init を再送しない。
    // setContent で iframe の src を付けて読み込みを始めると、listener を付ける page.evaluate が遅れた間に届いた init を取りこぼす。
    // その結果、60 秒待って時間切れになる。
    const { launch, evaluate, setContent } = mockPlaywright('data:image/svg+xml;base64,PHN2Zy8+')

    vi.doMock('playwright', () => ({ chromium: { launch } }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')
    await exportViaEmbed('<root/>', { format: 'svg' })

    const html = String(setContent.mock.calls[0]?.[0])
    expect(html).toContain('<iframe id="d"')
    expect(html).not.toContain('embed.diagrams.net')
    expect(html).not.toMatch(/<iframe[^>]*\ssrc=/)
    // eslint-disable-next-line no-restricted-syntax -- mock 引数を読み取って object 形を pin する narrowing
    const payload = evaluate.mock.calls[0]?.[1] as Readonly<{ embedUrl: string }>
    expect(payload.embedUrl).toBe('https://embed.diagrams.net/?embed=1&proto=json')
  })

  it('installEmbedHandshake は、message の待ち受けを設定してから、iframe の src を設定する', async () => {
    await explains('embed の通信を設定する `installEmbedHandshake` のテストです。ページの中で実行される関数を取り出して実行した場合に、先に `message` の待ち受けを設定し、その後で iframe の `src` に embed の URL を設定することを確認します。')
    const { launch, evaluate } = mockPlaywright('data:image/svg+xml;base64,PHN2Zy8+')

    vi.doMock('playwright', () => ({ chromium: { launch } }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')
    await exportViaEmbed('<root/>', { format: 'svg' })

    // page 内で実行される関数を取り出し、順序を記録するだけの globalThis で実行する。
    // eslint-disable-next-line no-restricted-syntax -- mock 引数を読み取って関数を取り出す narrowing
    const install = evaluate.mock.calls[0]?.[0] as (payload: unknown) => void
    const payload = evaluate.mock.calls[0]?.[1]
    const order: string[] = []
    const iframe = {
      contentWindow: { postMessage: vi.fn() },
      set src(value: string) {
        order.push(`src=${value}`)
      },
    }
    vi.stubGlobal('document', { querySelector: () => iframe })
    vi.stubGlobal('addEventListener', () => {
      order.push('listener')
    })
    try {
      install(payload)
    }
    finally {
      vi.unstubAllGlobals()
    }
    expect(order).toEqual(['listener', 'src=https://embed.diagrams.net/?embed=1&proto=json'])
  })

  describe('installEmbedHandshake の message 処理', () => {
    interface Harness {
      readonly deliver: (message: unknown, source?: unknown) => void
      readonly postMessage: ReturnType<typeof vi.fn>
      readonly target: object
      readonly onExport: ReturnType<typeof vi.fn>
      readonly cleanup: () => void
    }

    // page 内で実行される installEmbedHandshake を取り出し、listener を捕まえられる globalThis で実行する。
    async function installHandshake(onProgress: (event: string) => void): Promise<Harness> {
      const { launch, evaluate } = mockPlaywright('data:image/svg+xml;base64,PHN2Zy8+')
      vi.doMock('playwright', () => ({ chromium: { launch } }))
      const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')
      await exportViaEmbed('<root/>', { format: 'svg' })

      // eslint-disable-next-line no-restricted-syntax -- mock 引数を読み取って関数を取り出す narrowing
      const install = evaluate.mock.calls[0]?.[0] as (payload: unknown) => void
      const payload = evaluate.mock.calls[0]?.[1]
      const postMessage = vi.fn()
      const target = { postMessage }
      const onExport = vi.fn()
      let listener: ((event: unknown) => void) | undefined
      vi.stubGlobal('document', { querySelector: () => ({ contentWindow: target, src: '' }) })
      vi.stubGlobal('addEventListener', (_type: string, handler: (event: unknown) => void) => {
        listener = handler
      })
      vi.stubGlobal('__pecotvOnProgress', onProgress)
      vi.stubGlobal('__pecotvOnExport', onExport)
      install(payload)
      return {
        deliver: (message, source) => {
          listener?.({ data: JSON.stringify(message), source })
        },
        postMessage,
        target,
        onExport,
        cleanup: () => { vi.unstubAllGlobals() },
      }
    }

    it('進捗の通知が例外を発生させても、init には load を、load には export を送る', async () => {
      await explains('embed の通信を設定する `installEmbedHandshake` のテストです。進捗の通知が例外を発生させる場合に、`init` の後に `load`、`load` の後に `export` の指示を iframe へ送り、`export` の結果を受け取ることを確認します。')
      const harness = await installHandshake(() => {
        throw new Error('progress bridge down')
      })
      try {
        harness.deliver({ event: 'init' }, harness.target)
        harness.deliver({ event: 'load' }, harness.target)
        harness.deliver({ event: 'export', data: 'data:image/svg+xml;base64,PHN2Zy8+' }, harness.target)

        expect(harness.postMessage.mock.calls.map(([sent]) => String(sent))).toEqual([
          JSON.stringify({ action: 'load', xml: '<root/>' }),
          JSON.stringify({ action: 'export', format: 'svg', scale: 1, border: 0 }),
        ])
        expect(harness.onExport).toHaveBeenCalledWith('data:image/svg+xml;base64,PHN2Zy8+')
      }
      finally {
        harness.cleanup()
      }
    })

    it('embed の iframe 以外から届いた message には、応答しない', async () => {
      await explains('embed の通信を設定する `installEmbedHandshake` のテストです。iframe とは別の送信元から `init`・`load`・`export` や、送信元のない message が届いた場合に、何も送らず、`export` の結果の受け取りと進捗の通知も行わないことを確認します。')
      const progress = vi.fn()
      const harness = await installHandshake(progress)
      try {
        const stranger = { postMessage: vi.fn() }
        harness.deliver({ event: 'init' }, stranger)
        harness.deliver({ event: 'load' }, stranger)
        harness.deliver({ event: 'export', data: 'data:image/svg+xml;base64,PHN2Zy8+' }, stranger)
        harness.deliver({ event: 'init' })

        expect(harness.postMessage).not.toHaveBeenCalled()
        expect(harness.onExport).not.toHaveBeenCalled()
        expect(progress).not.toHaveBeenCalled()
      }
      finally {
        harness.cleanup()
      }
    })
  })

  describe('時間切れの診断', () => {
    it.each<'setContent' | 'evaluate'>(['setContent', 'evaluate'])(
      '%s が終わらないまま時間切れになっても、診断情報を含むエラーが呼び出し側に届き、未処理の拒否（unhandled rejection）にならない',
      async (stage) => {
        await explains('embed API で図を書き出す `exportViaEmbed` の時間切れのテストです。どちらが終わらなくても、`embed protocol timeout (60s)` と `last event: none` を含むエラーが届き、unhandled rejection は発生しません。')
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown): void => {
          unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)
        vi.useFakeTimers()
        try {
          const { launch } = mockHangingStage(stage)
          vi.doMock('playwright', () => ({ chromium: { launch } }))
          const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')

          const outcome = rejectionOf(exportViaEmbed('<root/>', { format: 'svg' }))
          await vi.advanceTimersByTimeAsync(60_000)
          const message = String(await outcome)

          expect(message).toMatch(/embed protocol timeout \(60s\)/)
          expect(message).toMatch(/last event: none/)
          // 未完了の段には単位の「s」を付けない
          expect(message).not.toMatch(/not dones/)
          expect(message).toContain(stage === 'setContent' ? 'setContent not done' : 'handshake not done')
          vi.useRealTimers()
          await new Promise<void>((resolve) => {
            setImmediate(resolve)
          })
          expect(unhandled).toEqual([])
        }
        finally {
          vi.useRealTimers()
          process.off('unhandledRejection', onUnhandled)
        }
      },
    )

    it('完了した段階には経過した秒数を、完了していない段階には「未完了」だけを書く', async () => {
      await explains('embed API で図を書き出す `exportViaEmbed` のテストです。`evaluate` が終わらないまま時間切れになった場合のエラーメッセージで、`setContent` は経過した秒数、`handshake` は `not done` だけが書かれることを確認します。')
      vi.useFakeTimers()
      try {
        const { launch } = mockHangingStage('evaluate')
        vi.doMock('playwright', () => ({ chromium: { launch } }))
        const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')

        const outcome = rejectionOf(exportViaEmbed('<root/>', { format: 'svg' }))
        await vi.advanceTimersByTimeAsync(60_000)
        expect(String(await outcome)).toMatch(/setContent done \d+\.\ds \/ handshake not done \//)
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('時間切れのエラーには、最後に受け取った embed のイベントと、各段階の経過を含める', async () => {
      await explains('embed API で図を書き出す `exportViaEmbed` のテストです。`init` と `load` の進捗を受け取った後で時間切れとなった場合は、エラーメッセージが `last event: load` を含むことを確認します。')
      vi.useFakeTimers()
      try {
        const { launch, exposeFunction } = mockPlaywright()
        vi.doMock('playwright', () => ({ chromium: { launch } }))
        const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')

        const pending = exportViaEmbed('<root/>', { format: 'svg' })
        const outcome = rejectionOf(pending)
        await vi.advanceTimersByTimeAsync(10)
        const progress = exposeFunction.mock.calls.find(([name]) => name === '__pecotvOnProgress')?.[1]
        progress?.('init')
        progress?.('load')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(String(await outcome)).toMatch(/embed protocol timeout \(60s\).*last event: load/s)
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('イベントを 1 つも受け取らなかった場合は、最後のイベントを none と書く', async () => {
      await explains('embed API で図を書き出す `exportViaEmbed` のテストです。進捗を 1 つも受け取らず時間切れとなった場合に、`init` が届かなかったことを示す `last event: none` をエラーメッセージが含むことを確認します。')
      vi.useFakeTimers()
      try {
        const { launch } = mockPlaywright()
        vi.doMock('playwright', () => ({ chromium: { launch } }))
        const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')

        const pending = exportViaEmbed('<root/>', { format: 'svg' })
        const outcome = rejectionOf(pending)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(String(await outcome)).toMatch(/last event: none/)
      }
      finally {
        vi.useRealTimers()
      }
    })
  })

  it('応答が base64 の data URI でなければ、空のファイルを書かず、エラーにする', async () => {
    await explains('embed API で図を書き出す `exportViaEmbed` のテストです。書き出しの結果が `<svg/>` のように data URI ではない場合に、`is not a base64 data URI` を含む例外が発生することを確認します。')
    const { launch } = mockPlaywright('<svg/>')

    vi.doMock('playwright', () => ({ chromium: { launch } }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')

    await expect(exportViaEmbed('<root/>', { format: 'svg' })).rejects.toThrow(
      /is not a base64 data URI/,
    )
  })

  it('ソースコードに、embed の公式のイベント名 init・load・export の定数が含まれる', async () => {
    await explains('`screenshot.ts` のソースを読んで調べるテストです。`EVENT_INIT`・`EVENT_LOAD`・`EVENT_EXPORT` が、それぞれ `init`・`load`・`export` として定義されていることを確認します。')
    const source = readFileSync(SCREENSHOT_SRC, 'utf8')
    expect(source).toMatch(/EVENT_INIT\s*=\s*'init'/)
    expect(source).toMatch(/EVENT_LOAD\s*=\s*'load'/)
    expect(source).toMatch(/EVENT_EXPORT\s*=\s*'export'/)
  })

  it('ソースコードに、以前の回避策の文字列が残っていない', async () => {
    await explains('`screenshot.ts` のソースを読んで調べるテストです。以前の回避策で使っていた `fontsource`・`foreignObject`・`page.route` が含まれないことを確認します。')
    const source = readFileSync(SCREENSHOT_SRC, 'utf8')
    expect(source).not.toMatch(/fontsource/i)
    expect(source).not.toMatch(/foreignObject/)
    expect(source).not.toMatch(/page\.route/)
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */
