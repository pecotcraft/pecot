// drawio url の書体・文字サイズの確認が、テーマの宣言（pecot-theme.json）から取る値で動くことを確かめる。
// 宣言の決め方は、--theme > 図の祖先の talk-dir > 本体の既定値の順。
// 実ファイルを一時ディレクトリに作り、モックはテーマの取得（fetchTheme）と PNG の撮影（capturePng）に限る。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てのみ */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DrawioUrlRuntimeError,
  DrawioUrlUsageError,
  createDrawioUrlCommand,
  errorToReason,
  executeDrawioUrl,
  toExitCode,
} from '../../../src/commands/drawio/url.js'
import type { DrawioUrlDependencies } from '../../../src/commands/drawio/url.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { ThemeDeclarationError } from '../../../src/domain/slidev-theme/declaration.js'
import { ThemeFetchError } from '../../../src/domain/slidev-theme/store-layout.js'
import { ThemeResolveError } from '../../../src/domain/slidev-theme/talk-theme.js'
import { ThemeSpecError } from '../../../src/domain/slidev-theme/theme-spec.js'
import { defaultLintText } from '../../../src/infra/text-lint.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { asStream, makeStream } from '../../_helpers/talk-directory.js'
import { copyFixtureTheme } from '../../_helpers/theme-fixtures.js'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const TEST_THEME_NAME = 'slidev-theme-pecotv-test-declared'

type FetchTheme = NonNullable<DrawioUrlDependencies['fetchTheme']>
type CapturePng = DrawioUrlDependencies['capturePng']

const TEST_SANS = {
  schema: 1,
  fonts: { body: ['Test Sans'], heading: ['Test Sans'], eastAsian: 'Test Sans JP' },
  fontSizes: { heading: 18, headingSm: 15, body: 14, bodySm: 11, label: 10 },
}
// 既定の書体と同じ値の宣言
const TWO_FONTS = {
  schema: 1,
  fonts: { body: ['Inter', 'Noto Sans JP'], heading: ['Inter', 'Noto Sans JP'], eastAsian: 'Noto Sans JP' },
  fontSizes: { heading: 16, headingSm: 13, body: 12, bodySm: 10, label: 9 },
}

const STYLE = 'html=1;whiteSpace=wrap;fontFamily=Inter, Noto Sans JP;'
function cell(id: string, value: string, size: number, style = STYLE): string {
  return `<mxCell id="${id}" value="${value}" style="${style}fontSize=${String(size)};" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>`
}
function diagram(...cells: readonly string[]): string {
  return `<mxfile><diagram name="d"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`
}
// 書体とサイズだけを確かめる図: Alpha 14px、Beta 16px、構成 14px
const CHECK_XML = diagram(cell('s14', 'Alpha', 14), cell('s16', 'Beta', 16), cell('ja', '構成', 14))

const NO_STORE_ROOT = (): string | undefined => undefined

const state = { root: '', stderr: makeStream(), stdout: makeStream() }

beforeEach(() => {
  state.root = mkdtempSync(path.join(tmpdir(), 'pecotv-drawio-theme-'))
  state.stderr = makeStream()
  state.stdout = makeStream()
})

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  process.exitCode = undefined
})

function writeDiagram(directory: string, xml = CHECK_XML, name = 'check.drawio'): string {
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, name)
  writeFileSync(file, xml)
  return file
}

/**
fixture テーマの写し。declaration が null なら宣言を外す。
*/
function makeTheme(label: string, declaration: object = TEST_SANS): string {
  const directory = path.join(state.root, 'themes', label)
  copyFixtureTheme('with-declaration', directory)
  writeFileSync(path.join(directory, 'pecot-theme.json'), JSON.stringify(declaration))
  return directory
}

/**
theme を参照する talk-dir。node_modules にテーマの写しを置く。
*/
function makeTalk(name: string, themeRoot: string): string {
  const talk = path.join(state.root, name)
  mkdirSync(path.join(talk, 'node_modules'), { recursive: true })
  writeFileSync(path.join(talk, 'slides.md'), `---\ntheme: ${TEST_THEME_NAME}\n---\n\n# t\n`)
  writeFileSync(path.join(talk, 'package.json'), JSON.stringify({ name, dependencies: { [TEST_THEME_NAME]: `file:${themeRoot}` } }))
  cpSync(themeRoot, path.join(talk, 'node_modules', TEST_THEME_NAME), { recursive: true })
  return talk
}

