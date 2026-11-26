// commands/slidev-project/create.ts の integration test。
// テーマは `file:` で指す。fixture テーマを一時ディレクトリへ写して使う（file: の取得は install しないため）。
// plugin-root は pnpm install 済みでないと、node_modules の張り先が realpath で解決できない。
// そのため test 自前で、plugins/pecot-visual に node_modules が存在することを期待する。

/* eslint-disable security/detect-non-literal-fs-filename */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SlideCreateUsageError,
  errorToReason,
  executeSlideCreate,
  slideCreateDefaultDependencies,
  runSlideCreate,
} from '../../../src/commands/slidev-project/create.js'
import type { SlideCreateDependencies } from '../../../src/commands/slidev-project/create.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import { START_SCRIPT_SOURCE, viteConfigSource } from '../../../src/domain/slidev-project/generated-files.js'
import { resolvePluginRoot } from '../../../src/infra/_shared/plugin-root.js'
import { copyFixtureTheme as copyTheme } from '../../_helpers/theme-fixtures.js'
import type { CopiedTheme, FixtureTheme } from '../../_helpers/theme-fixtures.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { verifies } from '../../_helpers/verifies.js'
import { readOutput } from '../../_helpers/attach.js'
import { makeStream } from '../../_helpers/talk-directory.js'
import type { CapturedStream } from '../../_helpers/talk-directory.js'

const HERE = import.meta.dirname
// repo の plugins/pecot-visual が plugin-root（cli/.. = plugins/pecot-visual）。
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const DEPENDENCY_NODE_MODULES = path.resolve(PLUGIN_ROOT, '..', '..', 'node_modules')
const DECLARED_THEME_NAME = 'slidev-theme-pecotv-test-declared'
const BARE_THEME_NAME = 'slidev-theme-pecotv-test-bare'

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
  return JSON.parse(readOutput(file)) as Record<string, unknown>
}

describe('executeSlideCreate (smoke)', () => {
  it('fixture テーマを file: で指して、生成するものだけを作る', async () => {
    const theme = declaredTheme()
    const projectDirectory = temporaryRoot('sample')
    const stderr = makeStream('stderr')
    const { summary, data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false },
      buildDependencies({ stderr: asStream(stderr) }),
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
      expect(readOutput(path.join(projectDirectory, 'pages', `${name}.md`)).startsWith(`---\nlayout: ${name}\n`)).toBe(true)
    }

    // slides.md: theme: はパッケージ名。テーマの headmatter は書かない。
    const slidesMd = readOutput(path.join(projectDirectory, 'slides.md'))
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
    expect(readOutput(path.join(projectDirectory, 'vite.config.ts'))).toBe(viteConfigSource({ themeName: DECLARED_THEME_NAME }))
    expect(readOutput(path.join(projectDirectory, 'start.mjs'))).toBe(START_SCRIPT_SOURCE)

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

    // layout catalog は data に載る。hidden の scratch は現れない。
    // eslint-disable-next-line no-restricted-syntax -- data の layouts / categories を検証用に narrowing
    const layouts = data['layouts'] as readonly { layout: string, category: string, deprecated: boolean }[]
    // eslint-disable-next-line no-restricted-syntax -- data の categories を検証用に narrowing
    const categories = data['categories'] as readonly { id: string, label: string }[]
    const names = layouts.map(entry => entry.layout)
    expect(names).toContain('cover')
    expect(names).not.toContain('scratch')

    // 分類の並びは _common.yaml の layout_categories の宣言順。
    expect(categories.map(category => category.label)).toEqual(['文章', '図'])

    // deprecated は所属分類（図）のまま残り、同じ群の中では stable が先。
    const figureId = categories.find(category => category.label === '図')?.id
    const figure = layouts.filter(entry => entry.category === figureId)
    expect(figure.find(entry => entry.layout === 'legacy-panel')?.deprecated).toBe(true)
    expect(figure.map(entry => entry.layout).indexOf('panel'))
      .toBeLessThan(figure.map(entry => entry.layout).indexOf('legacy-panel'))

    // 分類を読み取れなかったときだけ出る warn が出ていないこと。
    expect(stderr.chunks.join('')).not.toContain('cannot read the layout categories')
    // 分類を読み取れなかったときだけ出る warn が出ていないこと。
    expect(stderr.chunks.join('')).not.toContain('cannot read the layout categories')
  })

  it('fixture テーマ: 宣言の examples から初期ページを作り、生成する vite.config.ts はテーマの name だけで決まる', async () => {
    const theme = copyFixtureTheme('with-declaration', 'declared-theme')
    const projectDirectory = temporaryRoot('declared-talk')
    const stderr = makeStream('stderr')

    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false },
      buildDependencies({ stderr: asStream(stderr) }),
    )

    // fixture は cover・section・end が 4 つの候補に当たる。各 examples の雛形がそのまま入る。
    expect(readdirSync(path.join(projectDirectory, 'pages')).toSorted(compareStrings)).toEqual(['cover.md', 'end.md', 'section.md'])
    expect(readOutput(path.join(projectDirectory, 'pages', 'cover.md')))
      .toBe('---\nlayout: cover\nheading: 発表タイトル\nsubtitle: 副題の例\n---\n')
    expect(readOutput(path.join(projectDirectory, 'slides.md')))
      .toBe(`---\ntheme: ${DECLARED_THEME_NAME}\ntitle: Declared Talk\nsrc: ./pages/cover.md\n---\n<!-- markdownlint-disable -->\n`
        + '\n---\nsrc: ./pages/section.md\n---\n'
        + '\n---\nsrc: ./pages/end.md\n---\n')
    expect(readOutput(path.join(projectDirectory, 'vite.config.ts')))
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
    const stderr = makeStream('stderr')

    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false },
      buildDependencies({ stderr: asStream(stderr) }),
    )

    expect(readdirSync(path.join(projectDirectory, 'pages'))).toEqual(['one.md'])
    expect(readOutput(path.join(projectDirectory, 'pages', 'one.md'))).toBe('---\nlayout: one\n---\n')
    expect(readOutput(path.join(projectDirectory, 'slides.md')))
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

    const stderr = makeStream('stderr')
    const dependencies = buildDependencies({ fetchTheme, stderr: asStream(stderr) })
    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false },
      dependencies,
    )

    expect(data['warnings']).toEqual(expect.arrayContaining(['取得中の警告']))
    // 接頭辞は create が 1 回だけ付ける。
    expect(stderr.chunks.join('')).toContain('warning: 取得中の警告\n')
    expect(stderr.chunks.join('')).not.toContain('warning: warning:')
    expect(readOutput(path.join(projectDirectory, 'vite.config.ts')))
      .toBe(viteConfigSource({ themeName: BARE_THEME_NAME }))
  })

  it('相対の file: は cwd 基準で絶対化し、package.json には talk-dir からの相対で書く', async () => {
    const theme = copyFixtureTheme('without-declaration', 'bare-theme')
    const projectDirectory = temporaryRoot('nested', 'talk')
    const currentDirectory = temporaryRoot()

    const { summary } = await executeSlideCreate(
      projectDirectory,
      { theme: 'file:./bare-theme', force: false },
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
      { theme: declaredTheme().spec, force: false },
      buildDependencies(),
    )
    await expect(runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: false },
      buildDependencies(),
    )).rejects.toThrow(SlideCreateUsageError)
  })

  it('--force で既存ディレクトリを上書きし、前の生成物を残さない', async (context) => {
    await verifies(context, 'PV-SLIDE-CREATE-05')
    const projectDirectory = temporaryRoot('sample')
    await runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: false },
      buildDependencies(),
    )
    writeFileSync(path.join(projectDirectory, 'pages', 'stale.md'), '# 前回の生成物\n')

    // ２回目を --force で実行しても成功する
    const result = await runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: true },
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
      { theme: theme.spec, force: false },
      dependencies,
    )).rejects.toMatchObject({ reason: 'symlink-failed' })

    expect(existsSync(projectDirectory)).toBe(false)
  })

  it('--force で、生成の途中 (node_modules の組み立て) に失敗しても、既存の生成先は残り、一時 dir は残らない', async (context) => {
    await verifies(context, 'PV-SLIDE-CREATE-05')
    await verifies(context, 'PV-SLIDE-CREATE-10')
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
      { theme: 'file:./whatever', force: true },
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
      { theme: theme.spec, force: false },
      dependencies,
    )

    expect(data['warnings']).toEqual(expect.arrayContaining([expect.stringContaining('pptx.linkColor is omitted')]))
  })
})

