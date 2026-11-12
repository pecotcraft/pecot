import { describe, expect, it } from 'vitest'

import { InvalidValueError } from '../errors.js'
import { JSON_NULL } from '../json-null.js'
import { isJsonObject, jsonField, parseJsonText, tryParseJsonText } from '../json.js'

describe('isJsonObject', () => {
  it('配列・null・文字列などを渡すと false、プレーンなオブジェクトを渡すと true を返す', () => {
    expect(isJsonObject({ a: 1 })).toBe(true)
    expect(isJsonObject({})).toBe(true)
    for (const value of [JSON_NULL, undefined, [1], 'text', 5, true]) expect(isJsonObject(value)).toBe(false)
  })
})

describe('jsonField', () => {
  it('自身のキーの値を返す。無い、またはオブジェクトでなければ undefined', () => {
    expect(jsonField({ a: 1, b: JSON_NULL }, 'a')).toBe(1)
    expect(jsonField({ a: 1, b: JSON_NULL }, 'b')).toBe(JSON_NULL)
    expect(jsonField({ a: 1 }, 'missing')).toBeUndefined()
    for (const value of [JSON_NULL, undefined, [1], 'text']) expect(jsonField(value, 'a')).toBeUndefined()
  })

  it('継承されたキー（toString など）は読まない', () => {
    expect(jsonField({}, 'toString')).toBeUndefined()
    expect(jsonField({}, '__proto__')).toBeUndefined()
  })
})

describe('parseJsonText / tryParseJsonText', () => {
  it('JSON 文字列を渡すと、パースした値を返す', () => {
    expect(parseJsonText('{"a": [1, null]}')).toEqual({ a: [1, JSON_NULL] })
    expect(tryParseJsonText('[1]')).toEqual([1])
  })

  it('構文が不正なら parseJsonText は InvalidValueError、tryParseJsonText は undefined', () => {
    expect(() => parseJsonText('not json')).toThrow(InvalidValueError)
    expect(tryParseJsonText('not json')).toBeUndefined()
  })
})
