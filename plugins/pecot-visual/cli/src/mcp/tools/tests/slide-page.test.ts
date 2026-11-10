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
import { compareStrings } from '../../../domain/_shared/compare-strings.js'
import { executeSlideTheme } from '../../../commands/slidev-project/theme.js'
import { NodeThemeFiles } from '../../../infra/slidev-theme/fs.js'
import type { ToolCallContext } from '../../server.js'
import { normalizePageFileName, slidePageTool } from '../slide-page.js'

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

const tool = slidePageTool()

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
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が返っていません')
  return data
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
  it('pages/ 配下にスケルトンを書き出し、reference と includes を返す', async () => {
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'strategy' }, CALL)
    const structured = structuredOf(result)
    const data = dataOf(result)
    const target = path.join(directory, 'pages', 'strategy.md')

    expect(result.isError).toBeUndefined()
    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(structured['artifacts']).toEqual([target])
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
    expect(textOf(structured['message'])).toContain('slides.md')
    expect(textOf(structured['message'])).toContain('src: ./pages/strategy.md')
  })

  it('file の .md は省略できる (明示指定と同じ結果になる)', async () => {
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
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), '_common.yaml'),
      'description: 全レイアウトで使用可能な共通プロパティ。\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'cover', dir: directory, file: 'legacy' }, CALL)

    expect(structuredOf(result)['ok']).toBe(true)
    expect(dataOf(result)['category']).toBe('uncategorized')
  })

  it('deprecated レイアウトも生成できる (deprecated: true で返る)', async () => {
    const directory = makeTalkDirectory()
    const reference = path.join(themeReferences(directory), 'cover.yaml')
    writeFileSync(reference, `${readFileSync(reference, 'utf8')}\nstatus: deprecated\n`, 'utf8')

    const result = await tool.handler({ layout: 'cover', dir: directory, file: 'legacy-cover' }, CALL)

    expect(structuredOf(result)['ok']).toBe(true)
    expect(dataOf(result)['deprecated']).toBe(true)
  })

  it('talk-dir の references/ の宣言がテーマの宣言に勝ち、includes も talk-dir 側を先に探す', async () => {
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

    expect(structuredOf(result)['ok']).toBe(true)
    expect(data['skeleton']).toBe('---\nlayout: plain\nheading: talk-dir の雛形\n---\n')
    const includes = data['includes']
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(includes['_common']).toBe('description: talk-dir の共通仕様\n')
  })

  it.each(CATALOG)('$layout のスケルトンが有効なフロントマターとして書き出される', async (entry) => {
    // Acceptance「data.layouts に載る任意のレイアウト名」を代表値でなく全件で満たす。
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: entry.layout, dir: directory, file: 'page' }, CALL)
    const data = dataOf(result)

    expect(structuredOf(result)['ok'], `layout: ${entry.layout}`).toBe(true)
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
  it('dir が相対パスなら実処理を呼ばずに exitCode 2 で返す', async () => {
    const result = await tool.handler({ layout: 'plain', dir: 'talk', file: 'page' }, CALL)

    expect(result.isError).toBe(true)
    expect(structuredOf(result)['exitCode']).toBe(2)
    expect(dataOf(result)['invalidPaths']).toEqual(['dir=talk'])
  })

  it.each(['sub/page.md', '../escape.md', String.raw`sub\page.md`])(
    'パス区切りを含む file (%s) は拒否する',
    async (file) => {
      const directory = makeTalkDirectory()

      const result = await tool.handler({ layout: 'plain', dir: directory, file }, CALL)

      expect(structuredOf(result)['ok']).toBe(false)
      expect(dataOf(result)['reason']).toBe('invalid-file-name')
      expect(pageFilesOf(directory)).toEqual([])
    },
  )

  it('空の file は拒否する', async () => {
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: 'plain', dir: directory, file: '' }, CALL)

    expect(dataOf(result)['reason']).toBe('invalid-file-name')
    expect(pageFilesOf(directory)).toEqual([])
  })

  // 拡張子だけ揃っていて名前として成立しない指定。書けてしまうと lint 以前に
  // 「意図しない名前のページが残る」ため、生成前に弾く。
  it.each(['..md', ' .md', '-cover.md', '.hidden.md', 'カバー.md', 'cover page.md'])(
    'ファイル名として成立しない file (%s) はファイルを作らずに拒否する',
    async (file) => {
      const directory = makeTalkDirectory()

      const result = await tool.handler({ layout: 'plain', dir: directory, file }, CALL)

      expect(structuredOf(result)['ok'], `file: ${file}`).toBe(false)
      expect(dataOf(result)['reason'], `file: ${file}`).toBe('invalid-file-name')
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
  ])('file $file の数字始まり判定は lint ルールと一致する', ({ file, numeric }) => {
    const checked = normalizePageFileName(file)
    expect(checked.ok).toBe(!numeric)

    // ルール側と同じ手順で stem を求め、判定が一致することを確認する。
    const written = file.endsWith('.md') ? file : `${file}.md`
    const stem = written.slice(0, written.length - path.extname(written).length)
    expect(/^\d/.test(stem)).toBe(numeric)
  })

  it('数字始まりの file はファイルを作らずに拒否する', async () => {
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: 'plain', dir: directory, file: '01-cover' }, CALL)

    expect(structuredOf(result)['ok']).toBe(false)
    expect(dataOf(result)['reason']).toBe('numeric-filename-prefix')
    expect(textOf(dataOf(result)['detail'])).toContain('slides.md')
    expect(pageFilesOf(directory)).toEqual([])
  })
})

