// drawio 系 MCP ツール (drawio_create / drawio_export) のハンドラ単体テスト。
//
// ハンドラは deps を内部で組み立てるので、DI では差し替えられない。
// 代わりに実 fixture・一時ディレクトリ・失敗注入 env (PECOTV_FORCE_PNG_FAIL / PECOTV_FORCE_SVG_FAIL) で分岐を作る。
// 実 Chromium と embed.diagrams.net には到達しない。
//
// tools/list を通した契約 (パラメータ集合・description・annotations) は
// src/mcp/tests/contract.test.ts が持つ。ここは応答の中身だけを見る。

/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolCallContext } from '../../server.js'
import { isRecord } from '../../../../tests/_helpers/records.js'
import { useInstalledChromiumCache } from '../../../../tests/_helpers/chromium-cache.js'
import { copyFixtureTheme } from '../../../../tests/_helpers/theme-fixtures.js'
import { drawioCreateTool as drawioCreateDefinition, drawioExportTool as drawioExportDefinition } from '../drawio.js'
import { withOutputCheck } from './_output.js'
import { compareStrings } from '../../../domain/_shared/compare-strings.js'
import { decodeData } from '../../../domain/drawio/url.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const drawioCreateTool = withOutputCheck(drawioCreateDefinition)
const drawioExportTool = withOutputCheck(drawioExportDefinition)

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
// cli/ → plugins/pecot-visual
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
  return structuredOf(result)
}

