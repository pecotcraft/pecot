// commands/slidev-project/create.ts の integration test。
// テーマは `file:` で指す。fixture テーマを一時ディレクトリへ写して使う（file: の取得は install しないため）。
// CLAUDE_PLUGIN_ROOT = repo の plugins/pecot-visual を指す前提で動く。
// plugin-root は pnpm install 済みでないと、node_modules の張り先が realpath で解決できない。
// そのため test 自前で、plugins/pecot-visual に node_modules が存在することを期待する。

/* eslint-disable security/detect-non-literal-fs-filename */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SlideCreateUsageError,
  createSlideCreateCommand,
  executeSlideCreate,
  slideCreateDefaultDependencies,
  runSlideCreate,
} from '../../../src/commands/slidev-project/create.js'
import type { SlideCreateDependencies } from '../../../src/commands/slidev-project/create.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { START_SCRIPT_SOURCE, viteConfigSource } from '../../../src/domain/slidev-project/generated-files.js'
import { copyFixtureTheme as copyTheme } from '../../_helpers/theme-fixtures.js'
import type { CopiedTheme, FixtureTheme } from '../../_helpers/theme-fixtures.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

const HERE = import.meta.dirname
// repo の plugins/pecot-visual が plugin-root（cli/.. = plugins/pecot-visual）。
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const DEPENDENCY_NODE_MODULES = path.resolve(PLUGIN_ROOT, '..', '..', 'node_modules')
const DECLARED_THEME_NAME = 'slidev-theme-pecotv-test-declared'
const BARE_THEME_NAME = 'slidev-theme-pecotv-test-bare'

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

// runSlideCreate / createSlideCreateCommand は NodeJS.WritableStream を期待するが
// 実装が呼び出すのは write のみ。テストでは write のみを実装した stub を渡す。
// write を持つ stub をそのまま使う。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return captured as unknown as NodeJS.WritableStream
}

