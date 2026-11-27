// テーマの宣言が書ける規則の一覧（DECK_LINT_RULE_IDS）が、本体の deck lint プラグインの規則と一致することを固定する。
// 設定（deck-lint.config.js）は規則を持たず、宣言の lint.rules をそのまま置く。
// 宣言の無いテーマの既定値（REFERENCE_FREE_RULE_IDS の 9 本）が、レイアウトの宣言を読まないことも固定する。
// プラグインと設定は import せず、ファイルを読んで確かめる。

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DECK_LINT_RULE_IDS, REFERENCE_FREE_RULE_IDS } from '../../../src/domain/slidev-theme/deck-lint-rules.js'
import { DEFAULT_THEME_DECLARATION } from '../../../src/domain/slidev-theme/defaults.js'
import { explains } from '../../_helpers/explains.js'

// tests/unit/domain → plugins/pecot-visual
const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const SLIDEV_ASSETS = path.join(PLUGIN_ROOT, 'assets', 'slidev')
const CONFIG_PATH = path.join(SLIDEV_ASSETS, 'deck-lint.config.js')
const ESLINT_PLUGINS = path.join(SLIDEV_ASSETS, 'scripts', 'eslint')

const RULE_LINE = /'([a-z-]+\/[a-z-]+)'\s*:\s*'(?:error|warn|off)'/gu

// 設定の項目を読む関数。規則の実装がこれらを（直接でも、読み込み用の util 経由でも）使うと、宣言が無いと働かない。
const SETTINGS_READERS = ['readThemeSettings', 'loadLayoutReference', 'loadConstraintsFor']

const SIX_READERS: ReadonlySet<string> = new Set([
  'slidev-pages-lint/no-unknown-props',
  'slidev-pages-lint/validate-clicks',
  'slidev-pages-lint/require-matching-length',
  'slidev-pages-lint/no-missing-marker-cell',
  'slidev-pages-lint/no-scaled-drawio',
  'text-constraints/max-chars',
])

function compare(a: string, b: string): number {
  return a.localeCompare(b)
}

/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは本体のプラグインの固定パスだけ */
function ruleSource(id: string): string {
  const [plugin = '', rule = ''] = id.split('/', 2)
  return readFileSync(path.join(ESLINT_PLUGINS, plugin, 'lib', 'rules', `${rule}.ts`), 'utf8')
}

function isReadingSettings(id: string): boolean {
  const source = ruleSource(id)
  return SETTINGS_READERS.some(reader => source.includes(reader))
}

describe('DECK_LINT_RULE_IDS', () => {
  it('テーマの宣言で指定できる規則の一覧が、本体の lint プラグインの 15 個の規則と一致する', async () => {
    await explains('`DECK_LINT_RULE_IDS` のテストです。本体の `slidev-pages-lint` と `text-constraints` の推奨設定から読み取った 15 個の規則名と、一覧の内容が順序を除いて一致することを確認します。')
    const fromPlugins = ['slidev-pages-lint', 'text-constraints'].flatMap((plugin) => {
      const text = readFileSync(path.join(ESLINT_PLUGINS, plugin, 'index.ts'), 'utf8')
      const recommended = text.slice(text.indexOf('configs.recommended'))
      return recommended.matchAll(RULE_LINE).map(match => match[1] ?? '').toArray()
    })
    expect(fromPlugins).toHaveLength(15)
    expect(DECK_LINT_RULE_IDS).toHaveLength(15)
    expect(DECK_LINT_RULE_IDS.toSorted(compare)).toEqual(fromPlugins.toSorted(compare))
  })

  it('規則の一覧に、同じ規則名が重複して含まれない', async () => {
    await explains('`DECK_LINT_RULE_IDS` に同じ規則名が 2 回以上含まれないことを確認するテストです。')
    expect(new Set(DECK_LINT_RULE_IDS).size).toBe(DECK_LINT_RULE_IDS.length)
  })

  it('deck-lint.config.js は固定の規則を持たず、受け取った rules を設定に使う', async () => {
    await explains('`deck-lint.config.js` のソースを読んで検証するテストです。規則の指定が書かれておらず、`defineDeckLintConfig` だけを公開し、`pecot-theme.json` に依存しないことを確認します。')
    const text = readFileSync(CONFIG_PATH, 'utf8')
    expect(text.matchAll(RULE_LINE).toArray()).toEqual([])
    expect(text).toContain('export function defineDeckLintConfig')
    expect(text).not.toContain('export default')
    expect(text).not.toContain('pecot-theme.json')
  })
})

describe('REFERENCE_FREE_RULE_IDS', () => {
  it('宣言ファイルを持たないテーマの既定値は、設定を読まない 9 個の規則を、すべて error とした設定になる', async () => {
    await explains('`DEFAULT_THEME_DECLARATION` の lint の規則のテストです。`REFERENCE_FREE_RULE_IDS` の 9 個の規則が、すべて `error` として指定されていることを確認します。')
    expect(REFERENCE_FREE_RULE_IDS).toHaveLength(9)
    expect(DEFAULT_THEME_DECLARATION.lint.rules).toEqual(
      Object.fromEntries(REFERENCE_FREE_RULE_IDS.map(id => [id, 'error'])),
    )
  })

  it('設定を読まない規則の一覧は、全 15 個から設定を読む 6 個を除いたものと一致する', async () => {
    await explains('`REFERENCE_FREE_RULE_IDS` のテストです。`DECK_LINT_RULE_IDS` の 15 個から、設定の項目を読む 6 個を除いた規則名と、順序を除いて一致することを確認します。')
    const rest = DECK_LINT_RULE_IDS.filter(id => !SIX_READERS.has(id))
    expect(REFERENCE_FREE_RULE_IDS.toSorted(compare)).toEqual(rest.toSorted(compare))
  })

  it('設定を読むと定めた 6 個の規則は、実装でも設定の項目を読み込んでいる', async () => {
    await explains('`no-unknown-props` や `max-chars` など、設定を読むと定めた 6 個の規則の実装を調べるテストです。ソースに `readThemeSettings` などの読み込み関数が含まれていることを確認します。')
    const six = [...SIX_READERS]
    expect(six.map(id => [id, isReadingSettings(id)])).toEqual(six.map(id => [id, true]))
  })

  it('設定を読まない規則のうち textlint を除く 8 個は、実装でも設定の項目を読み込まない', async () => {
    await explains('`REFERENCE_FREE_RULE_IDS` から `text-constraints/textlint` を除いた 8 個の規則の実装を調べるテストです。ソースに設定を読み込む関数が含まれていないことを確認します。')
    const others = REFERENCE_FREE_RULE_IDS.filter(entry => entry !== 'text-constraints/textlint')
    expect(others).toHaveLength(8)
    expect(others.map(id => [id, isReadingSettings(id)])).toEqual(others.map(id => [id, false]))
  })

  it('textlint 規則は項目の宣言を読むが、referencesDirectories が空の場合は何も報告しない', async () => {
    await explains('`text-constraints/textlint` の実装を調べるテストです。設定の読み込み関数を使っていることと、`referencesDirectories` が空の場合に `null` を返す処理がソースに含まれていることを確認します。')
    expect(isReadingSettings('text-constraints/textlint')).toBe(true)
    const loader = readFileSync(path.join(ESLINT_PLUGINS, 'text-constraints', 'lib', 'utils', 'constraint-loader.ts'), 'utf8')
    expect(loader).toMatch(/referencesDirectories\.length === 0\)\s*\{\s*return null/u)
  })
})
