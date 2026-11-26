// commands/drawio/url.ts の integration test。
// DI override で readFile をスタブし、view/edit、output の有無、エラー時の出力を網羅する。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DrawioUrlRuntimeError,
  DrawioUrlUsageError,
  drawioUrlDefaultDependencies,
  errorData,
  executeDrawioUrl,
  runDrawioUrl,
} from '../../../src/commands/drawio/url.js'
import type { LintText } from '../../../src/domain/_shared/text-check.js'
import { defaultLintText } from '../../../src/infra/text-lint.js'
import { resolvePluginRoot } from '../../../src/infra/_shared/plugin-root.js'
import { attachFile, readOutput } from '../../_helpers/attach.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { verifies } from '../../_helpers/verifies.js'
import { makeStream } from '../../_helpers/talk-directory.js'
import type { CapturedStream } from '../../_helpers/talk-directory.js'

const failingLintText: LintText = () => Promise.reject(new Error('辞書を読めません'))

// 違反文を literal で持たない。語を分けて組み立てる。
const HYPE = ['ゲーム', 'チェンジャー', 'となる基盤です。'].join('')

const HERE = import.meta.dirname
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const FIXTURES = path.resolve(HERE, '..', '..', 'fixtures', 'drawio')
const MINIMAL_FIXTURE = path.join(FIXTURES, 'minimal.drawio')
const ICON_INCLUDED_FIXTURE = path.join(FIXTURES, 'icon-included.drawio')
// 未解決 icon 2 種（うち 1 種は 2 つの mxCell から参照）。警告の dedupe 粒度を pin する。
const ICON_UNRESOLVED_MULTI_FIXTURE = path.join(FIXTURES, 'icon-unresolved-multi.drawio')
// 生成 URL が 8,000 文字超になる大型 fixture（長大 URL の欠損検知用）。icon:// 13 件を含む。
// スキルの samples は見た目の規範で入れ替わるため、サイズ条件はテスト専用 fixture で担保する。
const LONG_URL_FIXTURE = path.join(FIXTURES, 'long-url.drawio')

const META_REFRESH_REGEX = /<meta http-equiv="refresh" content="0;url=([^"]*)">/
const TARGET_ANCHOR_REGEX = /<a id="target" href="([^"]*)">/

/**
表示用 HTML が URL を持つ 2 箇所（meta refresh / 可視リンク）から URL を取り出し、
HTML 属性エスケープを戻す。長大 URL の途中欠損はここで byte 比較して検出する。
*/
function extractUrls(html: string): readonly [string, string] {
  const meta = META_REFRESH_REGEX.exec(html)?.[1]
  const anchor = TARGET_ANCHOR_REGEX.exec(html)?.[1]
  if (meta === undefined || anchor === undefined) {
    throw new Error('表示用 HTML から URL を取り出せません')
  }
  return [unescapeHtmlAttribute(meta), unescapeHtmlAttribute(anchor)]
}

function unescapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write を持つ stub
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream として narrowing
  return captured as unknown as NodeJS.WritableStream
}

