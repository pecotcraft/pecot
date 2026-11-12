// payload.ts のテスト。Python の dict.get・as_dict・真偽値の読み方と同じになることを確かめる。
import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
import type { JsonValue } from '../../../domain/python-format.js'
import { GitHubAPIError } from '../errors.js'
import {
  asArray,
  asObject,
  isTruthy,
  numberOrNull,
  requireNumber,
  requireString,
  requireValue,
  stringOrNull,
  throwMalformed,
  truthyNodes,
} from '../payload.js'

describe('asObject / asArray', () => {
  it('オブジェクトはそのまま、それ以外は空のオブジェクト（as_dict）', () => {
    const object = { a: 1 }
    expect(asObject(object)).toBe(object)
    for (const value of [JSON_NULL, undefined, [1], 'text', 5, true]) expect(asObject(value)).toEqual({})
  })

  it('配列はそのまま、それ以外は空の配列', () => {
    const array = [1]
    expect(asArray(array)).toBe(array)
    for (const value of [JSON_NULL, undefined, { a: 1 }, 'text', 5]) expect(asArray(value)).toEqual([])
  })
})

describe('isTruthy', () => {
  it.each<[JsonValue | undefined, boolean]>([
    [undefined, false],
    [JSON_NULL, false],
    [false, false],
    [0, false],
    ['', false],
    [[], false],
    [{}, false],
    [true, true],
    [1, true],
    [-1, true],
    ['0', true],
    [[0], true],
    [{ a: JSON_NULL }, true],
  ])('%j は %s（Python の bool と同じ）', (value, expected) => {
    expect(isTruthy(value)).toBe(expected)
  })
})

describe('truthyNodes', () => {
  it('nodes のうち真偽値が偽の要素（None・空の辞書）を落とす', () => {
    expect(truthyNodes({ nodes: [{ a: 1 }, JSON_NULL, {}, 0, 'x'] })).toEqual([{ a: 1 }, 'x'])
  })

  it('nodes が無い、配列でない、親がオブジェクトでなければ空', () => {
    for (const value of [{}, { nodes: 'x' }, JSON_NULL, undefined, [1]]) expect(truthyNodes(value)).toEqual([])
  })
})

describe('必須の値', () => {
  it('requireString・requireNumber は型が合えば返す', () => {
    expect(requireString('', 'p')).toBe('')
    expect(requireNumber(0, 'p')).toBe(0)
  })

  it.each<[string, (value: JsonValue | undefined) => unknown, JsonValue | undefined]>([
    ['requireString（数）', value => requireString(value, 'a.b'), 1],
    ['requireString（無い）', value => requireString(value, 'a.b'), undefined],
    ['requireNumber（文字列）', value => requireNumber(value, 'a.b'), '1'],
    ['requireValue（無い）', value => requireValue(value, 'a.b'), undefined],
  ])('%s は、場所を示す GitHubAPIError', (_label, call, value) => {
    expect(() => call(value)).toThrow(new GitHubAPIError('malformed GitHub response: a.b'))
  })

  it('requireValue は null も返す', () => {
    expect(requireValue(JSON_NULL, 'p')).toBe(JSON_NULL)
  })

  it('throwMalformed は GitHubAPIError', () => {
    expect(() => throwMalformed('x')).toThrow(GitHubAPIError)
  })
})

describe('stringOrNull / numberOrNull', () => {
  it('型が合えばそのまま、合わなければ null', () => {
    expect(stringOrNull('')).toBe('')
    expect(stringOrNull(1)).toBe(JSON_NULL)
    expect(stringOrNull(undefined)).toBe(JSON_NULL)
    expect(numberOrNull(0)).toBe(0)
    expect(numberOrNull('1')).toBe(JSON_NULL)
    expect(numberOrNull(undefined)).toBe(JSON_NULL)
  })
})
