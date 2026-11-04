// YAML の読み込み。Python の CLI が使っていた YAML ライブラリ（safe_load）と同じ値を返す。
//
// 揃える対象は、型の決め方（暗黙の型の正規表現）と、重複キーの扱い。
//   - 真偽値は yes・no・true・false・on・off（大文字小文字は 3 通りだけ）。y と n は文字列のまま
//   - 整数は 2 進・8 進（先頭が 0）・16 進・60 進、数字の間の `_` を受ける。`0o10` と `08` は文字列
//   - 実数: 小数点が必要。`1e3` は文字列で、`1.0e+3` が実数。指数には符号が必要
//   - 日付は `YYYY-MM-DD` か、`Y-M-D` + 時刻
//   - 重複キーは後のものが勝つ。`=` と、キー以外の位置の `<<` は読めずにエラー
//   - 明示タグ（`!!float 1` など）は値の形に依らず、タグの型で読む。読めない値と未知のタグはエラー
//   - 配列や辞書をキーにすると、エラー
// 構文エラーの文は揃えない（YAML ライブラリの文のまま）。
// 文字列でないキー（`1:` `yes:` `null:`）は文字列にして読む。Python は整数・真偽値・None のキーで読む。
// フロントマターの項目名には当たらないため、検証後の結果は同じになる。

import { parseDocument, visit } from 'yaml'
import type { ScalarTag } from 'yaml'

import { JSON_NULL } from './json-null.js'

const REPLACED_TAGS: ReadonlySet<string> = new Set([
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:timestamp',
])

const BOOL_PATTERN = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/u

/* eslint-disable security/detect-unsafe-regex -- どの正規表現も全体を ^ と $ で囲み、量指定子の付いた群の中身は互いに重ならない。入力は YAML の 1 つのスカラー値で、破滅的な再試行は起きない */
// 実数と整数の正規表現は、Python の YAML ライブラリの 1 本を選択肢ごとに分けたもの（意味は同じ）
const FLOAT_PATTERNS: readonly RegExp[] = [
  /^[+-]?\d[\d_]*\.[\d_]*(?:e[+-]\d+)?$/iu,
  /^\.\d[\d_]*(?:e[+-]\d+)?$/iu,
  /^[+-]?\d[\d_]*(?::[0-5]?\d)+\.[\d_]*$/u,
  /^[+-]?\.(?:inf|Inf|INF)$/u,
  /^\.(?:nan|NaN|NAN)$/u,
]

const INT_PATTERNS: readonly RegExp[] = [
  /^[+-]?0b[01_]+$/u,
  /^[+-]?0[0-7_]+$/u,
  /^[+-]?(?:0|[1-9][\d_]*)$/u,
  /^[+-]?0x[\da-fA-F_]+$/u,
  /^[+-]?[1-9][\d_]*(?::[0-5]?\d)+$/u,
]

const TIMESTAMP_PATTERNS: readonly RegExp[] = [
  /^(\d{4})-(\d{2})-(\d{2})$/u,
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt]|[\t ]+)(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d*))?(?:[\t ]*(Z|[+-]\d{1,2}(?::\d{2})?))?$/u,
]

// 実数の各部（60 進の各部も同じ形）
const DECIMAL_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/u
/* eslint-enable security/detect-unsafe-regex */

function invalid(type: string, text: string): never {
  throw new Error(`${type} として読めない値です: ${text}`)
}

// `1:30.5` のような 60 進。各部は数でなければならない
function sexagesimal(text: string, type: string): number {
  let total = 0
  for (const part of text.split(':')) total = DECIMAL_NUMBER.test(part) ? total * 60 + Number(part) : invalid(type, text)
  return total
}

const BOOLEAN_VALUES: ReadonlyMap<string, boolean> = new Map([
  ['yes', true], ['true', true], ['on', true], ['no', false], ['false', false], ['off', false],
])

function isTrueKeyword(text: string): boolean {
  return BOOLEAN_VALUES.get(text.toLowerCase()) ?? invalid('bool', text)
}

function resolveFloat(text: string): number {
  const value = text.replaceAll('_', '').toLowerCase()
  const sign = value.startsWith('-') ? -1 : 1
  const unsigned = /^[+-]/u.test(value) ? value.slice(1) : value
  if (['.inf', 'inf', 'infinity'].includes(unsigned)) return sign * Infinity
  if (['.nan', 'nan'].includes(unsigned)) return NaN
  if (unsigned.includes(':')) return sign * sexagesimal(unsigned, 'float')
  return DECIMAL_NUMBER.test(unsigned) ? sign * Number(unsigned) : invalid('float', text)
}

// 符号を掛けると -0 になる（Python の整数に -0 は無い）ので、0 との差で負にする
function applySign(sign: number, magnitude: number): number {
  return sign < 0 ? 0 - magnitude : magnitude
}

function parseDigits(digits: string, radix: number, pattern: Readonly<RegExp>, text: string): number {
  return pattern.test(digits) ? Number.parseInt(digits, radix) : invalid('int', text)
}

function integerSexagesimal(unsigned: string, text: string): number {
  let total = 0
  for (const part of unsigned.split(':')) total = total * 60 + parseDigits(part, 10, /^\d+$/u, text)
  return total
}

