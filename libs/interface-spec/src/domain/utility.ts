// domain 全体で使う小さな関数。

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// code unit の順。出力を決定的にするため、並べ替えはこの比べ方にそろえる。
export function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
