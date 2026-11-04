// draw.io の図を画像にする I/O 層。PNG は commands/drawio/url.ts、SVG は commands/drawio/export.ts
// から DI 経由で注入される。
//
// PNG（capturePng）は、スライドが図を描くのと同じ diagrams.net の viewer で描いて撮る。
// 描くページには、テーマの宣言の書体（呼び出し側が渡す）を Google Fonts から読み込む。
// 作図エージェントは PNG を見て崩れを直すので、PNG がスライドと違う書体で描かれると、
// 収まっていない図を収まっていると判断してしまう。撮った PNG には XML を tEXt チャンク
// `mxfile` として埋め込み、draw.io で開けば再編集できる形（draw.io 公式の XML 埋め込み PNG）にする。
//
// SVG（exportViaEmbed）は draw.io editor の post message embed API（`embed.diagrams.net`）に
// 送って export させる。公式 post message protocol の event 名 `init` / `load` / `export` に
// 依存しており、editor 側 API が変わると破損する。event 名は本ファイル内の文字列定数として grep test 対象。
//
// どちらも外部 CDN（viewer.diagrams.net / embed.diagrams.net / fonts.googleapis.com）へ、
// XML か描画要求を送る。
// 機密 XML を扱う場合は、--no-png オプションで PNG 生成を抑止できる。
// PNG は tEXt チャンクに XML ソースをそのまま内包するため、PNG 単体の配布でもソースが漏れる。
// ラスター画像のみを配布したい場合は、--no-png が必須。
//
// 環境変数 PECOTV_FORCE_PNG_FAIL=1 / PECOTV_FORCE_SVG_FAIL=1 を指定すると、
// Playwright 起動より前に意図的に reject する。
// chromium 未インストール環境でも失敗パスを検証できるようにするため。

/* eslint-disable security/detect-non-literal-fs-filename -- outputPath は信頼境界内のパス */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32 } from 'node:zlib'

import type { Browser } from 'playwright'

import { launchChromium } from '../playwright/launch.js'
import { ignoreRejection } from '../../domain/_shared/ignore-rejection.js'
import { webFontsFor } from '../../domain/drawio/web-fonts.js'
import type { WebFonts } from '../../domain/drawio/web-fonts.js'

const EMBED_URL = 'https://embed.diagrams.net/?embed=1&proto=json'
const EVENT_INIT = 'init'
const EVENT_LOAD = 'load'
const EVENT_EXPORT = 'export'
const EXPORT_TIMEOUT_MS = 60_000
const VIEWPORT = { width: 1280, height: 800 } satisfies { readonly width: number, readonly height: number }

interface EmbedEvents {
  readonly init: string
  readonly load: string
  readonly exportEvent: string
}

interface HandshakePayload {
  readonly xml: string
  readonly format: EmbedExportFormat
  readonly events: EmbedEvents
  readonly embedUrl: string
}

interface PostMessage {
  readonly event?: string
  readonly data?: string
}

interface ExportBridge {
  readonly __pecotvOnExport: (data: string) => void
  readonly __pecotvOnProgress: (event: string) => void
}

/**
embed API の export action へ渡す format。
`xmlpng` は tEXt チャンク `mxfile` に XML を埋め込んだ PNG を返す。
これは draw.io 公式の XML 埋め込み PNG で、draw.io で開くと再編集できる。
`svg` は素の SVG を返す。
*/
export type EmbedExportFormat = 'xmlpng' | 'svg'

// format ごとの失敗注入 env。PNG は既存 CUJ が参照する名前を温存し、SVG は同形の別名を持つ。
const FORCE_FAIL_ENV: Readonly<Record<EmbedExportFormat, string>> = {
  xmlpng: 'PECOTV_FORCE_PNG_FAIL',
  svg: 'PECOTV_FORCE_SVG_FAIL',
}