describe('slide_page のテーマの失敗', () => {
  it('テーマを張っていない talk-dir は theme-unlinked で、slide_sync の node_modules_only を案内する', async () => {
    const directory = makeTalkDirectory({ link: false })

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['ok']).toBe(false)
    expect(structuredOf(result)['exitCode']).toBe(1)
    expect(dataOf(result)['event']).toBe('slide.page.error')
    expect(dataOf(result)['reason']).toBe('theme-unlinked')
    const detail = textOf(dataOf(result)['detail'])
    expect(detail).toContain('slide_sync')
    expect(detail).toContain('node_modules_only: true')
    // 捕捉した出力は空でもキーを残す。
    expect(structuredOf(result)['stdout']).toBe('')
    expect(structuredOf(result)['stderr']).toBe('')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('theme: none で宣言も無い talk-dir は theme-none で、slide sync --theme を案内する', async () => {
    const directory = makeTalkDirectory()
    writeFileSync(path.join(directory, 'slides.md'), '---\ntheme: none\n---\n', 'utf8')

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(dataOf(result)['reason']).toBe('theme-none')
    expect(textOf(dataOf(result)['detail'])).toContain('slide sync --theme <theme-spec>')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('宣言の誤りは theme-<reason> で返す', async () => {
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(directory, 'node_modules', THEME_NAME, 'pecot-theme.json'),
      JSON.stringify({ schema: 1, lint: { rules: { 'no-such/rule': 'error' } } }),
      'utf8',
    )

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(dataOf(result)['reason']).toBe('theme-unknown-rule')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('参照 yaml を持たないテーマ（layouts/*.vue だけ）は skeleton-unavailable で失敗する', async () => {
    const directory = makeTalkDirectory({ themeFixture: BARE_FIXTURE, themeName: BARE_NAME })

    const result = await tool.handler({ layout: 'one', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['ok']).toBe(false)
    expect(dataOf(result)['reason']).toBe('skeleton-unavailable')
    expect(textOf(dataOf(result)['detail'])).toContain('no reference yaml')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('テーマの警告は stderr に出す', async () => {
    const directory = makeTalkDirectory({ themeFixture: BARE_FIXTURE, themeName: BARE_NAME })

    const result = await tool.handler({ layout: 'one', dir: directory, file: 'page' }, CALL)

    expect(textOf(structuredOf(result)['stderr'])).toContain('warning: ')
  })
})

describe('slide_page の失敗ルート', () => {
  it('未知の layout は選択可能な一覧つきで失敗する', async () => {
    const directory = makeTalkDirectory()

    const result = await tool.handler({ layout: 'no-such-layout', dir: directory, file: 'page' }, CALL)
    const data = dataOf(result)

    expect(result.isError).toBe(true)
    expect(data['reason']).toBe('unknown-layout')
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
  ])('layout %s は catalog 一致確認で弾かれ、ファイルを読まない', async (layout) => {
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'secret.yaml'),
      'layout: secret\ncategory: text\nstatus: hidden\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      ---\n      layout: secret\n      ---\n',
      'utf8',
    )

    const result = await tool.handler({ layout, dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['ok'], `layout: ${layout}`).toBe(false)
    expect(dataOf(result)['reason'], `layout: ${layout}`).toBe('unknown-layout')
    expect(pageFilesOf(directory), `layout: ${layout}`).toEqual([])
  })

  it('既存ページは force なしなら上書きせず、force: true で上書きする', async () => {
    const directory = makeTalkDirectory()
    const target = path.join(directory, 'pages', 'page.md')
    writeFileSync(target, '---\nlayout: cover\n---\n', 'utf8')

    const refused = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(refused)['ok']).toBe(false)
    expect(dataOf(refused)['reason']).toBe('file-exists')
    expect(textOf(dataOf(refused)['detail'])).toContain('force')
    expect(readFileSync(target, 'utf8')).toBe('---\nlayout: cover\n---\n')

    const overwritten = await tool.handler(
      { layout: 'plain', dir: directory, file: 'page', force: true },
      CALL,
    )

    expect(structuredOf(overwritten)['ok']).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('layout: plain')
  })

  it('examples を持たない参照 yaml はページを作らずに失敗する', async () => {
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'no-examples.yaml'),
      'layout: no-examples\ndescription: examples を持たない参照\ncategory: text\n\nincludes:\n  - _common\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'no-examples', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['ok']).toBe(false)
    expect(dataOf(result)['reason']).toBe('skeleton-unavailable')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('includes 宣言に挟まったコメント行は読み飛ばし、後続の項目も読む', async () => {
    // コメントは宣言の終端ではない。ここで打ち切ると、後ろに並ぶ共通仕様が通知なしに欠ける。
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

    expect(structuredOf(result)['ok']).toBe(true)
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(Object.keys(includes)).toEqual(['_common', '_footer'])
  })

  it('includes 宣言はリスト項目とコメントのどちらでもない行で読み終える', async () => {
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

    expect(structuredOf(result)['ok']).toBe(true)
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(Object.keys(includes)).toEqual(['_common'])
  })

  it('includes 宣言を持たない参照でも生成でき、includes は空になる', async () => {
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'standalone.yaml'),
      'layout: standalone\ndescription: includes を持たない参照\ncategory: text\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      ---\n      layout: standalone\n      ---\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'standalone', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['ok']).toBe(true)
    expect(dataOf(result)['includes']).toEqual({})
  })

  it('examples が `---` で囲まれていない参照 yaml はページを作らずに失敗する', async () => {
    // 囲みが無い雛形をそのまま書くと「フロントマター無しの Markdown 本文」になり、
    // レイアウトの当たらないページが通知なしに出来る。書き込む前に弾く。
    const directory = makeTalkDirectory()
    writeFileSync(
      path.join(themeReferences(directory), 'unwrapped.yaml'),
      'layout: unwrapped\ndescription: 囲みの無い examples\ncategory: text\nexamples:\n  - name: 基本\n'
      + '    frontmatter: |\n      layout: unwrapped\n      title: 囲み無し\n',
      'utf8',
    )

    const result = await tool.handler({ layout: 'unwrapped', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['ok']).toBe(false)
    expect(dataOf(result)['reason']).toBe('skeleton-unavailable')
    expect(textOf(dataOf(result)['detail'])).toContain('---')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('参照 yaml が読めなければ、書き込みと別の reason で失敗する', async () => {
    // catalog の確認の後に参照 yaml が消える競合を、読み取りの差し替えで再現する。
    const directory = makeTalkDirectory()
    const racing = slidePageTool(() => Promise.reject(new Error('ENOENT: no such file (race)')))

    const result = await racing.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['ok']).toBe(false)
    expect(dataOf(result)['reason']).toBe('reference-read-failed')
    expect(textOf(dataOf(result)['detail'])).toContain('plain.yaml')
    expect(textOf(dataOf(result)['detail'])).toContain('race')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('書き込みに失敗しても structuredContent を持つ失敗応答に畳む', async () => {
    // ハンドラから例外が抜けると SDK が structuredContent 無しの応答を作り、
    // outputSchema を宣言したツールの契約が破れる。ENAMETOOLONG でルートを踏む。
    const directory = makeTalkDirectory()

    const result = await tool.handler(
      { layout: 'plain', dir: directory, file: 'a'.repeat(300) },
      CALL,
    )

    expect(structuredOf(result)['ok']).toBe(false)
    expect(structuredOf(result)['exitCode']).toBe(1)
    expect(dataOf(result)['reason']).toBe('write-failed')
    expect(textOf(dataOf(result)['detail'])).toContain('ENAMETOOLONG')
    expect(pageFilesOf(directory)).toEqual([])
  })

  it('__proto__ を include する参照でもキーを取りこぼさない', async () => {
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

    expect(structuredOf(result)['ok']).toBe(true)
    if (!isRecord(includes)) throw new Error('includes が返っていません')
    expect(Object.keys(includes)).toEqual(['__proto__'])
    expect(textOf(Object.getOwnPropertyDescriptor(includes, '__proto__')?.value)).toContain('危険なキー')
  })

  it('include 先の共通 yaml が無いテーマはページを作らずに失敗する', async () => {
    const directory = makeTalkDirectory()
    rmSync(path.join(themeReferences(directory), '_common.yaml'))

    const result = await tool.handler({ layout: 'plain', dir: directory, file: 'page' }, CALL)

    expect(structuredOf(result)['ok']).toBe(false)
    expect(dataOf(result)['reason']).toBe('broken-reference')
    expect(textOf(dataOf(result)['detail'])).toContain('_common.yaml')
    expect(pageFilesOf(directory)).toEqual([])
  })
})