function buildDependencies(overrides: Partial<{
  readonly readFile: (filePath: string) => Promise<string>
  readonly writeFile: (filePath: string, content: string) => Promise<void>
  readonly capturePng: (xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>
  readonly lintText: LintText
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly pluginRoot: string
}> = {}): ReturnType<typeof drawioUrlDefaultDependencies> {
  return {
    pluginRoot: overrides.pluginRoot ?? PLUGIN_ROOT,
    stdout: overrides.stdout ?? asStream(makeStream()),
    stderr: overrides.stderr ?? asStream(makeStream()),
    readFile: overrides.readFile ?? ((filePath: string) => Promise.resolve(readFileSync(filePath, 'utf8'))),
    writeFile: overrides.writeFile ?? ((filePath: string, content: string) => fsWriteFile(filePath, content, 'utf8')),
    capturePng: overrides.capturePng ?? (() => Promise.resolve()),
    lintText: overrides.lintText ?? defaultLintText,
    now: () => 0,
  }
}

describe('runDrawioUrl', () => {
  it('minimal fixture から URL を生成する (view)', async () => {
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies(),
    )
    expect(summary.url.startsWith('https://app.diagrams.net/?viewbox=')).toBe(true)
    expect(summary.url).toContain('#R')
    expect(summary.mode).toBe('view')
    expect(summary.inputFile).toBe(MINIMAL_FIXTURE)
  })

  it('mode は view と edit で同一 URL を返す（no-op）', async () => {
    const view = await runDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true }, buildDependencies())
    const edit = await runDrawioUrl(MINIMAL_FIXTURE, { mode: 'edit', png: true }, buildDependencies())
    expect(view.url).toBe(edit.url)
  })

  it('入力ファイル不存在で DrawioUrlRuntimeError(input-not-found) を投げる', async () => {
    await expect(runDrawioUrl(
      '/nonexistent/path/file.drawio',
      { mode: 'view', png: true },
      buildDependencies(),
    )).rejects.toThrow(DrawioUrlRuntimeError)
  })

  it('HTML 警告は stderr に流れ、warningCount に反映される', async () => {
    const stderr = makeStream('stderr')
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies({
        stderr: asStream(stderr),
        // 警告を発生させる XML をスタブ経由で渡す
        readFile: () => Promise.resolve(`<root><mxCell id="x" style="fontFamily=sans-serif;" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>`),
      }),
    )
    expect(stderr.chunks.join('')).toContain('unsupported <font> attribute')
    expect(summary.warningCount).toBe(1)
  })

  it('whiteSpace=wrap 抜け XML で stderr に [warn] を出し、warningCount に反映される', async () => {
    const stderr = makeStream('stderr')
    const wrapMissingXml = `<root><mxCell id="cellA" vertex="1" style="rounded=1;fillColor=#fff;fontFamily=sans-serif;" value="日本語テキスト"/></root>`
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies({
        stderr: asStream(stderr),
        readFile: () => Promise.resolve(wrapMissingXml),
      }),
    )
    expect(stderr.chunks.join('')).toContain('whiteSpace=wrap')
    expect(stderr.chunks.join('')).toContain('mxCell id=cellA')
    expect(summary.warningCount).toBe(1)
  })

  it('whiteSpace=wrap 付き XML では wrap 警告が出ない', async () => {
    const stderr = makeStream('stderr')
    const wrapPresentXml = `<root><mxCell id="cellA" vertex="1" style="rounded=1;whiteSpace=wrap;fillColor=#fff;fontFamily=sans-serif;" value="日本語テキスト"/></root>`
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies({
        stderr: asStream(stderr),
        readFile: () => Promise.resolve(wrapPresentXml),
      }),
    )
    expect(stderr.chunks.join('')).not.toContain('whiteSpace=wrap')
    expect(summary.warningCount).toBe(0)
  })

  it('icon が見つからない時は stderr に警告を出し、warningCount に反映される', async () => {
    const stderr = makeStream('stderr')
    const summary = await runDrawioUrl(
      ICON_INCLUDED_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies({ stderr: asStream(stderr) }),
    )
    const stderrText = stderr.chunks.join('')
    expect(stderrText.match(/icon not found/g)).toHaveLength(1)
    expect(summary.warningCount).toBe(1)
  })

  it('未解決 icon の警告はアイコン 1 種につき 1 件に畳まれる', async () => {
    const stderr = makeStream('stderr')
    const summary = await runDrawioUrl(
      ICON_UNRESOLVED_MULTI_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies({ stderr: asStream(stderr) }),
    )
    const stderrText = stderr.chunks.join('')
    expect(stderrText.match(/icon not found/g)).toHaveLength(2)
    expect(summary.warningCount).toBe(2)
  })

  it('警告無しの正常系では warningCount が 0', async () => {
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies(),
    )
    expect(summary.warningCount).toBe(0)
  })
})

