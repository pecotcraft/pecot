// デッキ（talk-dir）の pages/*.md と slides.md を lint する設定。
// ファイル名を `eslint.config.*` にしないのは、ESLint 10 の探索の仕様による。
// ESLint 10 は対象ファイルに最も近い `eslint.config.*` を、上方探索で使う。
// テーマの dir に `eslint.config.*` を置くと、開発 lint で templates/<テーマ>/** にこちらだけが当たる。
// すると vue / 2layer / pptx-compat / asset-path の規則が外れる。
// デッキ lint は cli（eslint-runner）と PostToolUse hook が、`--config` でこのファイルを渡す。
// 開発 lint は assets/slidev/eslint.config.js が、basePath 付きで取り込む。
//
// テーマ固有の値は、CLI が解釈した結果を 4 項目で受ける。この config は宣言のファイルを読まない。
// 宣言を解釈する場所は、CLI の `slide theme` の 1 か所だけにする。
//   referencesDirectories レイアウトの宣言（references/）を探す dir。先頭が優先（talk-dir 側が先）。
//   panels                レイアウト名 -> 図の枠寸法。
//   markerLayouts         印のセルを持つレイアウト名。
//   rules                 宣言の lint.rules。固定の規則を持たず、受けた値をそのまま置く。
// 規則は共有 settings['slidev-theme'] から 3 項目を受ける。
// cli と hook は deck-lint.env.config.js を `--config` で渡す。そちらが環境変数 PECOTV_DECK_LINT の JSON を読んで、ここへ渡す。
// プラグインは dist を相対パスで import する。実行用ミラーと配布物のどちらも、同じ tree に dist を持つ。
import markdown from '@eslint/markdown'
import { defineConfig } from 'eslint/config'
import slidevPagesLintPlugin from './scripts/eslint/slidev-pages-lint/dist/index.js'
import textConstraintsPlugin from './scripts/eslint/text-constraints/dist/index.js'

const NO_MISSING_PAGE = 'slidev-pages-lint/no-missing-page'

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * `slide theme --json` の lint の 4 項目を受けて、flat config を組む。
 * @param {object} options
 * @param {string[]} options.referencesDirectories 参照 yaml を探す dir。
 * @param {Record<string, { width: number, height: number }>} options.panels 図の枠寸法。
 * @param {string[]} options.markerLayouts 印のセルを持つレイアウト名。
 * @param {Record<string, 'error' | 'warn' | 'off'>} options.rules 規則の重さ。
 */
export function defineDeckLintConfig({ referencesDirectories, panels, markerLayouts, rules }) {
  const isValid = Array.isArray(referencesDirectories) && isRecord(panels) && Array.isArray(markerLayouts) && isRecord(rules)
  if (!isValid) {
    throw new TypeError(
      'defineDeckLintConfig の引数が不正です。'
      + 'referencesDirectories と markerLayouts は配列、panels と rules は object で渡してください',
    )
  }
  const settings = { 'slidev-theme': { referencesDirectories, panels, markerLayouts } }
  // no-missing-page は slides.md を見る規則で、pages/** の object には置かない。
  const { [NO_MISSING_PAGE]: noMissingPage, ...pageRules } = rules

  return defineConfig(
    {
      // ignores だけの object は全体の除外として働く。settings を足すと対象が狭まるので足さない。
      ignores: [
        'node_modules/**',
        'dist/**',
        '.slidev/**',
        '.vite/**',
      ]
    },
    {
      settings,
      files: ['pages/**/*.md'],
      plugins: {
        markdown,
        'slidev-pages-lint': slidevPagesLintPlugin,
        'text-constraints': textConstraintsPlugin
      },
      language: 'markdown/commonmark',
      rules: pageRules
    },
    {
      settings,
      files: ['slides.md'],
      plugins: { markdown, 'slidev-pages-lint': slidevPagesLintPlugin },
      language: 'markdown/commonmark',
      rules: noMissingPage === undefined ? {} : { [NO_MISSING_PAGE]: noMissingPage }
    }
  )
}