function sentenceOf(result: { readonly content?: unknown }): string {
  const content: unknown = result.content
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  return isRecord(first) && typeof first['text'] === 'string' ? first['text'] : ''
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
  it('相対パスは実処理を呼ばずに invalid-path で返す', async () => {
    // 存在しない相対パスを渡す。実処理まで進めば input-not-found が返る。invalid-path なら、実行前に弾いている。
    await explains('`drawio_create` の入力パスの検証のテストです。`input_path` に相対パスを指定した場合に、実処理に進まず `invalid-path` のエラーと、該当する指定の一覧を返すことを確認します。')
    const result = await drawioCreateTool.handler({ input_path: 'tests/fixtures/drawio/minimal.drawio' }, CALL)
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['kind']).toBe('invalid-path')
    expect(dataOf(result)['invalidPaths']).toEqual(['input_path=tests/fixtures/drawio/minimal.drawio'])
  })

  it('out_path だけが相対でも弾く', async () => {
    await explains('`drawio_create` の出力先パスの検証のテストです。`input_path` が絶対パスで `out_path` だけが相対パスの場合に、`invalid-path` のエラーを返し、`invalidPaths` に `out_path` の指定が入ることを確認します。')
    const result = await drawioCreateTool.handler({ input_path: MINIMAL, out_path: 'out/diagram.drawio.html' }, CALL)

    expect(structuredOf(result)['kind']).toBe('invalid-path')
    expect(dataOf(result)['invalidPaths']).toEqual(['out_path=out/diagram.drawio.html'])
  })

  it('out_path 省略時は URL だけを返し、file を持たない', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-01')
    await explains('`drawio_create` の出力先を省略した場合のテストです。`out_path` を省略したときに、`file` を含まず `event`・`theme`・`url` だけを持つ結果を返し、既定のテーマが使われることを確認します。')
    const result = await drawioCreateTool.handler({ input_path: MINIMAL }, CALL)
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured).not.toHaveProperty('kind')
    const data = dataOf(result)
    expect(Object.keys(data).toSorted(compareStrings)).toEqual(['event', 'theme', 'url'])
    expect(data['theme']).toEqual({ source: 'default', fonts: { body: ['sans-serif'] } })
    expect(data['event']).toBe('drawio.url.done')
    expect(data['url']).toEqual(expect.stringContaining('https://app.diagrams.net/'))
  })

  it('icon:// を含む入力は、URL に載る図の XML で icon がデータ URI に解決される', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-01')
    await explains('`drawio_create` が `icon://` を解決するテストです。`icon://` を含む図を渡した場合に、URL に埋め込まれた図の XML で、アイコンが `data:image/svg+xml` の URL に置き換えられることを確認します。')
    const result = await drawioCreateTool.handler({ input_path: ICON_RESOLVABLE }, CALL)
    const url = dataOf(result)['url']
    if (typeof url !== 'string') throw new TypeError('url が文字列ではありません')

    const xml = decodeData(url.slice(url.indexOf('#R') + 2))
    expect(xml).toContain('data:image/svg+xml')
    expect(xml).not.toContain('icon://')
  })

  it('入力ファイルが無いと、kind input-not-found で返す', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-09')
    await explains('`drawio_create` の入力ファイルの検証のテストです。`input_path` で存在しないファイルを指定した場合に、`input-not-found` のエラーと `pecotv drawio url:` で始まる文を返すことを確認します。')
    const result = await drawioCreateTool.handler(
      { input_path: path.join(makeTemporaryDirectory(), 'missing.drawio') },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ event: 'drawio.url.error', kind: 'input-not-found' })
    expect(sentenceOf(result)).toContain('drawio_create:')
  })

  it('警告のある入力は、成功のまま警告本文を warnings に載せる', async () => {
    await explains('`drawio_create` の警告の扱いのテストです。解決できない `icon://` を含む入力の場合に、エラーにはせず成功のまま、警告の本文を `warnings` に載せ、`1 warnings` を含む文を返すことを確認します。')
    const result = await drawioCreateTool.handler({ input_path: ICON_INCLUDED }, CALL)
    const structured = structuredOf(result)

    // 実行そのものは完了しているので isError を立てない。
    expect(result.isError).toBeUndefined()
    expect(structured).not.toHaveProperty('kind')
    expect(structured['warnings']).not.toEqual([])
    expect(dataOf(result)['warnings']).toEqual([expect.stringContaining('icon not found')])
    expect(structured).not.toHaveProperty('stderr')
    expect(sentenceOf(result)).toContain('1 warnings')
  })

  describe('theme', () => {
    it('theme 無しは既定値で書体だけを確かめる（52px は警告にしない）', async () => {
      await explains('`drawio_create` の `theme` を省略した場合の検証のテストです。`theme` を省略すると既定値で書体だけが検証され、52px の文字サイズは警告にならず、警告が 1 件だけ返ることを確認します。')
      const result = await drawioCreateTool.handler({ input_path: writePoster() }, CALL)
      expect(structuredOf(result)['warnings']).not.toEqual([])
      expect(dataOf(result)['warnings']).toHaveLength(1)
      expect(String(dataOf(result)['warnings'])).not.toContain('52px')
    })

    it('theme にテーマのパスを渡すと、その宣言で書体とサイズを確かめる', async () => {
      await explains('`drawio_create` の `theme` でテーマのパスを指定した場合のテストです。テーマの宣言で書体と文字サイズの両方が検証され、警告が 2 件になり、結果の `theme` に指定したテーマの名前が入ることを確認します。')
      const result = await drawioCreateTool.handler({ input_path: writePoster(), theme: makeThemeDirectory() }, CALL)
      expect(structuredOf(result)['warnings']).not.toEqual([])
      expect(dataOf(result)['warnings']).toHaveLength(2)
      expect(sentenceOf(result)).toContain('(2 warnings; see warnings)')
      expect(String(dataOf(result)['warnings'])).toContain('52px')
      expect(dataOf(result)['theme']).toMatchObject({ source: 'option', name: 'slidev-theme-pecotv-test-declared' })
    })

    it('theme の file: に相対パスを渡すと実処理を呼ばずに invalid-option で弾く', async () => {
      await explains('`drawio_create` の `theme` の形式の検証のテストです。`theme` に `file:` つきの相対パスを指定した場合に、実処理に進まず `invalid-option` のエラーを返すことを確認します。')
      const result = await drawioCreateTool.handler({ input_path: MINIMAL, theme: 'file:relative/theme' }, CALL)
      expect(result.isError).toBe(true)
      expect(structuredOf(result)).toMatchObject({ event: 'drawio.url.error', kind: 'invalid-option' })
    })

    it('theme のパスが相対なら弾く（MCP サーバの作業ディレクトリは呼び出し元と異なる）', async () => {
      await explains('`drawio_create` の `theme` のパスの検証のテストです。MCP サーバの作業ディレクトリは呼び出し元と異なるため、相対パスを指定した場合に `invalid-option` のエラーを返すことを確認します。')
      const result = await drawioCreateTool.handler({ input_path: MINIMAL, theme: 'relative/theme' }, CALL)
      expect(structuredOf(result)).toMatchObject({ event: 'drawio.url.error', kind: 'invalid-option' })
    })

    it('解けないテーマは invalid-theme で返す', async () => {
      await explains('`drawio_create` のテーマの解決のテストです。テーマの宣言を持たない空のディレクトリを `theme` で指定した場合に、`invalid-theme` のエラーを返すことを確認します。')
      const empty = makeTemporaryDirectory()
      const result = await drawioCreateTool.handler({ input_path: MINIMAL, theme: empty }, CALL)
      expect(structuredOf(result)).toMatchObject({ event: 'drawio.url.error', kind: 'invalid-theme' })
    })
  })

  it('png:false 指定の out_path は表示用 HTML だけを file に載せ、png を持たない', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-02')
    await explains('`drawio_create` の PNG を出力しない指定のテストです。`png: false` と `out_path` を指定した場合に、表示用の HTML だけが書き出され、結果の `file` にそのパスが入り、`png` を含まないことを確認します。')
    await verifies(context, 'PV-DRAWIO-CREATE-04')
    const outPath = path.join(makeTemporaryDirectory(), 'out.drawio.html')
    const result = await drawioCreateTool.handler({ input_path: MINIMAL, out_path: outPath, png: false }, CALL)
    const structured = structuredOf(result)

    expect(structured).not.toHaveProperty('kind')
    expect(structured['file']).toBe(outPath)
    expect(dataOf(result)).toEqual({ event: 'drawio.url.done', file: outPath, theme: { source: 'default', fonts: { body: ['sans-serif'] } } })
    const written = readFileSync(outPath, 'utf8')
    expect(written.startsWith('<!doctype html>\n')).toBe(true)
    expect(written).toContain('<a id="target" href="https://app.diagrams.net/')
    expect(sentenceOf(result)).toContain('wrote drawio viewer HTML')
    expect(sentenceOf(result)).toContain(outPath)
  })

  it('.html 以外の out_path は invalid-output-extension で弾く', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-08')
    await explains('`drawio_create` の出力先の拡張子の検証のテストです。`out_path` の拡張子が `.html` 以外の場合に、`invalid-output-extension` のエラーを返し、ファイルを書き出さないことを確認します。')
    const directory = makeTemporaryDirectory()
    const outPath = path.join(directory, 'out.drawio.url')
    const result = await drawioCreateTool.handler(
      { input_path: MINIMAL, out_path: outPath, png: false },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ event: 'drawio.url.error', kind: 'invalid-output-extension' })
    expect(existsSync(outPath)).toBe(false)
  })

  it('PNG 生成が失敗しても表示用 HTML は残り、png:null / pngFailed:true になる', async (context) => {
    await verifies(context, 'PV-DRAWIO-CREATE-06')
    // 実 Chromium を起こさずに PNG 失敗ルートへ入るための失敗注入。
    await explains('`drawio_create` の PNG の生成に失敗した場合のテストです。`PECOTV_FORCE_PNG_FAIL=1` を指定すると、表示用の HTML は書き出され、`png` が `null`、`pngFailed` が `true` になり、警告が載ることを確認します。')
    vi.stubEnv('PECOTV_FORCE_PNG_FAIL', '1')
    const directory = makeTemporaryDirectory()
    const outPath = path.join(directory, 'out.drawio.html')
    const result = await drawioCreateTool.handler({ input_path: MINIMAL, out_path: outPath }, CALL)
    const structured = structuredOf(result)

    expect(structured).not.toHaveProperty('kind')
    expect(structured['warnings']).not.toEqual([])
    // 生成できなかった PNG は png に載せない。
    expect(structured['file']).toBe(outPath)
    expect(existsSync(path.join(directory, 'out.drawio.png'))).toBe(false)
    expect(dataOf(result)).toEqual({
      event: 'drawio.url.done',
      file: outPath,
      // eslint-disable-next-line unicorn/no-null -- CLI の --json と同形性を保つため PNG 失敗時は null を pin する
      png: null,
      pngFailed: true,
      warnings: [expect.stringContaining('PNG export failed')],
      theme: { source: 'default', fonts: { body: ['sans-serif'] } },
    })
  })
})