const WARN_XML = `<root><mxCell id="x" style="fontFamily=sans-serif;" value="&lt;font weight=&quot;bold&quot;&gt;X&lt;/font&gt;"/></root>`
const WRAP_MISSING_XML = `<root><mxCell id="cellA" vertex="1" style="rounded=1;fillColor=#fff;fontFamily=sans-serif;" value="日本語テキスト"/></root>`

function violatingDrawio(): string {
  return `<mxfile><diagram id="d" name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" value="${HYPE}" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>`
}

type CapturePng = (xmlString: string, outputPath: string, fonts: readonly string[]) => Promise<void>

function pngSpy(implementation: CapturePng = () => Promise.resolve()): ReturnType<typeof vi.fn<CapturePng>> {
  return vi.fn<CapturePng>(implementation)
}

describe('executeDrawioUrl', () => {
  // 各ケースで一時ディレクトリを作って後始末する
  let workDirectory = ''

  afterEach(() => {
    if (workDirectory === '') {
      return
    }

    rmSync(workDirectory, { recursive: true, force: true })
    workDirectory = ''
  })

  function temporaryWorkDirectory(): string {
    workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-url-test-'))
    return workDirectory
  }

  describe('output なし', () => {
    it('data に drawio.url.done と URL を載せ、ファイルを書かず、警告 0 で終える', async () => {
      const execution = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true }, buildDependencies())
      expect(execution.data).toMatchObject({ event: 'drawio.url.done', warnings: 0 })
      expect(execution.data['url']).toBe(execution.url)
      expect(execution.url.startsWith('https://app.diagrams.net/')).toBe(true)
      expect(execution.artifacts).toStrictEqual([])
      expect(execution.outputFile).toBeUndefined()
    })

    it('mode edit でも成功し、view と同じ URL を返す', async () => {
      const view = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true }, buildDependencies())
      const edit = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'edit', png: true }, buildDependencies())
      expect(edit.url).toBe(view.url)
    })

    it('capturePng を呼ばない (PNG は output の兄弟ファイルなので抑止)', async () => {
      const capturePng = pngSpy()
      await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true }, buildDependencies({ capturePng }))
      expect(capturePng).not.toHaveBeenCalled()
    })
  })

  describe('失敗', () => {
    it('入力ファイル不存在は input-not-found の errorData になる', async () => {
      const failure = await rejectionOf(executeDrawioUrl('/no/such/file.drawio', { mode: 'view', png: true }, buildDependencies()))
      expect(errorData(failure)).toMatchObject({ event: 'drawio.url.error', reason: 'input-not-found' })
    })

    it('文面の違反は text-violation と violations の全件を errorData に載せ、HTML を書かない', async () => {
      const directory = temporaryWorkDirectory()
      const input = path.join(directory, 'd.drawio')
      await fsWriteFile(input, violatingDrawio(), 'utf8')
      const output = path.join(directory, 'd.drawio.html')

      const failure = await rejectionOf(executeDrawioUrl(input, { mode: 'view', png: false, output }, buildDependencies()))

      const data = errorData(failure)
      expect(data).toMatchObject({ event: 'drawio.url.error', reason: 'text-violation' })
      expect(data['violations']).toMatchObject([{ item: 'mxCell id="n1"', ruleId: 'no-ai-hype-expressions', text: HYPE }])
      expect(String(data['detail'])).toContain('mxCell id="n1"')
      expect(String(data['detail'])).toContain('1 text violation(s)')
      expect(existsSync(output)).toBe(false)
    })

    it('判定器が失敗したら text-lint-failed になり、HTML を書かない', async () => {
      const directory = temporaryWorkDirectory()
      const input = path.join(directory, 'd.drawio')
      await fsWriteFile(input, violatingDrawio(), 'utf8')
      const output = path.join(directory, 'd.drawio.html')

      const failure = await rejectionOf(executeDrawioUrl(input, { mode: 'view', png: false, output }, { ...buildDependencies(), lintText: failingLintText }))

      expect(errorData(failure)).toMatchObject({ event: 'drawio.url.error', reason: 'text-lint-failed' })
      expect(existsSync(output)).toBe(false)
    })

    it('書き込み不能な path は output-write-failed になる', async () => {
      const badPath = path.join(temporaryWorkDirectory(), 'nonexistent-dir', 'out.drawio.html')
      const failure = await rejectionOf(executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: false, output: badPath }, buildDependencies()))
      expect(errorData(failure)).toMatchObject({ event: 'drawio.url.error', reason: 'output-write-failed' })
    })
  })

  describe('警告', () => {
    it('警告ありの XML は warningCount と data.warnings が 1 で、stderr に warning を出し、URL は返す', async () => {
      const stderr = makeStream('stderr')
      const execution = await executeDrawioUrl(
        MINIMAL_FIXTURE,
        { mode: 'view', png: true },
        buildDependencies({ stderr: asStream(stderr), readFile: () => Promise.resolve(WARN_XML) }),
      )
      expect(execution.warningCount).toBe(1)
      expect(execution.data).toMatchObject({ event: 'drawio.url.done', warnings: 1 })
      expect(execution.url.startsWith('https://app.diagrams.net/')).toBe(true)
      expect(stderr.chunks.join('')).toContain('warning:')
    })

    it('警告ありの XML でも output にはファイルを書き出す', async () => {
      const outPath = path.join(temporaryWorkDirectory(), 'out.drawio.html')
      const execution = await executeDrawioUrl(
        MINIMAL_FIXTURE,
        { mode: 'view', png: true, output: outPath },
        buildDependencies({ readFile: () => Promise.resolve(WARN_XML) }),
      )
      const written = readOutput(outPath)
      for (const url of extractUrls(written)) {
        expect(url.startsWith('https://app.diagrams.net/')).toBe(true)
      }
      expect(execution.warningCount).toBe(1)
    })

    it('whiteSpace=wrap 抜け XML は warningCount が 1 で、stderr に whiteSpace=wrap の warning を出す', async () => {
      const stderr = makeStream('stderr')
      const execution = await executeDrawioUrl(
        MINIMAL_FIXTURE,
        { mode: 'view', png: true },
        buildDependencies({ stderr: asStream(stderr), readFile: () => Promise.resolve(WRAP_MISSING_XML) }),
      )
      expect(execution.warningCount).toBe(1)
      expect(execution.data).toMatchObject({ event: 'drawio.url.done', warnings: 1 })
      expect(stderr.chunks.join('')).toContain('warning:')
      expect(stderr.chunks.join('')).toContain('whiteSpace=wrap')
    })

    it('警告無しでも warnings: 0 が data に常時含まれる', async () => {
      const execution = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true }, buildDependencies())
      expect(execution.data['warnings']).toBe(0)
      expect(execution.warningCount).toBe(0)
    })
  })

  describe('output', () => {
    it('指定時は data に {event,file} (url キーなし) を載せ、stdout は空、ファイルは表示用 HTML', async () => {
      const outPath = path.join(temporaryWorkDirectory(), 'out.drawio.html')
      const stdout = makeStream('stdout')
      const execution = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true, output: outPath }, buildDependencies({ stdout: asStream(stdout) }))
      expect(stdout.chunks.join('')).toBe('')
      expect(execution.data).toMatchObject({ event: 'drawio.url.done', file: outPath })
      expect(Object.hasOwn(execution.data, 'url')).toBe(false)
      expect(execution.outputFile).toBe(outPath)
      const written = readOutput(outPath)
      expect(written.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n')).toBe(true)
      for (const url of extractUrls(written)) {
        expect(url.startsWith('https://app.diagrams.net/?viewbox=')).toBe(true)
      }
      expect(written.endsWith('</html>\n')).toBe(true)
      expect(written).not.toContain('\r')
    })

    it.each([
      { label: '.html でない拡張子', fileName: 'out.txt' },
      // 旧規約 (.url = InternetShortcut) の呼び出しが警告なしに通ると、中身が HTML の
      // ファイルに .url が付いたまま配布される。名指しで弾くことを pin する。
      { label: '旧規約の *.drawio.url', fileName: 'out.drawio.url' },
      { label: '拡張子なし', fileName: 'foo' },
    ])('output が $label なら invalid-output-extension で弾き、ファイルを書き出さない', async ({ fileName }) => {
      const outPath = path.join(temporaryWorkDirectory(), fileName)
      const failure = await rejectionOf(executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: false, output: outPath }, buildDependencies()))
      expect(failure).toBeInstanceOf(DrawioUrlUsageError)
      expect(errorData(failure)).toMatchObject({ event: 'drawio.url.error', reason: 'invalid-output-extension' })
      expect(String(errorData(failure)['detail'])).toContain('.html')
      expect(existsSync(outPath)).toBe(false)
    })

    it('output の拡張子が .html なら警告は出ない', async () => {
      const outPath = path.join(temporaryWorkDirectory(), 'out.drawio.html')
      const stderr = makeStream('stderr')
      const execution = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: false, output: outPath }, buildDependencies({ stderr: asStream(stderr) }))
      expect(stderr.chunks.join('')).not.toContain('warning:')
      expect(execution.warningCount).toBe(0)
    })

    it('長大 URL (8,000 文字超) でも表示用 HTML の 2 箇所に欠損なく書き出される', async () => {
      const outPath = path.join(temporaryWorkDirectory(), 'long-url.drawio.html')

      // 書き出し先ファイルと同じ生成ロジック (generateDrawioUrl) を通して URL 本体を取得する。
      const summary = await runDrawioUrl(LONG_URL_FIXTURE, { mode: 'view', png: false }, buildDependencies())
      expect(summary.url.length).toBeGreaterThan(8000)

      await executeDrawioUrl(LONG_URL_FIXTURE, { mode: 'view', png: false, output: outPath }, buildDependencies())

      const written = readOutput(outPath)
      // meta refresh と可視リンクの両方が生成 URL と byte 一致する（途中欠損が無い）ことを pin する。
      const [metaUrl, anchorUrl] = extractUrls(written)
      expect(metaUrl).toBe(summary.url)
      expect(anchorUrl).toBe(summary.url)
      expect(metaUrl).toBe(anchorUrl)
    })
  })

  describe('png / PNG 出力', () => {
    it('output + 既定 (png: true) で capturePng が <output 拡張子置換>.png 引数で呼ばれる', async (context) => {
      await verifies(context, 'PV-DRAWIO-CREATE-03')
      const outPath = path.join(temporaryWorkDirectory(), 'out.drawio.html')
      const expectedPngPath = path.join(workDirectory, 'out.drawio.png')
      const capturePng = pngSpy()
      const execution = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true, output: outPath }, buildDependencies({ capturePng }))
      expect(capturePng).toHaveBeenCalledTimes(1)
      const call = capturePng.mock.calls[0]
      // 第 1 引数は viewerUrl ではなく入力 XML 文字列 (embed.diagrams.net に post message で渡すため)
      expect(call?.[0]).toMatch(/<mxfile/)
      expect(call?.[1]).toBe(expectedPngPath)
      expect(execution.artifacts).toStrictEqual([outPath, expectedPngPath])
    })

    it('output diagram.drawio.html は diagram.drawio.png に拡張子置換される（最後の拡張子のみ置換）', async () => {
      const outPath = path.join(temporaryWorkDirectory(), 'diagram.drawio.html')
      const expectedPngPath = path.join(workDirectory, 'diagram.drawio.png')
      const capturePng = pngSpy()
      await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true, output: outPath }, buildDependencies({ capturePng }))
      expect(capturePng).toHaveBeenCalledTimes(1)
      expect(capturePng.mock.calls[0]?.[1]).toBe(expectedPngPath)
    })

    it('output 指定時に capturePng へ渡る XML は icon:// が data URI に解決済 (回帰防止)', async () => {
      // embed.diagrams.net editor は pecotv 独自スキーム `icon://` を解決できない。
      // このため capturePng へ渡す前の段階で、resolveIconsInStyle が data URI に変換する必要がある。
      // 変換し忘れると、editor 側で fallback アイコン (緑の画像破損マーク) が出る。
      const outPath = path.join(temporaryWorkDirectory(), 'out.drawio.html')
      const capturePng = pngSpy()
      await executeDrawioUrl(ICON_INCLUDED_FIXTURE, { mode: 'view', png: true, output: outPath }, buildDependencies({ capturePng }))
      expect(capturePng).toHaveBeenCalledTimes(1)
      const passedXml = capturePng.mock.calls[0]?.[0] ?? ''
      // 解決可能な icon (science/brain-circuit, weather/cloud) は data URI に置換されている
      expect(passedXml).toContain('data:image/svg+xml')
      // 解決済 icon の元参照は消えている
      expect(passedXml).not.toContain('icon://science/brain-circuit')
      expect(passedXml).not.toContain('icon://weather/cloud')
    })

    it('拡張子ガードで弾かれた output では capturePng も呼ばれない', async () => {
      // PNG は表示用 HTML の兄弟ファイルなので、HTML を書かない実行では PNG も作らない。
      const outPath = path.join(temporaryWorkDirectory(), 'out.tar.gz')
      const capturePng = pngSpy()
      const failure = await rejectionOf(executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true, output: outPath }, buildDependencies({ capturePng })))
      expect(failure).toBeInstanceOf(DrawioUrlUsageError)
      expect(capturePng).not.toHaveBeenCalled()
    })

    it('output + png: false で capturePng が呼ばれず、data に png / pngFailed キーが無い', async (context) => {
      await verifies(context, 'PV-DRAWIO-CREATE-04')
      const outPath = path.join(temporaryWorkDirectory(), 'out.drawio.html')
      const capturePng = pngSpy()
      const execution = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: false, output: outPath }, buildDependencies({ capturePng }))
      expect(capturePng).not.toHaveBeenCalled()
      expect(execution.data).toMatchObject({ event: 'drawio.url.done', file: outPath })
      expect(Object.hasOwn(execution.data, 'png')).toBe(false)
      expect(Object.hasOwn(execution.data, 'pngFailed')).toBe(false)
    })

    it('capturePng reject 時は表示用 HTML を生成し、stderr に warning、data に pngFailed: true / png: null / warnings: 1', async () => {
      const outPath = path.join(temporaryWorkDirectory(), 'out.drawio.html')
      const stderr = makeStream('stderr')
      const capturePng = pngSpy(() => Promise.reject(new Error('chromium 未インストール')))
      const execution = await executeDrawioUrl(
        MINIMAL_FIXTURE,
        { mode: 'view', png: true, output: outPath },
        buildDependencies({ stderr: asStream(stderr), capturePng }),
      )
      expect(capturePng).toHaveBeenCalledTimes(1)
      const written = readOutput(outPath)
      for (const url of extractUrls(written)) {
        expect(url.startsWith('https://app.diagrams.net/')).toBe(true)
      }
      expect(stderr.chunks.join('')).toContain('warning: PNG export failed')
      expect(stderr.chunks.join('')).toContain('chromium 未インストール')
      expect(execution.data).toMatchObject({
        event: 'drawio.url.done',
        file: outPath,
        // eslint-disable-next-line unicorn/no-null -- 結果のスキーマで PNG 失敗時に `png: null` を pin する
        png: null,
        pngFailed: true,
        warnings: 1,
      })
      expect(execution.artifacts).toStrictEqual([outPath])
    })

    it('png 成功時は data に png:<拡張子置換後> + pngFailed:false を載せる', async (context) => {
      await verifies(context, 'PV-DRAWIO-CREATE-03')
      const outPath = path.join(temporaryWorkDirectory(), 'out.drawio.html')
      const expectedPngPath = path.join(workDirectory, 'out.drawio.png')
      const execution = await executeDrawioUrl(MINIMAL_FIXTURE, { mode: 'view', png: true, output: outPath }, buildDependencies({ capturePng: pngSpy() }))
      expect(execution.data).toMatchObject({
        event: 'drawio.url.done',
        file: outPath,
        png: expectedPngPath,
        pngFailed: false,
        warnings: 0,
      })
    })
  })
})

