// payload.ts のテスト。Python の dict.get・as_dict・真偽値の読み方と同じになることを確かめる。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'
import { stepSync } from '../../../../tests/_helpers/step.js'

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
  subIssuesTotal,
  throwMalformed,
  truthyNodes,
} from '../payload.js'

describe('asObject / asArray', () => {
  it('オブジェクトはそのまま、それ以外は空のオブジェクト（as_dict）', async () => {
    await explains('`asObject` のテストです。オブジェクトはそのまま返し、`null` や配列、文字列などオブジェクト以外は空のオブジェクトを返す（Python の `as_dict` と同じ）ことを確認します。')
    const object = { a: 1 }
    const results = stepSync('asObject を呼ぶ', () => ({ same: asObject(object), others: [JSON_NULL, undefined, [1], 'text', 5, true].map(value => asObject(value)) }))
    stepSync('返したオブジェクトを比べる', () => {
      expect(results.same).toBe(object)
      for (const other of results.others) expect(other).toEqual({})
    })
  })

  it('配列はそのまま、それ以外は空の配列', async () => {
    await explains('`asArray` のテストです。配列はそのまま返し、配列以外は空の配列を返すことを確認します。')
    const array = [1]
    const results = stepSync('asArray を呼ぶ', () => ({ same: asArray(array), others: [JSON_NULL, undefined, { a: 1 }, 'text', 5].map(value => asArray(value)) }))
    stepSync('返した配列を比べる', () => {
      expect(results.same).toBe(array)
      for (const other of results.others) expect(other).toEqual([])
    })
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
  ])('%j は %s（Python の bool と同じ）', async (value, expected) => {
    await explains('`isTruthy` のテストです。`undefined`・`null`・`0`・空文字・空の配列や辞書を偽、それ以外を真とする、Python の `bool` と同じ判定になることを確認します。')
    const isTruthyValue = stepSync('isTruthy を呼ぶ', () => isTruthy(value))
    stepSync('判定を比べる', () => {
      expect(isTruthyValue).toBe(expected)
    })
  })
})

describe('truthyNodes', () => {
  it('nodes のうち真偽値が偽の要素（None・空の辞書）を落とす', async () => {
    await explains('`truthyNodes` のテストです。`nodes` のうち、真偽値が偽になる要素（`null` や空の辞書など）を除いて返すことを確認します。')
    const nodes = stepSync('truthyNodes を呼ぶ', () => truthyNodes({ nodes: [{ a: 1 }, JSON_NULL, {}, 0, 'x'] }))
    stepSync('残った要素を比べる', () => {
      expect(nodes).toEqual([{ a: 1 }, 'x'])
    })
  })

  it('nodes が存在しない、配列でない、または親がオブジェクトでない場合は、空の配列を返す', async () => {
    await explains('`truthyNodes` のテストです。`nodes` が存在しない場合、配列でない場合、親がオブジェクトでない場合に、空の配列を返すことを確認します。')
    const results = stepSync('truthyNodes を呼ぶ', () => [{}, { nodes: 'x' }, JSON_NULL, undefined, [1]].map(value => truthyNodes(value)))
    stepSync('空の配列を比べる', () => {
      for (const nodes of results) expect(nodes).toEqual([])
    })
  })
})

describe('必須の値', () => {
  it('requireString・requireNumber は型が合えば返す', async () => {
    await explains('必須の値を読み取る関数のテストです。`requireString` と `requireNumber` が、型が合う値（空文字や 0 を含む）をそのまま返すことを確認します。')
    const results = stepSync('requireString と requireNumber を呼ぶ', () => ({ text: requireString('', 'p'), count: requireNumber(0, 'p') }))
    stepSync('返した値を比べる', () => {
      expect(results.text).toBe('')
      expect(results.count).toBe(0)
    })
  })

  it.each<[string, (value: JsonValue | undefined) => unknown, JsonValue | undefined]>([
    ['requireString（数）', value => requireString(value, 'a.b'), 1],
    ['requireString（無い）', value => requireString(value, 'a.b'), undefined],
    ['requireNumber（文字列）', value => requireNumber(value, 'a.b'), '1'],
    ['requireValue（無い）', value => requireValue(value, 'a.b'), undefined],
  ])('%s の場合は、場所を示すメッセージの GitHubAPIError が発生する', async (_label, call, value) => {
    await explains('必須の値を読み取る関数のテストです。型が合わない値や存在しない値を渡した場合に、場所を示すメッセージの `GitHubAPIError` が発生することを確認します。')
    stepSync('エラーのメッセージを確かめる', () => {
      expect(() => call(value)).toThrow(new GitHubAPIError('malformed GitHub response: a.b'))
    })
  })

  it('requireValue は null も返す', async () => {
    await explains('`requireValue` のテストです。`null` を値として受け入れ、そのまま返すことを確認します。')
    const value = stepSync('requireValue を呼ぶ', () => requireValue(JSON_NULL, 'p'))
    stepSync('返した値を比べる', () => {
      expect(value).toBe(JSON_NULL)
    })
  })

  it('throwMalformed を呼ぶと、GitHubAPIError が発生する', async () => {
    await explains('`throwMalformed` のテストです。呼び出すと `GitHubAPIError` が発生することを確認します。')
    stepSync('エラーの種類を確かめる', () => {
      expect(() => throwMalformed('x')).toThrow(GitHubAPIError)
    })
  })
})

describe('stringOrNull / numberOrNull', () => {
  it('型が合えばそのまま、合わなければ null', async () => {
    await explains('`stringOrNull` と `numberOrNull` のテストです。型が合う値はそのまま返し、合わない値は `null` を返すことを確認します。')
    const results = stepSync('stringOrNull と numberOrNull を呼ぶ', () => [stringOrNull(''), stringOrNull(1), stringOrNull(undefined), numberOrNull(0), numberOrNull('1'), numberOrNull(undefined)])
    stepSync('返した値を比べる', () => {
      expect(results).toEqual(['', JSON_NULL, JSON_NULL, 0, JSON_NULL, JSON_NULL])
    })
  })
})

describe('subIssuesTotal', () => {
  it.each<[JsonValue, number]>([
    [{ subIssues: { totalCount: 3 } }, 3],
    [{ subIssues: { totalCount: 'x' } }, 0],
    [{ subIssues: JSON_NULL }, 0],
    [{}, 0],
  ])('Issue が %j の場合は、子 Issue の件数は %d になる', async (issue, expected) => {
    await explains('`subIssuesTotal` のテストです。`subIssues.totalCount` が数値の場合はその値を返し、数値でない場合や存在しない場合は 0 を返すことを確認します。')
    const total = stepSync('subIssuesTotal を呼ぶ', () => subIssuesTotal(issue))
    stepSync('件数を比べる', () => {
      expect(total).toBe(expected)
    })
  })
})