const temporaryRoot = useTemporaryDirectory('pecotv-slide-create-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

function buildDependencies(overrides: Readonly<Partial<SlideCreateDependencies>> = {}): SlideCreateDependencies {
  return {
    pluginRoot: PLUGIN_ROOT,
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => 0,
    themeStoreRoot: () => temporaryRoot('store'),
    ...overrides,
  }
}

// 宣言を持つ fixture テーマの写し。同じ名前への写しは同じ内容になるため、1 つのテストで何度呼んでもよい。
function declaredTheme(): CopiedTheme {
  return copyTheme('with-declaration', temporaryRoot('declared-theme-src'))
}

function copyFixtureTheme(fixture: FixtureTheme, name: string): CopiedTheme {
  return copyTheme(fixture, temporaryRoot(name))
}

function readJson(file: string): Record<string, unknown> {
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

// catalog の stdout 出力は executeSlideCreate が持つ（収集を 1 回に束ねたため）。
// 生成物の確認もここでまとめて行う。
describe('executeSlideCreate (smoke)', () => {
  it('fixture テーマを file: で指して、生成するものだけを作る', async () => {
    const theme = declaredTheme()
    const projectDirectory = temporaryRoot('sample')
    const stdout = makeStream()
    const stderr = makeStream()
    const { summary } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false, emitCatalog: true },
      buildDependencies({ stdout: asStream(stdout), stderr: asStream(stderr) }),
    )
    const relativeTheme = path.relative(projectDirectory, theme.directory).split(path.sep).join('/')
    expect(summary.theme).toEqual({ name: DECLARED_THEME_NAME, spec: `file:${relativeTheme}` })
    expect(summary.projectDirectory).toBe(projectDirectory)

    // 生成するもの: slides.md・package.json・pages・public/slides・start.mjs・vite.config.ts・node_modules だけ。
    expect(readdirSync(projectDirectory).toSorted(compareStrings)).toEqual([
      'node_modules', 'package.json', 'pages', 'public', 'slides.md', 'start.mjs', 'vite.config.ts',
    ])
    expect(readdirSync(path.join(projectDirectory, 'public'))).toEqual(['slides'])
    expect(readdirSync(path.join(projectDirectory, 'public', 'slides')).toSorted(compareStrings)).toEqual(['diagrams', 'html', 'images'])

    // 生成しないもの: テーマの layouts・styles・public・宣言のコピー・pages/_references。
    for (const name of [
      'layouts', 'components', 'composables', 'styles', 'setup', 'utils', 'scripts', 'patches', 'pecot-theme.json',
      path.join('public', 'assets'), path.join('public', 'fonts'), path.join('pages', '_references'),
    ]) {
      expect(existsSync(path.join(projectDirectory, name)), `${name} は生成しない`).toBe(false)
    }

    // 初期ページはテーマの参照の examples の雛形で作る。cover・agenda・section・end の順に、テーマにあるものだけを並べる。
    // fixture は agenda を持たない。
    expect(readdirSync(path.join(projectDirectory, 'pages')).toSorted(compareStrings)).toEqual(['cover.md', 'end.md', 'section.md'])
    for (const name of ['cover', 'section', 'end']) {
      expect(readFileSync(path.join(projectDirectory, 'pages', `${name}.md`), 'utf8').startsWith(`---\nlayout: ${name}\n`)).toBe(true)
    }

    // slides.md: theme: はパッケージ名。テーマの headmatter は書かない。
    const slidesMd = readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8')
    expect(slidesMd).toBe(
      `---\ntheme: ${DECLARED_THEME_NAME}\ntitle: Sample\nsrc: ./pages/cover.md\n---\n<!-- markdownlint-disable -->\n`
      + '\n---\nsrc: ./pages/section.md\n---\n'
      + '\n---\nsrc: ./pages/end.md\n---\n',
    )
    expect(slidesMd).not.toMatch(/canvasWidth|aspectRatio|routerMode/)

    // package.json: 依存はテーマ 1 つ。file: は talk-dir からの相対で書く。
    expect(readJson(path.join(projectDirectory, 'package.json'))).toEqual({
      name: 'sample',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: { [DECLARED_THEME_NAME]: `file:${relativeTheme}` },
    })

    // vite.config.ts と start.mjs は本体が生成した中身であること
    expect(readFileSync(path.join(projectDirectory, 'vite.config.ts'), 'utf8')).toBe(viteConfigSource({ themeName: DECLARED_THEME_NAME }))
    expect(readFileSync(path.join(projectDirectory, 'start.mjs'), 'utf8')).toBe(START_SCRIPT_SOURCE)

    // node_modules が実ディレクトリで、項目ごとに依存ルートの node_modules へ相対 symlink を張っていること
    const nodeModulesPath = path.join(projectDirectory, 'node_modules')
    expect(lstatSync(nodeModulesPath).isDirectory()).toBe(true)
    expect(lstatSync(nodeModulesPath).isSymbolicLink()).toBe(false)
    for (const name of ['vue', '@slidev', '.bin']) {
      const link = path.join(nodeModulesPath, name)
      expect(lstatSync(link).isSymbolicLink(), `${name} は symlink`).toBe(true)
      expect(path.isAbsolute(readlinkSync(link))).toBe(false)
      expect(realpathSync(link)).toBe(realpathSync(path.join(DEPENDENCY_NODE_MODULES, name)))
    }
    // テーマは name の項目としてテーマの実体へ張る。
    expect(realpathSync(path.join(nodeModulesPath, DECLARED_THEME_NAME))).toBe(realpathSync(theme.directory))
    expect(existsSync(path.join(nodeModulesPath, '.pecotv-link.json'))).toBe(true)

    // layout catalog が stdout に出ていること（json でないモード）
    const written = stdout.chunks.join('')
    expect(written).toContain('Layout Catalog')
    expect(written).toContain('- cover:')

    // hidden 検証: scratch は catalog 全体に現れない
    expect(written).not.toMatch(/^- scratch:/m)
    expect(written).not.toMatch(/\[deprecated\] scratch:/)

    // 見せ方の分類ごとに群化され、見出しは `--- <label>: <question> ---` で出る。
    // 分類の並びは _common.yaml の layout_categories の宣言順。
    const headings = written.matchAll(/^--- (.+?): .+ ---$/gm).map(match => match[1]).toArray()
    expect(headings).toEqual(['文章', '図'])

    // deprecated 用の末尾セクションは廃止し、各群の中に [deprecated] 付きで残す。
    expect(written).not.toContain('--- deprecated (use only if no alternative) ---')
    const [, figureSection = ''] = written.split(/^--- 図: .+ ---$/m, 2)
    expect(written).toContain('[deprecated] legacy-panel:')
    // deprecated は所属分類（図）の群の中に出て、他の群には現れない。
    expect(figureSection).toContain('[deprecated] legacy-panel:')
    expect(written).not.toContain('\n- legacy-panel:')

    // 群内は stable が先、deprecated が後。
    expect(figureSection.indexOf('- panel:'))
      .toBeLessThan(figureSection.indexOf('[deprecated] legacy-panel:'))

    // 分類を読み取れなかったときだけ出る warn が出ていないこと。
    expect(stderr.chunks.join('')).not.toContain('見せ方の分類を読み取れませんでした')
  })

  it('fixture テーマ: 宣言の examples から初期ページを作り、生成する vite.config.ts はテーマの name だけで決まる', async () => {
    const theme = copyFixtureTheme('with-declaration', 'declared-theme')
    const projectDirectory = temporaryRoot('declared-talk')
    const stderr = makeStream()

    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false, emitCatalog: false },
      buildDependencies({ stderr: asStream(stderr) }),
    )

    // fixture は cover・section・end が 4 つの候補に当たる。各 examples の雛形がそのまま入る。
    expect(readdirSync(path.join(projectDirectory, 'pages')).toSorted(compareStrings)).toEqual(['cover.md', 'end.md', 'section.md'])
    expect(readFileSync(path.join(projectDirectory, 'pages', 'cover.md'), 'utf8'))
      .toBe('---\nlayout: cover\nheading: 発表タイトル\nsubtitle: 副題の例\n---\n')
    expect(readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8'))
      .toBe(`---\ntheme: ${DECLARED_THEME_NAME}\ntitle: Declared Talk\nsrc: ./pages/cover.md\n---\n<!-- markdownlint-disable -->\n`
        + '\n---\nsrc: ./pages/section.md\n---\n'
        + '\n---\nsrc: ./pages/end.md\n---\n')
    expect(readFileSync(path.join(projectDirectory, 'vite.config.ts'), 'utf8'))
      .toBe(viteConfigSource({ themeName: DECLARED_THEME_NAME }))

    // 一覧の出どころはテーマの宣言。レイアウト名・分類・並びが宣言どおり。
    expect(data['event']).toBe('slide.create.done')
    expect(data['theme']).toEqual({ name: DECLARED_THEME_NAME, spec: `file:${path.relative(projectDirectory, theme.directory)}` })
    expect(data['layouts']).toEqual([
      { layout: 'cover', description: '資料の表紙。タイトルと副題だけを置く。', category: 'text', deprecated: false, filename: 'cover.yaml' },
      { layout: 'end', description: '資料の最後に置く。結びの言葉だけを置く。', category: 'text', deprecated: false, filename: 'end.yaml' },
      { layout: 'link', description: '見出しと、リンク付きのカードを縦に並べる。参考資料や関連 URL をまとめる場面に使う。', category: 'text', deprecated: false, filename: 'link.yaml' },
      { layout: 'plain', description: '見出しと本文だけを置く最小のレイアウト。文章で伝える場面に使う。', category: 'text', deprecated: false, filename: 'plain.yaml' },
      { layout: 'section', description: '章の区切りに置く。見出しと一言の説明に、装飾の線を添える。', category: 'text', deprecated: false, filename: 'section.yaml' },
      { layout: 'marked', description: '見出しと印のセルを置く枠を持つレイアウト。図に印を付ける場面に使う。', category: 'figure', deprecated: false, filename: 'marked.yaml' },
      { layout: 'panel', description: '見出しと画像の枠を置くレイアウト。図を 1 つ見せる場面に使う。', category: 'figure', deprecated: false, filename: 'panel.yaml' },
      { layout: 'legacy-panel', description: '【非推奨】品質が水準に達していないため選ばない、見出しだけの枠。', category: 'figure', deprecated: true, filename: 'legacy-panel.yaml' },
    ])
    expect(stderr.chunks.join('')).not.toContain('warning:')
  })

  it('宣言の無いテーマ: layout だけの初期ページ 1 つと警告', async () => {
    const theme = copyFixtureTheme('without-declaration', 'bare-theme')
    const projectDirectory = temporaryRoot('bare-talk')
    const stderr = makeStream()

    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false, emitCatalog: false },
      buildDependencies({ stderr: asStream(stderr) }),
    )

    expect(readdirSync(path.join(projectDirectory, 'pages'))).toEqual(['one.md'])
    expect(readFileSync(path.join(projectDirectory, 'pages', 'one.md'), 'utf8')).toBe('---\nlayout: one\n---\n')
    expect(readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8'))
      .toContain(`theme: ${BARE_THEME_NAME}\n`)
    const warnings = stderr.chunks.join('')
    expect(warnings).toContain('warning: ')
    expect(warnings).toContain('examples')
    expect(data['warnings']).toEqual(expect.arrayContaining([expect.stringContaining('examples')]))
  })

  it('取得中の警告を結果の warnings に載せ、package.json が JSON でないテーマでも進む', async () => {
    const theme = copyFixtureTheme('without-declaration', 'broken-manifest-theme')
    const projectDirectory = temporaryRoot('broken-manifest-talk')
    // fetchTheme の port が name と directory を返す。テーマの package.json は JSON として読めない。
    writeFileSync(path.join(theme.directory, 'package.json'), '{not json')
    const fetchTheme: NonNullable<SlideCreateDependencies['fetchTheme']> = (_spec, options) => {
      options.warn?.('取得中の警告')
      return Promise.resolve({ name: BARE_THEME_NAME, directory: theme.directory, reused: false })
    }

    const stderr = makeStream()
    const dependencies = buildDependencies({ fetchTheme, stderr: asStream(stderr) })
    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false, emitCatalog: false },
      dependencies,
    )

    expect(data['warnings']).toEqual(expect.arrayContaining(['取得中の警告']))
    // 接頭辞は create が 1 回だけ付ける。
    expect(stderr.chunks.join('')).toContain('warning: 取得中の警告\n')
    expect(stderr.chunks.join('')).not.toContain('warning: warning:')
    expect(readFileSync(path.join(projectDirectory, 'vite.config.ts'), 'utf8'))
      .toBe(viteConfigSource({ themeName: BARE_THEME_NAME }))
  })

  it('相対の file: は cwd 基準で絶対化し、package.json には talk-dir からの相対で書く', async () => {
    const theme = copyFixtureTheme('without-declaration', 'bare-theme')
    const projectDirectory = temporaryRoot('nested', 'talk')
    const currentDirectory = temporaryRoot()

    const { summary } = await executeSlideCreate(
      projectDirectory,
      { theme: 'file:./bare-theme', force: false, emitCatalog: false },
      buildDependencies({ currentDirectory }),
    )

    expect(summary.theme.spec).toBe('file:../../bare-theme')
    expect(readJson(path.join(projectDirectory, 'package.json'))['dependencies']).toEqual({ [BARE_THEME_NAME]: 'file:../../bare-theme' })
    expect(realpathSync(path.join(projectDirectory, 'node_modules', BARE_THEME_NAME))).toBe(realpathSync(theme.directory))
  })

  it('既存ディレクトリ + force=false は SlideCreateUsageError(dest-exists) を投げる', async () => {
    const projectDirectory = temporaryRoot('sample')
    await runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: false, emitCatalog: true },
      buildDependencies(),
    )
    await expect(runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: false, emitCatalog: true },
      buildDependencies(),
    )).rejects.toThrow(SlideCreateUsageError)
  })

  it('--force で既存ディレクトリを上書きし、前の生成物を残さない', async () => {
    const projectDirectory = temporaryRoot('sample')
    await runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: false, emitCatalog: true },
      buildDependencies(),
    )
    writeFileSync(path.join(projectDirectory, 'pages', 'stale.md'), '# 前回の生成物\n')

    // ２回目を --force で実行しても成功する
    const result = await runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: true, emitCatalog: true },
      buildDependencies(),
    )

    expect(result.projectDirectory).toBe(projectDirectory)
    expect(existsSync(path.join(projectDirectory, 'pages', 'cover.md'))).toBe(true)
    expect(existsSync(path.join(projectDirectory, 'pages', 'stale.md'))).toBe(false)
  })

  it('生成の途中で失敗したら、生成途中の talk-dir を消す', async () => {
    const theme = copyFixtureTheme('without-declaration', 'bare-theme')
    const projectDirectory = temporaryRoot('half-made')

    // 依存ルートに node_modules が無く、最後の node_modules の組み立てで失敗する。
    const dependencies = buildDependencies({ dependencyRoot: temporaryRoot('no-dependency-root') })
    await expect(runSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false, emitCatalog: false },
      dependencies,
    )).rejects.toMatchObject({ reason: 'symlink-failed' })

    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('--force で、生成の途中 (node_modules の組み立て) に失敗しても、既存の生成先は残り、一時 dir は残らない', async () => {
    const projectDirectory = temporaryRoot('forced', 'talk')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(path.join(projectDirectory, 'slides.md'), '# 既存\n')
    // テーマの directory が実在せず、最後の node_modules の組み立てで失敗する。
    const fetchTheme: NonNullable<SlideCreateDependencies['fetchTheme']> = () => Promise.resolve({
      name: BARE_THEME_NAME,
      directory: temporaryRoot('no-such-theme-directory'),
      reused: false,
    })
    const dependencies = buildDependencies({ fetchTheme, stderr: asStream(makeStream()) })

    await expect(runSlideCreate(
      projectDirectory,
      { theme: 'file:./whatever', force: true, emitCatalog: false },
      dependencies,
    )).rejects.toThrow()

    expect(readFileSync(path.join(projectDirectory, 'slides.md'), 'utf8')).toBe('# 既存\n')
    expect(readdirSync(path.dirname(projectDirectory))).toEqual(['talk'])
  })

  it('テーマの宣言に pptx.linkColor が無ければ、警告を結果に載せる', async () => {
    const theme = copyFixtureTheme('without-declaration', 'no-link-color-theme')
    const projectDirectory = temporaryRoot('no-link-color-talk')
    const dependencies = buildDependencies({ stderr: asStream(makeStream()) })

    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false, emitCatalog: false },
      dependencies,
    )

    expect(data['warnings']).toEqual(expect.arrayContaining([expect.stringContaining('pptx.linkColor を省いた')]))
  })

  it('emitCatalog: false では layout catalog を stdout に流さない', async () => {
    const projectDirectory = temporaryRoot('sample')
    const stdout = makeStream()
    await executeSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: false, emitCatalog: false },
      buildDependencies({ stdout: asStream(stdout) }),
    )
    // layout catalog 出力が抑止されること
    expect(stdout.chunks.join('')).not.toContain('Layout Catalog')
  })
})