function diagramIn(talk: string, xml = CHECK_XML): string {
  return writeDiagram(path.join(talk, 'public', 'slides', 'diagrams'), xml)
}

function dependencies(overrides: Partial<DrawioUrlDependencies> = {}): DrawioUrlDependencies {
  return {
    pluginRoot: PLUGIN_ROOT,
    stdout: asStream(state.stdout),
    stderr: asStream(state.stderr),
    readFile: file => Promise.resolve(readFileSync(file, 'utf8')),
    writeFile: (file, content) => {
      writeFileSync(file, content)
      return Promise.resolve()
    },
    capturePng: () => Promise.resolve(),
    lintText: defaultLintText,
    now: () => 0,
    themeStoreRoot: () => path.join(state.root, 'store'),
    dependencyRoot: PLUGIN_ROOT,
    currentDirectory: state.root,
    ...overrides,
  }
}

interface ThemeData {
  readonly source: string
  readonly name?: string
  readonly fonts: { readonly body: readonly string[], readonly eastAsian?: string }
  readonly fontSizes?: Readonly<Record<string, number>>
}

async function run(input: string, options: { readonly theme?: string } = {}, overrides: Partial<DrawioUrlDependencies> = {}) {
  const execution = await executeDrawioUrl(input, { mode: 'view', png: false, ...options }, dependencies(overrides))
  // eslint-disable-next-line no-restricted-syntax -- data.theme の形を narrowing
  const theme = execution.data['theme'] as ThemeData
  return { execution, theme, stderr: state.stderr.chunks.join('') }
}

function warnLines(stderr: string): readonly string[] {
  return stderr.split('\n').filter(line => line.startsWith('warning:'))
}

describe('宣言の値が違う 2 つのテーマの talk-dir', () => {
  it('Test Sans の talk-dir: 宣言の書体と 18/15/14/11/10 で確かめる', async () => {
    const talk = makeTalk('talk-test', makeTheme('test-sans'))
    const { execution, theme, stderr } = await run(diagramIn(talk))

    expect(theme).toEqual({
      source: 'talk-dir',
      name: TEST_THEME_NAME,
      fonts: { body: ['Test Sans'], eastAsian: 'Test Sans JP' },
      fontSizes: { heading: 18, headingSm: 15, body: 14, bodySm: 11, label: 10 },
    })
    const warnings = warnLines(stderr)
    // 3 セルすべての書体、ja の和文の書体、16px のサイズ
    expect(warnings.filter(line => line.includes('先頭書体'))).toHaveLength(3)
    expect(warnings.filter(line => line.includes('Test Sans JP がありません'))).toHaveLength(1)
    const sizeWarnings = warnings.filter(line => line.includes('規定外'))
    expect(sizeWarnings).toHaveLength(1)
    expect(sizeWarnings[0]).toContain('mxCell id=s16')
    expect(execution.exitCode).toBe(3)
    expect(execution.warningCount).toBe(warnings.length)
  })

  it('既定の書体と同じ値の talk-dir: 書体の警告は無く、サイズは 14px だけ外れる', async () => {
    const talk = makeTalk('talk-default-fonts', makeTheme('two-fonts', TWO_FONTS))
    const { execution, theme, stderr } = await run(diagramIn(talk))

    expect(theme).toEqual({
      source: 'talk-dir',
      name: TEST_THEME_NAME,
      fonts: { body: ['Inter', 'Noto Sans JP'], eastAsian: 'Noto Sans JP' },
      fontSizes: { heading: 16, headingSm: 13, body: 12, bodySm: 10, label: 9 },
    })
    const warnings = warnLines(stderr)
    expect(warnings.filter(line => line.includes('書体'))).toEqual([])
    expect(warnings.filter(line => line.includes('規定外')).map(line => /mxCell id=(\w+)/.exec(line)?.[1] ?? '').toSorted(compareStrings)).toEqual(['ja', 's14'])
    expect(execution.exitCode).toBe(3)
  })

  it('宣言に合う図は警告 0 で exit 0', async () => {
    const talk = makeTalk('talk-test', makeTheme('test-sans'))
    const xml = diagram(cell('a', 'Alpha', 14, 'html=1;fontFamily=Test Sans;'), cell('b', '構成', 18, 'html=1;whiteSpace=wrap;fontFamily=Test Sans, Test Sans JP;'))
    const { execution, stderr } = await run(diagramIn(talk, xml))
    expect(stderr).toBe('')
    expect(execution.exitCode).toBe(0)
  })
})

