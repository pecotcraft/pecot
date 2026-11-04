// drawio 系 MCP ツール (drawio_create / drawio_export) のハンドラ単体テスト。
//
// ハンドラは deps を内部で組み立てる。CLAUDE_PLUGIN_ROOT 未設定でサーバ起動が落ちないための設計。
// そのため DI では差し替えられない。
// 代わりに実 fixture・一時ディレクトリ・失敗注入 env (PECOTV_FORCE_PNG_FAIL / PECOTV_FORCE_SVG_FAIL) で分岐を作る。
// 実 Chromium と embed.diagrams.net には到達しない。
//
// tools/list を通した契約 (パラメータ集合・description・annotations) は
// src/mcp/tests/contract.test.ts が持つ。ここは応答の中身だけを見る。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolCallContext } from '../../server.js'
import { isRecord } from '../../../../tests/_helpers/records.js'
import { useInstalledChromiumCache } from '../../../../tests/_helpers/chromium-cache.js'
import { copyFixtureTheme } from '../../../../tests/_helpers/theme-fixtures.js'
import { drawioExportTool, drawioCreateTool } from '../drawio.js'
import { compareStrings } from '../../../domain/_shared/compare-strings.js'

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
// cli/ → plugins/pecot-visual (既定 deps ファクトリが要求する CLAUDE_PLUGIN_ROOT)
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
const ICON_ROOT = path.join(PLUGIN_ROOT, 'assets', 'drawio-icons')
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures', 'drawio')
// 警告 0 件で URL を返す最小 fixture。
const MINIMAL = path.join(FIXTURES, 'minimal.drawio')
// icons root で解決できない icon:// を含む fixture (url では警告、export では失敗になる)。
const ICON_INCLUDED = path.join(FIXTURES, 'icon-included.drawio')
// icons root で全件解決できる fixture。
const ICON_RESOLVABLE = path.join(FIXTURES, 'icon-resolvable.drawio')

// ハンドラは呼び出し文脈を読まないが、ToolHandler の型が 2 引数を要求するため最小のフェイクを渡す。
const CALL: ToolCallContext = { signal: new AbortController().signal }

function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が返っていません')
  return data
}

const temporaryDirectories: string[] = []

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-test-drawio-'))
  temporaryDirectories.push(directory)
  return directory
}

// chromium 依存ツールの実行時ガードは、実行ホストの ~/.cache/ms-playwright を見る。
// 取得済みの一時ディレクトリへ向けて、判定を固定する。
// ガードそのものの検証は chromium-guard.test.ts が持つ。
useInstalledChromiumCache()

