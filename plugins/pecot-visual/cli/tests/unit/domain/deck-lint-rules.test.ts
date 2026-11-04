// テーマの宣言が書ける規則の一覧（DECK_LINT_RULE_IDS）が、本体の deck lint プラグインの規則と一致することを固定する。
// 設定（deck-lint.config.js）は規則を持たず、宣言の lint.rules をそのまま置く。
// 宣言の無いテーマの既定値（REFERENCE_FREE_RULE_IDS の 9 本）が、レイアウトの宣言を読まないことも固定する。
// プラグインと設定は import せず、ファイルを読んで確かめる。

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DECK_LINT_RULE_IDS, REFERENCE_FREE_RULE_IDS } from '../../../src/domain/slidev-theme/deck-lint-rules.js'
import { DEFAULT_THEME_DECLARATION } from '../../../src/domain/slidev-theme/defaults.js'

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
  it('本体のプラグインが持つ 15 本の規則と一致する', () => {
    const fromPlugins = ['slidev-pages-lint', 'text-constraints'].flatMap((plugin) => {
      const text = readFileSync(path.join(ESLINT_PLUGINS, plugin, 'index.ts'), 'utf8')
      const recommended = text.slice(text.indexOf('configs.recommended'))
      return recommended.matchAll(RULE_LINE).map(match => match[1] ?? '').toArray()
    })
    expect(fromPlugins).toHaveLength(15)
    expect(DECK_LINT_RULE_IDS).toHaveLength(15)
    expect(DECK_LINT_RULE_IDS.toSorted(compare)).toEqual(fromPlugins.toSorted(compare))
  })

  it('重複しない', () => {
    expect(new Set(DECK_LINT_RULE_IDS).size).toBe(DECK_LINT_RULE_IDS.length)
  })

  it('deck-lint.config.js は固定の規則を持たず、受けた rules を置く', () => {
    const text = readFileSync(CONFIG_PATH, 'utf8')
    expect(text.matchAll(RULE_LINE).toArray()).toEqual([])
    expect(text).toContain('export function defineDeckLintConfig')
    expect(text).not.toContain('export default')
    expect(text).not.toContain('pecot-theme.json')
  })
})

describe('REFERENCE_FREE_RULE_IDS', () => {
  it('宣言の無いテーマの既定値は、この 9 本を error にしたもの', () => {
    expect(REFERENCE_FREE_RULE_IDS).toHaveLength(9)
    expect(DEFAULT_THEME_DECLARATION.lint.rules).toEqual(
      Object.fromEntries(REFERENCE_FREE_RULE_IDS.map(id => [id, 'error'])),
    )
  })

  it('15 本のうち、設定の項目を読む 6 本を除いたものと一致する', () => {
    const rest = DECK_LINT_RULE_IDS.filter(id => !SIX_READERS.has(id))
    expect(REFERENCE_FREE_RULE_IDS.toSorted(compare)).toEqual(rest.toSorted(compare))
  })

  it('6 本の実装は、設定の項目（referencesDirectories・panels・markerLayouts）を読む', () => {
    const six = [...SIX_READERS]
    expect(six.map(id => [id, isReadingSettings(id)])).toEqual(six.map(id => [id, true]))
  })

  it('textlint 以外の 8 本の実装は、設定の項目を読まない', () => {
    const others = REFERENCE_FREE_RULE_IDS.filter(entry => entry !== 'text-constraints/textlint')
    expect(others).toHaveLength(8)
    expect(others.map(id => [id, isReadingSettings(id)])).toEqual(others.map(id => [id, false]))
  })

  it('textlint は項目の宣言を読むが、referencesDirectories が空なら何も報告しない', () => {
    expect(isReadingSettings('text-constraints/textlint')).toBe(true)
    const loader = readFileSync(path.join(ESLINT_PLUGINS, 'text-constraints', 'lib', 'utils', 'constraint-loader.ts'), 'utf8')
    expect(loader).toMatch(/referencesDirectories\.length === 0\)\s*\{\s*return null/u)
  })
})