describe('talk-dir の外', () => {
  const POSTER = diagram(
    cell('big', 'Title', 52, 'html=1;fontFamily=Inter;'),
    cell('plain', 'Plain', 52, 'html=1;fontFamily=sans-serif;'),
  )

  it('--theme 無しは既定値で、書体だけを確かめる。data.theme に name と fontSizes を載せない', async () => {
    const input = writeDiagram(path.join(state.root, 'outside'), POSTER, 'poster.drawio')
    const { execution, theme, stderr } = await run(input)

    expect(theme).toEqual({ source: 'default', fonts: { body: ['sans-serif'] } })
    expect(warnLines(stderr)).toHaveLength(1)
    expect(stderr).toContain('mxCell id=big')
    expect(stderr).toContain('既定の書体')
    expect(stderr).not.toContain('52px')
    expect(execution.exitCode).toBe(3)
  })

  it('public/ の外の図は、祖先に slides.md があっても既定値', async () => {
    const talk = makeTalk('talk-test', makeTheme('test-sans'))
    const input = writeDiagram(path.join(talk, '.pecotv', 'work'), CHECK_XML)
    const { theme } = await run(input)
    expect(theme.source).toBe('default')
  })

  it('--theme にテーマの talk-dir を渡すと、その宣言で書体とサイズを確かめる', async () => {
    const talk = makeTalk('talk-test', makeTheme('test-sans'))
    const input = writeDiagram(path.join(state.root, 'outside'), POSTER, 'poster.drawio')
    const { theme, stderr } = await run(input, { theme: talk })

    expect(theme.source).toBe('option')
    expect(theme.name).toBe(TEST_THEME_NAME)
    expect(theme.fontSizes).toEqual(TEST_SANS.fontSizes)
    const warnings = warnLines(stderr)
    expect(warnings.some(line => line.includes('id=big') && line.includes('書体'))).toBe(true)
    expect(warnings.some(line => line.includes('id=big') && line.includes('52px'))).toBe(true)
    expect(warnings.some(line => line.includes('id=plain') && line.includes('書体'))).toBe(true)
    expect(warnings.some(line => line.includes('id=plain') && line.includes('52px'))).toBe(true)
  })

  it('--theme はテーマ root（pecot-theme.json を持つ dir）も受ける。相対パスは currentDirectory を基準にする', async () => {
    const themeRoot = makeTheme('test-sans')
    const input = writeDiagram(path.join(state.root, 'outside'), POSTER, 'poster.drawio')
    const { theme } = await run(input, { theme: path.relative(state.root, themeRoot) })
    expect(theme.source).toBe('option')
    expect(theme.name).toBe(TEST_THEME_NAME)
    expect(theme.fonts).toEqual({ body: ['Test Sans'], eastAsian: 'Test Sans JP' })
  })

  it('--theme file:<dir> は pecot-theme.json を直接読み、取得（install）を呼ばない', async () => {
    const themeRoot = makeTheme('test-sans')
    const fetchTheme = vi.fn<FetchTheme>().mockRejectedValue(new Error('呼ばれない'))
    const input = writeDiagram(path.join(state.root, 'outside'), POSTER, 'poster.drawio')
    const { theme } = await run(input, { theme: `file:${themeRoot}` }, { fetchTheme })

    expect(fetchTheme).not.toHaveBeenCalled()
    expect(theme).toMatchObject({ source: 'option', name: TEST_THEME_NAME, fontSizes: TEST_SANS.fontSizes })
  })

  it('--theme git+...#tag は fetchTheme で置き場から取り、signal と置き場を渡す。取得の警告は [info] で stderr へ', async () => {
    const themeRoot = makeTheme('test-sans')
    const fetchTheme = vi.fn<FetchTheme>().mockImplementation((_spec, options) => {
      options.warn?.('キャッシュを使います')
      return Promise.resolve({ name: TEST_THEME_NAME, directory: themeRoot, reused: true })
    })
    const controller = new AbortController()
    const input = writeDiagram(path.join(state.root, 'outside'), POSTER, 'poster.drawio')
    const spec = 'git+file:///themes/test-sans.git#v1.0.0'
    const { theme, stderr, execution } = await run(input, { theme: spec }, { fetchTheme, signal: controller.signal })

    expect(fetchTheme).toHaveBeenCalledTimes(1)
    const [passedSpec, passedOptions] = fetchTheme.mock.calls[0] ?? []
    expect(passedSpec).toEqual({ kind: 'git', url: 'file:///themes/test-sans.git', tag: 'v1.0.0' })
    expect(passedOptions).toMatchObject({ storeRoot: path.join(state.root, 'store'), dependencyRoot: PLUGIN_ROOT, signal: controller.signal })
    expect(theme).toMatchObject({ source: 'option', name: TEST_THEME_NAME, fontSizes: TEST_SANS.fontSizes })
    expect(stderr).toContain('note: キャッシュを使います')
    expect(warnLines(stderr).every(line => !line.includes('キャッシュ'))).toBe(true)
    expect(execution.warningCount).toBe(warnLines(stderr).length)
  })

  it('--theme は図の祖先の talk-dir より優先する', async () => {
    const talkTest = makeTalk('talk-test', makeTheme('test-sans'))
    const twoFonts = makeTheme('two-fonts', TWO_FONTS)
    const { theme } = await run(diagramIn(talkTest), { theme: twoFonts })
    expect(theme.source).toBe('option')
    expect(theme.fonts.body).toEqual(['Inter', 'Noto Sans JP'])
  })

  it('宣言の無いテーマは既定値で続け、欠落は [info] にして exit 3 の件数に数えない', async () => {
    const themeRoot = makeTheme('no-declaration')
    rmSync(path.join(themeRoot, 'pecot-theme.json'))
    const xml = diagram(cell('a', 'Alpha', 12, 'html=1;fontFamily=sans-serif;'))
    const input = writeDiagram(path.join(state.root, 'outside'), xml, 'a.drawio')
    const { theme, stderr, execution } = await run(input, { theme: `file:${themeRoot}` })

    expect(theme).toMatchObject({ source: 'option', name: TEST_THEME_NAME, fonts: { body: ['sans-serif'] }, fontSizes: { heading: 16, headingSm: 13, body: 12, bodySm: 10, label: 9 } })
    expect(stderr).toContain('note:')
    expect(stderr).toContain('pecot-theme.json')
    expect(warnLines(stderr)).toEqual([])
    expect(execution.exitCode).toBe(0)
  })

  it('schema 違いの宣言の警告も [info] で、exit 3 にしない', async () => {
    const themeRoot = makeTheme('future', { schema: 2 })
    const xml = diagram(cell('a', 'Alpha', 12, 'html=1;fontFamily=sans-serif;'))
    const input = writeDiagram(path.join(state.root, 'outside'), xml, 'a.drawio')
    const { stderr, execution } = await run(input, { theme: themeRoot })
    expect(stderr).toContain('note:')
    expect(warnLines(stderr)).toEqual([])
    expect(execution.exitCode).toBe(0)
  })
})