beforeEach(() => {
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// poster 相当: Inter の 52px。既定値では書体だけが外れ、テーマの宣言ではサイズも外れる。
function writePoster(): string {
  const inputPath = path.join(makeTemporaryDirectory(), 'poster.drawio')
  writeFileSync(inputPath, [
    '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>',
    '<mxCell id="p" vertex="1" parent="1" value="Title" style="text;fontFamily=Inter;fontSize=52;"><mxGeometry width="100" height="40" as="geometry"/></mxCell>',
    '</root></mxGraphModel></diagram></mxfile>',
  ].join(''))
  return inputPath
}

function makeThemeDirectory(): string {
  const directory = path.join(makeTemporaryDirectory(), 'theme')
  copyFixtureTheme('with-declaration', directory)
  return directory
}

describe('drawio_create', () => {
  it('相対パスは実処理を呼ばずに exitCode 2 で返す', async () => {
    // 存在しない相対パスを渡す。実処理まで進めば、「入力不在」の exitCode 1 が返る。
    // exitCode 2 が返れば、それが実行前に弾いた証拠となる。
    const result = await drawioCreateTool.handler({ input_path: 'tests/fixtures/drawio/minimal.drawio' }, CALL)
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(2)
    expect(structured['artifacts']).toEqual([])
    expect(dataOf(result)['invalidPaths']).toEqual(['input_path=tests/fixtures/drawio/minimal.drawio'])
  })

  it('out_path だけが相対でも弾く', async () => {
    const result = await drawioCreateTool.handler({ input_path: MINIMAL, out_path: 'out/diagram.drawio.html' }, CALL)

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)['invalidPaths']).toEqual(['out_path=out/diagram.drawio.html'])
  })

  it('out_path 省略時は URL だけを data に載せ、artifacts は空になる', async () => {
    const result = await drawioCreateTool.handler({ input_path: MINIMAL }, CALL)
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(structured['artifacts']).toEqual([])
    const data = dataOf(result)
    expect(Object.keys(data).toSorted(compareStrings)).toEqual(['event', 'theme', 'url', 'warnings'])
    expect(data['theme']).toEqual({ source: 'default', fonts: { body: ['sans-serif'] } })
    expect(data['event']).toBe('drawio.url.done')
    expect(data['url']).toEqual(expect.stringContaining('https://app.diagrams.net/'))
    expect(data['warnings']).toBe(0)
  })

  it('入力ファイル不在は reason input-not-found + exitCode 1 で返す', async () => {
    const result = await drawioCreateTool.handler(
      { input_path: path.join(makeTemporaryDirectory(), 'missing.drawio') },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(structured['artifacts']).toEqual([])
    expect(dataOf(result)).toMatchObject({ event: 'drawio.url.error', reason: 'input-not-found' })
    expect(structured['message']).toContain('pecotv drawio url:')
  })

  it('CLAUDE_PLUGIN_ROOT 未設定でも例外を投げず ok:false を返す', async () => {
    // 既定 deps ファクトリはここで throw する。ハンドラが捕まえ損ねると
    // SDK が包む未捕捉例外になり、structuredContent が返らなくなる。
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '')
    const result = await drawioCreateTool.handler({ input_path: MINIMAL }, CALL)
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(structured['message']).toContain('CLAUDE_PLUGIN_ROOT')
  })

  it('警告のある入力は ok:true のまま exitCode 3 になり、警告本文を stderr に載せる', async () => {
    const result = await drawioCreateTool.handler({ input_path: ICON_INCLUDED }, CALL)
    const structured = structuredOf(result)

    // 実行そのものは完了しているので ok は true のまま (exit 3 は警告の通知)。
    expect(result.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(3)
    expect(dataOf(result)['warnings']).toBe(1)
    expect(structured['stderr']).toContain('アイコンが見つかりません')
    expect(structured['message']).toContain('警告')
  })

  describe('theme', () => {
    it('theme 無しは既定値で書体だけを確かめる（52px は警告にしない）', async () => {
      const result = await drawioCreateTool.handler({ input_path: writePoster() }, CALL)
      expect(structuredOf(result)['exitCode']).toBe(3)
      expect(dataOf(result)['warnings']).toBe(1)
      expect(structuredOf(result)['stderr']).not.toContain('52px')
    })

    it('theme にテーマのパスを渡すと、その宣言で書体とサイズを確かめる', async () => {
      const result = await drawioCreateTool.handler({ input_path: writePoster(), theme: makeThemeDirectory() }, CALL)
      expect(structuredOf(result)['exitCode']).toBe(3)
      expect(dataOf(result)['warnings']).toBe(2)
      expect(structuredOf(result)['stderr']).toContain('52px')
      expect(dataOf(result)['theme']).toMatchObject({ source: 'option', name: 'slidev-theme-pecotv-test-declared' })
    })

    it('theme の file: に相対パスを渡すと実処理を呼ばずに invalid-option で弾く', async () => {
      const result = await drawioCreateTool.handler({ input_path: MINIMAL, theme: 'file:relative/theme' }, CALL)
      expect(result.isError).toBe(true)
      expect(structuredOf(result)['exitCode']).toBe(2)
      expect(dataOf(result)).toMatchObject({ event: 'drawio.url.error', reason: 'invalid-option' })
    })

    it('theme のパスが相対なら弾く（MCP サーバの作業ディレクトリは呼び出し元と異なる）', async () => {
      const result = await drawioCreateTool.handler({ input_path: MINIMAL, theme: 'relative/theme' }, CALL)
      expect(structuredOf(result)['exitCode']).toBe(2)
      expect(dataOf(result)).toMatchObject({ event: 'drawio.url.error', reason: 'invalid-option' })
    })

    it('解けないテーマは invalid-theme（exitCode 2）で返す', async () => {
      const empty = makeTemporaryDirectory()
      const result = await drawioCreateTool.handler({ input_path: MINIMAL, theme: empty }, CALL)
      expect(structuredOf(result)['exitCode']).toBe(2)
      expect(dataOf(result)).toMatchObject({ event: 'drawio.url.error', reason: 'invalid-theme' })
    })
  })

  it('png:false 指定の out_path は表示用 HTML だけを artifacts に載せる', async () => {
    const outPath = path.join(makeTemporaryDirectory(), 'out.drawio.html')
    const result = await drawioCreateTool.handler({ input_path: MINIMAL, out_path: outPath, png: false }, CALL)
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(structured['artifacts']).toEqual([outPath])
    expect(dataOf(result)).toEqual({ event: 'drawio.url.done', file: outPath, warnings: 0, theme: { source: 'default', fonts: { body: ['sans-serif'] } } })
    const written = readFileSync(outPath, 'utf8')
    expect(written.startsWith('<!doctype html>\n')).toBe(true)
    expect(written).toContain('<a id="target" href="https://app.diagrams.net/')
    expect(structured['message']).toContain('表示用 HTML')
    expect(structured['message']).toContain(outPath)
  })

  it('.html 以外の out_path は reason invalid-output-extension + exitCode 2 で弾く', async () => {
    const directory = makeTemporaryDirectory()
    const outPath = path.join(directory, 'out.drawio.url')
    const result = await drawioCreateTool.handler(
      { input_path: MINIMAL, out_path: outPath, png: false },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(2)
    expect(structured['artifacts']).toEqual([])
    expect(dataOf(result)).toMatchObject({ event: 'drawio.url.error', reason: 'invalid-output-extension' })
    expect(existsSync(outPath)).toBe(false)
  })

  it('PNG 生成が失敗しても表示用 HTML は残り、png:null / pngFailed:true になる', async () => {
    // 実 Chromium を起こさずに PNG 失敗ルートへ入るための失敗注入。
    vi.stubEnv('PECOTV_FORCE_PNG_FAIL', '1')
    const directory = makeTemporaryDirectory()
    const outPath = path.join(directory, 'out.drawio.html')
    const result = await drawioCreateTool.handler({ input_path: MINIMAL, out_path: outPath }, CALL)
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(3)
    // 生成できなかった PNG は artifacts に含めない。
    expect(structured['artifacts']).toEqual([outPath])
    expect(existsSync(path.join(directory, 'out.drawio.png'))).toBe(false)
    expect(dataOf(result)).toEqual({
      event: 'drawio.url.done',
      file: outPath,
      // eslint-disable-next-line unicorn/no-null -- CLI の --json と同形性を保つため PNG 失敗時は null を pin する
      png: null,
      pngFailed: true,
      warnings: 1,
      theme: { source: 'default', fonts: { body: ['sans-serif'] } },
    })
    expect(structured['stderr']).toContain('[warn] PNG 生成失敗')
  })
})

describe('drawio_export', () => {
  it('icons_dir が相対なら exitCode 2 で弾く', async () => {
    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: 'assets/drawio-icons' },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['exitCode']).toBe(2)
    expect(dataOf(result)['invalidPaths']).toEqual(['icons_dir=assets/drawio-icons'])
  })

  it('icons_dir 省略時は plugin-root 同梱のカタログを既定に使う', async () => {
    // 標準の指す先が別の root なら、解決できる icon の集合が変わり、合成ハッシュがずれる。
    const explicit = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, print_hash: true },
      CALL,
    )
    const omitted = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )

    expect(structuredOf(omitted)['ok']).toBe(true)
    expect(dataOf(omitted)['sourceSha256']).toBe(dataOf(explicit)['sourceSha256'])
  })

  it('icons_dir を明示すれば既定より優先される', async () => {
    // 空ディレクトリでは icon が 1 件も解決できず、合成ハッシュが既定と一致しない。
    const empty = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: makeTemporaryDirectory(), print_hash: true },
      CALL,
    )
    const omitted = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )

    expect(structuredOf(empty)['ok']).toBe(true)
    expect(dataOf(empty)['sourceSha256']).not.toBe(dataOf(omitted)['sourceSha256'])
  })

  it('CLAUDE_PLUGIN_ROOT 未設定でも既定の icons root は source 相対で解決する', async () => {
    // 単体配布ルートの `node dist/cli.js` 直叩きに対応する fallback ルート。
    const withEnvironment = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '')
    const withoutEnvironment = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )

    expect(structuredOf(withoutEnvironment)['ok']).toBe(true)
    expect(dataOf(withoutEnvironment)['sourceSha256']).toBe(dataOf(withEnvironment)['sourceSha256'])
  })

  it('CLAUDE_PLUGIN_ROOT を別ルートへ向けると既定の icons root もそちらへ移る', async () => {
    // 本ファイルの PLUGIN_ROOT と source 相対 fallback の解決先は同一ディレクトリなので、
    // env を無視する実装でも上の 3 本は通る。
    // env を「icon カタログを持たない fake plugin root」へ向ける。
    // 標準の icons root が env 側へ移る（= 1 件も解決できずハッシュが変わる）ことで、precedence を判別する。
    const bundled = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )
    // 「1 件も解決できない」ときのハッシュ。fake root の期待値をこちらで固定する。
    const unresolvable = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: makeTemporaryDirectory(), print_hash: true },
      CALL,
    )

    vi.stubEnv('CLAUDE_PLUGIN_ROOT', makeTemporaryDirectory())
    const fromFakeRoot = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )

    expect(structuredOf(fromFakeRoot)['ok']).toBe(true)
    expect(dataOf(fromFakeRoot)['sourceSha256']).not.toBe(dataOf(bundled)['sourceSha256'])
    expect(dataOf(fromFakeRoot)['sourceSha256']).toBe(dataOf(unresolvable)['sourceSha256'])
  })

  it('print_hash:true は export と書き出しのどちらも行わずハッシュだけを返す', async () => {
    const outPath = path.join(makeTemporaryDirectory(), 'out.svg')
    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: outPath, print_hash: true },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(structured['artifacts']).toEqual([])
    expect(existsSync(outPath)).toBe(false)
    const data = dataOf(result)
    expect(Object.keys(data).toSorted(compareStrings)).toEqual(['event', 'file', 'icons', 'sourceSha256'])
    expect(data['event']).toBe('drawio.export.hash')
    expect(data['file']).toBe(ICON_RESOLVABLE)
    expect(data['icons']).toBe(2)
    expect(data['sourceSha256']).toMatch(/^[\da-f]{64}$/)
    expect(structured['message']).toContain('合成ハッシュ')
  })

  it('解決できない icon:// があれば reason icon-unresolved + exitCode 1 で返す', async () => {
    const result = await drawioExportTool.handler(
      { input_path: ICON_INCLUDED, icons_dir: ICON_ROOT, out_path: path.join(makeTemporaryDirectory(), 'out.svg') },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(structured['artifacts']).toEqual([])
    expect(dataOf(result)).toMatchObject({ event: 'drawio.export.error', reason: 'icon-unresolved' })
  })

  it('入力ファイル不在は reason input-not-found + exitCode 1 で返す', async () => {
    const result = await drawioExportTool.handler(
      { input_path: path.join(makeTemporaryDirectory(), 'missing.drawio'), icons_dir: ICON_ROOT },
      CALL,
    )

    expect(dataOf(result)).toMatchObject({ event: 'drawio.export.error', reason: 'input-not-found' })
    expect(structuredOf(result)['exitCode']).toBe(1)
  })

  it('export 失敗は reason export-failed + exitCode 1 で返す', async () => {
    // 実 Chromium / embed.diagrams.net を起こさずに export 失敗ルートへ入るための失敗注入。
    vi.stubEnv('PECOTV_FORCE_SVG_FAIL', '1')
    const outPath = path.join(makeTemporaryDirectory(), 'out.svg')
    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: outPath },
      CALL,
    )

    expect(dataOf(result)).toMatchObject({ event: 'drawio.export.error', reason: 'export-failed' })
    expect(structuredOf(result)['exitCode']).toBe(1)
    expect(existsSync(outPath)).toBe(false)
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */
