import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import type { IssueCoverage } from '../issue-surface.js'
import { checkIssueCoverage, diffIssueSurface, hasIssueSurfaceDifference, issueCoverageSchema, issueSurfaceSchema } from '../issue-surface.js'

const HANDLERS = ['labels', 'milestone']
const TOOLS = ['issue_check', 'issue_dependency_check']

function coverageOf(items: readonly unknown[]): IssueCoverage {
  return issueCoverageSchema.parse({ items })
}

describe('checkIssueCoverage', () => {
  const surface = ['graphql:A.a', 'graphql:A.b', 'graphql:A.c']

  it('スナップショットのすべての項目が一覧に存在し、組み合わせも正しい場合は、問題を返さない', async () => {
    await explains('対応状況の一覧（`issue-coverage.yaml`）を検証する `checkIssueCoverage` のテストです。スナップショットのすべての項目が一覧にあり、`supported` と `excluded` の組み合わせが正しい場合に、問題を 1 件も返さないことを確認します。')
    const coverage = stepSync('一覧を用意する', () => coverageOf([
      { id: 'graphql:A.a', status: 'supported', handler: 'labels' },
      { id: 'graphql:A.b', status: 'supported', tool: 'issue_dependency_check' },
      { id: 'graphql:A.c', status: 'excluded', reason: 'preview' },
    ]))
    stepSync('問題の一覧を比べる', () => {
      expect(checkIssueCoverage(surface, coverage, HANDLERS, TOOLS)).toEqual([])
    })
  })

  it('問題ごとに id を示し、id の順に返す', async () => {
    await explains('`checkIssueCoverage` が返す問題のテストです。一覧への未登録・`handler` と `tool` の指定の誤り・重複・スナップショットに存在しない項目を、それぞれ id を示した文にして、id の順に返すことを確認します。')
    const coverage = stepSync('誤りを含む一覧を用意する', () => coverageOf([
      { id: 'graphql:A.c', status: 'supported' },
      { id: 'graphql:A.c', status: 'excluded', reason: 'preview' },
      { id: 'graphql:Z.z', status: 'supported', handler: 'labels' },
      { id: 'graphql:A.b', status: 'supported', handler: 'labels', tool: 'issue_check' },
    ]))
    stepSync('問題の一覧を比べる', () => {
      expect(checkIssueCoverage(surface, coverage, HANDLERS, TOOLS)).toEqual([
        'graphql:A.a: not in issue-coverage.yaml',
        'graphql:A.b: supported needs exactly one of handler or tool',
        'graphql:A.c: listed more than once',
        'graphql:A.c: supported needs exactly one of handler or tool',
        'graphql:Z.z: not in github-issue-surface.json',
      ])
    })
  })

  it.for([
    { name: 'handler が ATTRIBUTE_HANDLERS に存在しない', entry: { handler: 'parent' }, expected: 'handler parent is not in ATTRIBUTE_HANDLERS' },
    { name: 'tool が TOOLS に存在しない', entry: { tool: 'issue_link' }, expected: 'tool issue_link is not an MCP tool of TOOLS' },
    { name: 'supported に reason がある', entry: { handler: 'labels', reason: 'x' }, expected: 'supported must not have a reason' },
    { name: 'excluded に handler がある', entry: { status: 'excluded', handler: 'labels', reason: 'x' }, expected: 'excluded must not have handler or tool' },
    { name: 'excluded に tool がある', entry: { status: 'excluded', tool: 'issue_check', reason: 'x' }, expected: 'excluded must not have handler or tool' },
  ])('$name 場合は、id を示した問題を返す', async ({ entry, expected }) => {
    await explains('`supported` と `excluded` の項目の指定を検証する `checkIssueCoverage` のテストです。存在しない `handler` や `tool`、`supported` の `reason`、`excluded` の `handler` や `tool` を指定した場合に、id を示した問題を 1 件返すことを確認します。')
    const coverage = stepSync('項目 1 件の一覧を用意する', () => coverageOf([{ id: 'graphql:A.a', status: 'supported', ...entry }]))
    stepSync('問題の一覧を比べる', () => {
      expect(checkIssueCoverage(['graphql:A.a'], coverage, HANDLERS, TOOLS)).toEqual([`graphql:A.a: ${expected}`])
    })
  })

  it.for([
    { name: 'reason が存在しない', entry: {} },
    { name: 'reason が空白だけ', entry: { reason: '  ' } },
  ])('excluded の $name 場合は、スキーマの検証で止めず、id を示した問題を返す', async ({ entry }) => {
    await explains('`excluded` の項目に `reason` がない場合の `checkIssueCoverage` のテストです。`reason` が存在しない場合も空白だけの場合も、スキーマの検証では拒否せず、`excluded needs a reason` の問題を id とともに返すことを確認します。')
    const coverage = stepSync('項目 1 件の一覧を用意する', () => coverageOf([{ id: 'graphql:A.a', status: 'excluded', ...entry }]))
    stepSync('問題の一覧を比べる', () => {
      expect(checkIssueCoverage(['graphql:A.a'], coverage, HANDLERS, TOOLS)).toEqual(['graphql:A.a: excluded needs a reason'])
    })
  })
})