/**
viewer で `xmlString` を描いて `outputPath` に PNG を書く。
fonts は読み込む書体名（テーマの宣言の本文の書体と和文の書体）。総称の書体だけなら Web フォントを読み込まない。
*/
export async function capturePng(xmlString: string, outputPath: string, fonts: readonly string[]): Promise<void> {
  if (process.env[FORCE_FAIL_ENV.xmlpng] === '1') {
    throw new Error(`forced XMLPNG failure (${FORCE_FAIL_ENV.xmlpng}=1)`)
  }
  // mkdir は描画成功後に置く。失敗パスで先にディレクトリを掘ると、PNG の無い
  // 空ディレクトリが残る。
  const rendered = await renderWithThemeFonts(xmlString, webFontsFor(fonts))
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, embedXmlChunk(rendered, xmlString))
}

const VIEWER_SCRIPT_URL = 'https://viewer.diagrams.net/js/viewer-static.min.js'

/**
viewer で `xmlString` を描き、図の範囲を撮った PNG のバイト列を返す。
描く前に、渡された Web フォントを読み込む。読み込む書体が無ければ @import を作らない。
*/
async function renderWithThemeFonts(xmlString: string, fonts: Readonly<WebFonts>): Promise<Buffer> {
  // url('...') の引用符を壊さないよう、URL の ' は %27 にしてある（webFontsFor）。
  const fontCss = fonts.stylesheetUrl === undefined ? '' : `@import url('${fonts.stylesheetUrl}');`
  const browser = await launchChromium()
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}body{margin:0;background:#FFFFFF}</style></head>`
      + '<body><div class="mxgraph" id="d"></div></body></html>',
      { waitUntil: 'load', timeout: EXPORT_TIMEOUT_MS },
    )
    await page.evaluate(preloadFonts, [...fonts.preload])
    await page.evaluate(mountViewerConfig, xmlString)
    await page.addScriptTag({ url: VIEWER_SCRIPT_URL })
    await page.evaluate(processViewerElements)
    const diagram = page.locator('#d svg').first()
    await diagram.waitFor({ state: 'visible', timeout: EXPORT_TIMEOUT_MS })
    await page.evaluate(waitFontsReady)
    return await diagram.screenshot({ timeout: EXPORT_TIMEOUT_MS })
  }
  finally {
    await browser.close()
  }
}

// ブラウザ context で実行される関数群。page.evaluate で注入される。
async function preloadFonts(fonts: readonly string[]): Promise<void> {
  await Promise.all(fonts.map(async (font) => {
    try {
      await document.fonts.load(font)
    }
    catch {
      // 読めない書体は代替書体で描く。読み込みの失敗で PNG 全体を落とさない
    }
  }))
}

function mountViewerConfig(xml: string): void {
  const element = document.querySelector<HTMLElement>('#d')
  if (element === null) throw new Error('viewer element not mounted')
  element.dataset['mxgraph'] = JSON.stringify({
    xml, 'highlight': 'none', 'nav': false, 'resize': false, 'toolbar': '', 'border': 0, 'check-visible-state': false,
  })
}

interface ViewerGlobal {
  readonly GraphViewer?: { readonly processElements: () => void }
}

function processViewerElements(): void {
  // eslint-disable-next-line no-restricted-syntax -- viewer-static が window に生やす GraphViewer を narrowing
  const viewer = (globalThis as unknown as ViewerGlobal).GraphViewer
  if (viewer === undefined) throw new Error('GraphViewer が読み込まれていません')
  viewer.processElements()
}

async function waitFontsReady(): Promise<void> {
  await document.fonts.ready
}

/**
PNG の IHDR の直後に tEXt チャンク `mxfile` を差し込む。値は draw.io の XML 埋め込み PNG と同じく
encodeURIComponent した XML で、draw.io で開くと再編集できる。
*/
function embedXmlChunk(png: Readonly<Buffer>, xmlString: string): Buffer {
  const IHDR_END = 8 + 4 + 4 + 13 + 4
  const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(`mxfile\0${encodeURIComponent(xmlString)}`, 'latin1')])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length - 4)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([png.subarray(0, IHDR_END), length, body, crc, png.subarray(IHDR_END)])
}

