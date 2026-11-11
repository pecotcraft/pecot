// slide 系 4 ツールのハンドラ単体テスト。
//
// tools/list 側の契約は、src/mcp/tests/contract.test.ts が 11 件まとめて pin する。
// 対象はパラメータ集合・annotations・outputSchema。
// そのため、ここでは重複させない。
// 「ハンドラを直接呼んだときの ToolResult への写像」だけを見る。
//
// 子プロセス (slidev build / eslint) とブラウザは 1 つも起こさない。
// slide_convert では SlidevRunner と SlidevPptxPipeline を fake に差し替える。
// slide_lint では EslintRunner を fake に差し替える。
// slide_create では、fixture テーマ (tests/fixtures/themes) の写しを `file:` で指す。
// slide_sync と slide_lint では、tmpdir の依存ルートだけを持つ pluginRoot を使う。
// 自動 deck lint は eslint を解決できず、skipped に畳まれる。これも観測対象。

// SpawnResult 契約上 exitCode / signal は null を取り得るため、本ファイルで no-null を許可する。
/* eslint-disable unicorn/no-null */
// fs path も全て tmpdir 由来でリテラルではない。
/* eslint-disable security/detect-non-literal-fs-filename */
// SDK の CallToolResult / ToolDefinition と test stub はいずれも mutable メンバを持つ。
// そのため prefer-readonly-parameter-types は本ファイル全体で外す (src/mcp/tests/_client.ts と同じ扱い)。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/server'
import type { SlideCreateDependencies } from '../../../commands/slidev-project/create.js'
import type { SlideLintDependencies } from '../../../commands/slidev-project/lint.js'
import type { SlideSyncDependencies } from '../../../commands/slidev-project/sync.js'
import type { SlideConvertDependencies } from '../../../commands/slidev-to-pptx/convert.js'
import type {
  PptxArchive,
  SlidevPptxPipeline,
  SlidevRunner,
  XmlEngine,
} from '../../../domain/_shared/ports.js'
import type { EslintRunner } from '../../../domain/slidev-project/lint.js'
import { DEFAULT_THEME_DECLARATION } from '../../../domain/slidev-theme/defaults.js'
import { PipelineRuntimeError } from '../../../domain/slidev-to-pptx/errors.js'
import { YauzlYazlPptxArchive } from '../../../infra/pptx-ooxml/archive.js'
import { XmldomXmlEngine } from '../../../infra/pptx-ooxml/xml-engine.js'
import type { ToolCallContext, ToolDefinition } from '../../server.js'
import { useInstalledChromiumCache } from '../../../../tests/_helpers/chromium-cache.js'
import { seedDependencyRoot } from '../../../../tests/_helpers/dependency-probes.js'
import { copyFixtureTheme } from '../../../../tests/_helpers/theme-fixtures.js'
import {
  slideConvertTool,
  slideCreateTool,
  slideLintTool,
  slideSyncTool,
  slideTools,
} from '../slide.js'
import { useTemporaryDirectory } from '../../../../tests/_helpers/temporary-directory.js'

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
// 単スライド PPTX の実 fixture。fake pipeline の出力としてそのまま置く。
const DUMMY_PPTX = path.join(CLI_ROOT, 'tests', 'fixtures', 'pptx', 'dummy.pptx')

/**
tools/call の第 2 引数。ハンドラは progress と cancel を見ないため、最小限だけ埋める。
progress ハートビートは server.ts 側が包む責務で、ハンドラの関知するところではない。
*/
const TOOL_CALL: ToolCallContext = { signal: new AbortController().signal }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function call(
  tool: ToolDefinition,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> {
  return await tool.handler(arguments_, TOOL_CALL)
}

function structuredOf(result: CallToolResult): Record<string, unknown> {
  const structured = result.structuredContent
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: CallToolResult): Record<string, unknown> {
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が object ではありません')
  return data
}

function stringsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError('配列ではありません')
  return value.filter(entry => typeof entry === 'string')
}

