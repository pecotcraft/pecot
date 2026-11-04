// JSON 由来の unknown 値を扱う共有ガード。`as` キャストを使わずに narrowing するため、
// 型ガード述語として提供する。

/**
プレーンなオブジェクト（配列・null を除く）かを判定する。
JSON.parse / 外部ライブラリ由来の unknown を Record として扱う前段に置く。
*/
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