describe('executeSlideCreate の結果と失敗', () => {
  it('成功時の data に slide.create.done と projectDir・theme を載せ、template は載せない', async () => {
    const projectDirectory = temporaryRoot('sample-cmd')

    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: false },
      buildDependencies(),
    )

    expect(data['event']).toBe('slide.create.done')
    expect(data['projectDir']).toBe(projectDirectory)
    expect(data['theme']).toMatchObject({ name: DECLARED_THEME_NAME })
    expect(data).not.toHaveProperty('template')
  })

  it('既存ディレクトリ + force=false は dest-exists の reason と文言を返す', async () => {
    const projectDirectory = temporaryRoot('sample-conflict')
    await executeSlideCreate(projectDirectory, { theme: declaredTheme().spec, force: false }, buildDependencies())

    const error = await rejectionOf(executeSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: false },
      buildDependencies(),
    ))

    expect(errorToReason(error)).toBe('dest-exists')
    expect(error).toBeInstanceOf(Error)
  })

  it('テーマのディレクトリが無い file: は theme-unknown で、生成先を作らない', async () => {
    const projectDirectory = temporaryRoot('sample-no-theme')

    const error = await rejectionOf(executeSlideCreate(
      projectDirectory,
      { theme: `file:${temporaryRoot('no-such-theme')}`, force: false },
      buildDependencies(),
    ))

    expect(errorToReason(error)).toBe('theme-unknown')
    expect(error instanceof Error ? error.message : '').toContain('package.json')
    expect(existsSync(projectDirectory)).toBe(false)
  })
})

describe('slideCreateDefaultDependencies', () => {
  it('CLAUDE_PLUGIN_ROOT があっても読まず、pluginRoot をサーバ自身の置き場所から求める', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/installed/pecot-visual')
    try {
      const dependencies = slideCreateDefaultDependencies()
      expect(dependencies.pluginRoot).toBe(resolvePluginRoot())
      expect(typeof dependencies.now()).toBe('number')
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})

// 実ファイルの書き込みを避け、pages/ の再生成を見る。
describe('pages/ の再生成 (slide_create の force 経由)', () => {
  it('pages/ は初期ページだけになり、テーマの参照は書き出さない', async () => {
    const projectDirectory = temporaryRoot('pages-test')
    mkdirSync(path.join(projectDirectory, 'pages'), { recursive: true })
    writeFileSync(path.join(projectDirectory, 'pages', 'old.md'), '# 旧\n')

    await runSlideCreate(
      projectDirectory,
      { theme: declaredTheme().spec, force: true },
      buildDependencies(),
    )

    expect(readdirSync(path.join(projectDirectory, 'pages')).toSorted(compareStrings)).toEqual(['cover.md', 'end.md', 'section.md'])
  })
})