/**
structuredContent の任意フィールドを文字列として取り出す (未捕捉なら空文字)。
*/
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const temporaryRoot = useTemporaryDirectory('pecotv-test-slide-')
// slide_convert の実行時ガードは playwright の browsers root を見る。
// 実行ホストの chromium 取得状況に左右されないよう、取得済みの一時ディレクトリへ向ける。
// ガードそのものの検証は chromium-guard.test.ts が持つ。
useInstalledChromiumCache()

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return captured as unknown as NodeJS.WritableStream
}

/**
依存ルートだけを持つ plugin root の fixture を作る。
eslint は同梱しないので、自動 deck lint は起動前に解決失敗して skipped に畳まれる。
*/
function makePluginRoot(): string {
  const pluginRoot = temporaryRoot('plugin-root')
  seedDependencyRoot(pluginRoot)
  return pluginRoot
}

const THEME_NAME = 'slidev-theme-pecotv-test-declared'

/**
fixture テーマ (宣言あり) の写しを作り、`file:` の指定を返す。
*/
function makeThemeSpec(): string {
  return copyFixtureTheme('with-declaration', temporaryRoot('theme')).spec
}

/**
slides.md だけを持つ talk-dir。sync / convert の対象として最小構成。
テーマを参照しない形 (theme 無し) で、sync の node_modules のみの張り直しは何も取得しない。
*/
function makeTalkDirectory(name: string, slidesContent = '---\ntitle: デモ\n---\n\n# hello\n'): string {
  const directory = temporaryRoot(name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'slides.md'), slidesContent, 'utf8')
  return directory
}

/**
テーマを参照する talk-dir。lint が宣言を読むため、node_modules にテーマ (fixture) を張る。
*/
function makeThemedTalkDirectory(name: string): string {
  const directory = makeTalkDirectory(name, `---\ntheme: ${THEME_NAME}\ntitle: デモ\n---\n\n# hello\n`)
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, dependencies: { [THEME_NAME]: 'file:../theme' } }),
    'utf8',
  )
  const theme = copyFixtureTheme('with-declaration', temporaryRoot(`${name}-theme`))
  mkdirSync(path.join(directory, 'node_modules'), { recursive: true })
  symlinkSync(theme.directory, path.join(directory, 'node_modules', THEME_NAME), 'dir')
  return directory
}

function createCreateTool(
  pluginRoot: string,
  stdout: CapturedStream,
  stderr: CapturedStream,
): ToolDefinition {
  const dependencies: SlideCreateDependencies = {
    pluginRoot,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
    now: () => 0,
    themeStoreRoot: () => temporaryRoot('store'),
  }
  return slideCreateTool(() => dependencies)
}

function createSyncTool(pluginRoot: string): ToolDefinition {
  const dependencies: SlideSyncDependencies = {
    pluginRoot,
    stdout: asStream(makeStream()),
    stderr: asStream(makeStream()),
    themeStoreRoot: () => temporaryRoot('store'),
  }
  return slideSyncTool(() => dependencies)
}

function createLintTool(eslint: EslintRunner): ToolDefinition {
  const dependencies: SlideLintDependencies = {
    pluginRoot: makePluginRoot(),
    stdout: asStream(makeStream()),
    stderr: asStream(makeStream()),
    eslint,
  }
  return slideLintTool(() => dependencies)
}

/** eslint の `--format json` 出力を返す fake runner。子プロセスは起こさない。 */
function fakeEslint(exitCode: number, report: unknown): EslintRunner {
  return {
    run: () => Promise.resolve({
      exitCode,
      signal: null,
      stdout: JSON.stringify(report),
      stderr: '',
      timedOut: false,
    }),
  }
}

function fakeSlidevRunner(): SlidevRunner {
  return {
    build: (projectDirectory) => {
      // 後段が dist/ の存在を前提にするため空 dir を作る。
      mkdirSync(path.join(projectDirectory, 'dist'), { recursive: true })
      return Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    },
  }
}

