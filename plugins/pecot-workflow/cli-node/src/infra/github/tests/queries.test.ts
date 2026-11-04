// queries.ts が cli/core/github/queries.py の文字列と一致すること、
// 偽サーバの operation 対応表と矛盾しないことを固定する。
/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは固定パスの queries.py */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { OPERATION_NAMES, operationNameOf } from '../../../../tests/fake-github/operations.js'
import * as queries from '../queries.js'

const PYTHON_QUERIES = new URL('../../../../../cli/core/github/queries.py', import.meta.url)

function readPythonQueries(): ReadonlyMap<string, string> {
  const source = readFileSync(PYTHON_QUERIES, 'utf8')
  const found = new Map<string, string>()
  for (const match of source.matchAll(/^([A-Z][\dA-Z_]*) = """(.*?)"""$/gmsu)) {
    found.set(match[1] ?? '', match[2] ?? '')
  }
  return found
}

function pascalCase(constantName: string): string {
  return constantName
    .replace(/^(?:QUERY|MUTATION)_/u, '')
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join('')
}

function byName(a: string, b: string): number {
  return a.localeCompare(b)
}

const exported = new Map(Object.entries(queries))

describe('queries.py との一致', () => {
  const python = readPythonQueries()

  it('Python の 29 個の定数をすべて写している', () => {
    expect(python.size).toBe(29)
    expect(Object.keys(queries).toSorted(byName)).toEqual(Object.keys(Object.fromEntries(python)).toSorted(byName))
  })

  it.each([...python])('%s は逐語で一致する', (name, text) => {
    expect(exported.get(name)).toBe(text)
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
