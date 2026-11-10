// GitHub の応答（REST の JSON と GraphQL の data）を読む補助。
// Python の dict.get と as_dict に当たる。形が合わないときは、辞書や配列を空として読む。
// 必須の値が無い、または型が違うときは GitHubAPIError にする（Python は KeyError で落ちる所）。

import { isJsonObject, jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import { isJsonArray } from '../../domain/python-format.js'
import type { JsonValue } from '../../domain/python-format.js'
import { GitHubAPIError } from './errors.js'

const EMPTY_OBJECT: JsonObject = {}
const EMPTY_ARRAY: readonly JsonValue[] = []

/**
as_dict と同じ。オブジェクトでなければ空のオブジェクト
*/
export function asObject(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : EMPTY_OBJECT
}

/**
配列でなければ空の配列
*/
export function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return isJsonArray(value) ? value : EMPTY_ARRAY
}

/**
Python の真偽値と同じ。None・False・0・空文字・空の配列・空の辞書は偽
*/
export function isTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return false
  if (isJsonArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/**
`value.get(key, [])` の `nodes` の読み方。真偽値が偽の要素（None・空の辞書）を落とした配列
*/
export function truthyNodes(value: JsonValue | undefined): readonly JsonValue[] {
  return asArray(jsonField(value, 'nodes')).filter(node => isTruthy(node))
}

export function throwMalformed(path: string): never {
  throw new GitHubAPIError(`malformed GitHub response: ${path}`)
}

/**
必須の文字列。無い、または文字列でなければ GitHubAPIError
*/
export function requireString(value: JsonValue | undefined, path: string): string {
  return typeof value === 'string' ? value : throwMalformed(path)
}

/**
必須の数。無い、または数でなければ GitHubAPIError
*/
export function requireNumber(value: JsonValue | undefined, path: string): number {
  return typeof value === 'number' ? value : throwMalformed(path)
}

/**
文字列か null。無いときと文字列以外は null
*/
export function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : JSON_NULL
}

/**
数か null。無いときと数以外は null
*/
export function numberOrNull(value: JsonValue | undefined): number | null {
  return typeof value === 'number' ? value : JSON_NULL
}

/**
必須の値（null でもよい）。キーが無ければ GitHubAPIError
*/
export function requireValue(value: JsonValue | undefined, path: string): JsonValue {
  return value === undefined ? throwMalformed(path) : value
}
