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
  it('talk-dir に references/ が無ければ、テーマの宣言をそのまま一覧にする', async () => {
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

  it('_ 始まりのファイル（_common.yaml）は一覧に入れない', async () => {
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries.map(entry => entry.name)).not.toContain('_common')
    expect(result.entries.map(entry => path.basename(entry.file))).not.toContain('_common.yaml')
  })

  it('directories は talk-dir 側が先', async () => {
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

  it('themeRoot と talkDirectory が同じなら、directories は 1 つにまとめる', async () => {
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: WITH_DECLARATION,
      referencesDirectory: 'references',
    })
    expect(result.directories).toEqual([path.join(WITH_DECLARATION, 'references')])
  })

  it('同名のレイアウトは talk-dir の宣言が勝つ', async () => {
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

  it('talk-dir だけにある宣言も一覧に加わる', async () => {
    writeTalkReference('extra.yaml', `layout: 'extra'\ndescription: '追加'\ncategory: 'text'\n`)
    const result = await resolveLayoutReferences(new NodeThemeFiles(), {
      themeRoot: WITH_DECLARATION,
      talkDirectory: state.talk,
      referencesDirectory: 'references',
    })
    expect(result.entries.map(entry => entry.name)).toEqual(['cover', 'end', 'extra', 'legacy-panel', 'link', 'marked', 'panel', 'plain', 'scratch', 'section'])
  })

  it('layout: が無い宣言はファイル名を名前にし、category が無ければ uncategorized', async () => {
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

  it('宣言の無いテーマは layouts/*.vue の名前だけを一覧にする', async () => {
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

  it('宣言の無いテーマでも、talk-dir の宣言は上書きとして使われる', async () => {
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
  it('status: deprecated / hidden を読む。未指定は stable', async () => {
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

  it('未知の status は stable 扱いにして、警告を warnings に積む', async () => {
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
    const talk = writeCommon(path.join(state.talk, 'a'), `layout_categories:\n  - { id: x, label: X, question: 'x?' }\n`)
    const theme = writeCommon(path.join(state.talk, 'b'), `layout_categories:\n  - { id: y, label: Y, question: 'y?' }\n`)
    const result = await readLayoutCategories(new NodeThemeFiles(), [talk, theme])
    expect(result).toEqual({ categories: [{ id: 'x', label: 'X', question: 'x?' }], warnings: [] })
  })

  it('先の directory に無ければ後ろを読む', async () => {
    const empty = path.join(state.talk, 'none')
    const theme = path.join(WITH_DECLARATION, 'references')
    const result = await readLayoutCategories(new NodeThemeFiles(), [empty, theme])
    expect(result).toEqual({ categories: [TEXT, FIGURE], warnings: [] })
  })

  it('どこにも _common.yaml が無ければ、空で警告する', async () => {
    const directory = path.join(state.talk, 'none')
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('cannot read the layout categories')
    expect(result.warnings[0]).toContain(path.join(directory, '_common.yaml'))
    expect(result.warnings[0]).toContain(SYNC_HINT)
  })

  it('layout_categories が配列でなければ、空で警告する', async () => {
    const directory = writeCommon(path.join(state.talk, 'bad'), `description: 'x'\n`)
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([])
    expect(result.warnings[0]).toContain('layout_categories is not found as an array')
  })

  it('使える要素が 0 件なら、全滅の警告 1 行に合流する', async () => {
    const directory = writeCommon(path.join(state.talk, 'zero'), `layout_categories:\n  - { id: x }\n  - 3\n`)
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([])
    expect(result.warnings).toEqual([
      `cannot read the layout categories (${path.join(directory, '_common.yaml')}: layout_categories has no usable item (0 of 2)); continuing without categories (fix: ${SYNC_HINT})`,
    ])
  })

  it('予約語 uncategorized と不揃いの要素は落とし、件数を 1 行ずつ警告する', async () => {
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

  it('YAML として不正な _common.yaml も、空で警告する', async () => {
    const directory = writeCommon(path.join(state.talk, 'broken'), 'layout_categories: [unclosed\n')
    const result = await readLayoutCategories(new NodeThemeFiles(), [directory])
    expect(result.categories).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('cannot read the layout categories')
  })
})

describe('buildLayoutCatalog', () => {
  it('categories の宣言順 → stable → deprecated → ファイル名順に並べ、既存の形で返す', () => {
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

  it('status: hidden は落とす', () => {
    const catalog = buildLayoutCatalog(references([reference('shown', 'text'), reference('secret', 'text', 'hidden')]), [TEXT])
    expect(catalog.layouts.map(entry => entry.layout)).toEqual(['shown'])
  })

  it('未設定・未知の category は uncategorized に倒し、末尾に合成分類を足して警告する', () => {
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

  it('分類の語彙が空のときは、レイアウトごとの警告を重ねない', () => {
    const catalog = buildLayoutCatalog(references([reference('one', 'text'), reference('two', 'uncategorized')]), [])
    expect(catalog.warnings).toEqual([])
    expect(catalog.layouts.every(entry => entry.category === 'uncategorized')).toBe(true)
    expect(catalog.categories.map(category => category.id)).toEqual(['uncategorized'])
  })

  it('uncategorized が 1 件も無ければ、合成分類を足さない', () => {
    const catalog = buildLayoutCatalog(references([reference('one', 'text')]), [TEXT])
    expect(catalog.categories).toEqual([TEXT])
  })

  it('references の警告（未知の status など）を先頭に引き継ぐ', () => {
    const catalog = buildLayoutCatalog(references([reference('lost', 'mystery')], ['upstream']), [TEXT])
    expect(catalog.warnings[0]).toBe('upstream')
    expect(catalog.warnings).toHaveLength(2)
  })

  it('宣言の無いテーマ（vue 由来）の filename は vue のファイル名になる', () => {
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
