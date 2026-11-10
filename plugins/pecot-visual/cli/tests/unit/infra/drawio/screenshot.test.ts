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

  it('PECOTV_FORCE_PNG_FAIL=1 のとき Playwright 起動前に reject する', async () => {
    vi.stubEnv('PECOTV_FORCE_PNG_FAIL', '1')
    const { capturePng } = await import('../../../../src/infra/drawio/screenshot.js')
    await expect(capturePng('<root/>', '/tmp/x.png', ['Test Sans'])).rejects.toThrow(
      /forced XMLPNG failure/,
    )
  })

  it('export に失敗したときは出力ディレクトリを作らない', async () => {
    vi.stubEnv('PECOTV_FORCE_PNG_FAIL', '1')
    const { capturePng } = await import('../../../../src/infra/drawio/screenshot.js')
    const outputDirectory = path.join(tmpdir(), `pecotv-capture-fail-${String(process.pid)}`)

    await expect(capturePng('<root/>', path.join(outputDirectory, 'x.png'), ['Test Sans'])).rejects.toThrow()

    expect(existsSync(outputDirectory)).toBe(false)
  })

  it('PECOTV_FORCE_SVG_FAIL=1 は SVG export だけを reject し、PNG の出力には影響しない', async () => {
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

  it('別の宣言の書体を渡すと、その書体を読み込み、Inter と Noto Sans JP は読み込まない', async () => {
    const { html, preloaded } = await captureWithFonts(['Caveat'])
    expect(html).toContain('family=Caveat:wght@400;500;600;700')
    expect(html).not.toContain('Inter')
    expect(html).not.toContain('Noto')
    expect(preloaded).toEqual(['400 16px "Caveat"', '500 16px "Caveat"', '600 16px "Caveat"', '700 16px "Caveat"'])
  })

  it('総称の書体だけなら @import を作らず、preload も空にする', async () => {
    const { html, preloaded } = await captureWithFonts(['sans-serif'])
    expect(html).not.toContain('@import')
    expect(html).not.toContain('fonts.googleapis.com')
    expect(preloaded).toEqual([])
  })

  it('書体名の \' は URL に出さず、@import の引用符を壊さない', async () => {
    const { html } = await captureWithFonts(['O\'Neil'])
    expect(html).toContain('family=O%27Neil')
    expect(html).toContain('@import url(\'https://fonts.googleapis.com/css2?family=O%27Neil')
  })

  it('capturePng は viewer で描き、宣言の書体を読み込んでから撮り、PNG に XML を埋め込む', async () => {
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

  it('ページは User-Agent の HeadlessChrome だけを Chrome に替えて開き、版の数字は起動した Chromium のまま (#1166)', async () => {
    const { launch, newPage, detach } = mockPlaywright('data:image/png;base64,aGVsbG8=')

    vi.doMock('playwright', () => ({ chromium: { launch } }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')
    await exportViaEmbed('<root/>', { format: 'xmlpng' })

    expect(newPage).toHaveBeenCalledWith({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.16 Safari/537.36',
    })
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('format svg では payload.format が svg になり、decode 済 SVG 文字列を返す', async () => {
    const { launch, evaluate } = mockPlaywright('data:image/svg+xml;base64,PHN2Zy8+')

    vi.doMock('playwright', () => ({ chromium: { launch } }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')
    const exported = await exportViaEmbed('<root/>', { format: 'svg' })

    // eslint-disable-next-line no-restricted-syntax -- mock 引数を読み取って object 形を pin する narrowing
    const payload = evaluate.mock.calls[0]?.[1] as Readonly<{ format: string }>
    expect(payload.format).toBe('svg')
    expect(exported.toString('utf8')).toBe('<svg/>')
  })

  it('iframe は src 無しで載せ、embed の URL は handshake の listener を付けた後に page 内で設定する (init の取りこぼし防止)', async () => {
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

  it('installEmbedHandshake は message の listener を付けてから iframe の src を設定する', async () => {
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

    it('診断用の進捗通知が投げても、init への load と load への export は送る (F-10)', async () => {
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

    it('embed の iframe 以外から届いた message には応答しない (F-10)', async () => {
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
      '%s が返らないまま時間切れになっても、診断つきのエラーが呼び出し側に届き、unhandled rejection にならない',
      async (stage) => {
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

    it('完了した段には経過秒を、未完了の段には「未完了」だけを書く', async () => {
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

    it('最後に受けた embed のイベントと、各段の経過をエラーに含める', async () => {
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

    it('イベントを 1 つも受けなかったときは「なし」と書く（init が届かなかったことを示す）', async () => {
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

  it('base64 data URI 以外の応答は空ファイルを書かず明示エラーにする', async () => {
    const { launch } = mockPlaywright('<svg/>')

    vi.doMock('playwright', () => ({ chromium: { launch } }))
    const { exportViaEmbed } = await import('../../../../src/infra/drawio/screenshot.js')

    await expect(exportViaEmbed('<root/>', { format: 'svg' })).rejects.toThrow(
      /is not a base64 data URI/,
    )
  })

  it('source に event 名定数 init / load / export が含まれる (公式 protocol 名 grep pin)', () => {
    const source = readFileSync(SCREENSHOT_SRC, 'utf8')
    expect(source).toMatch(/EVENT_INIT\s*=\s*'init'/)
    expect(source).toMatch(/EVENT_LOAD\s*=\s*'load'/)
    expect(source).toMatch(/EVENT_EXPORT\s*=\s*'export'/)
  })

  it('source に旧 workaround の文字列が残っていない (regression 防止)', () => {
    const source = readFileSync(SCREENSHOT_SRC, 'utf8')
    expect(source).not.toMatch(/fontsource/i)
    expect(source).not.toMatch(/foreignObject/)
    expect(source).not.toMatch(/page\.route/)
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */
