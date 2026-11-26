// slide_page ツールのハンドラ単体テスト。
//
// fixture テーマ（with-declaration）の複製を node_modules/<name> に symlink する。
// その talk-dir に対して
// ハンドラを直接呼び、「生成されたページの中身」と「応答の data」を見る。子プロセスは 1 つも起こさない。
// 複製にするのは、参照 yaml を足したり壊したりするケースがあるため。
//
// tools/list に載る形は、src/mcp/tests/contract.test.ts が pin する。
// 対象はパラメータ集合・annotations・outputSchema。
// そのため、ここでは扱わない。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下の fixture のみ */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { isRecord } from '../../../../tests/_helpers/records.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
import { compareStrings } from '../../../domain/_shared/compare-strings.js'
import { executeSlideTheme } from '../../../commands/slidev-project/theme.js'
import { NodeThemeFiles } from '../../../infra/slidev-theme/fs.js'
import type { ToolCallContext } from '../../server.js'
import { normalizePageFileName, slidePageTool } from '../slide-page.js'
import { withOutputCheck } from './_output.js'
import { explains } from '../../../../tests/_helpers/explains.js'

// src/mcp/tools/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const THEMES = path.join(CLI_ROOT, 'tests', 'fixtures', 'themes')
const THEME_FIXTURE = path.join(THEMES, 'with-declaration')
const BARE_FIXTURE = path.join(THEMES, 'without-declaration')
const THEME_NAME = 'slidev-theme-pecotv-test-declared'
const BARE_NAME = 'slidev-theme-pecotv-test-bare'

/**
応答 1 件あたりのサイズ予算 (JSON.stringify 後の文字数)。

toCallToolResult() は content と structuredContent の双方に同じ JSON を載せる (src/mcp/result.ts)。
そのため、クライアントへ渡る量はこの倍になる。
fixture テーマの応答は数千文字。参照 yaml が肥大したときにここで気づくよう、余裕を見た上限を置く。
*/
const DATA_SIZE_BUDGET = 40_000

/**
ハンドラは呼び出し文脈を読まないが、ToolHandler の型が 2 引数を要求するため最小のフェイクを渡す。
*/
const CALL: ToolCallContext = { signal: new AbortController().signal }

const tool = withOutputCheck(slidePageTool())

const temporaryDirectories: string[] = []

interface TalkOptions {
  readonly themeFixture?: string
  readonly themeName?: string
  // false でテーマを node_modules に張らない
  readonly link?: boolean
}

/**
テーマの複製を node_modules/<name> に symlink した talk-dir。`theme` は複製の root（参照 yaml をいじるための場所）。
*/
function makeTalkDirectory(options: Readonly<TalkOptions> = {}): string {
  const { themeFixture = THEME_FIXTURE, themeName = THEME_NAME, link = true } = options
  const root = mkdtempSync(path.join(tmpdir(), 'pecotv-test-slide-page-'))
  temporaryDirectories.push(root)
  const directory = path.join(root, 'talk')
  const theme = path.join(root, 'theme')
  cpSync(themeFixture, theme, { recursive: true })
  mkdirSync(path.join(directory, 'pages'), { recursive: true })
  writeFileSync(path.join(directory, 'slides.md'), `---\ntheme: ${themeName}\n---\n`, 'utf8')
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'talk', dependencies: { [themeName]: `file:${theme}` } }),
    'utf8',
  )
  if (link) {
    mkdirSync(path.join(directory, 'node_modules'))
    symlinkSync(theme, path.join(directory, 'node_modules', themeName), 'dir')
  }
  return directory
}

/**
複製したテーマの references/ のディレクトリ。talk-dir から node_modules 経由で辿る。
*/
function themeReferences(directory: string): string {
  return path.join(directory, 'node_modules', THEME_NAME, 'references')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
レイアウト全件のテーブル駆動に使う catalog。fixture テーマから `slide theme` と同じ手順で取る。
*/
const catalogExecution = await executeSlideTheme({ dir: makeTalkDirectory() }, { files: new NodeThemeFiles() })
const CATALOG = catalogExecution.data.layouts

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

function textOf(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('文字列ではありません')
  return value
}

/**
`pages/` 直下の生成物一覧。「ファイルを作っていない」の観測に使う。
*/
function pageFilesOf(directory: string): readonly string[] {
  const pages = path.join(directory, 'pages')
  return existsSync(pages) ? readdirSync(pages).toSorted(compareStrings) : []
}

describe('slide_page の成功ルート', () => {
  it('pages/ 配下にスケルトンを書き出し、reference と includes を返す', async (context) => {
    await verifies(context, 'PV-SLIDE-PAGE-01')
    await explains('`slide_page` ツールがページの雛形を書き出すテストです。`plain` レイアウトを指定した場合に、`pages/` に雛形が書き出され、参照 yaml の全文と共通仕様の yaml が結果に含まれることを確認します。')
    await verifies(context, 'PV-SLIDE-PAGE-02')
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'strategy' }, CALL)
    const structured = structuredOf(result)
    const data = dataOf(result)
    const target = path.join(directory, 'pages', 'strategy.md')

    expect(result.isError).toBeUndefined()
    expect(structured).not.toHaveProperty('kind')
    expect(structured['path']).toBe(target)
    expect(data['event']).toBe('slide.page.done')
    expect(data['layout']).toBe('plain')
    expect(data['category']).toBe('text')
    expect(data['deprecated']).toBe(false)
    expect(data['path']).toBe(target)

    // 書き出した内容と応答の skeleton は同じもの。examples の 1 件目の frontmatter そのまま。
    const written = readFileSync(target, 'utf8')
    expect(written).toBe(data['skeleton'])
    expect(written).toBe('---\nlayout: plain\nheading: 見出しの例\nbody: 本文の例\n---\n')

    // reference は参照 yaml の全文、includes は宣言された共通仕様 yaml の全文マップ。
    expect(data['reference']).toBe(readFileSync(path.join(THEME_FIXTURE, 'references', 'plain.yaml'), 'utf8'))
    const includes = data['includes']
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(Object.keys(includes)).toEqual(['_common'])
    expect(textOf(includes['_common'])).toBe(readFileSync(path.join(THEME_FIXTURE, 'references', '_common.yaml'), 'utf8'))

    // slides.md への登録が別作業であることを message で案内する (require-slides-entry の予防)。
    expect(textOf(sentenceOf(result))).toContain('slides.md')
    expect(textOf(sentenceOf(result))).toContain('src: ./pages/strategy.md')
  })

  it('ページを書いても slides.md は書き換えない', async (context) => {
    await verifies(context, 'PV-SLIDE-PAGE-09')
    await explains('`slide_page` ツールが `slides.md` を変更しないことのテストです。ページを書き出した場合に、`slides.md` の内容が書き出しの前後で変わらないことを確認します。')
    const directory = makeTalkDirectory()
    const slides = path.join(directory, 'slides.md')
    const before = readFileSync(slides, 'utf8')

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'strategy' }, CALL)

    expect(structuredOf(result)).not.toHaveProperty('kind')
    expect(existsSync(path.join(directory, 'pages', 'strategy.md'))).toBe(true)
    expect(readFileSync(slides, 'utf8')).toBe(before)
  })

  it('file の .md は省略できる (明示指定と同じ結果になる)', async (context) => {
    await verifies(context, 'PV-SLIDE-PAGE-03')
    await explains('`slide_page` ツールの `file` の拡張子のテストです。`file` の `.md` を省略した場合と明示した場合で、`pages/` 配下のパスが決まり、同じ雛形が書き出されることを確認します。')
    const directory = makeTalkDirectory()

    const omitted = await tool.handler({ layout: 'cover', dir: directory, file: 'chapter' }, CALL)
    const explicit = await tool.handler({ layout: 'cover', dir: directory, file: 'chapter-2.md' }, CALL)

    expect(dataOf(omitted)['path']).toBe(path.join(directory, 'pages', 'chapter.md'))
    expect(dataOf(explicit)['path']).toBe(path.join(directory, 'pages', 'chapter-2.md'))
    expect(dataOf(omitted)['skeleton']).toBe(dataOf(explicit)['skeleton'])
  })

  it('layout_categories を持たないテーマでも生成でき、category は uncategorized になる', async () => {
    // 分類語彙を引けないだけでページ生成は止めない
    // (`slide_page` を丸ごと失敗させると、分類を宣言していないテーマのデッキが編集不能になる)。
    await explains('`slide_page` ツールのレイアウトの分類のテストです。テーマがレイアウトの分類を宣言していない場合でも、ページを書き出し、`category` が `uncategorized` になることを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), '_common.yaml'),
      'description: 全レイアウトで使用可能な共通プロパティ。\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'cover', dir: directory, file: 'legacy' }, CALL)

    expect(structuredOf(result)).not.toHaveProperty('kind')
    expect(dataOf(result)['category']).toBe('uncategorized')
  })

  it('deprecated レイアウトも生成できる (deprecated: true で返る)', async () => {
    await explains('`slide_page` ツールの非推奨のレイアウトのテストです。参照 yaml が `status: deprecated` のレイアウトでも、ページを書き出し、結果の `deprecated` が `true` になることを確認します。')
    const directory = makeTalkDirectory()
    const reference = path.join(themeReferences(directory), 'cover.yaml')
    writeFileSync(reference, `${readFileSync(reference, 'utf8')}\nstatus: deprecated\n`, 'utf8')

    const result = await tool.handler({ layout: 'cover', dir: directory, file: 'legacy-cover' }, CALL)

    expect(structuredOf(result)).not.toHaveProperty('kind')
    expect(dataOf(result)['deprecated']).toBe(true)
  })

  it('talk-dir の references/ の宣言がテーマの宣言に勝ち、includes も talk-dir 側を先に探す', async () => {
    await explains('`slide_page` ツールの参照 yaml の優先順位のテストです。talk-dir の `references/` にある宣言がテーマの宣言より優先され、共通仕様の yaml も talk-dir 側から先に探すことを確認します。')
    const directory = makeTalkDirectory()
    const talkReferences = path.join(directory, 'references')
    mkdirSync(talkReferences)
    writeFileSync(
      path.join(talkReferences, 'plain.yaml'),
      'layout: plain\ndescription: talk-dir の上書き\ncategory: text\nincludes:\n  - _common\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      ---\n      layout: plain\n      heading: talk-dir の雛形\n      ---\n',
      'utf8',
    )
    writeFileSync(path.join(talkReferences, '_common.yaml'), 'description: talk-dir の共通仕様\n', 'utf8')

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'override' }, CALL)
    const data = dataOf(result)

    expect(structuredOf(result)).not.toHaveProperty('kind')
    expect(data['skeleton']).toBe('---\nlayout: plain\nheading: talk-dir の雛形\n---\n')
    const includes = data['includes']
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(includes['_common']).toBe('description: talk-dir の共通仕様\n')
  })

  it.each(CATALOG)('$layout のスケルトンが有効なフロントマターとして書き出される', async (entry) => {
    // Acceptance「layouts に載る任意のレイアウト名」を代表値でなく全件で満たす。
    await explains('`slide_page` ツールが、テーマのすべてのレイアウトで雛形を書き出すテストです。各レイアウトで、雛形が `---` で囲まれた有効な YAML で、`includes` が宣言と一致し、結果のサイズが上限以内であることを確認します。')
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: entry.layout, dir: directory, file: 'page' }, CALL)
    const data = dataOf(result)

    expect(result.isError, `layout: ${entry.layout}`).toBeUndefined()
    expect(data['deprecated'], `layout: ${entry.layout}`).toBe(entry.deprecated)
    expect(data['category'], `layout: ${entry.layout}`).toBe(entry.category)

    const skeleton = textOf(data['skeleton'])
    expect(skeleton.startsWith('---\n'), `layout: ${entry.layout}`).toBe(true)
    expect(skeleton.endsWith('---\n'), `layout: ${entry.layout}`).toBe(true)

    // `---` を剥がした中身が YAML として解釈でき、layout が要求どおりであること
    // (先頭数行だけ合っていて途中で切れている、を弾く)。
    const body = skeleton.slice('---\n'.length, skeleton.length - '---\n'.length)
    const parsed: unknown = parseYaml(body)
    if (!isRecord(parsed)) throw new Error(`${entry.layout}: フロントマターが object ではありません`)
    expect(parsed['layout'], `layout: ${entry.layout}`).toBe(entry.layout)

    // includes は宣言と応答のキー集合が一致する。
    const reference: unknown = parseYaml(textOf(data['reference']))
    if (!isRecord(reference)) throw new Error(`${entry.layout}: 参照 yaml が object ではありません`)
    const declared: unknown = reference['includes']
    const declaredNames = Array.isArray(declared)
      ? declared.filter((name: unknown): name is string => typeof name === 'string')
      : []
    const includes = data['includes']
    if (!isRecord(includes)) throw new Error(`${entry.layout}: includes が返っていません`)
    expect(Object.keys(includes).toSorted(compareStrings), `layout: ${entry.layout}`).toEqual(declaredNames.toSorted(compareStrings))

    // 応答サイズ予算。将来 yaml が肥大したらここで落ちる。
    expect(JSON.stringify(structuredOf(result)).length, `layout: ${entry.layout}`).toBeLessThan(DATA_SIZE_BUDGET)
  })
})

describe('slide_page の引数検証', () => {
  it('dir が相対パスなら、実処理を呼ばずに invalid-path のエラーを返す', async () => {
    await explains('`slide_page` ツールの入力パスの検証のテストです。`dir` に相対パスを指定した場合に、実処理に進まず `invalid-path` のエラーと、該当する指定の一覧を返すことを確認します。')
    const result = await tool.handler({ layout: 'plain', dir: 'talk', file: 'page' }, CALL)

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['kind']).toBe('invalid-path')
    expect(dataOf(result)['invalidPaths']).toEqual(['dir=talk'])
  })

  it.for([{ file: 'sub/page.md' }, { file: '../escape.md' }, { file: String.raw`sub\page.md` }])(
    'パス区切りを含む file ($file) は拒否する',
    async ({ file }, context) => {
      await verifies(context, 'PV-SLIDE-PAGE-08')
      await explains('`slide_page` ツールの `file` の検証のテストです。`sub/page.md` や `../escape.md` のようにパスの区切りを含む場合に、`invalid-file-name` のエラーを返し、ファイルを作らないことを確認します。')
      const directory = makeTalkDirectory()

      const result = await tool.handler({ layout: 'plain', dir: directory, file }, CALL)

      expect(structuredOf(result)['kind']).toBe('invalid-file-name')
      expect(pageFilesOf(directory)).toEqual([])
    },
  )

  it('空の file は拒否する', async () => {
    await explains('`slide_page` ツールの `file` の検証のテストです。`file` が空文字の場合に、`invalid-file-name` のエラーを返し、ファイルを作らないことを確認します。')
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: 'plain', dir: directory, file: '' }, CALL)

    expect(structuredOf(result)['kind']).toBe('invalid-file-name')
    expect(pageFilesOf(directory)).toEqual([])
  })

  // 拡張子だけ揃っていて名前として成立しない指定。書けてしまうと lint 以前に
  // 「意図しない名前のページが残る」ため、生成前に弾く。
  it.each(['..md', ' .md', '-cover.md', '.hidden.md', 'カバー.md', 'cover page.md'])(
    'ファイル名として成立しない file (%s) はファイルを作らずに拒否する',
    async (file) => {
      await explains('`slide_page` ツールの `file` の検証のテストです。`..md` や `カバー.md` のようにファイル名として成立しない場合に、`invalid-file-name` のエラーを返し、ファイルを作らないことを確認します。')
      const directory = makeTalkDirectory()

      const result = await tool.handler({ layout: 'plain', dir: directory, file }, CALL)

      expect(structuredOf(result)['kind'], `file: ${file}`).toBe('invalid-file-name')
      expect(pageFilesOf(directory), `file: ${file}`).toEqual([])
    },
  )

  // no-numeric-filename-prefix (slidev-pages-lint) と同じ判定であることを stem の境界で pin する。
  // ルール側は「拡張子を除いた stem の先頭が数字か」だけを見る。
  it.each([
    { file: '1cover', numeric: true },
    { file: '1cover.md', numeric: true },
    { file: '1.md', numeric: true },
    { file: '01-intro.md', numeric: true },
    { file: 'cover1', numeric: false },
    { file: 'cover-1.md', numeric: false },
    { file: 'cover.1.md', numeric: false },
  ])('file $file の数字始まり判定は lint ルールと一致する', async ({ file, numeric }) => {
    await explains('`normalizePageFileName` の数字で始まる名前の判定のテストです。拡張子を除いた名前が数字で始まる場合だけを不正とし、lint ルールの判定と同じ結果になることを確認します。')
    const checked = normalizePageFileName(file)
    expect(checked.ok).toBe(!numeric)

    // ルール側と同じ手順で stem を求め、判定が一致することを確認する。
    const written = file.endsWith('.md') ? file : `${file}.md`
    const stem = written.slice(0, written.length - path.extname(written).length)
    expect(/^\d/.test(stem)).toBe(numeric)
  })

  it('数字始まりの file はファイルを作らずに拒否する', async (context) => {
    await verifies(context, 'PV-SLIDE-PAGE-07')
    await explains('`slide_page` ツールの `file` の検証のテストです。`01-cover` のように数字で始まる場合に、`numeric-filename-prefix` のエラーを返し、ファイルを作らないことを確認します。')
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: 'plain', dir: directory, file: '01-cover' }, CALL)

    expect(structuredOf(result)['kind']).toBe('numeric-filename-prefix')
    expect(textOf(dataOf(result)['detail'])).toContain('slides.md')
    expect(pageFilesOf(directory)).toEqual([])
  })
})

describe('slide_page のテーマの失敗', () => {
  it('テーマを張っていない talk-dir は theme-unlinked で、slide_sync の node_modules_only を案内する', async () => {
    await explains('`slide_page` ツールのテーマが張られていない場合のテストです。テーマを張っていない場合は、`theme-unlinked` のエラーと `slide_sync` の案内を返し、ファイルを作らないことを確認します。')
    const directory = makeTalkDirectory({ link: false })

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)).toHaveProperty('kind')
    expect(dataOf(result)['event']).toBe('slide.page.error')
    expect(structuredOf(result)['kind']).toBe('theme-unlinked')
    const detail = textOf(dataOf(result)['detail'])
    expect(detail).toContain('slide_sync')
    expect(detail).toContain('node_modules_only: true')
    expect(Object.keys(structuredOf(result)).toSorted(compareStrings)).toEqual(['detail', 'event', 'kind'])
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('theme: none で宣言も無い talk-dir は theme-none で、slide_sync の theme を案内する', async () => {
    await explains('`slide_page` ツールのテーマの指定のテストです。`theme: none` で宣言も存在しない場合に、`theme-none` のエラーと `slide_sync` の `theme` の案内を返し、ファイルを作らないことを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(path.join(directory, 'slides.md'), '---\ntheme: none\n---\n', 'utf8')

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['kind']).toBe('theme-none')
    expect(textOf(dataOf(result)['detail'])).toContain('slide_sync with theme: <theme-spec>')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('宣言に未知の lint ルールがあると、theme-unknown-rule のエラーを返す', async () => {
    await explains('`slide_page` ツールのテーマの宣言の検証のテストです。宣言の `lint.rules` に存在しないルールが含まれる場合に、`theme-unknown-rule` のエラーを返し、ファイルを作らないことを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(directory, 'node_modules', THEME_NAME, 'pecot-theme.json'),
      JSON.stringify({ schema: 1, lint: { rules: { 'no-such/rule': 'error' } } }),
      'utf8',
    )

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['kind']).toBe('theme-unknown-rule')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('参照 yaml を持たないテーマ（layouts/*.vue だけ）は skeleton-unavailable で失敗する', async () => {
    await explains('`slide_page` ツールの参照 yaml がないテーマのテストです。`layouts/*.vue` だけを持つテーマの場合に、`skeleton-unavailable` のエラーを返し、ファイルを作らないことを確認します。')
    const directory = makeTalkDirectory({ themeFixture: BARE_FIXTURE, themeName: BARE_NAME })

    const result = await tool.handler({ layout: 'one', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['kind']).toBe('skeleton-unavailable')
    expect(textOf(dataOf(result)['detail'])).toContain('no reference yaml')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('テーマの警告は warnings に載せる', async () => {
    await explains('`slide_page` ツールのテーマの警告のテストです。参照 yaml を持たないテーマの場合に、テーマの警告が `warnings` に含まれることを確認します。')
    const directory = makeTalkDirectory({ themeFixture: BARE_FIXTURE, themeName: BARE_NAME })

    const result = await tool.handler({ layout: 'one', dir: directory, file: 'page' }, CALL)

    expect(dataOf(result)['warnings']).toEqual(expect.arrayContaining([expect.any(String)]))
    expect(String(dataOf(result)['warnings'])).not.toContain('warning: ')
  })
})

describe('slide_page の失敗ルート', () => {
  it('未知の layout は選択可能な一覧つきで失敗する', async (context) => {
    await verifies(context, 'PV-SLIDE-PAGE-06')
    await explains('`slide_page` ツールの未知のレイアウトのテストです。存在しないレイアウトを指定した場合に、`unknown-layout` のエラーと、選択できるレイアウトと分類の一覧を返し、ファイルを作らないことを確認します。')
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: 'no-such-layout', dir: directory, file: 'page' }, CALL)
    const data = dataOf(result)

    expect(result.isError).toBe(true)
    expect(data['kind']).toBe('unknown-layout')
    const layouts = data['layouts']
    if (!Array.isArray(layouts)) throw new TypeError('data.layouts が返っていません')
    expect(layouts).toHaveLength(CATALOG.length)
    expect(layouts.map(entry => (isRecord(entry) ? entry['layout'] : undefined))).toContain('plain')

    // 選び直しに要る分類語彙も同じ応答に載せる (layouts だけだと平坦な一覧に戻る)。
    const categories = data['categories']
    if (!Array.isArray(categories)) throw new TypeError('data.categories が返っていません')
    expect(categories.map(entry => (isRecord(entry) ? entry['id'] : undefined))).toEqual(['text', 'figure'])
    expect(pageFilesOf(directory)).toEqual([])
  })

  // catalog 一致確認がファイル読み取りより先にあることの pin。順序が破損すると任意ファイル読みになる。
  it.each([
    '../../../etc/passwd',
    '_common',
    '_template',
    'Plain',
    ' plain ',
    '',
    // status: hidden は catalog から落ちるため、ファイルが実在しても選べない。
    'secret',
  ])('一覧にない layout (%s) を指定すると、ファイルを読まずに unknown-layout のエラーを返す', async (layout) => {
    await explains('`slide_page` ツールのレイアウト名の検証のテストです。`../../../etc/passwd` や `_common` など一覧にない名前を指定した場合に、ファイルを読まず `unknown-layout` のエラーを返すことを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'secret.yaml'),
      'layout: secret\ncategory: text\nstatus: hidden\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      ---\n      layout: secret\n      ---\n',
      'utf8',
    )

    const result = await tool.handler({ layout, dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['kind'], `layout: ${layout}`).toBe('unknown-layout')
    expect(pageFilesOf(directory), `layout: ${layout}`).toEqual([])
  })

  it('既存ページは force なしなら上書きせず、force: true で上書きする', async (context) => {
    await verifies(context, 'PV-SLIDE-PAGE-04')

    await explains('`slide_page` ツールの既存のページの扱いのテストです。同じ名前のページがある場合に、`force` なしでは `file-exists` のエラーで上書きせず、`force: true` では上書きすることを確認します。')
    await verifies(context, 'PV-SLIDE-PAGE-05')
    const directory = makeTalkDirectory()
    const target = path.join(directory, 'pages', 'page.md')
    writeFileSync(target, '---\nlayout: cover\n---\n', 'utf8')

    const refused = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(refused)['kind']).toBe('file-exists')
    expect(textOf(dataOf(refused)['detail'])).toContain('force')
    expect(readFileSync(target, 'utf8')).toBe('---\nlayout: cover\n---\n')

    const overwritten = await tool.handler(
      { layout: 'plain', dir: directory, file: 'page', force: true },
      CALL,
    )

    expect(structuredOf(overwritten)).not.toHaveProperty('kind')
    expect(readFileSync(target, 'utf8')).toContain('layout: plain')
  })

  it('examples を持たない参照 yaml はページを作らずに失敗する', async () => {
    await explains('`slide_page` ツールの参照 yaml の検証のテストです。`examples` を持たない参照 yaml の場合に、`skeleton-unavailable` のエラーを返し、ページを作らないことを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'no-examples.yaml'),
      'layout: no-examples\ndescription: examples を持たない参照\ncategory: text\n\nincludes:\n  - _common\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'no-examples', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['kind']).toBe('skeleton-unavailable')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('includes 宣言に挟まったコメント行は読み飛ばし、後続の項目も読む', async () => {
    // コメントは宣言の終端ではない。ここで打ち切ると、後ろに並ぶ共通仕様が通知なしに欠ける。
    await explains('`slide_page` ツールの `includes` の読み取りのテストです。`includes` の宣言の途中にコメント行がある場合に、コメントを読み飛ばし、後ろの項目まですべて読み取ることを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(path.join(themeReferences(directory), '_footer.yaml'), 'description: フッター\n', 'utf8')
    writeFileSync(
      path.join(themeReferences(directory), 'commented.yaml'),
      'layout: commented\ndescription: コメントを挟む includes\ncategory: text\nincludes:\n'
      + '  - _common\n  # 補足コメント\n  - _footer\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      ---\n      layout: commented\n      ---\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'commented', dir: directory, file: 'page' }, CALL)
    const includes = dataOf(result)['includes']

    expect(structuredOf(result)).not.toHaveProperty('kind')
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(Object.keys(includes)).toEqual(['_common', '_footer'])
  })

  it('includes 宣言はリスト項目とコメントのどちらでもない行で読み終える', async () => {
    await explains('`slide_page` ツールの `includes` の読み取りのテストです。`includes` の次に別のキーが現れた場合に、そこで `includes` の読み取りを終えることを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'terminated.yaml'),
      'layout: terminated\ndescription: 別キーで終わる includes\ncategory: text\nincludes:\n'
      + '  - _common\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      ---\n      layout: terminated\n      ---\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'terminated', dir: directory, file: 'page' }, CALL)
    const includes = dataOf(result)['includes']

    expect(structuredOf(result)).not.toHaveProperty('kind')
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(Object.keys(includes)).toEqual(['_common'])
  })

  it('includes 宣言を持たない参照でも生成でき、includes は空になる', async () => {
    await explains('`slide_page` ツールの `includes` の読み取りのテストです。参照 yaml に `includes` の宣言がない場合でも、ページを書き出し、結果の `includes` が空になることを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'standalone.yaml'),
      'layout: standalone\ndescription: includes を持たない参照\ncategory: text\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      ---\n      layout: standalone\n      ---\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'standalone', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)).not.toHaveProperty('kind')
    expect(dataOf(result)['includes']).toEqual({})
  })

  it('examples が `---` で囲まれていない参照 yaml はページを作らずに失敗する', async () => {
    // 囲みが無い雛形をそのまま書くと「フロントマター無しの Markdown 本文」になり、
    // レイアウトの当たらないページが通知なしに出来る。書き込む前に弾く。
    await explains('`slide_page` ツールの雛形の検証のテストです。`examples` の雛形が `---` で囲まれていない場合に、`skeleton-unavailable` のエラーを返し、ページを作らないことを確認します。')
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'unwrapped.yaml'),
      'layout: unwrapped\ndescription: 囲みの無い examples\ncategory: text\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      layout: unwrapped\n      title: 囲み無し\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'unwrapped', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['kind']).toBe('skeleton-unavailable')
    expect(textOf(dataOf(result)['detail'])).toContain('---')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('参照 yaml を読めないと、書き込みの失敗とは別の reference-read-failed のエラーを返す', async () => {
    // catalog の確認の後に参照 yaml が消える競合を、読み取りの差し替えで再現する。
    await explains('`slide_page` ツールの参照 yaml の読み取りに失敗した場合のテストです。一覧の確認の後でファイルが消えた場合に、`reference-read-failed` のエラーを返し、ファイルを作らないことを確認します。')
    const directory = makeTalkDirectory()
    const racing = withOutputCheck(slidePageTool(() => Promise.reject(new Error('ENOENT: no such file (race)'))))

    const result = await racing.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['kind']).toBe('reference-read-failed')
    expect(textOf(dataOf(result)['detail'])).toContain('plain.yaml')
    expect(textOf(dataOf(result)['detail'])).toContain('race')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('書き込みに失敗すると、例外を投げずに write-failed の結果を structuredContent つきで返す', async () => {
    // ハンドラから例外が抜けると SDK が structuredContent 無しの応答を作り、
    // outputSchema を宣言したツールの契約が破れる。ENAMETOOLONG でルートを踏む。
    await explains('`slide_page` ツールの書き込みに失敗した場合のテストです。ファイル名が長すぎて書き込めない場合に、例外を発生させず、`write-failed` のエラーを `structuredContent` つきで返すことを確認します。')
    const directory = makeTalkDirectory()

    const result = await tool.handler(
      { layout: 'plain', dir: directory, file: 'a'.repeat(300) },
      CALL,
    )

    expect(structuredOf(result)['kind']).toBe('write-failed')
    expect(textOf(dataOf(result)['detail'])).toContain('ENAMETOOLONG')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('__proto__ を include する参照でもキーを取りこぼさない', async () => {
    await explains('`slide_page` ツールの `includes` のキーのテストです。`__proto__` を include する参照 yaml の場合に、そのキーを取りこぼさず、内容が `includes` に含まれることを確認します。')
    const directory = makeTalkDirectory()
    const references = themeReferences(directory)
    writeFileSync(path.join(references, '__proto__.yaml'), 'name: 危険なキー\n', 'utf8')
    writeFileSync(
      path.join(references, 'prototyped.yaml'),
      'layout: prototyped\ndescription: __proto__ を include する参照\ncategory: text\nincludes:\n'
      + '  - __proto__\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      ---\n      layout: prototyped\n      ---\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'prototyped', dir: directory, file: 'page' }, CALL)
    const includes = dataOf(result)['includes']

    expect(structuredOf(result)).not.toHaveProperty('kind')
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(Object.keys(includes)).toEqual(['__proto__'])
    expect(textOf(Object.getOwnPropertyDescriptor(includes, '__proto__')?.value)).toContain('危険なキー')
  })

  it('include 先の共通 yaml が無いテーマはページを作らずに失敗する', async () => {
    await explains('`slide_page` ツールの共通仕様の yaml がない場合のテストです。参照 yaml が include する `_common.yaml` が存在しないときに、`broken-reference` のエラーを返し、ページを作らないことを確認します。')
    const directory = makeTalkDirectory()
    rmSync(path.join(themeReferences(directory), '_common.yaml'))

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['kind']).toBe('broken-reference')
    expect(textOf(dataOf(result)['detail'])).toContain('_common.yaml')
    expect(pageFilesOf(directory)).toEqual([])
  })
})