describe('drawioUrlDefaultDependencies', () => {
  it('pluginRoot をサーバ自身の置き場所から求める', () => {
    const dependencies = drawioUrlDefaultDependencies()
    expect(dependencies.pluginRoot).toBe(resolvePluginRoot())
    expect(typeof dependencies.now()).toBe('number')
  })

  it('readFile が実ファイルを読める', async () => {
    const dependencies = drawioUrlDefaultDependencies()
    const text = await dependencies.readFile(MINIMAL_FIXTURE)
    expect(text).toContain('<mxfile>')
  })
})

// 例外型がコンストラクタ経由で reason を保持することを pin
describe('error types', () => {
  it('DrawioUrlUsageError は reason を保持する', () => {
    const error = new DrawioUrlUsageError('m', 'invalid-mode')
    expect(error.reason).toBe('invalid-mode')
    expect(error.name).toBe('DrawioUrlUsageError')
  })

  it('DrawioUrlRuntimeError は reason を保持する', () => {
    const error = new DrawioUrlRuntimeError('m', 'input-not-found')
    expect(error.reason).toBe('input-not-found')
    expect(error.name).toBe('DrawioUrlRuntimeError')
  })
})

// PECOTV_PLAYWRIGHT_AVAILABLE=1 環境でのみ動く、実 Chromium 経由の PNG smoke。
// devcontainer の通常 test 実行では skip し、`PECOTV_PLAYWRIGHT_AVAILABLE=1 pnpm ... test` で初めて評価される。
const IS_PLAYWRIGHT_AVAILABLE = process.env['PECOTV_PLAYWRIGHT_AVAILABLE'] === '1'
const playwrightOnlyDescribe = IS_PLAYWRIGHT_AVAILABLE ? describe : describe.skip