/**
MCP のパラメータが pipeline へどう写ったかを観測するための記録。
*/
interface PipelineCall {
  theme?: string
  cacheSkipRead: boolean
}

interface RecordingPipeline extends SlidevPptxPipeline {
  readonly calls: PipelineCall[]
}

/**
単スライド PPTX の実 fixture を staging に置くだけの fake pipeline。
*/
function fakePipeline(): RecordingPipeline {
  const calls: PipelineCall[] = []
  return {
    calls,
    convert: (arguments_) => {
      const entry: PipelineCall = { cacheSkipRead: arguments_.cacheSkipRead === true }
      if (arguments_.theme !== undefined) entry.theme = arguments_.theme
      calls.push(entry)
      arguments_.onStepProgress?.(0, 3)
      arguments_.onStepProgress?.(2, 3)
      arguments_.onStepProgress?.(3, 3)

      const slidesDirectory = path.join(arguments_.outputDirectory, 'slides')
      mkdirSync(slidesDirectory, { recursive: true })
      copyFileSync(DUMMY_PPTX, path.join(slidesDirectory, 'slide-1.pptx'))
      return Promise.resolve({
        success: true,
        slideCount: 1,
        slidesDirectory,
        errors: [],
        warnings: ['キャッシュ再利用のため要素診断をスキップしました'],
        timing: { total: 12, scan: 1, phase1: 5, phase2: 6, perSlide: { 1: 5 } },
        cache: {
          enabled: true,
          hits: 0,
          misses: 1,
          invalidated: 'none',
          perStep: [{ stepIndex: 0, key: '1', cache: 'miss' }],
        },
      })
    },
  }
}

function failingPipeline(): SlidevPptxPipeline {
  return {
    convert: () => Promise.resolve({
      success: false,
      slideCount: 0,
      slidesDirectory: '',
      errors: [{ level: 'slide', slideNumber: 1, message: '変換に失敗しました' }],
      warnings: [],
      timing: { total: 0, scan: 0, phase1: 0, phase2: 0, perSlide: {} },
    }),
  }
}

function createConvertTool(pipeline: SlidevPptxPipeline): ToolDefinition {
  const archive: PptxArchive = new YauzlYazlPptxArchive()
  const engine: XmlEngine = new XmldomXmlEngine()
  const dependencies: SlideConvertDependencies = {
    slidevRunner: fakeSlidevRunner(),
    pptxConverter: pipeline,
    archive,
    engine,
    stdout: asStream(makeStream()),
    stderr: asStream(makeStream()),
    now: () => 0,
    pluginVersion: () => 'test-plugin',
    ensureThemeLinked: () => Promise.resolve({ theme: { directory: '/theme-root' } }),
    readThemeDeclaration: () => Promise.resolve({ declaration: DEFAULT_THEME_DECLARATION, warnings: [] }),
  }
  return slideConvertTool(() => dependencies)
}

describe('slideTools', () => {
  it('4 件を既定 deps で組み立てる (deps はハンドラ内生成なので評価時に throw しない)', () => {
    const previous = process.env['CLAUDE_PLUGIN_ROOT']
    // interface-env: none
    Reflect.deleteProperty(process.env, 'CLAUDE_PLUGIN_ROOT')
    try {
      expect(slideTools().map(tool => tool.name))
        .toEqual(['slide_create', 'slide_convert', 'slide_sync', 'slide_lint'])
    }
    finally {
      if (previous !== undefined) process.env['CLAUDE_PLUGIN_ROOT'] = previous
    }
  })
})