describe('issueCoverageSchema', () => {
  it.for([
    { name: '未定義のキー', entry: { id: 'graphql:A.a', status: 'excluded', reason: 'x', note: 'x' } },
    { name: '未定義の status', entry: { id: 'graphql:A.a', status: 'partial' } },
    { name: 'id が存在しない項目', entry: { status: 'excluded', reason: 'x' } },
  ])('$name を含む項目は、スキーマの検証で拒否する', async ({ entry }) => {
    await explains('対応状況の一覧のスキーマ `issueCoverageSchema` のテストです。未定義のキーや `status`、`id` が存在しない項目を含む一覧を渡した場合に、検証に失敗することを確認します。')
    stepSync('検証の結果を比べる', () => {
      expect(issueCoverageSchema.safeParse({ items: [entry] }).success).toBe(false)
    })
  })
})

describe('issueSurfaceSchema', () => {
  const sources = { graphql: 'https://example.com/schema.graphql', rest: 'https://example.com/openapi.json', rest_api_version: '2022-11-28', fetched_at: '2026-11-25T01:02:03.000Z' }

  it('取得元と項目の一覧を持つ写しを、そのまま受け入れる', async () => {
    await explains('Issue の機能の写しのスキーマ `issueSurfaceSchema` のテストです。取得元の 4 つの項目と、項目の一覧を持つ写しを渡した場合に、同じ値を返すことを確認します。')
    stepSync('検証の結果を比べる', () => {
      expect(issueSurfaceSchema.parse({ sources, items: ['graphql:A.a'] })).toEqual({ sources, items: ['graphql:A.a'] })
    })
  })

  it.for([
    { name: '取得元が存在しない', surface: { items: [] } },
    { name: '取得元に未定義のキーがある', surface: { sources: { ...sources, note: 'x' }, items: [] } },
    { name: '項目が文字列でない', surface: { sources, items: [1] } },
  ])('$name 写しは、スキーマの検証で拒否する', async ({ surface }) => {
    await explains('Issue の機能の写しのスキーマ `issueSurfaceSchema` のテストです。取得元が存在しない写しと、取得元に未定義のキーがある写し、項目が文字列でない写しを拒否することを確認します。')
    stepSync('検証の結果を比べる', () => {
      expect(issueSurfaceSchema.safeParse(surface).success).toBe(false)
    })
  })
})

describe('diffIssueSurface', () => {
  it('現在あってスナップショットにない id を added に、スナップショットにあって現在にない id を removed に、コードポイントの順に返す', async () => {
    await explains('スナップショットと現在の項目の差を求める `diffIssueSurface` のテストです。現在だけにある id を `added`、スナップショットだけにある id を `removed` として、それぞれコードポイントの順に返すことを確認します。')
    const snapshot = ['graphql:B.b', 'graphql:A.a', 'graphql:a.x']
    const current = ['graphql:a.x', 'rest:POST /repos/{owner}/{repo}/issues#type', 'graphql:Z.z', 'graphql:C.c']
    stepSync('差を比べる', () => {
      expect(diffIssueSurface(snapshot, current)).toEqual({
        added: ['graphql:C.c', 'graphql:Z.z', 'rest:POST /repos/{owner}/{repo}/issues#type'],
        removed: ['graphql:A.a', 'graphql:B.b'],
      })
    })
  })

  it('同じ集合の場合は、並びが違っても、差を空にして返す', async () => {
    await explains('スナップショットと現在の項目の差を求める `diffIssueSurface` のテストです。同じ id を別の並びで渡した場合に、`added` と `removed` がどちらも空になることを確認します。')
    stepSync('差を比べる', () => {
      expect(diffIssueSurface(['graphql:B.b', 'graphql:A.a'], ['graphql:A.a', 'graphql:B.b'])).toEqual({ added: [], removed: [] })
    })
  })
})

describe('hasIssueSurfaceDifference', () => {
  it.for([
    { name: '増えた id だけ', diff: { added: ['graphql:A.a'], removed: [] }, expected: true },
    { name: '消えた id だけ', diff: { added: [], removed: ['graphql:A.a'] }, expected: true },
    { name: 'どちらも空', diff: { added: [], removed: [] }, expected: false },
  ])('$name なら $expected を返す', async ({ diff, expected }) => {
    await explains('差の有無を判定する `hasIssueSurfaceDifference` のテストです。`added` と `removed` のどちらかに id がある場合は `true`、どちらも空の場合は `false` を返すことを確認します。')
    stepSync('判定の結果を比べる', () => {
      expect(hasIssueSurfaceDifference(diff)).toBe(expected)
    })
  })
})