describe('drawio_export', () => {
  it('icons_dir が相対なら invalid-path で弾く', async () => {
    await explains('`drawio_export` のアイコンのディレクトリの検証のテストです。`icons_dir` に相対パスを指定した場合に、`invalid-path` のエラーと、該当する指定の一覧を返すことを確認します。')
    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: 'assets/drawio-icons' },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['kind']).toBe('invalid-path')
    expect(dataOf(result)['invalidPaths']).toEqual(['icons_dir=assets/drawio-icons'])
  })

  it('icons_dir が空文字なら、invalid-path で弾き、missing-icons-root は返さない', async () => {
    await explains('`drawio_export` のアイコンのディレクトリの検証のテストです。`icons_dir` が空文字の場合に、`invalid-path` のエラーを返し、`missing-icons-root` は返さないことを確認します。')
    const result = await drawioExportTool.handler({ input_path: ICON_RESOLVABLE, icons_dir: '' }, CALL)
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['kind']).toBe('invalid-path')
    expect(dataOf(result)['invalidPaths']).toEqual(['icons_dir='])
    expect(structuredOf(result)['kind']).toBe('invalid-path')
    expect(structuredOf(result)['detail']).toBe(sentenceOf(result))
  })

  it('icons_dir 省略時は plugin-root 同梱のカタログを既定に使う', async () => {
    // 標準の指す先が別の root なら、解決できる icon の集合が変わり、合成ハッシュがずれる。
    await explains('`drawio_export` のアイコンのディレクトリの既定値のテストです。`icons_dir` を省略した場合に、プラグインに同梱されたカタログが使われ、明示した場合と同じ `sourceSha256` になることを確認します。')
    const explicit = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, print_hash: true },
      CALL,
    )
    const omitted = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )

    expect(structuredOf(omitted)).not.toHaveProperty('kind')
    expect(dataOf(omitted)['sourceSha256']).toBe(dataOf(explicit)['sourceSha256'])
  })

  it('icons_dir を明示すれば既定より優先される', async () => {
    // 空ディレクトリでは icon が 1 件も解決できず、合成ハッシュが既定と一致しない。
    await explains('`drawio_export` のアイコンのディレクトリの優先順位のテストです。`icons_dir` を明示した場合に既定のカタログより優先され、空のディレクトリを指定するとアイコンは解決されず、`sourceSha256` の値が変わることを確認します。')
    const empty = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: makeTemporaryDirectory(), print_hash: true },
      CALL,
    )
    const omitted = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )

    expect(structuredOf(empty)).not.toHaveProperty('kind')
    expect(dataOf(empty)['sourceSha256']).not.toBe(dataOf(omitted)['sourceSha256'])
  })

  it('CLAUDE_PLUGIN_ROOT を別ルートへ向けても、既定の icons root は同梱のまま', async () => {
    await explains('`drawio_export` の既定のアイコンのディレクトリのテストです。`CLAUDE_PLUGIN_ROOT` がカタログを持たない別のディレクトリを指す場合も、同梱のカタログが使われ、既定の場合と同じ `sourceSha256` になることを確認します。')
    // npx で起動したサーバに渡る CLAUDE_PLUGIN_ROOT は、アセットを持たない入れたプラグインのディレクトリを指す。
    const bundled = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', makeTemporaryDirectory())
    const fromFakeRoot = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, print_hash: true },
      CALL,
    )

    expect(structuredOf(fromFakeRoot)).not.toHaveProperty('kind')
    expect(dataOf(fromFakeRoot)['sourceSha256']).toBe(dataOf(bundled)['sourceSha256'])
  })

  it('print_hash:true は export と書き出しのどちらも行わずハッシュだけを返す', async (context) => {
    await verifies(context, 'PV-DRAWIO-EXPORT-03')
    await explains('`drawio_export` のハッシュだけを求める指定のテストです。`print_hash: true` を指定した場合に、書き出しを行わず、`event`・`file`・`icons`・`sourceSha256` だけを持つ結果を返すことを確認します。')
    const outPath = path.join(makeTemporaryDirectory(), 'out.svg')
    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: outPath, print_hash: true },
      CALL,
    )
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured).not.toHaveProperty('kind')
    expect(existsSync(outPath)).toBe(false)
    const data = dataOf(result)
    expect(Object.keys(data).toSorted(compareStrings)).toEqual(['event', 'file', 'icons', 'sourceSha256'])
    expect(data['event']).toBe('drawio.export.hash')
    expect(data['file']).toBe(ICON_RESOLVABLE)
    expect(data['icons']).toBe(2)
    expect(data['sourceSha256']).toMatch(/^[\da-f]{64}$/)
    expect(sentenceOf(result)).toContain('computed composite hash')
  })

  it('解決できない icon:// があると、kind icon-unresolved で返す', async () => {
    await explains('`drawio_export` のアイコンの検証のテストです。解決できない `icon://` を含む入力の場合に、`icon-unresolved` のエラーを返すことを確認します。')
    const result = await drawioExportTool.handler(
      { input_path: ICON_INCLUDED, icons_dir: ICON_ROOT, out_path: path.join(makeTemporaryDirectory(), 'out.svg') },
      CALL,
    )

    expect(result.isError).toBe(true)
    expect(structuredOf(result)).toMatchObject({ event: 'drawio.export.error', kind: 'icon-unresolved' })
  })

  it('入力ファイルが無いと、kind input-not-found で返す', async () => {
    await explains('`drawio_export` の入力ファイルの検証のテストです。`input_path` で存在しないファイルを指定した場合に、`input-not-found` のエラーを返すことを確認します。')
    const result = await drawioExportTool.handler(
      { input_path: path.join(makeTemporaryDirectory(), 'missing.drawio'), icons_dir: ICON_ROOT },
      CALL,
    )

    expect(structuredOf(result)).toMatchObject({ event: 'drawio.export.error', kind: 'input-not-found' })
  })

  it('export が失敗すると、kind export-failed で返す', async (context) => {
    await verifies(context, 'PV-DRAWIO-EXPORT-05')
    // 実 Chromium / embed.diagrams.net を起こさずに export 失敗ルートへ入るための失敗注入。
    await explains('`drawio_export` の書き出しに失敗した場合のテストです。`PECOTV_FORCE_SVG_FAIL=1` を指定した場合に、`export-failed` のエラーを返し、SVG を書き出さないことを確認します。')
    vi.stubEnv('PECOTV_FORCE_SVG_FAIL', '1')
    const outPath = path.join(makeTemporaryDirectory(), 'out.svg')
    const result = await drawioExportTool.handler(
      { input_path: ICON_RESOLVABLE, icons_dir: ICON_ROOT, out_path: outPath },
      CALL,
    )

    expect(structuredOf(result)).toMatchObject({ event: 'drawio.export.error', kind: 'export-failed' })
    expect(existsSync(outPath)).toBe(false)
  })
})
/* eslint-enable security/detect-non-literal-fs-filename */