describe('createSlideCreateCommand', () => {
  it('--json 成功時 stdout に slide.create.done を出す', async () => {
    const projectDirectory = temporaryRoot('sample-cmd')
    const stdout = makeStream()
    const command = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(stdout), stderr: asStream(makeStream()) }))

    await command.parseAsync([projectDirectory, '--theme', declaredTheme().spec, '--json'], { from: 'user' })
    const lines = stdout.chunks.join('').trim().split('\n').filter(l => l.length > 0)
    const lastLine = lines.at(-1) ?? ''
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(lastLine) as { event: string, projectDir: string, theme: { name: string, spec: string }, template?: string }
    expect(parsed.event).toBe('slide.create.done')
    expect(parsed.projectDir).toBe(projectDirectory)
    expect(parsed.theme.name).toBe(DECLARED_THEME_NAME)
    expect(parsed).not.toHaveProperty('template')
  })

  it('--json なし成功時 stdout にテキスト + Layout Catalog を出す', async () => {
    const projectDirectory = temporaryRoot('sample-cmd2')
    const stdout = makeStream()
    const command = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(stdout), stderr: asStream(makeStream()) }))

    await command.parseAsync([projectDirectory, '--theme', declaredTheme().spec], { from: 'user' })
    const written = stdout.chunks.join('')
    expect(written).toContain(`slide create: 成功 (${projectDirectory})`)
    expect(written).toContain(`  theme=${DECLARED_THEME_NAME}, 0ms`)
    expect(written).toContain('Layout Catalog')
  })

  it('既存ディレクトリ + --json で slide.create.error(dest-exists) + exit 2 (usage error)', async () => {
    const projectDirectory = temporaryRoot('sample-conflict')
    const command1 = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(makeStream()), stderr: asStream(makeStream()) }))
    await command1.parseAsync([projectDirectory, '--theme', declaredTheme().spec, '--json'], { from: 'user' })

    const stdout2 = makeStream()
    const command2 = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(stdout2), stderr: asStream(makeStream()) }))
    const previousExitCode = process.exitCode
    try {
      await command2.parseAsync([projectDirectory, '--theme', declaredTheme().spec, '--json'], { from: 'user' })
      const lastLine = stdout2.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastLine) as { event: string, reason: string }
      expect(parsed.event).toBe('slide.create.error')
      expect(parsed.reason).toBe('dest-exists')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('既存ディレクトリ + --json なしは stderr にメッセージ', async () => {
    const projectDirectory = temporaryRoot('sample-conflict2')
    const command1 = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(makeStream()), stderr: asStream(makeStream()) }))
    await command1.parseAsync([projectDirectory, '--theme', declaredTheme().spec], { from: 'user' })

    const stderr = makeStream()
    const command2 = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(makeStream()), stderr: asStream(stderr) }))
    const previousExitCode = process.exitCode
    try {
      await command2.parseAsync([projectDirectory, '--theme', declaredTheme().spec], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('error: slide create 失敗:')
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('テーマのディレクトリが無い file: は theme-unknown + exit 1 (runtime error)', async () => {
    const projectDirectory = temporaryRoot('sample-no-theme')
    const stdout = makeStream()
    const command = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(stdout), stderr: asStream(makeStream()) }))
    const previousExitCode = process.exitCode
    try {
      await command.parseAsync([projectDirectory, '--theme', `file:${temporaryRoot('no-such-theme')}`, '--json'], { from: 'user' })
      const lastLine = stdout.chunks.join('').trim().split('\n').findLast(l => l.length > 0) ?? ''
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastLine) as { event: string, reason: string, detail: string }
      expect(parsed.event).toBe('slide.create.error')
      expect(parsed.reason).toBe('theme-unknown')
      expect(parsed.detail).toContain('package.json')
      expect(process.exitCode).toBe(1)
      expect(existsSync(projectDirectory)).toBe(false)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('引数未指定 + --json で commander が slide.create.error(invalid-option) を stdout に出す', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(stdout), stderr: asStream(stderr) }))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'create', '--json']
    try {
      await expect(
        command.parseAsync(['--json'], { from: 'user' }),
      ).rejects.toThrow()
      const written = stdout.chunks.join('').trim()
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(written) as { event: string, reason: string }
      expect(parsed.event).toBe('slide.create.error')
      expect(parsed.reason).toBe('invalid-option')
      expect(stderr.chunks.length).toBe(0)
    }
    finally {
      process.argv = originalArgv
    }
  })

  it('引数未指定 + --json なしは commander が stderr に英文を出す (必須の --theme が先に挙がる)', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(stdout), stderr: asStream(stderr) }))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'create']
    try {
      await expect(
        command.parseAsync([], { from: 'user' }),
      ).rejects.toThrow()
      expect(stderr.chunks.join('')).toContain('--theme')
      expect(stdout.chunks.length).toBe(0)
    }
    finally {
      process.argv = originalArgv
    }
  })

  it('--theme 無しは commander が invalid-option で止める', async () => {
    const stdout = makeStream()
    const command = createSlideCreateCommand(() => buildDependencies({ stdout: asStream(stdout), stderr: asStream(makeStream()) }))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'create', 'talk', '--json']
    try {
      await expect(command.parseAsync([temporaryRoot('talk'), '--json'], { from: 'user' })).rejects.toThrow()
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(stdout.chunks.join('').trim()) as { reason: string, detail: string }
      expect(parsed.reason).toBe('invalid-option')
      expect(parsed.detail).toContain('--theme')
    }
    finally {
      process.argv = originalArgv
    }
  })
})

