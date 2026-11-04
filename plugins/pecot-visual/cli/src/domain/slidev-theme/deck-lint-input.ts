// デッキ lint（deck-lint.config.js）が受ける、テーマの宣言の解釈結果。
// `slide theme --json` の lint と同じ形で、CLI が環境変数 PECOTV_DECK_LINT に JSON で渡す。

import type { LintSeverity } from './declaration.js'

export interface DeckLintInput {
  // レイアウトの宣言（references/）を探す dir。先頭が優先（talk-dir 側が先）
  readonly referencesDirectories: readonly string[]
  // レイアウト名 -> 図の枠寸法
  readonly panels: Readonly<Record<string, { readonly width: number, readonly height: number }>>
  // 印のセルを持つレイアウト名
  readonly markerLayouts: readonly string[]
  // 宣言の lint.rules
  readonly rules: Readonly<Record<string, LintSeverity>>
}