/**
embed API で `xmlString` を `format` に export し、decode 済のバイト列を返す。
data URI の base64 部分のみを扱う（editor は png / svg いずれも base64 で返す）。
*/
export async function exportViaEmbed(
  xmlString: string,
  options: Readonly<{ format: EmbedExportFormat }>,
): Promise<Buffer> {
  const failFlagName = FORCE_FAIL_ENV[options.format]
  // eslint-disable-next-line security/detect-object-injection -- key は EmbedExportFormat union で本ファイル内固定
  if (process.env[failFlagName] === '1') {
    throw new Error(`forced ${options.format.toUpperCase()} failure (${failFlagName}=1)`)
  }

  const browser = await launchChromium()

  try {
    const page = await browser.newPage({ userAgent: await headedUserAgent(browser) })
    await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height })

    // closure 経由で export の応答を外部から resolve できる形に分離。
    // exposeFunction を await することで listener install 完了を保証してから setContent に進む。
    const { promise: dataUriPromise, resolve: resolveExport } = Promise.withResolvers<string>()
    // 時間切れの診断用に、どこまで進んだかを控える。
    // 時間切れの原因は、init 未着・load/export 未着・setContent の遅延のいずれか。
    // これが無いと、原因を区別できない。
    const startedAt = performance.now()
    const elapsedSeconds = (): number => (performance.now() - startedAt) / 1000
    const progress: string[] = []
    let contentLoadSeconds: number | undefined
    let handshakeSeconds: number | undefined
    // 完了した段だけ「<動詞> <秒>s」と書く。未完了の段は単位を付けない。
    const describeStage = (name: string, done: string, seconds: number | undefined): string => (
      seconds === undefined ? `${name} 未完了` : `${name} ${done} ${seconds.toFixed(1)}s`
    )
    // 時間切れは export の応答待ちだけでなく、setContent / evaluate などの各段も打ち切る。
    // `expired` は reject 専用で、各段と Promise.race で競わせる。
    // race が各 promise に handler を付けるので、負けた段が後から reject しても unhandled rejection にならない。
    // 生成直後に catch を付けるのは、どの段も race していない間の時間切れへ備えるため。
    // 例えば exposeFunction の await 中。
    const { promise: expired, reject: expire } = Promise.withResolvers<never>()
    // 呼び出し側へは race 経由で届く。ここは unhandled rejection を避けるだけ。
    void ignoreRejection(expired)
    const withinDeadline = async <T>(stage: Promise<T>): Promise<T> => await Promise.race([stage, expired])
    const timer = setTimeout(
      () => {
        const last = progress.at(-1) ?? 'なし'
        expire(new Error(
          `embed protocol timeout (${(EXPORT_TIMEOUT_MS / 1000).toString()}s)`
          + `: 最後に受けたイベント=${last}`
          + ` (${describeStage('setContent', '完了', contentLoadSeconds)} / ${describeStage('handshake', '設置', handshakeSeconds)}`
          + ` / 受信 ${progress.join(' → ') || 'なし'})`,
        ))
      },
      EXPORT_TIMEOUT_MS,
    )
    try {
      await withinDeadline(page.exposeFunction('__pecotvOnExport', (data: string) => {
        clearTimeout(timer)
        resolveExport(data)
      }))
      await withinDeadline(page.exposeFunction('__pecotvOnProgress', (event: string) => {
        progress.push(`${event}@${elapsedSeconds().toFixed(1)}s`)
      }))

      // about:blank を base にして iframe で embed.diagrams.net をロードする。
      // top-level navigation で `embed.diagrams.net` を開くと、editor が iframe 専用 protocol を起動しない。
      // そのため init event が来ない。iframe 経由なら、draw.io 公式 embed.html の前提と一致する。
      // iframe はここでは src 無しで載せる。
      // embed の URL は、handshake の中で message の listener を付けた後に設定する。
      // embed は init を再送しない。読み込みを先に始めて listener が後になると、その間に届いた init を取りこぼす。
      // その場合は 60 秒待つことになる（実 embed では init が約 3 秒後に届く）。
      await withinDeadline(page.setContent(
        `<!doctype html><html><body style="margin:0">`
        + `<iframe id="d" style="width:${VIEWPORT.width.toString()}px;height:${VIEWPORT.height.toString()}px;border:0"></iframe>`
        + `</body></html>`,
        { waitUntil: 'domcontentloaded', timeout: EXPORT_TIMEOUT_MS },
      ))
      contentLoadSeconds = elapsedSeconds()

      const payload: HandshakePayload = {
        xml: xmlString,
        format: options.format,
        events: { init: EVENT_INIT, load: EVENT_LOAD, exportEvent: EVENT_EXPORT },
        embedUrl: EMBED_URL,
      }
      await withinDeadline(page.evaluate(installEmbedHandshake, payload))
      handshakeSeconds = elapsedSeconds()

      const dataUri = await withinDeadline(dataUriPromise)
      return decodeExportDataUri(dataUri)
    }
    finally {
      clearTimeout(timer)
    }
  }
  finally {
    await browser.close()
  }
}

