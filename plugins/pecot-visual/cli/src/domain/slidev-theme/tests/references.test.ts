/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てのみ */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NodeThemeFiles } from '../../../infra/slidev-theme/fs.js'
import {
  buildLayoutCatalog,
  readLayoutCategories,
  resolveLayoutReferences,
} from '../references.js'
import type { LayoutCategory, LayoutReference } from '../references.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const THEMES = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'themes')
const WITH_DECLARATION = path.join(THEMES, 'with-declaration')
const WITHOUT_DECLARATION = path.join(THEMES, 'without-declaration')

const state = { talk: '' }

beforeEach(() => {
  state.talk = mkdtempSync(path.join(tmpdir(), 'pecotv-references-'))
})

afterEach(() => {
  rmSync(state.talk, { recursive: true, force: true })
})

function writeTalkReference(fileName: string, text: string): void {
  const directory = path.join(state.talk, 'references')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, fileName), text)
}

describe('resolveLayoutReferences', () => {
  it('talk-dir に references/ が存在しない場合は、テーマの宣言をそのまま一覧にする', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。talk-dir に `references/` が存在しない場合は、テーマの宣言（`cover` や `panel` など）の内容が、名前順にそのまま返ることを確認します。')
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries).toEqual([
      {
        name: 'cover',
        description: '資料の表紙。タイトルと副題だけを置く。',
        category: 'text',
        status: 'stable',
        file: path.join(WITH_DECLARATION, 'references', 'cover.yaml'),
      },
      {
        name: 'end',
        description: '資料の最後に置く。結びの言葉だけを置く。',
        category: 'text',
        status: 'stable',
        file: path.join(WITH_DECLARATION, 'references', 'end.yaml'),
      },
      {
        name: 'legacy-panel',
        description: '【非推奨】品質が水準に達していないため選ばない、見出しだけの枠。',
        category: 'figure',
        status: 'deprecated',
        file: path.join(WITH_DECLARATION, 'references', 'legacy-panel.yaml'),
      },
      {
        name: 'link',
        description: '見出しと、リンク付きのカードを縦に並べる。参考資料や関連 URL をまとめる場面に使う。',
        category: 'text',
        status: 'stable',
        file: path.join(WITH_DECLARATION, 'references', 'link.yaml'),
      },
      {
        name: 'marked',
        description: '見出しと印のセルを置く枠を持つレイアウト。図に印を付ける場面に使う。',
        category: 'figure',
        status: 'stable',
        file: path.join(WITH_DECLARATION, 'references', 'marked.yaml'),
      },
      {
        name: 'panel',
        description: '見出しと画像の枠を置くレイアウト。図を 1 つ見せる場面に使う。',
        category: 'figure',
        status: 'stable',
        file: path.join(WITH_DECLARATION, 'references', 'panel.yaml'),
      },
      {
        name: 'plain',
        description: '見出しと本文だけを置く最小のレイアウト。文章で伝える場面に使う。',
        category: 'text',
        status: 'stable',
        file: path.join(WITH_DECLARATION, 'references', 'plain.yaml'),
      },
      {
        name: 'scratch',
        description: '内部の確認用の枠。一覧に載せない。',
        category: 'uncategorized',
        categoryMissing: true,
        status: 'hidden',
        file: path.join(WITH_DECLARATION, 'references', 'scratch.yaml'),
      },
      {
        name: 'section',
        description: '章の区切りに置く。見出しと一言の説明に、装飾の線を添える。',
        category: 'text',
        status: 'stable',
        file: path.join(WITH_DECLARATION, 'references', 'section.yaml'),
      },
    ])
  })

  it('_ で始まるファイル（_common.yaml）は、一覧に含めない', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。テーマに `_common.yaml` がある場合に、一覧の名前とファイル名のどちらにも `_common` が含まれないことを確認します。')
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries.map(entry => entry.name)).not.toContain('_common')
    expect(result.entries.map(entry => path.basename(entry.file))).not.toContain('_common.yaml')
  })

  it('参照を探したディレクトリの一覧では、talk-dir 側を先に返す', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。`directories` に、talk-dir の `references/` とテーマの `references/` が、この順で入ることを確認します。')
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.directories).toEqual([
      path.join(state.talk, 'references'),
      path.join(WITH_DECLARATION, 'references'),
    ])
  })

  it('themeRoot と talkDirectory が同じ場合は、directories を 1 つにまとめる', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。`themeRoot` と `talkDirectory` に同じパスを渡した場合に、`directories` が 1 件だけになることを確認します。')
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: WITH_DECLARATION,
      referencesDirectory: 'references',
    })
    expect(result.directories).toEqual([path.join(WITH_DECLARATION, 'references')])
  })

  it('同じ名前のレイアウトは、talk-dir の宣言を優先する', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。talk-dir に `panel.yaml` がある場合に、`panel` はその宣言の内容になり、ほかの名前はテーマのものが残って重複しないことを確認します。')
    writeTalkReference('panel.yaml', `layout: 'panel'\ndescription: 'talk-dir で上書きした説明'\ncategory: 'text'\n`)
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    const panel = result.entries.find(entry => entry.name === 'panel')
    expect(panel).toEqual({
      name: 'panel',
      description: 'talk-dir で上書きした説明',
      category: 'text',
      status: 'stable',
      file: path.join(state.talk, 'references', 'panel.yaml'),
    })
    // 上書きされなかった分はテーマのものが残り、名前は重複しない
    expect(result.entries.map(entry => entry.name)).toEqual(['cover', 'end', 'legacy-panel', 'link', 'marked', 'panel', 'plain', 'scratch', 'section'])
  })

  it('talk-dir だけに存在する宣言も、一覧に含める', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。テーマに存在しない `extra.yaml` を talk-dir へ置いた場合は、一覧にその名前が加わることを確認します。')
    writeTalkReference('extra.yaml', `layout: 'extra'\ndescription: '追加'\ncategory: 'text'\n`)
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries.map(entry => entry.name)).toEqual(['cover', 'end', 'extra', 'legacy-panel', 'link', 'marked', 'panel', 'plain', 'scratch', 'section'])
  })

  it('layout: が存在しない宣言は、ファイル名を名前にし、category が存在しなければ uncategorized にする', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。`layout:` と `category:` が存在しない `nameless.yaml` の場合は、名前がファイル名の `nameless` になり、分類は `uncategorized` になることを確認します。')
    writeTalkReference('nameless.yaml', `description: '名前なし'\n`)
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries.find(entry => entry.name === 'nameless')).toEqual({
      name: 'nameless',
      description: '名前なし',
      category: 'uncategorized',
      categoryMissing: true,
      status: 'stable',
      file: path.join(state.talk, 'references', 'nameless.yaml'),
    })
  })

  it('宣言が存在しないテーマは、layouts/ の vue ファイルの名前だけを一覧にする', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。宣言が存在しないテーマの場合に、`layouts/` の `.vue` ファイルが、説明が空で分類が `uncategorized` の項目として返ることを確認します。')
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITHOUT_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries).toEqual([
      { name: 'one', description: '', category: 'uncategorized', categoryMissing: true, status: 'stable', file: path.join(WITHOUT_DECLARATION, 'layouts', 'one.vue') },
      { name: 'two', description: '', category: 'uncategorized', categoryMissing: true, status: 'stable', file: path.join(WITHOUT_DECLARATION, 'layouts', 'two.vue') },
    ])
  })

  it('宣言が存在しないテーマでも、talk-dir の宣言で一覧の項目を上書きできる', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。宣言が存在しないテーマの `one` に対して、talk-dir に `one.yaml` を置いた場合に、`one` だけがその宣言の内容になることを確認します。')
    writeTalkReference('one.yaml', `layout: 'one'\ndescription: 'talk-dir の説明'\ncategory: 'text'\n`)
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITHOUT_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries).toEqual([
      { name: 'one', description: 'talk-dir の説明', category: 'text', status: 'stable', file: path.join(state.talk, 'references', 'one.yaml') },
      { name: 'two', description: '', category: 'uncategorized', categoryMissing: true, status: 'stable', file: path.join(WITHOUT_DECLARATION, 'layouts', 'two.vue') },
    ])
  })
})

describe('resolveLayoutReferences の status', () => {
  it('status に deprecated と hidden を指定できる。指定しない場合は stable になる', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。`status: deprecated` と `status: hidden` の宣言を置いた場合に、その状態が返り、指定のない宣言は `stable` で、警告が空であることを確認します。')
    writeTalkReference('old.yaml', `layout: 'old'\ncategory: 'text'\nstatus: deprecated\n`)
    writeTalkReference('secret.yaml', `layout: 'secret'\ncategory: 'text'\nstatus: hidden\n`)
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    const statuses = Object.fromEntries(result.entries.map(entry => [entry.name, entry.status]))
    expect(statuses).toEqual({
      'cover': 'stable',
      'end': 'stable',
      'legacy-panel': 'deprecated',
      'link': 'stable',
      'marked': 'stable',
      'old': 'deprecated',
      'panel': 'stable',
      'plain': 'stable',
      'scratch': 'hidden',
      'secret': 'hidden',
      'section': 'stable',
    })
    expect(result.warnings).toEqual([])
  })

  it('未対応の status は stable として扱い、警告を warnings に追加する', async () => {
    await explains('テーマのレイアウト参照を集める `resolveLayoutReferences` のテストです。`status: beta` のように未対応の値を指定した場合に、状態が `stable` になり、警告が 1 件 `warnings` に入ることを確認します。')
    writeTalkReference('odd.yaml', `layout: 'odd'\ncategory: 'text'\nstatus: beta\n`)
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries.find(entry => entry.name === 'odd')?.status).toBe('stable')
    expect(result.warnings).toEqual(['unknown status in odd.yaml: beta; treating it as stable'])
  })
})

const SYNC_HINT = 'check layout_categories in references/_common.yaml of the theme'
const TEXT: LayoutCategory = { id: 'text', label: '文章', question: '文章で見せる' }
const FIGURE: LayoutCategory = { id: 'figure', label: '図', question: '図で見せる' }

function reference(name: string, category: string, status: LayoutReference['status'] = 'stable'): LayoutReference {
  return { name, description: `${name} の説明`, category, status, file: path.join('/theme/references', `${name}.yaml`) }
}

function references(entries: readonly LayoutReference[], warnings: readonly string[] = []) {
  return { entries, directories: ['/theme/references'], warnings }
}

function writeCommon(directory: string, text: string): string {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, '_common.yaml'), text)
  return directory
}

describe('readLayoutCategories', () => {
  it('directories の順に探し、最初に見つかった _common.yaml の layout_categories を返す', async () => {
    await explains('レイアウトの分類を読み込む `readLayoutCategories` のテストです。2 つのディレクトリの両方に `_common.yaml` がある場合に、先に指定したディレクトリの分類だけが返り、警告が空であることを確認します。')
    const talk = writeCommon(path.join(state.talk, 'a'), `layout_categories:\n  - { id: x, label: X, question: 'x?' }\n`)
    const theme = writeCommon(path.join(state.talk, 'b'), `layout_categories:\n  - { id: y, label: Y, question: 'y?' }\n`)
    const result = await readLayoutCategories(new NodeThemeFiles(), [talk, theme])
    expect(result).toEqual({ categories: [{ id: 'x', label: 'X', question: 'x?' }], warnings: [] })
  })

  it('先のディレクトリに _common.yaml が存在しない場合は、後ろのディレクトリを読む', async () => {
    await explains('レイアウトの分類を読み込む `readLayoutCategories` のテストです。先のディレクトリに `_common.yaml` が存在しない場合は、後ろのテーマのディレクトリから `text` と `figure` の分類が返ることを確認します。')
    const empty = path.join(state.talk, 'none')
    const theme = path.join(WITH_DECLARATION, 'references')
    const result = await readLayoutCategories(new NodeThemeFiles(), [empty, theme])
    expect(result).toEqual({ categories: [TEXT, FIGURE], warnings: [] })
  })

  it('どのディレクトリにも _common.yaml が存在しない場合は、分類を空にして警告する', async () => {
    await explains('レイアウトの分類を読み込む `readLayoutCategories` のテストです。`_common.yaml` が存在しない場合に、分類が空になり、読めない旨と対処のヒントを含む警告が 1 件返ることを確認します。')
    const directory = path.join(state.talk, 'none')
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('cannot read the layout categories')
    expect(result.warnings[0]).toContain(path.join(directory, '_common.yaml'))
    expect(result.warnings[0]).toContain(SYNC_HINT)
  })

  it('layout_categories が配列でない場合は、分類を空にして警告する', async () => {
    await explains('レイアウトの分類を読み込む `readLayoutCategories` のテストです。`layout_categories` を持たない `_common.yaml` の場合に、分類が空になり、配列が見つからない旨の警告が返ることを確認します。')
    const directory = writeCommon(path.join(state.talk, 'bad'), `description: 'x'\n`)
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([])
    expect(result.warnings[0]).toContain('layout_categories is not found as an array')
  })

  it('使える要素が 1 件も存在しない場合は、警告を 1 件にまとめて分類を空にする', async () => {
    await explains('レイアウトの分類を読み込む `readLayoutCategories` のテストです。`layout_categories` の 2 要素がどちらも使えない場合に、分類が空になり、件数（0 of 2）を含む警告が 1 件だけ返ることを確認します。')
    const directory = writeCommon(path.join(state.talk, 'zero'), `layout_categories:\n  - { id: x }\n  - 3\n`)
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([])
    expect(result.warnings).toEqual([
      `cannot read the layout categories (${path.join(directory, '_common.yaml')}: layout_categories has no usable item (0 of 2)); continuing without categories (fix: ${SYNC_HINT})`,
    ])
  })

  it('予約語 uncategorized の要素と、項目が不足している要素は除外し、それぞれの件数を警告する', async () => {
    await explains('レイアウトの分類を読み込む `readLayoutCategories` のテストです。`uncategorized` の要素と `id` だけの要素が混じる場合に、有効な `text` だけが返り、除外した理由ごとに警告が 1 件ずつ返ることを確認します。')
    const directory = writeCommon(
      path.join(state.talk, 'mixed'),
      `layout_categories:\n  - { id: text, label: 文章, question: 'q' }\n  - { id: uncategorized, label: u, question: q }\n  - { id: broken }\n`,
    )
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([{ id: 'text', label: '文章', question: 'q' }])
    expect(result.warnings).toEqual([
      `ignoring reserved layout_categories id uncategorized (1 item(s)); ${SYNC_HINT}`,
      `skipped part of layout_categories (id, label or question missing: 1 item(s)); ${SYNC_HINT}`,
    ])
  })

  it('YAML として不正な _common.yaml でも、分類を空にして警告する', async () => {
    await explains('レイアウトの分類を読み込む `readLayoutCategories` のテストです。閉じていない配列のように YAML として不正な場合に、分類が空になり、警告が 1 件返ることを確認します。')
    const directory = writeCommon(path.join(state.talk, 'broken'), 'layout_categories: [unclosed\n')
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('cannot read the layout categories')
  })
})

describe('buildLayoutCatalog', () => {
  it('レイアウトを、分類の宣言順・stable が先・ファイル名順に並べて返す', async () => {
    await explains('レイアウトの一覧を作成する `buildLayoutCatalog` のテストです。分類の宣言順で並び、同じ分類では `stable` が `deprecated` より先になり、同じ状態ではファイル名順になることを確認します。')
    const catalog = buildLayoutCatalog(
      references([
        reference('b-figure', 'figure'),
        reference('a-figure-old', 'figure', 'deprecated'),
        reference('a-figure', 'figure'),
        reference('z-text', 'text'),
      ]),
      [TEXT, FIGURE],
    )
    expect(catalog.categories).toEqual([TEXT, FIGURE])
    expect(catalog.layouts).toEqual([
      { layout: 'z-text', description: 'z-text の説明', category: 'text', deprecated: false, filename: 'z-text.yaml' },
      { layout: 'a-figure', description: 'a-figure の説明', category: 'figure', deprecated: false, filename: 'a-figure.yaml' },
      { layout: 'b-figure', description: 'b-figure の説明', category: 'figure', deprecated: false, filename: 'b-figure.yaml' },
      { layout: 'a-figure-old', description: 'a-figure-old の説明', category: 'figure', deprecated: true, filename: 'a-figure-old.yaml' },
    ])
    expect(catalog.warnings).toEqual([])
  })

  it('status が hidden のレイアウトは、一覧に含めない', async () => {
    await explains('レイアウトの一覧を作成する `buildLayoutCatalog` のテストです。`status: hidden` のレイアウトを含めて渡した場合に、一覧には `hidden` でないレイアウトだけが入ることを確認します。')
    const catalog = buildLayoutCatalog(references([reference('shown', 'text'), reference('secret', 'text', 'hidden')]), [TEXT])
    expect(catalog.layouts.map(entry => entry.layout)).toEqual(['shown'])
  })

  it('category が未設定または未対応の場合は、uncategorized に分類し、末尾に分類を追加して警告する', async () => {
    await explains('レイアウトの一覧を作成する `buildLayoutCatalog` のテストです。未対応の分類と未設定の分類を渡した場合に、`uncategorized` に分類され、警告が 1 件ずつ返ることを確認します。')
    const catalog = buildLayoutCatalog(
      references([
        reference('known', 'text'),
        reference('lost', 'mystery'),
        { ...reference('nameless', 'uncategorized'), categoryMissing: true },
        // 明示の uncategorized は、意図した未分類なので警告しない
        reference('explicit', 'uncategorized'),
      ]),
      [TEXT],
    )
    expect(catalog.categories).toEqual([
      TEXT,
      { id: 'uncategorized', label: 'Uncategorized', question: `layouts whose category is unset or unknown (${SYNC_HINT})` },
    ])
    expect(catalog.layouts.map(entry => [entry.layout, entry.category])).toEqual([
      ['known', 'text'],
      ['explicit', 'uncategorized'],
      ['lost', 'uncategorized'],
      ['nameless', 'uncategorized'],
    ])
    expect(catalog.warnings).toEqual([
      `unknown category 'mystery' in lost.yaml, treated as uncategorized (${SYNC_HINT})`,
      `missing category in nameless.yaml, treated as uncategorized (${SYNC_HINT})`,
    ])
  })

  it('分類の一覧が空の場合は、レイアウトごとの警告を出さない', async () => {
    await explains('レイアウトの一覧を作成する `buildLayoutCatalog` のテストです。分類が 1 件も存在しない場合に、すべてのレイアウトが `uncategorized` になり、警告が空であることを確認します。')
    const catalog = buildLayoutCatalog(references([reference('one', 'text'), reference('two', 'uncategorized')]), [])
    expect(catalog.warnings).toEqual([])
    expect(catalog.layouts.every(entry => entry.category === 'uncategorized')).toBe(true)
    expect(catalog.categories.map(category => category.id)).toEqual(['uncategorized'])
  })

  it('uncategorized のレイアウトが存在しない場合は、uncategorized の分類を追加しない', async () => {
    await explains('レイアウトの一覧を作成する `buildLayoutCatalog` のテストです。すべてのレイアウトが宣言済みの分類に属する場合は、分類の一覧が渡した分類のままであることを確認します。')
    const catalog = buildLayoutCatalog(references([reference('one', 'text')]), [TEXT])
    expect(catalog.categories).toEqual([TEXT])
  })

  it('参照を集めた時点の警告（未対応の status など）を、先頭に引き継ぐ', async () => {
    await explains('レイアウトの一覧を作成する `buildLayoutCatalog` のテストです。参照側の警告 `upstream` がある場合に、それが警告の先頭に残り、分類に関する警告が続いて合計 2 件になることを確認します。')
    const catalog = buildLayoutCatalog(references([reference('lost', 'mystery')], ['upstream']), [TEXT])
    expect(catalog.warnings[0]).toBe('upstream')
    expect(catalog.warnings).toHaveLength(2)
  })

  it('宣言が存在しないテーマ（vue が由来）のレイアウトは、filename が vue のファイル名になる', async () => {
    await explains('レイアウトの一覧を作成する `buildLayoutCatalog` のテストです。`.vue` ファイルが由来のレイアウトを渡した場合に、`filename` が `one.vue` になることを確認します。')
    const entry: LayoutReference = {
      name: 'one',
      description: '',
      category: 'uncategorized',
      categoryMissing: true,
      status: 'stable',
      file: '/theme/layouts/one.vue',
    }
    const catalog = buildLayoutCatalog(references([entry]), [])
    expect(catalog.layouts).toEqual([
      { layout: 'one', description: '', category: 'uncategorized', deprecated: false, filename: 'one.vue' },
    ])
  })
})
