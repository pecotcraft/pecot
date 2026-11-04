// テストが応答・JSON Schema から Record を取り出すときの型ガード。
//
// contract / tools-read / tools-reject が同じ定義を各々持っていたので 1 箇所へ寄せる。
// 実装側（src/mcp/tools/_shared.ts）は依存方向の都合でテストヘルパを import しないため、
// 同じ述部が実装側にもう 1 つ残る。

/**
オブジェクト（配列ではない）か。
*/
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value instanceof Object && !Array.isArray(value)
}