// embed.diagrams.net（Cloudflare 配下）は、User-Agent に `HeadlessChrome` を含む要求を 403 で拒否する。
// 拒否は 2026-10-07〜10-13 の間に始まった（#1166）。
// 起動した Chromium が名乗る User-Agent の `HeadlessChrome` だけを `Chrome` に置き換える。
// 版の数字は、起動した Chromium のものをそのまま使う。
async function headedUserAgent(browser: Readonly<Browser>): Promise<string> {
  const session = await browser.newBrowserCDPSession()
  try {
    const { userAgent } = await session.send('Browser.getVersion')
    return userAgent.replace('HeadlessChrome', 'Chrome')
  }
  finally {
    await session.detach()
  }
}

// `data:<mime>;base64,<payload>` を decode する。
// prefix が想定外の形なら、空ファイルを通知なしに書き出さず、明示エラーにする。
function decodeExportDataUri(dataUri: string): Buffer {
  const match = /^data:[^;,]+;base64,(?<payload>.*)$/s.exec(dataUri)
  if (match?.groups?.['payload'] === undefined) {
    throw new Error(`embed export の応答が base64 data URI ではありません: ${dataUri.slice(0, 60)}`)
  }
  return Buffer.from(match.groups['payload'], 'base64')
}

// ブラウザ context で実行される handshake installer。Node 側からは page.evaluate で注入される。
// Node 側で実行されないため、ここで使う globalThis / document は page 内のものに解決される。
//
// embed は init を再送しないため、message の listener を付けてから iframe の src を設定する（順序が要る）。
function installEmbedHandshake(payload: Readonly<HandshakePayload>): void {
  const { xml, format, events, embedUrl } = payload
  const iframe = document.querySelector<HTMLIFrameElement>('#d')
  if (!iframe?.contentWindow) {
    throw new Error('embed iframe not mounted')
  }
  const target = iframe.contentWindow
  // exposeFunction で page 側に install された host bridge。
  // eslint-disable-next-line no-restricted-syntax -- exposeFunction で動的注入された関数を ExportBridge に narrowing
  const bridge = globalThis as unknown as ExportBridge
  // 診断用の通知。失敗しても本処理（postMessage / export の受け渡し）を止めないよう、本処理の後に呼んで握りつぶす。
  const report = (event: string): void => {
    try {
      bridge.__pecotvOnProgress(event)
    }
    catch {
      // 診断の失敗で書き出しを落とさない
    }
  }
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- MessageEvent は標準型
  globalThis.addEventListener('message', (event: MessageEvent) => {
    // 応答するのは embed の iframe からの message だけ。
    // 他の window からの message では、load / export を送らない。
    if (event.source !== target) return
    let message: PostMessage
    try {
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りを PostMessage に narrowing
      message = JSON.parse(String(event.data)) as PostMessage
    }
    catch {
      return
    }
    if (message.event === events.init) {
      target.postMessage(JSON.stringify({ action: 'load', xml }), '*')
      report(events.init)
    }
    else if (message.event === events.load) {
      target.postMessage(
        JSON.stringify({ action: 'export', format, scale: 1, border: 0 }),
        '*',
      )
      report(events.load)
    }
    else if (message.event === events.exportEvent && typeof message.data === 'string') {
      bridge.__pecotvOnExport(message.data)
      report(events.exportEvent)
    }
  })
  // listener を付けた後に読み込みを始める。
  iframe.src = embedUrl
}
/* eslint-enable security/detect-non-literal-fs-filename */
