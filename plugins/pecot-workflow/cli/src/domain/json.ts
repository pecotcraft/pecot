// JSON の値を読む補助。型の絞り込み、フィールドの読み取り、JSON 文字列の読み込みの置き場。
// 同じ補助を各所に書かないよう、domain と infra はここから import する。

import { InvalidValueError } from './errors.js'
import { isJsonArray } from './python-format.js'
import type { JsonValue } from './python-format.js'

export type JsonObject = Readonly<Record<string, JsonValue>>

/**
配列でも null でもないオブジェクトか
*/
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !isJsonArray(value)
}

/**
オブジェクトの自身のキーの値。オブジェクトでない、またはキーが無ければ undefined。
キーに prototype の名前が来ても、継承した値は返さない
*/
export function jsonField(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isJsonObject(value) ? new Map(Object.entries(value)).get(key) : undefined
}

/**
JSON 文字列を読む。構文が不正なら undefined
*/
export function tryParseJsonText(text: string): JsonValue | undefined {
  try {
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse の結果は定義上 JsonValue
    return JSON.parse(text) as JsonValue
  }
  catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
JSON 文字列を読む。不正なら InvalidValueError。
文言は JSON パーサーのもので、Python の JSONDecodeError の文とは違う
*/
export function parseJsonText(text: string): JsonValue {
  try {
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse の結果は定義上 JsonValue
    return JSON.parse(text) as JsonValue
  }
  catch (error: unknown) {
    if (error instanceof SyntaxError) throw new InvalidValueError(error.message, { cause: error })
    throw error
  }
}