describe('移行前の talk-dir と、解けないテーマ', () => {
  it('theme: none の talk-dir は既定値で続け、[info] で slide sync --theme を案内する', async () => {
    const talk = path.join(state.root, 'talk-legacy')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n\n# t\n')
    const xml = diagram(cell('a', 'Alpha', 52, 'html=1;fontFamily=sans-serif;'))
    const output = path.join(talk, 'public', 'slides', 'diagrams', 'check.html')
    const input = diagramIn(talk, xml)
    const pngs: string[] = []
    const capturePng = vi.fn<CapturePng>().mockImplementation((_xml, png) => {
      pngs.push(png)
      return Promise.resolve()
    })
    const { theme, stderr, execution } = await run(input, {}, { capturePng })
    expect(theme).toEqual({ source: 'default', fonts: { body: ['sans-serif'] } })
    expect(stderr).toContain('note:')
    expect(stderr).toContain('slide sync --theme')
    expect(execution.exitCode).toBe(0)

    // 出力を書く場合でも止まらない
    const written = await executeDrawioUrl(input, { mode: 'view', png: true, output }, dependencies({ capturePng }))
    expect(existsSync(output)).toBe(true)
    expect(pngs).toEqual([path.join(path.dirname(output), 'check.png')])
    expect(written.exitCode).toBe(0)
  })

  it('theme-unlinked（node_modules にテーマが無い）は止まり、HTML と PNG を作らない', async () => {
    const talk = makeTalk('talk-unlinked', makeTheme('test-sans'))
    rmSync(path.join(talk, 'node_modules', TEST_THEME_NAME), { recursive: true })
    const input = diagramIn(talk)
    const output = path.join(path.dirname(input), 'check.html')
    const capturePng = vi.fn<CapturePng>().mockResolvedValue()

    const error = await rejectionOf(executeDrawioUrl(input, { mode: 'view', png: true, output }, dependencies({ capturePng })))
    expect(error).toBeInstanceOf(ThemeResolveError)
    expect(errorToReason(error)).toBe('theme-unlinked')
    expect(toExitCode(error)).toBe(1)
    expect(existsSync(output)).toBe(false)
    expect(capturePng).not.toHaveBeenCalled()
  })

  it('取得の失敗は theme-<reason> の exit 1', async () => {
    const fetchTheme = vi.fn<FetchTheme>().mockRejectedValue(new ThemeFetchError('タグがありません', 'tag'))
    const input = writeDiagram(path.join(state.root, 'outside'))
    const error = await rejectionOf(run(input, { theme: 'git+file:///x.git#v9.9.9' }, { fetchTheme }))
    expect(error).toBeInstanceOf(ThemeFetchError)
    expect(errorToReason(error)).toBe('theme-tag')
    expect(toExitCode(error)).toBe(1)
  })

  it('宣言の誤り（形の誤り）は theme-invalid-shape の exit 1', async () => {
    const themeRoot = makeTheme('broken', { schema: 1, fonts: { body: [] } })
    const input = writeDiagram(path.join(state.root, 'outside'))
    const error = await rejectionOf(run(input, { theme: themeRoot }))
    expect(error).toBeInstanceOf(ThemeDeclarationError)
    expect(errorToReason(error)).toBe('theme-invalid-shape')
    expect(toExitCode(error)).toBe(1)
  })

  it('指定の誤り（ThemeSpecError）は exit 2', async () => {
    const input = writeDiagram(path.join(state.root, 'outside'))
    const error = await rejectionOf(run(input, { theme: 'git+https://example.com/x.git' }))
    expect(error).toBeInstanceOf(ThemeSpecError)
    expect(errorToReason(error)).toBe('theme-tag-required')
    expect(toExitCode(error)).toBe(2)
  })

  it('slides.md も pecot-theme.json も無いパスは invalid-theme の usage error（exit 2）', async () => {
    const empty = path.join(state.root, 'empty')
    mkdirSync(empty)
    const input = writeDiagram(path.join(state.root, 'outside'))
    const error = await rejectionOf(run(input, { theme: empty }))
    expect(error).toBeInstanceOf(DrawioUrlUsageError)
    expect(errorToReason(error)).toBe('invalid-theme')
    expect(toExitCode(error)).toBe(2)
  })

  it('file: の指定先に pecot-theme.json も package.json も無ければ invalid-theme（exit 2）', async () => {
    const input = writeDiagram(path.join(state.root, 'outside'))
    const error = await rejectionOf(run(input, { theme: `file:${path.join(state.root, 'missing')}` }))
    expect(error).toBeInstanceOf(DrawioUrlUsageError)
    expect(errorToReason(error)).toBe('invalid-theme')
    expect(toExitCode(error)).toBe(2)
  })

  it('テーマ root の package.json が読めないときは、ディレクトリ名をテーマ名にする', async () => {
    const themeRoot = makeTheme('broken-package')
    writeFileSync(path.join(themeRoot, 'package.json'), '{')
    const input = writeDiagram(path.join(state.root, 'outside'))
    const { theme } = await run(input, { theme: `file:${themeRoot}` })
    expect(theme.name).toBe('broken-package')
  })

  it('テーマ以外の例外の reason は unknown（exit 1）', () => {
    expect(errorToReason(new Error('予期しない失敗'))).toBe('unknown')
    expect(toExitCode(new Error('予期しない失敗'))).toBe(1)
  })

  it('置き場を決められない git の指定は theme-unknown（exit 1）', async () => {
    const input = writeDiagram(path.join(state.root, 'outside'))
    const error = await rejectionOf(run(input, { theme: 'git+file:///x.git#v1.0.0' }, { themeStoreRoot: NO_STORE_ROOT }))
    expect(error).toBeInstanceOf(DrawioUrlRuntimeError)
    expect(errorToReason(error)).toBe('theme-unknown')
    expect(toExitCode(error)).toBe(1)
  })
})

