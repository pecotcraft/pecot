import { isRecord } from '../../parity/baseline.js'

export function toRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${what} がオブジェクトではありません`)
  return value
}

export function toArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} が配列ではありません`)
  return value
}
