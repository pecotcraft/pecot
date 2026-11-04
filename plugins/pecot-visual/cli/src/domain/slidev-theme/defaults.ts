// 宣言（pecot-theme.json）を省いたテーマに使う、本体の既定値（research R6）。

import type { LintSeverity, ResolvedThemeDeclaration } from './declaration.js'
import { REFERENCE_FREE_RULE_IDS } from './deck-lint-rules.js'

export const DEFAULT_THEME_DECLARATION: ResolvedThemeDeclaration = {
  schema: 1,
  slide: { width: 960, height: 540 },
  fonts: { body: ['sans-serif'], heading: ['sans-serif'] },
  fontSizes: { heading: 16, headingSm: 13, body: 12, bodySm: 10, label: 9 },
  pptx: {},
  // レイアウトの宣言を読まない規則だけを有効にする。宣言の無いテーマでも lint が動く。
  lint: { rules: Object.fromEntries(REFERENCE_FREE_RULE_IDS.map((id): [string, LintSeverity] => [id, 'error'])) },
  layouts: { references: 'references' },
  drawio: { panels: {}, markerLayouts: [] },
}