describe('PNG の書体', () => {
  it('capturePng に宣言の書体（body と eastAsian）を渡す', async () => {
    const talk = makeTalk('talk-test', makeTheme('test-sans'))
    const input = diagramIn(talk)
    const capturePng = vi.fn<CapturePng>().mockResolvedValue()
    await executeDrawioUrl(input, { mode: 'view', png: true, output: path.join(path.dirname(input), 'check.html') }, dependencies({ capturePng }))
    expect(capturePng).toHaveBeenCalledTimes(1)
    expect(capturePng.mock.calls[0]?.[2]).toEqual(['Test Sans', 'Test Sans JP'])
  })

  it('talk-dir の外で --theme 無しなら既定の書体を渡す', async () => {
    const input = writeDiagram(path.join(state.root, 'outside'))
    const capturePng = vi.fn<CapturePng>().mockResolvedValue()
    await executeDrawioUrl(input, { mode: 'view', png: true, output: path.join(state.root, 'outside', 'check.html') }, dependencies({ capturePng }))
    expect(capturePng.mock.calls[0]?.[2]).toEqual(['sans-serif'])
  })
})

async function runCli(arguments_: readonly string[]): Promise<{ readonly json: Record<string, unknown>, readonly exitCode: number | string | undefined }> {
  const command = createDrawioUrlCommand(() => dependencies())
  process.exitCode = 0
  await command.parseAsync([...arguments_, '--json'], { from: 'user' })
  const line = state.stdout.chunks.join('').trim().split('\n').at(-1) ?? ''
  // eslint-disable-next-line no-restricted-syntax -- JSON 出力の narrowing
  return { json: JSON.parse(line) as Record<string, unknown>, exitCode: process.exitCode }
}