describe('slideCreateDefaultDependencies', () => {
  it('CLAUDE_PLUGIN_ROOT を読んで pluginRoot を構築する', () => {
    const previous = process.env['CLAUDE_PLUGIN_ROOT']
    process.env['CLAUDE_PLUGIN_ROOT'] = '/tmp/x'
    try {
      const dependencies = slideCreateDefaultDependencies()
      expect(dependencies.pluginRoot).toBe('/tmp/x')
      expect(typeof dependencies.now()).toBe('number')
    }
    finally {
      if (previous === undefined) {
        delete process.env['CLAUDE_PLUGIN_ROOT']
      }
      else {
        process.env['CLAUDE_PLUGIN_ROOT'] = previous
      }
    }
  })
})

// 実ファイルの書き込みを避け、pages/ の再生成を見る。
describe('pages/ の再生成 (slide create --force 経由)', () => {
  it('pages/ は初期ページだけになり、テーマの参照は書き出さない', async () => {
    const projectDirectory = temporaryRoot('pages-test')
    mkdirSync(path.join(projectDirectory, 'pages'), { recursive: true })
    writeFileSync(path.join(projectDirectory, 'pages', 'old.md'), '# 旧\n')

    await runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: true, emitCatalog: false },
      buildDependencies(),
    )

    expect(readdirSync(path.join(projectDirectory, 'pages')).toSorted(compareStrings)).toEqual(['cover.md', 'end.md', 'section.md'])
  })
})