describe('slide_create', () => {
  it('相対パスは実処理を呼ばずに exitCode 2 で返す', async () => {
    const result = await call(createCreateTool(makePluginRoot(), makeStream(), makeStream()), {
      project_dir: 'relative/deck',
      theme: makeThemeSpec(),
    })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(2)
    expect(structured['message']).toContain('must be an absolute path')
    expect(dataOf(result)['invalidPaths']).toEqual(['project_dir=relative/deck'])
  })

  it('生成に成功すると slide.create.done を data に載せ、生成先を artifacts に返す', async () => {
    const projectDirectory = temporaryRoot('deck')
    const theme = makeThemeSpec()
    const result = await call(createCreateTool(makePluginRoot(), makeStream(), makeStream()), {
      project_dir: projectDirectory,
      theme,
    })
    const structured = structuredOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(stringsOf(structured['artifacts'])).toEqual([projectDirectory])
    expect(dataOf(result)['event']).toBe('slide.create.done')
    expect(dataOf(result)['theme']).toEqual({
      name: THEME_NAME,
      spec: `file:${path.relative(projectDirectory, temporaryRoot('theme')).split(path.sep).join('/')}`,
    })
    expect(dataOf(result)).not.toHaveProperty('template')
    expect(dataOf(result)['layouts']).toHaveLength(8)
    // eslint を解決できない fixture なので、自動 deck lint は成否を変えず skipped として扱われる。
    expect(dataOf(result)['lint']).toMatchObject({ skipped: true })
  })

  it('layout catalog は stdout と捕捉出力のどちらにも出さない (emitCatalog: false 固定)', async () => {
    const stdout = makeStream()
    const result = await call(createCreateTool(makePluginRoot(), stdout, makeStream()), {
      project_dir: temporaryRoot('deck-no-catalog'),
      theme: makeThemeSpec(),
    })

    expect(stdout.chunks.join('')).not.toContain('Layout Catalog')
    expect(textOf(structuredOf(result)['stdout'])).not.toContain('Layout Catalog')
  })

  it('タグの無い git URL は取得に入らず usage error として exitCode 2 で返す', async () => {
    const result = await call(createCreateTool(makePluginRoot(), makeStream(), makeStream()), {
      project_dir: temporaryRoot('deck-no-tag'),
      theme: 'git+https://example.com/org/theme.git',
    })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(2)
    expect(dataOf(result)).toMatchObject({ event: 'slide.create.error', reason: 'theme-tag-required' })
  })

  it('相対の file: は実処理前に invalid-option・exitCode 2 で返す (サーバの cwd は呼び出し元と別)', async () => {
    const projectDirectory = temporaryRoot('deck-relative-theme')
    const result = await call(createCreateTool(makePluginRoot(), makeStream(), makeStream()), {
      project_dir: projectDirectory,
      theme: 'file:../my-theme',
    })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['exitCode']).toBe(2)
    expect(dataOf(result)).toMatchObject({ event: 'slide.create.error', reason: 'invalid-option' })
    expect(textOf(structured['message'])).toContain('must be an absolute path')
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('解決できない Windows 形式の file: (ドライブ相対) は invalid-option・exitCode 2 で返す', async () => {
    const projectDirectory = temporaryRoot('deck-drive-relative')
    const result = await call(createCreateTool(makePluginRoot(), makeStream(), makeStream()), {
      project_dir: projectDirectory,
      theme: 'file:C:my-theme',
    })

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)['reason']).toBe('invalid-option')
    expect(textOf(structuredOf(result)['message'])).toContain('drive-relative')
    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('Windows 形式の file: は POSIX パスに変換して取得する', async () => {
    const result = await call(createCreateTool(makePluginRoot(), makeStream(), makeStream()), {
      project_dir: temporaryRoot('deck-windows-theme'),
      theme: 'file:C:\\themes\\my-theme',
    })

    // 変換後の /mnt/c/themes/my-theme は実在しないので、取得の失敗として返る。変換されたパスが文言に出る。
    expect(structuredOf(result)['ok']).toBe(false)
    expect(textOf(structuredOf(result)['message'])).toContain('/mnt/c/themes/my-theme')
    expect(dataOf(result)['reason']).toBe('theme-unknown')
  })

  it('force なしで既存ディレクトリを指すと exitCode 2 で返す', async () => {
    const pluginRoot = makePluginRoot()
    const projectDirectory = makeTalkDirectory('existing')
    const theme = makeThemeSpec()

    const rejected = await call(createCreateTool(pluginRoot, makeStream(), makeStream()), {
      project_dir: projectDirectory,
      theme,
    })
    expect(structuredOf(rejected)['exitCode']).toBe(2)
    expect(dataOf(rejected)['reason']).toBe('dest-exists')

    // force: true なら同じ入力で成功する (上書き分岐が生きていることの確認)。
    const forced = await call(createCreateTool(pluginRoot, makeStream(), makeStream()), {
      project_dir: projectDirectory,
      theme,
      force: true,
    })
    expect(structuredOf(forced)['ok']).toBe(true)
  })

  it('CLAUDE_PLUGIN_ROOT 未設定の既定 deps は実行失敗 (exitCode 1) として返る', async () => {
    const previous = process.env['CLAUDE_PLUGIN_ROOT']
    // interface-env: none
    Reflect.deleteProperty(process.env, 'CLAUDE_PLUGIN_ROOT')
    try {
      const result = await call(slideCreateTool(), { project_dir: temporaryRoot('deck-noenv'), theme: makeThemeSpec() })
      const structured = structuredOf(result)

      expect(structured['ok']).toBe(false)
      expect(structured['exitCode']).toBe(1)
      expect(textOf(structured['message'])).toContain('CLAUDE_PLUGIN_ROOT')
    }
    finally {
      if (previous !== undefined) process.env['CLAUDE_PLUGIN_ROOT'] = previous
    }
  })
})

describe('slide_sync', () => {
  it('相対 dir は exitCode 2 で返す', async () => {
    const result = await call(createSyncTool(makePluginRoot()), { dir: 'relative/talk' })

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)['invalidPaths']).toEqual(['dir=relative/talk'])
  })

  it('node_modules_only の同期に成功すると slide.sync.done を返す', async () => {
    const talk = makeTalkDirectory('talk-sync')
    const result = await call(createSyncTool(makePluginRoot()), { dir: talk, node_modules_only: true })
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(stringsOf(structured['artifacts'])).toEqual([talk])
    expect(dataOf(result)).toMatchObject({
      event: 'slide.sync.done',
      dir: talk,
      nodeModulesOnly: true,
    })
  })

  it('移行済みの talk-dir は node_modules_only なしでも張り直し、message と data にテーマの name と spec を載せる', async () => {
    const talk = makeThemedTalkDirectory('talk-migrated')
    const spec = 'git+https://example.com/org/theme.git#v1.0.1'
    const directory = '/store/abc/v1.0.1/package'
    const tool = slideSyncTool(() => ({
      pluginRoot: makePluginRoot(),
      stdout: asStream(makeStream()),
      stderr: asStream(makeStream()),
      ensureThemeLinked: () => Promise.resolve({
        relinked: true, regenerated: false,
        theme: { name: THEME_NAME, spec, directory },
        nodeModulesTarget: '/runtime/current/node_modules',
      }),
    }))

    const result = await call(tool, { dir: talk })
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(true)
    expect(textOf(structured['message'])).toBe(`slide sync: succeeded (${talk}); theme: ${THEME_NAME} (${spec})`)
    expect(dataOf(result)).toMatchObject({
      event: 'slide.sync.done',
      nodeModulesOnly: false,
      theme: { name: THEME_NAME, spec, directory },
    })
  })

  it('移行前の talk-dir に theme を渡すと、テーマを参照する形へ移し、消した名前を data.migration.removed と message に返す', async () => {
    const talk = makeTalkDirectory('talk-legacy')
    mkdirSync(path.join(talk, 'layouts'))
    mkdirSync(path.join(talk, 'pages'))
    writeFileSync(path.join(talk, 'pages', 'cover.md'), 'COVER')
    const theme = makeThemeSpec()

    const result = await call(createSyncTool(makePluginRoot()), { dir: talk, theme })
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(true)
    expect(dataOf(result)).toMatchObject({
      event: 'slide.sync.done',
      nodeModulesOnly: false,
      migration: { removed: ['layouts'] },
      theme: { name: THEME_NAME },
    })
    expect(textOf(structured['message'])).toContain(`theme: ${THEME_NAME}`)
    expect(textOf(structured['message'])).toContain('migration: removed 1 files from the template (layouts)')
    expect(existsSync(path.join(talk, 'layouts'))).toBe(false)
    expect(readFileSync(path.join(talk, 'pages', 'cover.md'), 'utf8')).toBe('COVER')
    expect(readFileSync(path.join(talk, 'slides.md'), 'utf8')).toContain(`theme: ${THEME_NAME}`)
  })

  it('移行前の talk-dir に theme を渡さないと theme-required・exitCode 2 で返し、何も変えない', async () => {
    const talk = makeTalkDirectory('talk-legacy-no-theme')
    mkdirSync(path.join(talk, 'layouts'))

    const result = await call(createSyncTool(makePluginRoot()), { dir: talk })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['exitCode']).toBe(2)
    expect(dataOf(result)).toMatchObject({ event: 'slide.sync.error', reason: 'theme-required' })
    expect(textOf(structured['message'])).toContain('theme: <theme-spec>')
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
  })

  it('相対の file: の theme は実処理前に invalid-option・exitCode 2 で返す', async () => {
    const talk = makeTalkDirectory('talk-relative-theme')
    mkdirSync(path.join(talk, 'layouts'))

    const result = await call(createSyncTool(makePluginRoot()), { dir: talk, theme: 'file:../my-theme' })

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)).toMatchObject({ event: 'slide.sync.error', reason: 'invalid-option' })
    expect(existsSync(path.join(talk, 'layouts'))).toBe(true)
  })

  it('タグの無い git URL の theme は theme-tag-required・exitCode 2 で返す', async () => {
    const talk = makeTalkDirectory('talk-no-tag')

    const result = await call(createSyncTool(makePluginRoot()), { dir: talk, theme: 'git+https://example.com/org/theme.git' })

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)).toMatchObject({ event: 'slide.sync.error', reason: 'theme-tag-required' })
  })

  it('slides.md の無いディレクトリは実行失敗 (exitCode 1) として返る', async () => {
    const notTalk = temporaryRoot('not-talk')
    mkdirSync(notTalk, { recursive: true })

    const result = await call(createSyncTool(makePluginRoot()), { dir: notTalk })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(dataOf(result)).toMatchObject({ event: 'slide.sync.error', reason: 'not-talk-dir' })
  })
})