describe('CLI', () => {
  it('--theme を渡すと data.theme が option で、警告があれば exit 3', async () => {
    const talk = makeTalk('talk-test', makeTheme('test-sans'))
    const input = writeDiagram(path.join(state.root, 'outside'))
    const { json, exitCode } = await runCli([input, '--theme', talk])
    expect(json['theme']).toMatchObject({ source: 'option', name: TEST_THEME_NAME })
    expect(exitCode).toBe(3)
  })

  it('--theme 無しの talk-dir の図は talk-dir', async () => {
    const talk = makeTalk('talk-test', makeTheme('test-sans'))
    const { json } = await runCli([diagramIn(talk)])
    expect(json['theme']).toMatchObject({ source: 'talk-dir' })
  })

  it('--slide は廃止した（指定すると usage error）', async () => {
    const input = writeDiagram(path.join(state.root, 'outside'))
    const command = createDrawioUrlCommand(() => dependencies())
    await expect(command.parseAsync([input, '--slide', '--json'], { from: 'user' })).rejects.toThrow()
  })

  it('invalid-theme は JSON のエラーイベントで exit 2', async () => {
    const empty = path.join(state.root, 'empty')
    mkdirSync(empty)
    const input = writeDiagram(path.join(state.root, 'outside'))
    const { json, exitCode } = await runCli([input, '--theme', empty])
    expect(json).toMatchObject({ event: 'drawio.url.error', reason: 'invalid-theme' })
    expect(exitCode).toBe(2)
  })

  it('theme-unlinked は JSON のエラーイベントで exit 1', async () => {
    const talk = makeTalk('talk-unlinked', makeTheme('test-sans'))
    rmSync(path.join(talk, 'node_modules', TEST_THEME_NAME), { recursive: true })
    const { json, exitCode } = await runCli([diagramIn(talk)])
    expect(json).toMatchObject({ event: 'drawio.url.error', reason: 'theme-unlinked' })
    expect(exitCode).toBe(1)
  })
})
