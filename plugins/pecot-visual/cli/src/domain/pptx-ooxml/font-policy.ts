// Phase 1 のフォントポリシー。
// Python 版 fix_japanese_fonts.py / postprocess.py を直訳する。
// 対象は正規表現判定 (`_contains_japanese`) と spc 計算 (`_calculate_spc_value`)。
// fontkit ベースの glyph 存在チェックは Phase 1 では行わない。Python 版に該当ロジックが無いため。

/**
PPTX の後処理に渡す、テーマの宣言から組む値。どちらも省略できる。
`ea` が無ければ東アジア書体を書かない。`linkColor` が無ければリンク色の run をハイパーリンクに置換しない。
*/
export interface FontPolicy {
  readonly ea?: string
  readonly linkColor?: string
}

// Python 版 postprocess.py:65 の `re.search(r"[぀-ゟ゠-ヿ一-鿿]", text)` を
// JavaScript regex に直訳。ひらがな (U+3040–U+309F) / カタカナ (U+30A0–U+30FF) /
// CJK 統合漢字 (U+4E00–U+9FFF) の文字を含むかどうか判定する。
// regexp/no-obscure-range は obscure な range を Unicode escape で示すよう要求する。
// ただし Python 版とソースレベルで一致させるため、生 CJK 文字を残し、規則を局所的に無効化する。
// eslint-disable-next-line regexp/no-obscure-range
const JAPANESE_CHARACTER_REGEX = /[぀-ゟ゠-ヿ一-鿿]/

export function doesContainJapanese(text?: string): boolean {
  return text !== undefined && text !== '' && JAPANESE_CHARACTER_REGEX.test(text)
}

// Python 版 postprocess.py:68 の `_calculate_spc_value` を直訳。
// letter-spacing の px 値を 0.75 倍して pt に換算し、PPTX の spc 単位 (1/100 pt) に乗算して丸める。
// Python 版は引数 `font_size_px` を受け取るが計算には使用しないため、TS 移植では削除する。
export function calculateSpcValue(letterSpacingPx: string): number {
  const spacing = Number(letterSpacingPx.replace('px', ''))
  const spacingPt = spacing * 0.75
  return Math.round(spacingPt * 100)
}
