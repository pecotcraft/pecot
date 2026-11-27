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
import { explains } from '../../_helpers/explains.js'

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
  it('fixture のテーマを file: で指定すると、決まったファイルだけを生成し、レイアウトの一覧を標準出力に表示する', async () => {
    await explains('`slide create` の実行結果のテストです。fixture のテーマを `file:` で指定した場合に、`slides.md`・`package.json`・`pages` などが生成されることを確認します。')
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

  it('宣言を持つテーマでは、宣言の examples から初期ページを作成し、vite.config.ts はテーマの name だけで決まる', async () => {
    await explains('宣言を持つテーマに対する、`slide create` のテストです。宣言の `examples` から初期ページと `slides.md` が作成され、結果のイベントにレイアウトの名前・分類・並びが宣言どおりに含まれることを確認します。')
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

  it('宣言を持たないテーマでは、layout だけの初期ページを 1 つ作成し、警告を表示する', async () => {
    await explains('宣言を持たないテーマに対する、`slide create` のテストです。初期ページが `one.md` の 1 つだけ作成され、`examples` に関する警告が標準エラーと結果の `warnings` に含まれることを確認します。')
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

  it('テーマの取得中に警告が出ると結果の warnings に含め、package.json が JSON でないテーマでも生成を続ける', async () => {
    await explains('テーマの取得中に警告が発生した場合の、`slide create` のテストです。警告が `warnings` に含まれ、標準エラーには `warning:` の接頭辞が 1 回だけ付いて表示され、生成が最後まで進むことを確認します。')
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

  it('相対パスの file: は現在のディレクトリを基準に絶対パスへ変換し、package.json には talk-dir からの相対パスで書く', async () => {
    await explains('相対パスで指定したテーマの扱いのテストです。`file:./bare-theme` を指定した場合に、`package.json` へ相対パス `file:../../bare-theme` が書かれることを確認します。')
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

  it('出力先のディレクトリが存在し force が false の場合は、dest-exists の SlideCreateUsageError が発生する', async () => {
    await explains('出力先がすでに存在する場合の、`runSlideCreate` のテストです。生成した後で、同じ出力先へ `force: false` で再度実行した場合に、`SlideCreateUsageError` の例外が発生することを確認します。')
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
    await explains('`--force` を指定した場合の、`runSlideCreate` のテストです。生成済みの出力先に前回の生成物 `stale.md` がある状態で再実行した場合に、成功し、`stale.md` が削除されて初期ページが作成されることを確認します。')
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

  it('生成の途中で失敗すると、生成途中の talk-dir を削除する', async () => {
    await explains('生成が途中で失敗した場合の、`runSlideCreate` のテストです。依存のルートに `node_modules` が存在せず、`symlink-failed` で失敗した場合に、生成途中の出力先が残らないことを確認します。')
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

  it('--force を指定した生成の途中で node_modules の組み立てに失敗しても、既存の出力先を残し、一時ディレクトリを残さない', async (context) => {
    await verifies(context, 'PV-SLIDE-CREATE-05')
    await explains('`--force` を指定した生成が途中で失敗した場合の、`runSlideCreate` のテストです。テーマのディレクトリが存在せず、例外で失敗した場合に、既存の `slides.md` は元の内容のまま残り、一時ディレクトリも残らないことを確認します。')
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
    await explains('テーマの宣言に関する警告のテストです。宣言を持たないテーマで生成した場合に、`pptx.linkColor` が省略されることを知らせる警告が、結果の `warnings` に含まれることを確認します。')
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
    await explains('`executeSlideCreate` の成功時の結果のテストです。テーマを指定して生成が成功した場合は、`slide.create.done` のイベントへ `projectDir` と `theme` が含まれ、`template` は含まれないことを確認します。')
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
    await explains('`executeSlideCreate` の生成先の検証のテストです。既存のディレクトリへ `force: false` で生成した場合に、例外が発生し、理由が `dest-exists` になることを確認します。')
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
    await explains('`executeSlideCreate` のテーマの検証のテストです。ディレクトリが存在しないテーマを `file:` で指定した場合に、理由が `theme-unknown` の例外が発生し、生成先を作成しないことを確認します。')
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
  it('CLAUDE_PLUGIN_ROOT があっても読まず、pluginRoot をサーバ自身の置き場所から求める', async () => {
    await explains('`slideCreateDefaultDependencies` の `pluginRoot` のテストです。環境変数 `CLAUDE_PLUGIN_ROOT` を設定していても、`pluginRoot` はサーバ自身の置き場所から求めた値になり、`now` が数値を返すことを確認します。')
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
  it('--force で再生成すると、pages には初期ページだけが残り、テーマの参照は書き出さない', async () => {
    await explains('`pages` ディレクトリの再生成のテストです。古い `old.md` がある出力先へ `force: true` で生成した場合に、`pages` が `cover.md`・`end.md`・`section.md` だけになることを確認します。')
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
