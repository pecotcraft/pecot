// commands/slidev-project/theme.ts の unit test。
// fixture テーマを node_modules/<name> に symlink した一時 talk-dir で、`slide theme` の出力を固定する。
// I/O 境界（ファイル読み取り）は実装を通し、モックしない。ネットワークには出ない。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てのみ */
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  errorToReason,
  executeSlideTheme,
  slideThemeDefaultDependencies,
} from '../../../src/commands/slidev-project/theme.js'
import type { SlideThemeDependencies } from '../../../src/commands/slidev-project/theme.js'
import { NodeThemeFiles } from '../../../src/infra/slidev-theme/fs.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { verifies } from '../../_helpers/verifies.js'
import { explains } from '../../_helpers/explains.js'

const THEMES = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'themes')
const WITH_DECLARATION = path.join(THEMES, 'with-declaration')
const WITHOUT_DECLARATION = path.join(THEMES, 'without-declaration')
const WITH_DECLARATION_NAME = 'slidev-theme-pecotv-test-declared'

const temporaryRoot = useTemporaryDirectory('pecotv-slide-theme-unit-', { resolveRealPath: true })

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

interface Captured {
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
}

// write を持つ stub をそのまま使う。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function asStream(chunks: string[]): NodeJS.WritableStream {
  const stub = {
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return stub as unknown as NodeJS.WritableStream
}

function makeDependencies(): { dependencies: SlideThemeDependencies, captured: Captured } {
  const stdout: string[] = []
  const stderr: string[] = []
  const dependencies: SlideThemeDependencies = {
    files: new NodeThemeFiles(),
    currentDirectory: temporaryRoot(),
    stdout: asStream(stdout),
    stderr: asStream(stderr),
  }
  return { dependencies, captured: { stdout, stderr } }
}

interface TalkOptions {
  readonly themeRoot?: string
  readonly themeName?: string
  readonly themeField?: string
  readonly link?: boolean
}

// themeRoot を node_modules/<name> に symlink した talk-dir を作る。
function makeTalk(options: Readonly<TalkOptions> = {}): string {
  const { themeRoot = WITH_DECLARATION, themeName = WITH_DECLARATION_NAME, themeField = themeName, link = true } = options
  const talk = temporaryRoot('talk')
  mkdirSync(talk, { recursive: true })
  writeFileSync(path.join(talk, 'slides.md'), `---\ntheme: ${themeField}\ntitle: テスト\n---\n\n# 表紙\n`)
  writeFileSync(
    path.join(talk, 'package.json'),
    JSON.stringify({ name: 'talk', dependencies: { [themeName]: `file:${themeRoot}` } }),
  )
  if (link) {
    mkdirSync(path.join(talk, 'node_modules'), { recursive: true })
    symlinkSync(themeRoot, path.join(talk, 'node_modules', themeName))
  }
  return talk
}

describe('executeSlideTheme（宣言のあるテーマ）', () => {
  it('宣言ファイルを持つテーマを指定すると、テーマの情報と宣言の内容をすべて返す', async (context) => {
    await verifies(context, 'PV-SLIDE-THEME-01')
    await explains('`slide theme` が、`pecot-theme.json` を持つテーマを読んだときの結果のテストです。テーマ名・宣言・レイアウトの一覧・カテゴリ・lint の設定が宣言どおりに返り、警告が空であることを確認します。')
    const talk = makeTalk()
    const themeRoot = path.join(talk, 'node_modules', WITH_DECLARATION_NAME)
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)

    expect(data.event).toBe('slide.theme.done')
    expect(data.theme).toEqual({
      name: WITH_DECLARATION_NAME,
      spec: `file:${WITH_DECLARATION}`,
      declared: true,
      directory: themeRoot,
      linked: true,
    })
    expect(data.declaration).toMatchObject({
      schema: 1,
      fonts: { body: ['Test Sans'], heading: ['Test Sans'], eastAsian: 'Test Sans JP' },
      pptx: { eastAsianFont: 'Test Sans JP', linkColor: '0A7F3F' },
    })
    expect(data.categories).toEqual([
      { id: 'text', label: '文章', question: '文章で見せる' },
      { id: 'figure', label: '図', question: '図で見せる' },
    ])
    expect(data.layouts).toEqual([
      { layout: 'cover', description: '資料の表紙。タイトルと副題だけを置く。', category: 'text', deprecated: false, filename: 'cover.yaml' },
      { layout: 'end', description: '資料の最後に置く。結びの言葉だけを置く。', category: 'text', deprecated: false, filename: 'end.yaml' },
      { layout: 'link', description: '見出しと、リンク付きのカードを縦に並べる。参考資料や関連 URL をまとめる場面に使う。', category: 'text', deprecated: false, filename: 'link.yaml' },
      { layout: 'plain', description: '見出しと本文だけを置く最小のレイアウト。文章で伝える場面に使う。', category: 'text', deprecated: false, filename: 'plain.yaml' },
      { layout: 'section', description: '章の区切りに置く。見出しと一言の説明に、装飾の線を添える。', category: 'text', deprecated: false, filename: 'section.yaml' },
      { layout: 'marked', description: '見出しと印のセルを置く枠を持つレイアウト。図に印を付ける場面に使う。', category: 'figure', deprecated: false, filename: 'marked.yaml' },
      { layout: 'panel', description: '見出しと画像の枠を置くレイアウト。図を 1 つ見せる場面に使う。', category: 'figure', deprecated: false, filename: 'panel.yaml' },
      { layout: 'legacy-panel', description: '【非推奨】品質が水準に達していないため選ばない、見出しだけの枠。', category: 'figure', deprecated: true, filename: 'legacy-panel.yaml' },
    ])
    expect(data.lint).toEqual({
      referencesDirectories: [path.join(talk, 'references'), path.join(themeRoot, 'references')],
      panels: { panel: { width: 400, height: 300 } },
      markerLayouts: ['marked'],
      rules: {
        'slidev-pages-lint/no-unknown-props': 'error',
        'slidev-pages-lint/no-missing-page': 'error',
        'text-constraints/max-chars': 'error',
      },
    })
    expect(data.warnings).toEqual([])
  })

  it('slides.md の theme に短い名前を書いても、解決した完全な名前を返す', async () => {
    await explains('`slides.md` の `theme` に `pecotv-test-declared` のような短い名前を書いた場合のテストです。`slidev-theme-` から始まる完全なテーマ名に解決して返すことを確認します。')
    const talk = makeTalk({ themeField: 'pecotv-test-declared' })
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)
    expect(data.theme).toMatchObject({ name: WITH_DECLARATION_NAME })
  })

  it('talk-dir の references に同名のレイアウト宣言があると、テーマ側の宣言より優先する', async () => {
    await explains('talk-dir の `references/` に、テーマと同じ名前のレイアウト宣言がある場合のテストです。レイアウトの説明と非推奨の指定が talk-dir 側の内容になることを確認します。')
    const talk = makeTalk()
    mkdirSync(path.join(talk, 'references'))
    writeFileSync(
      path.join(talk, 'references', 'plain.yaml'),
      `layout: 'plain'\ndescription: 'talk-dir の説明'\ncategory: 'text'\nstatus: deprecated\n`,
    )
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)
    expect(data.layouts).toContainEqual({
      layout: 'plain',
      description: 'talk-dir の説明',
      category: 'text',
      deprecated: true,
      filename: 'plain.yaml',
    })
  })

  it('宣言に pptx.linkColor が存在しないと、リンクが PPTX に変換されない旨の警告を返す', async () => {
    await explains('`pecot-theme.json` に `pptx.linkColor` が指定されていない場合の警告のテストです。リンクが PPTX に変換されないことと、設定の修正方法を示す警告が 1 件だけ返ることを確認します。')
    const themeRoot = temporaryRoot('theme-without-link-color')
    cpSync(WITH_DECLARATION, themeRoot, { recursive: true })
    writeFileSync(
      path.join(themeRoot, 'pecot-theme.json'),
      JSON.stringify({ schema: 1, pptx: { eastAsianFont: 'Test Sans JP' } }),
    )
    const talk = makeTalk({ themeRoot })
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)
    expect(data.warnings).toEqual([
      'pptx.linkColor is omitted, so links are not converted in PPTX (no hyperlinks are added) (fix: set pptx.linkColor in pecot-theme.json to a 6-digit hex value to convert links)',
    ])
  })

  it('宣言に警告がある場合は、その警告を warnings の先頭に並べる', async () => {
    await explains('宣言の `schema` が未対応の新しい版である場合の警告のテストです。宣言に関する警告が `warnings` の先頭に並び、全体で 2 件になることを確認します。')
    const themeRoot = temporaryRoot('theme-future-schema')
    cpSync(WITH_DECLARATION, themeRoot, { recursive: true })
    writeFileSync(path.join(themeRoot, 'pecot-theme.json'), JSON.stringify({ schema: 2 }))
    const talk = makeTalk({ themeRoot })
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)
    const { warnings } = data
    expect(warnings[0]).toContain('schema 2')
    expect(warnings).toHaveLength(2)
  })
})

describe('executeSlideTheme（宣言の無いテーマ）', () => {
  it('宣言ファイルを持たないテーマを指定すると、declared を false にして既定値の一覧と警告を返す', async () => {
    await explains('`pecot-theme.json` を持たないテーマを読んだ場合のテストです。`declared` が `false` になり、`.vue` ファイルから作ったレイアウト一覧と未分類のカテゴリを返すことと、宣言が存在しない旨の警告を含むことを確認します。')
    const talk = makeTalk({ themeRoot: WITHOUT_DECLARATION, themeName: 'slidev-theme-pecotv-test-bare' })
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)

    expect(data.theme).toMatchObject({ name: 'slidev-theme-pecotv-test-bare', declared: false })
    expect(data.layouts).toEqual([
      { layout: 'one', description: '', category: 'uncategorized', deprecated: false, filename: 'one.vue' },
      { layout: 'two', description: '', category: 'uncategorized', deprecated: false, filename: 'two.vue' },
    ])
    expect(data.categories).toEqual([
      expect.objectContaining({ id: 'uncategorized', label: 'Uncategorized' }),
    ])
    const { warnings } = data
    expect(warnings[0]).toContain('has no pecot-theme.json declaration')
    expect(warnings.some(warning => warning.includes('cannot read the layout categories'))).toBe(true)
    expect(warnings.some(warning => warning.includes('pptx.linkColor'))).toBe(true)
  })
})

describe('executeSlideTheme（pecot-theme.json を持つ dir）', () => {
  it('theme に none を指定した dir に pecot-theme.json があっても、テーマとして読まず theme-none で失敗する', async () => {
    await explains('`theme: none` と書かれた `slides.md` の dir に、`pecot-theme.json` が置かれている場合のテストです。その dir をテーマとして扱わず、理由が `theme-none` の例外が発生することを確認します。')
    const talk = temporaryRoot('theme-root')
    cpSync(WITH_DECLARATION, talk, { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n\n# 見本\n')
    const { dependencies } = makeDependencies()

    await expect(executeSlideTheme({ dir: talk }, dependencies)).rejects.toMatchObject({ reason: 'theme-none' })
  })
})

describe('executeSlideTheme の失敗', () => {
  it('テーマが node_modules にリンクされていないと、theme-unlinked の例外が発生する', async () => {
    await explains('`node_modules` にテーマのリンクが存在しない talk-dir を指定した場合のテストです。理由が `theme-unlinked` の例外が発生することを確認します。')
    const talk = makeTalk({ link: false })
    const { dependencies } = makeDependencies()
    await expect(executeSlideTheme({ dir: talk }, dependencies)).rejects.toMatchObject({ reason: 'theme-unlinked' })
  })

  it('宣言の形式が誤っていると、invalid-shape の例外が発生する', async (context) => {
    await verifies(context, 'PV-SLIDE-THEME-05')
    await explains('`pecot-theme.json` の `slide.width` に負の値を指定した場合のテストです。理由が `invalid-shape` の例外が発生することを確認します。')
    const themeRoot = temporaryRoot('theme-broken')
    cpSync(WITH_DECLARATION, themeRoot, { recursive: true })
    writeFileSync(path.join(themeRoot, 'pecot-theme.json'), JSON.stringify({ schema: 1, slide: { width: -1, height: 1 } }))
    const talk = makeTalk({ themeRoot })
    const { dependencies } = makeDependencies()
    await expect(executeSlideTheme({ dir: talk }, dependencies)).rejects.toMatchObject({ reason: 'invalid-shape' })
  })
})

describe('executeSlideTheme の失敗の reason', () => {
  it('テーマを張っていない talk-dir は theme-unlinked で、node_modules_only の syncを示す', async () => {
    await explains('`executeSlideTheme` のテーマの検証のテストです。テーマを張っていない talk-dir の場合に、理由が `theme-unlinked` の例外が発生し、メッセージで `node_modules_only` の同期を案内することを確認します。')
    const talk = makeTalk({ link: false })

    const { dependencies } = makeDependencies()
    const error = await rejectionOf(executeSlideTheme({ dir: talk }, dependencies))

    expect(errorToReason(error)).toBe('theme-unlinked')
    expect(error instanceof Error ? error.message : '').toEqual(expect.stringContaining('node_modules_only'))
  })

  it('theme: none の talk-dir は theme-none で、slide_sync の theme を案内する', async () => {
    await explains('`executeSlideTheme` のテーマの検証のテストです。`slides.md` の `theme` が `none` の talk-dir の場合に、理由が `theme-none` の例外が発生し、`slide_sync` の `theme` の指定を案内することを確認します。')
    const talk = temporaryRoot('legacy')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n')

    const { dependencies } = makeDependencies()
    const error = await rejectionOf(executeSlideTheme({ dir: talk }, dependencies))

    expect(errorToReason(error)).toBe('theme-none')
    expect(error instanceof Error ? error.message : '').toEqual(expect.stringContaining('slide_sync with theme: <theme-spec>'))
  })

  it('宣言に誤りがあると、reason を theme- で始まる値にして表示する', async () => {
    await explains('`pecot-theme.json` が存在しない lint の規則を指定している場合のテストです。終了コードが 1 になり、`reason` が `theme-unknown-rule` になることと、`detail` に規則名 `no-such/rule` が含まれることを確認します。')
    const themeRoot = temporaryRoot('theme-unknown-rule')
    cpSync(WITH_DECLARATION, themeRoot, { recursive: true })
    writeFileSync(
      path.join(themeRoot, 'pecot-theme.json'),
      JSON.stringify({ schema: 1, lint: { rules: { 'no-such/rule': 'error' } } }),
    )
    const talk = makeTalk({ themeRoot })

    const { dependencies } = makeDependencies()
    const error = await rejectionOf(executeSlideTheme({ dir: talk }, dependencies))

    expect(errorToReason(error)).toBe('theme-unknown-rule')
    expect(error instanceof Error ? error.message : '').toEqual(expect.stringContaining('no-such/rule'))
  })
})

describe('errorToReason', () => {
  it('テーマの解決や宣言に由来しない例外は、reason を unknown にする', async () => {
    await explains('`errorToReason` が、通常の `Error` を受け取った場合のテストです。テーマの解決や宣言に由来しない例外は、`unknown` を返すことを確認します。')
    expect(errorToReason(new Error('x'))).toBe('unknown')
  })
})

describe('slideThemeDefaultDependencies', () => {
  it('既定の依存には、実際のファイル読み取りとプロセスの入出力を使う', async () => {
    await explains('`slideThemeDefaultDependencies` が返す既定の依存のテストです。ファイル読み取りに `NodeThemeFiles`、カレントディレクトリに `process.cwd()`、出力先に `process.stdout` と `process.stderr` を使うことを確認します。')
    const dependencies = slideThemeDefaultDependencies()
    expect(dependencies.files).toBeInstanceOf(NodeThemeFiles)
    expect(dependencies.currentDirectory).toBe(process.cwd())
    expect(dependencies.stdout).toBe(process.stdout)
    expect(dependencies.stderr).toBe(process.stderr)
  })
})
