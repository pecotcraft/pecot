// queries.ts の先頭の 30 個が、Python の queries.py を記録した queries.json と逐語で一致することを固定する。
// 偽サーバの operation 対応表と矛盾しないことも固定する。
import { parse, print } from 'graphql'
import { describe, expect, it } from 'vitest'

import { OPERATION_NAMES, operationNameOf } from '../../../../tests/_helpers/fake-github/operations.js'
import { queriesOutput } from '../../../../tests/_helpers/python-output.js'
import * as queries from '../queries.js'
import { explains } from '../../../../tests/_helpers/explains.js'

function pascalCase(constantName: string): string {
  return constantName
    .replace(/^(?:QUERY|MUTATION)_/u, '')
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join('')
}

const exported = new Map(Object.entries(queries))

describe('export', () => {
  it('export する GraphQL の文の定数は 59 個になる', async () => {
    await explains('`queries.ts` が export する GraphQL の文の定数の数のテストです。定数を追加した場合は、operation の対応表とこの個数を同時に更新する必要があるため、59 個になることを確認します。')
    expect(exported.size).toBe(59)
  })
})

describe('queries.json との一致', () => {
  const recorded = queriesOutput()

  it('Python から記録した 31 個の定数が、すべて export されている', async () => {
    await explains('Python 版の `queries.py` を記録した `queries.json` のテストです。記録した 31 個の定数が、`queries.ts` からすべて export されていることを確認します。')
    expect(Object.keys(recorded)).toHaveLength(31)
    expect(Object.keys(recorded).filter(name => !exported.has(name))).toEqual([])
  })

  it.each(Object.entries(recorded))('%s の GraphQL の文が、記録した文と一致する', async (name, text) => {
    await explains(`記録した定数 ${name} のテストです。\`queries.ts\` の同名の定数が、\`queries.json\` に記録した文と一致することを確認します。`)
    expect(exported.get(name)).toBe(text)
  })

  it.each([...exported])('%s の文は、パースして整形し直しても変化しない', async (_name, text) => {
    await explains(`定数 ${_name} の GraphQL の文のテストです。\`graphql\` でパースして整形し直した結果が、元の文と一致することを確認します。`)
    expect(print(parse(text))).toBe(text)
  })
})

function namesOf(text: string, pattern: Readonly<RegExp>): ReadonlySet<string> {
  return new Set(Array.from(text.matchAll(pattern), match => match[1] ?? ''))
}

describe('fragment', () => {
  it.each([...exported].filter(([, text]) => text.includes('fragment ')))('%s は、参照する fragment をすべて定義し、使わない定義を持たない', async (_name, text) => {
    await explains(`fragment を含む定数 ${_name} のテストです。文の中で参照している fragment がすべて定義されており、未使用の fragment 定義が存在しないことを確認します。`)
    expect(namesOf(text, /\.\.\.(?!\s*on\b)(\w+)/gu)).toEqual(namesOf(text, /^fragment (\w+) on /gmu))
  })
})

describe('偽サーバの operation 対応表', () => {
  it.each([...exported])('%s の operation 名が、偽サーバの対応表に存在する', async (name, query) => {
    await explains(`定数 ${name} と、偽サーバの operation 対応表のテストです。文から取り出した operation 名が表に存在し、定数名を PascalCase にした名前と一致することを確認します。`)
    const operation = operationNameOf(query)
    expect(operation).toBeDefined()
    expect(OPERATION_NAMES.has(operation ?? '')).toBe(true)
    // 名前を持つ operation（CreateLinkedBranch）は query に書かれた名前で、他は定数名を PascalCase にした名前
    expect(operation).toBe(pascalCase(name))
  })

  it('すべての定数が、互いに異なる operation 名を持つ', async () => {
    await explains('operation 名の重複のテストです。すべての定数の operation 名に重複がなく、定数の数と同じ個数になることを確認します。')
    const operations = new Set(Array.from(exported.values(), query => operationNameOf(query)))
    expect(operations.size).toBe(exported.size)
  })
})
