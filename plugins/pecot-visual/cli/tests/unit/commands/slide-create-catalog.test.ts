// slide create が返すレイアウトの一覧の検証。
// 整形（emitLayoutCatalog）は与えた一覧をそのまま書く。fixture テーマ（with-declaration）を張った talk-dir から、
// 件数・分類・SKILL.md が名指しするキー名を固定する。期待値はテーマの references/ から導く。一覧の組み立て規則は domain の references.test.ts が持つ。

/* eslint-disable security/detect-non-literal-fs-filename -- fixture テーマ配下の固定パスと一時ディレクトリだけを触る */
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { emitLayoutCatalog } from '../../../src/commands/slidev-project/create.js'
import { executeSlideTheme } from '../../../src/commands/slidev-project/theme.js'
import { compareStrings } from '../../../src/domain/_shared/compare-strings.js'
import type { LayoutCatalog } from '../../../src/domain/slidev-theme/references.js'
import { NodeThemeFiles } from '../../../src/infra/slidev-theme/fs.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

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

// write を持つ stub をそのまま使う。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return captured as unknown as NodeJS.WritableStream
}

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const THEME_ROOT = path.join(PLUGIN_ROOT, 'cli', 'tests', 'fixtures', 'themes', 'with-declaration')
const THEME_NAME = 'slidev-theme-pecotv-test-declared'
const REFERENCES_ROOT = path.join(THEME_ROOT, 'references')

const temporaryRoot = useTemporaryDirectory('pecotv-create-catalog-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

/**
fixture テーマを node_modules/<name> に symlink した talk-dir を作る。
*/
function makeTalk(): string {
  const talk = temporaryRoot('talk')
  mkdirSync(path.join(talk, 'node_modules'), { recursive: true })
  writeFileSync(path.join(talk, 'slides.md'), `---\ntheme: ${THEME_NAME}\n---\n\n# 表紙\n`)
  writeFileSync(path.join(talk, 'package.json'), JSON.stringify({ name: 'talk', dependencies: { [THEME_NAME]: `file:${THEME_ROOT}` } }))
  symlinkSync(THEME_ROOT, path.join(talk, 'node_modules', THEME_NAME))
  return talk
}

interface ReferenceEntry {
  readonly layout: string
  readonly category: string
  readonly status: string
}

/**
テーマの references/ を直に読み、`_` 始まりの共通 include を除いた各レイアウトの分類と状態を返す。
件数の固定値を書かず、fixture の増減に追従する。
*/
function readReferences(): readonly ReferenceEntry[] {
  return readdirSync(REFERENCES_ROOT)
    .filter(name => name.endsWith('.yaml') && !name.startsWith('_'))
    .toSorted(compareStrings)
    .map((name) => {
      const text = readFileSync(path.join(REFERENCES_ROOT, name), 'utf8')
      return {
        layout: name.replace(/\.yaml$/u, ''),
        category: /^category:\s*'([^']+)'/mu.exec(text)?.[1] ?? '',
        status: /^status:\s*'([^']+)'/mu.exec(text)?.[1] ?? 'stable',
      }
    })
}

const CATALOG: Pick<LayoutCatalog, 'categories' | 'layouts'> = {
  categories: [
    { id: 'fixed', label: '定型ページ', question: '見せ方の選択対象外' },
    { id: 'figure', label: '図', question: '図で見せる' },
    { id: 'table', label: '表', question: '軸のある表で見せる' },
  ],
  layouts: [
    { layout: 'cover', description: '表紙', category: 'fixed', deprecated: false, filename: 'cover.yaml' },
    { layout: 'chart', description: 'グラフ', category: 'figure', deprecated: false, filename: 'chart.yaml' },
    { layout: 'legacy', description: '旧い図', category: 'figure', deprecated: true, filename: 'legacy.yaml' },
  ],
}

describe('emitLayoutCatalog', () => {
  it('分類ごとに群化し、0 件分類は見出しと (該当レイアウトなし) を出す', () => {
    const stdout = makeStream()

    emitLayoutCatalog(CATALOG, asStream(stdout))
    const written = stdout.chunks.join('')

    // 既存の `=` 罫線書式を保つ。
    expect(written).toContain(`${'='.repeat(60)}\n`)
    expect(written).toContain('Layout Catalog')

    // 分類見出しは label: question の形で、宣言順に出る。
    expect(written.indexOf('--- 定型ページ: 見せ方の選択対象外 ---'))
      .toBeLessThan(written.indexOf('--- 図: 図で見せる ---'))
    expect(written.indexOf('--- 図: 図で見せる ---'))
      .toBeLessThan(written.indexOf('--- 表: 軸のある表で見せる ---'))

    // deprecated は群の中に [deprecated] 付きで残り、末尾の専用セクションは作らない。
    expect(written).toContain('- [deprecated] legacy: 旧い図\n')
    expect(written).not.toContain('--- deprecated (use only if no alternative) ---')
    const [, figureSection = ''] = written.split('--- 図: 図で見せる ---', 2)
    expect(figureSection.indexOf('- chart:')).toBeLessThan(figureSection.indexOf('[deprecated] legacy:'))

    // 0 件分類も見出しを出して不足を見せる。
    expect(written).toContain('--- 表: 軸のある表で見せる ---\n\n(該当レイアウトなし)\n')
  })
})

describe('fixture テーマの一覧', () => {
  it('hidden を除いた全レイアウトを分類付きで返す', async () => {
    const { data } = await executeSlideTheme({ dir: makeTalk() }, { files: new NodeThemeFiles() })
    const { categories, layouts } = data
    const references = readReferences()
    const selectable = references.filter(entry => entry.status !== 'hidden')
    const hiddenReferences = references.filter(entry => entry.status === 'hidden')

    expect(layouts).toHaveLength(selectable.length)
    expect(hiddenReferences.length, 'fixture に hidden が無いと検証にならない').toBeGreaterThan(0)
    for (const hidden of hiddenReferences) {
      expect(layouts.map(entry => entry.layout)).not.toContain(hidden.layout)
    }
    expect(layouts.filter(entry => entry.deprecated).map(entry => entry.layout).toSorted(compareStrings))
      .toEqual(selectable.filter(entry => entry.status === 'deprecated').map(entry => entry.layout))

    // 語彙は _common.yaml が基準。uncategorized は 1 件も出ない。
    expect(categories.map(category => category.id)).toEqual(['text', 'figure'])

    // 件数だけを固定すると、レイアウトを別の分類へ入れ替えた取り違えが通過する。
    // 所属そのものを、references/ に書いた category と照らし合わせる。
    const expected = new Map(selectable.map(entry => [entry.layout, entry.category]))
    const actual = new Map(layouts.map(entry => [entry.layout, entry.category]))
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected))
    // 警告に出るのは宣言の不備だけ。分類の取り違えや読み飛ばしは無い。
    expect(data.warnings.filter(warning => /category|分類/.test(warning))).toEqual([])
  })
})

// SKILL.md は配布物であり、利用環境のエージェントはこの本文だけを手掛かりに応答を読む。
// 本文が名指しするキー名と実際の応答キーが割れると、エージェントは存在しないキーを探す。
describe('v-slidev SKILL.md の応答キー名', () => {
  it('SKILL.md が名指しするキーが fixture テーマの一覧に実在する', async () => {
    const skillPath = path.join(PLUGIN_ROOT, 'skills', 'v-slidev', 'SKILL.md')
    const skill = readFileSync(skillPath, 'utf8')
    const { data } = await executeSlideTheme({ dir: makeTalk() }, { files: new NodeThemeFiles() })
    const catalog = { categories: data.categories, layouts: data.layouts }

    const categoryKeys = new Set(catalog.categories.flatMap(category => Object.keys(category)))
    const layoutKeys = new Set(catalog.layouts.flatMap(entry => Object.keys(entry)))
    const responseKeys = [...categoryKeys, ...layoutKeys]
    const categoryIds = new Set(catalog.categories.map(category => category.id))

    // 見るのは `data.categories` / `data.layouts` を名指しする行だけ。その行のバッククォート
    // トークンのうち、1 語の小文字（= キー名の形）で分類 id でないものをキー名候補とする。
    const lines = skill.split('\n')
      .filter(line => line.includes('data.categories') || line.includes('data.layouts'))
    expect(lines.length).toBeGreaterThan(0)

    const containers = new Set<string>()
    const fields = new Set<string>()
    for (const line of lines) {
      for (const [, token = ''] of line.matchAll(/`([^`]+)`/g)) {
        if (token === 'data.categories' || token === 'data.layouts') {
          containers.add(token.slice('data.'.length))
        }
        else if (/^[a-z]+$/.test(token) && !categoryIds.has(token)) fields.add(token)
      }
    }

    // 応答の入れ物 2 つは一覧のフィールド名そのもの。
    expect(containers).toEqual(new Set(['categories', 'layouts']))
    expect(Object.keys(catalog).toSorted(compareStrings)).toEqual(['categories', 'layouts'])

    expect(fields.size).toBeGreaterThan(0)
    for (const field of fields) {
      expect(responseKeys, `SKILL.md が名指しする '${field}' が応答キーに無い`).toContain(field)
    }

    // Step 2 の選択手順が依存するキーは、実キー側にも必ず在ること。
    expect([...categoryKeys]).toEqual(expect.arrayContaining(['id', 'label', 'question']))
    expect([...layoutKeys])
      .toEqual(expect.arrayContaining(['layout', 'description', 'category', 'deprecated']))
  })
})
