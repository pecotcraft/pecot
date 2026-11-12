// テストの JSON 補助。
//
// 使い方:
//   parseJson('{"a": [1, null]}')   JSON.parse の結果を JsonValue として返す（型の絞り込みは省く）
import { parseJsonText } from '../../domain/json.js'
import type { JsonValue } from '../../domain/python-format.js'

export function parseJson(text: string): JsonValue {
  return parseJsonText(text)
}