function resolveInteger(text: string): number {
  const value = text.replaceAll('_', '')
  const sign = value.startsWith('-') ? -1 : 1
  const unsigned = /^[+-]/u.test(value) ? value.slice(1) : value
  if (unsigned === '0') return 0
  if (unsigned.startsWith('0b')) return applySign(sign, parseDigits(unsigned.slice(2), 2, /^[01]+$/u, text))
  if (unsigned.startsWith('0x')) return applySign(sign, parseDigits(unsigned.slice(2), 16, /^[\da-f]+$/iu, text))
  if (unsigned.startsWith('0')) return applySign(sign, parseDigits(unsigned, 8, /^[0-7]+$/u, text))
  if (unsigned.includes(':')) return applySign(sign, integerSexagesimal(unsigned, text))
  return applySign(sign, parseDigits(unsigned, 10, /^\d+$/u, text))
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function timeZoneMinutes(zone: string | undefined): number {
  if (zone === undefined || zone === 'Z') return 0
  const sign = zone.startsWith('-') ? -1 : 1
  const [hours = '0', minutes = '0'] = zone.slice(1).split(':', 2)
  return sign * (Number(hours) * 60 + Number(minutes))
}

function numberOrZero(text = '0'): number {
  return Number(text)
}

// 小数部の最初の 3 桁がミリ秒
function milliseconds(fraction = ''): number {
  return Number(`${fraction}000`.slice(0, 3))
}

function execFirst(patterns: readonly Readonly<RegExp>[], text: string): RegExpExecArray | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match !== null) return match
  }
  return undefined
}

function resolveTimestamp(text: string): Date {
  const match = execFirst(TIMESTAMP_PATTERNS, text)
  if (match === undefined) throw new Error('timestamp の形式ではありません')
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = [year, month, day, hour, minute, second].map(part => numberOrZero(part))
  const isValidDate = d >= 1 && d <= (DAYS_IN_MONTH[mo - 1] ?? 0) && new Date(Date.UTC(y, mo - 1, d)).getUTCDate() === d
  if (!isValidDate || h > 23 || mi > 59 || s > 59) throw new Error(`日付または時刻の範囲が不正です: ${text}`)
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, milliseconds(fraction)) - timeZoneMinutes(zone) * 60_000)
}

const TAG_BOOL = 'tag:yaml.org,2002:bool'
const TAG_FLOAT = 'tag:yaml.org,2002:float'
const TAG_INT = 'tag:yaml.org,2002:int'
const TAG_TIMESTAMP = 'tag:yaml.org,2002:timestamp'
const TAG_NULL = 'tag:yaml.org,2002:null'

// 暗黙の型（正規表現に合うとき）の読み方
const IMPLICIT_TAGS: readonly ScalarTag[] = [
  { default: true, tag: TAG_BOOL, test: BOOL_PATTERN, resolve: isTrueKeyword },
  ...FLOAT_PATTERNS.map((test): ScalarTag => ({ default: true, tag: TAG_FLOAT, test, resolve: resolveFloat })),
  ...INT_PATTERNS.map((test): ScalarTag => ({ default: true, tag: TAG_INT, test, resolve: resolveInteger })),
  ...TIMESTAMP_PATTERNS.map((test): ScalarTag => ({ default: true, tag: TAG_TIMESTAMP, test, resolve: resolveTimestamp })),
  {
    default: true,
    tag: 'tag:yaml.org,2002:value',
    test: /^=$/u,
    resolve(): never {
      throw new Error('could not determine a constructor for the tag \'tag:yaml.org,2002:value\'')
    },
  },
]

// 明示タグ（`!!float 1`）の読み方。正規表現に合わない値も、タグの型で読む
const EXPLICIT_TAGS: readonly ScalarTag[] = [
  { tag: TAG_BOOL, resolve: isTrueKeyword },
  { tag: TAG_FLOAT, resolve: resolveFloat },
  { tag: TAG_INT, resolve: resolveInteger },
  { tag: TAG_TIMESTAMP, resolve: resolveTimestamp },
  { tag: TAG_NULL, resolve: () => JSON_NULL },
]

// mapAsMap で読んだ Map を、文字列キーの辞書にする。配列や辞書のキーは、Python ではハッシュできずエラー
function toPlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => toPlainValue(item))
  if (!(value instanceof Map)) return value
  const entries: (readonly [string, unknown])[] = []
  for (const [key, item] of value) {
    if (key instanceof Map || Array.isArray(key)) throw new TypeError('while constructing a mapping: found unhashable key')
    entries.push([String(key), toPlainValue(item)])
  }
  return Object.fromEntries(entries)
}

/**
YAML の文字列を読む。空の文書は null。構文が不正なら YAML ライブラリのエラーを投げる
*/
export function parseYamlDocument(source: string): unknown {
  const document = parseDocument(source, {
    version: '1.1',
    uniqueKeys: false,
    logLevel: 'error',
    customTags: tags => [...tags.filter(tag => typeof tag === 'string' || !REPLACED_TAGS.has(tag.tag)), ...IMPLICIT_TAGS, ...EXPLICIT_TAGS],
  })
  const [error] = document.errors
  if (error !== undefined) throw error
  // 未知のタグ（`!!foo`・`!foo`）は、YAML ライブラリでは警告になる。Python ではエラー
  const unresolved = document.warnings.find(warning => warning.code === 'TAG_RESOLVE_FAILED')
  if (unresolved !== undefined) throw unresolved
  // `<<` は、キーの位置でだけ merge として読める。値や配列の要素にある引用符なしの `<<` は読めない
  visit(document, {
    Scalar(key, node) {
      if (key !== 'key' && node.tag === undefined && node.type === 'PLAIN' && node.source === '<<') {
        throw new Error('could not determine a constructor for the tag \'tag:yaml.org,2002:merge\'')
      }
    },
  })
  return toPlainValue(document.toJS({ mapAsMap: true }))
}