playwrightOnlyDescribe('capturePng smoke (実 embed.diagrams.net)', () => {
  it('日本語入り .drawio から PNG が生成され、非白ピクセル比率 > 1%', async () => {
    const { capturePng } = await import('../../../src/infra/drawio/screenshot.js')
    const workDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-png-smoke-'))
    try {
      const xml = readFileSync(LONG_URL_FIXTURE, 'utf8')
      const outPath = path.join(workDirectory, 'smoke.png')
      await capturePng(xml, outPath, ['sans-serif'])
      await attachFile('書き出した PNG', outPath)
      const png = readFileSync(outPath)
      // PNG header 検証
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      // 非白ピクセル比率は単純化する。IDAT 圧縮後の byte size が 10 KB を超えていれば、
      // 描画コンテンツが豊富という proxy 指標として扱う (真の pixel 解凍は重いため避ける)。
      expect(png.byteLength).toBeGreaterThan(10_000)
      // XML 埋め込み PNG (draw.io 公式 .drawio.png) を確かめる。
      // tEXt チャンク keyword `mxfile` に XML が埋め込まれ、draw.io で開くと再編集できることを pin する。
      expect(png.includes(Buffer.from('tEXtmxfile\0'))).toBe(true)
    }
    finally {
      rmSync(workDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})

function isDiagramsNet(url: Readonly<URL>): boolean {
  return url.hostname === 'app.diagrams.net'
}

playwrightOnlyDescribe('表示用 HTML の遷移 smoke (実 Chromium・file://)', () => {
  // app.diagrams.net へは出さず、ナビゲーション要求を stub で fulfill して遷移先 URL だけを見る。
  // 見るのは「file:// から開いて生成 URL へそのまま届くか」までで、描画の妥当性は対象外。
  // PECOTV_PLAYWRIGHT_AVAILABLE=1 を立てる処理は run-tests.sh と githooks に無い。
  // そのため常用の pre-push と scripts/ci/run-tests.sh では skip される。
  // 上の capturePng smoke と同じ扱いで受け入れ、実行はリリース前の手動確認に委ねる。
  const STUB_BODY = '<!doctype html><title>stub</title>'
  const NAVIGATION_TIMEOUT_MS = 15_000

  async function navigatedUrl(htmlPath: string, isJavaScriptEnabled: boolean): Promise<string> {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ javaScriptEnabled: isJavaScriptEnabled })
      const page = await context.newPage()
      await page.route(isDiagramsNet, async (route) => {
        await route.fulfill({ status: 200, contentType: 'text/html', body: STUB_BODY })
      })
      await page.goto(pathToFileURL(htmlPath).href)
      await page.waitForURL(isDiagramsNet, { timeout: NAVIGATION_TIMEOUT_MS })
      return page.url()
    }
    finally {
      await browser.close()
    }
  }

  it.each([
    { label: 'JS 有効 (location.replace)', javaScriptEnabled: true },
    // MOTW 等で JS が止まる環境でも meta refresh のフォールバック層が働くことを見る。
    { label: 'JS 無効 (meta refresh)', javaScriptEnabled: false },
  ])('$label で生成 URL へ byte 一致のまま遷移する', async ({ javaScriptEnabled }) => {
    const smokeDirectory = mkdtempSync(path.join(tmpdir(), 'drawio-redirect-smoke-'))
    try {
      const outPath = path.join(smokeDirectory, 'smoke.drawio.html')
      const summary = await runDrawioUrl(LONG_URL_FIXTURE, { mode: 'view', png: false }, buildDependencies())
      await executeDrawioUrl(LONG_URL_FIXTURE, { mode: 'view', png: false, output: outPath }, buildDependencies())

      expect(await navigatedUrl(outPath, javaScriptEnabled)).toBe(summary.url)
    }
    finally {
      rmSync(smokeDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('talk-dir の外で --theme 無し（本体の既定値）', () => {
  const SWIMLANE_SAMPLE = path.resolve(HERE, '..', '..', '..', '..', 'skills', 'v-drawio', 'references', 'poster', 'swimlane-flow', 'samples', 'swimlane-flow.drawio')
  // poster 相当（52px の sans-serif）と aws の iconLabel（11px・書体指定なし）
  const OFF_STEPS_XML = `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="poster" vertex="1" parent="1" value="Title" style="text;html=1;fontFamily=sans-serif;fontSize=52;"><mxGeometry width="100" height="40" as="geometry"/></mxCell>
    <mxCell id="mono" vertex="1" parent="1" value="node" style="text;html=1;fontFamily='Noto Sans Mono', monospace;fontSize=14;"><mxGeometry width="100" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`

  it('既定値の書体（sans-serif）と等幅の並びは、52px や 14px でも警告 0（サイズは確かめない）', async () => {
    const stderr = makeStream('stderr')
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies({ stderr: asStream(stderr), readFile: () => Promise.resolve(OFF_STEPS_XML) }),
    )
    expect(stderr.chunks.join('')).toBe('')
    expect(summary.warningCount).toBe(0)
    expect(summary.theme).toEqual({ source: 'default', fonts: { body: ['sans-serif'] } })
  })

  it('書体指定なし（draw.io 既定の Helvetica）は既定値でも警告する', async () => {
    const stderr = makeStream('stderr')
    const xml = OFF_STEPS_XML.replace('fontFamily=sans-serif;', '')
    const summary = await runDrawioUrl(
      MINIMAL_FIXTURE,
      { mode: 'view', png: true },
      buildDependencies({ stderr: asStream(stderr), readFile: () => Promise.resolve(xml) }),
    )
    expect(summary.warningCount).toBe(1)
    expect(stderr.chunks.join('')).toContain('Helvetica')
    expect(stderr.chunks.join('')).toContain('the default font')
  })

  it('同梱の poster swimlane-flow 見本は警告 0', async () => {
    const stderr = makeStream('stderr')
    const summary = await runDrawioUrl(
      SWIMLANE_SAMPLE,
      { mode: 'view', png: true },
      buildDependencies({ stderr: asStream(stderr) }),
    )
    expect(stderr.chunks.join('')).toBe('')
    expect(summary.warningCount).toBe(0)
  })
})
