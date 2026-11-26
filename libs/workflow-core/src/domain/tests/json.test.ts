import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { InvalidValueError } from '../errors.js'
import { JSON_NULL } from '../json-null.js'
import { isJsonObject, jsonField, parseJsonText, tryParseJsonText } from '../json.js'

describe('isJsonObject', () => {
  it('配列・null・文字列などを渡すと false、プレーンなオブジェクトを渡すと true を返す', async () => {
    await explains('値が JSON のオブジェクトかどうかを判定する、`isJsonObject` のテストです。プレーンなオブジェクトの場合は `true`、配列・`null`・文字列・数値・真偽値などの場合は `false` を返すことを確認します。')
    expect(isJsonObject({ a: 1 })).toBe(true)
    expect(isJsonObject({})).toBe(true)
    for (const value of [JSON_NULL, undefined, [1], 'text', 5, true]) expect(isJsonObject(value)).toBe(false)
  })
})

describe('jsonField', () => {
  it('自身のキーの値を返し、キーが存在しない場合やオブジェクトでない場合は undefined を返す', async () => {
    await explains('JSON のオブジェクトからキーの値を取り出す、`jsonField` のテストです。存在するキーは値（`null` を含む）を返し、存在しないキーや、オブジェクトでない値を渡した場合は `undefined` を返すことを確認します。')
    expect(jsonField({ a: 1, b: JSON_NULL }, 'a')).toBe(1)
    expect(jsonField({ a: 1, b: JSON_NULL }, 'b')).toBe(JSON_NULL)
    expect(jsonField({ a: 1 }, 'missing')).toBeUndefined()
    for (const value of [JSON_NULL, undefined, [1], 'text']) expect(jsonField(value, 'a')).toBeUndefined()
  })

  it('継承されたキー（toString など）は読まない', async () => {
    await explains('JSON のオブジェクトからキーの値を取り出す、`jsonField` のテストです。`toString` や `__proto__` のような継承されたキーを指定した場合に、`undefined` を返すことを確認します。')
    expect(jsonField({}, 'toString')).toBeUndefined()
    expect(jsonField({}, '__proto__')).toBeUndefined()
  })
})

describe('parseJsonText / tryParseJsonText', () => {
  it('JSON 文字列を渡すと、パースした値を返す', async () => {
    await explains('JSON 文字列をパースする、`parseJsonText` と `tryParseJsonText` のテストです。正しい JSON 文字列を渡した場合に、どちらも JSON の `null` を `JSON_NULL` に変換した値を返すことを確認します。')
    expect(parseJsonText('{"a": [1, null]}')).toEqual({ a: [1, JSON_NULL] })
    expect(tryParseJsonText('[1]')).toEqual([1])
  })

  it('構文が不正な場合は、parseJsonText が InvalidValueError を投げ、tryParseJsonText が undefined を返す', async () => {
    await explains('JSON 文字列をパースする、`parseJsonText` と `tryParseJsonText` のテストです。構文が不正な文字列を渡した場合に、前者は `InvalidValueError` の例外が発生し、後者は `undefined` を返すことを確認します。')
    expect(() => parseJsonText('not json')).toThrow(InvalidValueError)
    expect(tryParseJsonText('not json')).toBeUndefined()
  })
})
