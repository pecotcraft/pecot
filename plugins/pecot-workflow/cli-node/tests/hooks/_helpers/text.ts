import { expect } from 'vitest'

import { compareStrings } from '../../parity/baseline.js'

// 行の切れ目。末尾の改行は空要素を作らない。
// eslint-disable-next-line no-control-regex, security/detect-unsafe-regex -- 切れ目に制御文字（0x1C〜0x1E）がある
const LINE_BREAK = /\r\n|[\n\r\v\f\u{1C}-\u{1E}\u{85}\u{2028}\u{2029}]/u

export function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function escapeUnit(unit: number): string {
  return String.raw`\u${unit.toString(16).padStart(4, '0')}`
}

// json.dumps の既定どおり、区切りは ", " と ": "、非 ASCII は \uXXXX にする。
export function jsonDumps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => jsonDumps(item)).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value).map(([key, item]) => `${jsonDumps(key)}: ${jsonDumps(item)}`)
    return `{${members.join(', ')}}`
  }
  let escaped = ''
  for (const char of JSON.stringify(value)) {
    const codePoint = char.codePointAt(0) ?? 0
    if (char >= ' ' && char <= '~') escaped += char
    // 0x20〜0x7E の外は UTF-16 のコード単位ごとにエスケープする
    else if (codePoint > 0xFF_FF) escaped += escapeUnit(0xD8_00 + ((codePoint - 0x1_00_00) >> 10)) + escapeUnit(0xDC_00 + ((codePoint - 0x1_00_00) & 0x3_FF))
    else escaped += escapeUnit(codePoint)
  }
  return escaped
}

// JSON.parse の any を unknown にして返す。expect に渡す前の型の絞り込みを省く。
export function parseJson(text: string): unknown {
  return JSON.parse(text)
}

// expect.stringContaining の any を unknown にして返す。toMatchObject の期待値に使う。
export function containing(text: string): unknown {
  return expect.stringContaining(text)
}

// パスを構成要素ごとに比べる。
export function comparePathParts(left: string, right: string): number {
  const leftParts = left.split('/')
  const rightParts = right.split('/')
  const firstDifference = leftParts.map((part, index) => compareStrings(part, rightParts.at(index) ?? '')).find(order => order !== 0)
  return firstDifference ?? leftParts.length - rightParts.length
}
