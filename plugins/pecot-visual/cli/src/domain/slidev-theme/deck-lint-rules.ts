// 本体の deck lint（assets/slidev/deck-lint.config.js）が持つ規則 id の一覧。
// テーマの宣言（pecot-theme.json の lint.rules）が書ける規則は、この一覧にあるものだけ。
// 一覧と、本体のプラグインが持つ規則の一致は tests/unit/domain/deck-lint-rules.test.ts が固定する。

export const DECK_LINT_RULE_IDS: readonly string[] = [
  'slidev-pages-lint/one-slide-per-file',
  'slidev-pages-lint/no-content-before-frontmatter',
  'slidev-pages-lint/validate-clicks',
  'slidev-pages-lint/no-unknown-props',
  'slidev-pages-lint/require-slides-entry',
  'slidev-pages-lint/no-triple-hyphen-in-frontmatter',
  'slidev-pages-lint/no-numeric-filename-prefix',
  'slidev-pages-lint/no-numeric-asset-prefix',
  'slidev-pages-lint/require-matching-length',
  'slidev-pages-lint/no-missing-marker-cell',
  'slidev-pages-lint/no-scaled-drawio',
  'slidev-pages-lint/no-missing-page',
  'text-constraints/max-chars',
  'text-constraints/textlint',
  'text-constraints/textlint-body',
]

// レイアウトの宣言（references/）・図の枠・印のレイアウトを読まない規則。
// 宣言の無いテーマの既定値（DEFAULT_THEME_DECLARATION.lint.rules）は、この規則だけを有効にする。
// 残りの 6 本は settings['slidev-theme'] の項目を読む。
// 6 本の内訳は次のとおり。
// no-unknown-props、validate-clicks、require-matching-length。
// no-missing-marker-cell、no-scaled-drawio、max-chars。
// textlint は項目の宣言を読むが、referencesDirectories が空なら何も報告しないだけで、設定が無くても動く。
export const REFERENCE_FREE_RULE_IDS: readonly string[] = [
  'slidev-pages-lint/one-slide-per-file',
  'slidev-pages-lint/no-content-before-frontmatter',
  'slidev-pages-lint/require-slides-entry',
  'slidev-pages-lint/no-triple-hyphen-in-frontmatter',
  'slidev-pages-lint/no-numeric-filename-prefix',
  'slidev-pages-lint/no-numeric-asset-prefix',
  'slidev-pages-lint/no-missing-page',
  'text-constraints/textlint',
  'text-constraints/textlint-body',
]
