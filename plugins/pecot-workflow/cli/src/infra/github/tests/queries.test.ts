// queries.ts の先頭の 30 個が、Python の queries.py を記録した queries.json と逐語で一致することを固定する。
// 偽サーバの operation 対応表と矛盾しないことも固定する。
import { parse, print } from 'graphql'
import { describe, expect, it } from 'vitest'

import { OPERATION_NAMES, operationNameOf } from '../../../../tests/fake-github/operations.js'
import { queriesOutput } from '../../../tests/_helpers/python-output.js'
import * as queries from '../queries.js'

function pascalCase(constantName: string): string {
  return constantName
    .replace(/^(?:QUERY|MUTATION)_/u, '')
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join('')
}

const exported = new Map(Object.entries(queries))

describe('queries.json との一致', () => {
  const recorded = queriesOutput()

  it('記録の 30 個の定数がすべて export にある', () => {
    expect(Object.keys(recorded)).toHaveLength(30)
    expect(Object.keys(recorded).filter(name => !exported.has(name))).toEqual([])
  })

  it.each(Object.entries(recorded))('%s は記録した文と一致する', (name, text) => {
    expect(exported.get(name)).toBe(text)
  })

  it.each([...exported])('%s は print(parse(text)) で変わらない', (_name, text) => {
    expect(print(parse(text))).toBe(text)
  })
})

describe('偽サーバの operation 対応表', () => {
  it.each([...exported])('%s は表の operation 名に引ける', (name, query) => {
    const operation = operationNameOf(query)
    expect(operation).toBeDefined()
    expect(OPERATION_NAMES.has(operation ?? '')).toBe(true)
    // 名前を持つ operation（CreateLinkedBranch）は query に書かれた名前で、他は定数名を PascalCase にした名前
    expect(operation).toBe(pascalCase(name))
  })

  it('全定数が別々の operation になる', () => {
    const operations = new Set(Array.from(exported.values(), query => operationNameOf(query)))
    expect(operations.size).toBe(exported.size)
  })
})