describe('slide_lint', () => {
  it('相対 dir は exitCode 2 で返す', async () => {
    const result = await call(createLintTool(fakeEslint(0, [])), { dir: 'relative/talk' })

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(textOf(structuredOf(result)['message'])).toContain('must be an absolute path')
  })

  it('違反なしは slide.lint.done / exitCode 0 で返す', async () => {
    const talk = makeThemedTalkDirectory('talk-clean')
    const eslint = fakeEslint(0, [
      { filePath: path.join(talk, 'slides.md'), errorCount: 0, warningCount: 0, messages: [] },
    ])

    const result = await call(createLintTool(eslint), { dir: talk })
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(stringsOf(structured['artifacts'])).toEqual([])
    expect(dataOf(result)).toMatchObject({ event: 'slide.lint.done', outcome: 'clean' })
  })

  it('違反ありは「報告が成果」なので ok: true / exitCode 1 で返す', async () => {
    const talk = makeThemedTalkDirectory('talk-violations')
    const eslint = fakeEslint(1, [
      {
        filePath: path.join(talk, 'slides.md'),
        errorCount: 1,
        warningCount: 0,
        messages: [{ ruleId: 'slidev-pages-lint/no-missing-page', message: '幽霊 src', line: 3, column: 1 }],
      },
    ])

    const result = await call(createLintTool(eslint), { dir: talk })
    const structured = structuredOf(result)

    // ok は「目的の実行を完了したか」なので、違反の検出自体は成功として扱う。
    expect(result.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(1)
    expect(textOf(structured['message'])).toContain('violations found')
    expect(dataOf(result)).toMatchObject({
      event: 'slide.lint.violations',
      outcome: 'violations',
      errorCount: 1,
    })
  })

  it('talk-dir が存在しないと実行失敗 (exitCode 1) として返る', async () => {
    const result = await call(createLintTool(fakeEslint(0, [])), {
      dir: temporaryRoot('no-such-talk'),
    })
    const structured = structuredOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(dataOf(result)).toMatchObject({ event: 'slide.lint.error', reason: 'dir-not-found' })
  })

  it('eslint が異常終了すると実行失敗として返り、stderr 抜粋が message に載る', async () => {
    const talk = makeThemedTalkDirectory('talk-eslint-broken')
    const broken: EslintRunner = {
      run: () => Promise.resolve({
        exitCode: 2,
        signal: null,
        stdout: '',
        stderr: 'config error',
        timedOut: false,
      }),
    }

    const result = await call(createLintTool(broken), { dir: talk })
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(textOf(structured['message'])).toContain('config error')
    expect(dataOf(result)['reason']).toBe('eslint-failed')
  })
})

describe('slide_convert', () => {
  it('相対パスは project_dir と out_path の両方をまとめて exitCode 2 で返す', async () => {
    const result = await call(createConvertTool(fakePipeline()), {
      project_dir: 'relative/deck',
      out_path: 'relative/out.pptx',
    })

    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)['invalidPaths'])
      .toEqual(['project_dir=relative/deck', 'out_path=relative/out.pptx'])
  })

  it('変換に成功すると slide.convert.done を data に載せ、出力 PPTX を artifacts に返す', async () => {
    const project = makeTalkDirectory('convert-ok')
    const out = temporaryRoot('out', 'deck.pptx')

    const result = await call(createConvertTool(fakePipeline()), { project_dir: project, out_path: out })
    const structured = structuredOf(result)
    const data = dataOf(result)

    expect(result.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(stringsOf(structured['artifacts'])).toEqual([out])
    // 進捗イベントの slide.convert.start は結果ではないので data に畳まない。
    expect(data['event']).toBe('slide.convert.done')
    expect(data['output']).toBe(out)
    expect(data['warnings']).toEqual(['キャッシュ再利用のため要素診断をスキップしました'])
    expect(data['errors']).toEqual([])
    // timings / cache は summary に載っているときだけ足される。
    expect(data['timings']).toMatchObject({ scan: 1, phase1: 5, phase2: 6 })
    expect(data['cache']).toMatchObject({ enabled: true, hits: 0, misses: 1 })
  })

  it('工程と変換の件数・割合を reportProgress へ順に流す (#1160)', async () => {
    const project = makeTalkDirectory('convert-progress')
    const out = temporaryRoot('out', 'progress.pptx')
    const messages: string[] = []

    const result = await createConvertTool(fakePipeline()).handler(
      { project_dir: project, out_path: out },
      TOOL_CALL,
      { reportProgress: (message) => { messages.push(message) } },
    )

    expect(structuredOf(result)['ok']).toBe(true)
    // 割合は切り捨て (2/3 なら 66%)。
    expect(messages).toEqual([
      'running slidev build',
      'scanning slides',
      'converting 0/3 (0%)',
      'converting 2/3 (66%)',
      'converting 3/3 (100%)',
      'merging PPTX',
    ])
  })

  it('省略可能なパラメータを全て指定しても CLI の option へ写る', async () => {
    const project = makeTalkDirectory('convert-full')
    const out = temporaryRoot('out', 'full.pptx')
    const spacingJson = temporaryRoot('letter-spacing.json')
    const hrefJson = temporaryRoot('href-map.json')
    writeFileSync(spacingJson, JSON.stringify({ demo: { letterSpacing: '1px', fontSize: '20px' } }), 'utf8')
    writeFileSync(hrefJson, JSON.stringify({ demo: 'https://example.test/' }), 'utf8')
    const pipeline = fakePipeline()

    const result = await call(createConvertTool(pipeline), {
      project_dir: project,
      out_path: out,
      theme: '@slidev/theme-default',
      spacing_json_path: spacingJson,
      href_json_path: hrefJson,
      transition_type: 'morph',
      transition_duration_ms: 250,
      morph_option: 'byWord',
      cache: false,
    })

    expect(structuredOf(result)['ok']).toBe(true)
    // cache: false は「読み取りだけ止める」ので cacheSkipRead に写る。
    expect(pipeline.calls).toEqual([{ theme: '@slidev/theme-default', cacheSkipRead: true }])
  })

  it('out_path 省略時は slides.md の title から既定の出力先を決める', async () => {
    const project = makeTalkDirectory('convert-default-out', '---\ntitle: デモ資料\n---\n\n# hello\n')

    const result = await call(createConvertTool(fakePipeline()), { project_dir: project })
    const expected = path.join(project, 'pptx', 'デモ資料.pptx')

    expect(stringsOf(structuredOf(result)['artifacts'])).toEqual([expected])
    expect(dataOf(result)['output']).toBe(expected)
  })

  it('pipeline の失敗は exitCode 1 と pipeline 診断つきで返る', async () => {
    const project = makeTalkDirectory('convert-fail')

    const result = await call(createConvertTool(failingPipeline()), {
      project_dir: project,
      out_path: temporaryRoot('out', 'fail.pptx'),
    })
    const structured = structuredOf(result)
    const data = dataOf(result)

    expect(result.isError).toBe(true)
    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(data['event']).toBe('slide.convert.error')
    expect(data['reason']).toBe('pptx-convert-failed')
    expect(data['errors']).toEqual([{ level: 'slide', slideNumber: 1, message: '変換に失敗しました' }])
  })

  it('クライアントのキャンセルで pipeline が止まり、PPTX を書かずに cancelled で返る (#1228)', async () => {
    const project = makeTalkDirectory('convert-cancel')
    const out = temporaryRoot('out', 'cancel.pptx')
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const pipeline: SlidevPptxPipeline = {
      convert: (arguments_) => {
        received = arguments_.signal
        return new Promise((_resolve, reject) => {
          arguments_.signal?.addEventListener('abort', () => {
            reject(new PipelineRuntimeError('aborted'))
          })
          controller.abort()
        })
      },
    }

    const result = await createConvertTool(pipeline).handler(
      { project_dir: project, out_path: out },
      { ...TOOL_CALL, signal: controller.signal },
    )

    expect(received?.aborted).toBe(true)
    expect(result.isError).toBe(true)
    expect(dataOf(result)['reason']).toBe('cancelled')
    expect(existsSync(out)).toBe(false)
  })

  it('不正な theme は usage error として exitCode 2 で返る', async () => {
    const result = await call(createConvertTool(fakePipeline()), {
      project_dir: makeTalkDirectory('convert-theme'),
      theme: 'bad theme',
    })
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(2)
    expect(dataOf(result)['reason']).toBe('invalid-theme')
  })

  it('project-dir 不在は実行失敗 (exitCode 1) として返る', async () => {
    const result = await call(createConvertTool(fakePipeline()), {
      project_dir: temporaryRoot('no-such-project'),
    })
    const structured = structuredOf(result)

    expect(structured['ok']).toBe(false)
    expect(structured['exitCode']).toBe(1)
    expect(dataOf(result)['reason']).toBe('project-not-found')
  })
})
