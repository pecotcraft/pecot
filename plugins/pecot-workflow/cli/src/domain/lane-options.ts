// pecot-lane の選択肢を組む純粋な関数。値は利用者が決め、色だけをここで決める。
import { appendOptions, findOptionByName } from './field-options.js'
import type { FieldOptionInput } from './field-options.js'

/**
新しい選択肢の色。選択肢の並びの位置で順に回す（ProjectV2SingleSelectFieldOptionColor の 8 色）
*/
export const LANE_COLORS: readonly string[] = ['BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE', 'GRAY']

/**
既存の選択肢を残し、無い値を末尾に足す。入力の重なりは 1 つにまとめ、名前は大文字と小文字を区別する
*/
export function mergeLaneOptions(existing: readonly FieldOptionInput[], lanes: readonly string[]): Readonly<{ options: readonly FieldOptionInput[], added: readonly string[] }> {
  const missing = [...new Set(lanes)].filter(lane => findOptionByName(existing, lane) === undefined)
  const additions = missing.map((name, index) => ({ name, color: LANE_COLORS[(existing.length + index) % LANE_COLORS.length] ?? 'GRAY', description: '' }))
  return appendOptions(existing, additions)
}
