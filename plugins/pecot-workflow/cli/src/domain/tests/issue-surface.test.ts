import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'
import type { IssueCoverage } from '../issue-surface.js'
import {
  checkIssueCoverage,
  diffIssueSurface,
  extractIssueSurface,
  hasIssueSurfaceDifference,
  issueCoverageSchema,
} from '../issue-surface.js'

// 公開スキーマの SDL の抜粋。範囲の外の型・項目・mutation も混ぜる
const SDL = `
directive @possibleTypes(concreteTypes: [String!]!, abstractType: String) on INPUT_FIELD_DEFINITION | ARGUMENT_DEFINITION

type Issue { id: ID! }

input CreateIssueInput {
  title: String!
  repositoryId: ID! @possibleTypes(concreteTypes: ["Repository"])
  parentIssueId: ID @possibleTypes(concreteTypes: ["Issue"])
  body: String
}

input UpdateIssueInput {
  id: ID! @possibleTypes(concreteTypes: ["Issue"])
  title: String
}

input ProjectV2FieldValue {
  text: String
  date: Date
}

input AddLabelsToLabelableInput {
  labelableId: ID! @possibleTypes(concreteTypes: ["Discussion", "Issue", "PullRequest"], abstractType: "Labelable")
  labelIds: [ID!]!
}

input CreateIssueTypeInput {
  ownerId: ID! @possibleTypes(concreteTypes: ["Organization"])
  name: String!
}

input AddBlockedByInput {
  issueId: ID! @possibleTypes(concreteTypes: ["Issue"])
  blockingIssueId: ID! @possibleTypes(concreteTypes: ["Issue"])
}

input UpdatePullRequestInput {
  pullRequestId: ID! @possibleTypes(concreteTypes: ["PullRequest"])
}

enum ProjectV2FieldType { TEXT ITERATION }
enum ProjectV2CustomFieldType { TEXT }
enum IssueFieldDataType { NUMBER DATE }
enum IssueState { OPEN CLOSED }

type Mutation {
  updateIssue(input: UpdateIssueInput!): Issue
  addLabelsToLabelable(input: AddLabelsToLabelableInput!): Issue
  createIssueType(input: CreateIssueTypeInput!): Issue
  createIssue(input: CreateIssueInput!): Issue
  addBlockedBy(input: AddBlockedByInput!): Issue
  updatePullRequest(input: UpdatePullRequestInput!): Issue
  noInput: Issue
  unknownInput(input: MissingInput!): Issue
}
`

const EMPTY_SDL = 'type Query { ok: Boolean }'

const CREATE_PATH = '/repos/{owner}/{repo}/issues'

function openapiOf(requestBody: JsonValue, components: JsonValue = {}): JsonValue {
  return {
    paths: {
      [CREATE_PATH]: { get: {}, post: { requestBody } },
      '/repos/{owner}/{repo}/pulls': { post: { requestBody: { content: { 'application/json': { schema: { properties: { head: {} } } } } } } },
    },
    components,
  }
}

const INLINE_BODY: JsonValue = { content: { 'application/json': { schema: { type: 'object', properties: { title: {}, labels: {}, assignee: {} } } } } }

const SDL_ITEMS = [
  'graphql:CreateIssueInput.body',
  'graphql:CreateIssueInput.parentIssueId',
  'graphql:CreateIssueInput.repositoryId',
  'graphql:CreateIssueInput.title',
  'graphql:ProjectV2FieldValue.date',
  'graphql:ProjectV2FieldValue.text',
  'graphql:UpdateIssueInput.id',
  'graphql:UpdateIssueInput.title',
  'graphql:enum:IssueFieldDataType.DATE',
  'graphql:enum:IssueFieldDataType.NUMBER',
  'graphql:enum:ProjectV2CustomFieldType.TEXT',
  'graphql:enum:ProjectV2FieldType.ITERATION',
  'graphql:enum:ProjectV2FieldType.TEXT',
  'graphql:mutation:addBlockedBy',
  'graphql:mutation:createIssue',
  'graphql:mutation:updateIssue',
]

const REST_ITEMS = [
  'rest:POST /repos/{owner}/{repo}/issues#assignee',
  'rest:POST /repos/{owner}/{repo}/issues#labels',
  'rest:POST /repos/{owner}/{repo}/issues#title',
]

describe('extractIssueSurface', () => {
  it('対象の型の項目と値、Issue を対象にする mutation、REST の起票の本文の項目を、コードポイントの順に返す', async () => {
    await explains('GitHub の SDL と OpenAPI から Issue に関する項目を取り出す `extractIssueSurface` のテストです。対象の型の項目と enum の値、`mutation`、REST の項目を、`graphql:` と `rest:` の ID にして、コードポイント順に返すことを確認します。')
    expect(extractIssueSurface(SDL, openapiOf(INLINE_BODY))).toEqual([...SDL_ITEMS, ...REST_ITEMS])
  })

  it('ID の項目が Issue だけを受ける mutation を取り出し、Issue 以外の型も受ける mutation と、Organization を対象にする mutation は取り出さない', async () => {
    await explains('`extractIssueSurface` が取り出す `mutation` のテストです。`addBlockedBy`・`createIssue`・`updateIssue` を取り出し、`addLabelsToLabelable` などは取り出さないことを確認します。')
    const mutations = extractIssueSurface(SDL, openapiOf(INLINE_BODY)).filter(id => id.startsWith('graphql:mutation:'))
    expect(mutations).toEqual(['graphql:mutation:addBlockedBy', 'graphql:mutation:createIssue', 'graphql:mutation:updateIssue'])
  })

  it('対象の外の型と、ほかの REST の path の項目を出力しない', async () => {
    await explains('`extractIssueSurface` の対象外のテストです。`IssueState` などの対象外の型と、`/pulls` などほかの REST の path の項目が、結果に含まれないことを確認します。')
    const items = extractIssueSurface(SDL, openapiOf(INLINE_BODY))
    expect(items.filter(id => /IssueState|AddLabelsToLabelableInput|CreateIssueTypeInput|#head$/u.test(id))).toEqual([])
  })

  it('requestBody と schema が $ref のとき、components をたどって本文の項目を読む', async () => {
    await explains('OpenAPI の `requestBody` と `schema` が `$ref` の場合の `extractIssueSurface` のテストです。`components` をたどって、`body` と `type` を REST の起票の本文の項目として取り出すことを確認します。')
    const components: JsonValue = {
      requestBodies: { create: { content: { 'application/json': { schema: { $ref: '#/components/schemas/issue-create' } } } } },
      schemas: { 'issue-create': { properties: { body: {}, type: {} } } },
    }
    const items = extractIssueSurface(EMPTY_SDL, openapiOf({ $ref: '#/components/requestBodies/create' }, components))
    expect(items).toEqual(['rest:POST /repos/{owner}/{repo}/issues#body', 'rest:POST /repos/{owner}/{repo}/issues#type'])
  })

  it('対象の型と Mutation が SDL に存在しない場合は、エラーにせず、その型の項目を出力しない', async () => {
    await explains('対象の型と `Mutation` を含まない SDL を渡した場合の `extractIssueSurface` のテストです。例外を発生させず、REST の項目だけを返すことを確認します。')
    expect(extractIssueSurface(EMPTY_SDL, openapiOf(INLINE_BODY))).toEqual(REST_ITEMS)
  })

  it.for([
    { name: 'path が存在しない', openapi: { paths: {} } },
    { name: 'paths が存在しない', openapi: {} },
    { name: 'post が存在しない', openapi: { paths: { [CREATE_PATH]: { get: {} } } } },
    { name: 'JSON の本文が存在しない', openapi: openapiOf({ content: { 'text/plain': {} } }) },
    { name: 'properties が存在しない', openapi: openapiOf({ content: { 'application/json': { schema: { type: 'string' } } } }) },
    { name: '$ref の先が存在しない', openapi: openapiOf({ $ref: '#/components/requestBodies/missing' }) },
    { name: '$ref が文書の外を指す', openapi: openapiOf({ $ref: 'other.json#/components/requestBodies/create' }) },
  ] satisfies { name: string, openapi: JsonValue }[])('OpenAPI の $name 場合は、REST の項目を出力しない', async ({ openapi }) => {
    await explains('OpenAPI が起票の定義を持たない場合の `extractIssueSurface` のテストです。path・`post`・JSON の本文・`properties` が存在しない場合と、`$ref` の参照先が存在しない場合や文書の外を指す場合のどれでも、REST の項目を出力しないことを確認します。')
    expect(extractIssueSurface(EMPTY_SDL, openapi)).toEqual([])
  })

  it('$ref の JSON Pointer の ~1 と ~0 を、/ と ~ に戻してたどる', async () => {
    await explains('`$ref` の JSON Pointer を解決する `extractIssueSurface` のテストです。`~1` を `/`、`~0` を `~` に戻して `components` をたどり、`milestone` を REST の項目として取り出すことを確認します。')
    const components: JsonValue = { schemas: { 'a/b~c': { properties: { milestone: {} } } } }
    const body: JsonValue = { content: { 'application/json': { schema: { $ref: '#/components/schemas/a~1b~0c' } } } }
    expect(extractIssueSurface(EMPTY_SDL, openapiOf(body, components))).toEqual(['rest:POST /repos/{owner}/{repo}/issues#milestone'])
  })

  it('SDL の構文が誤っている場合は、graphql の parse の例外を送出する', async () => {
    await explains('構文が誤っている SDL を渡した場合の `extractIssueSurface` のテストです。graphql の `parse` が投げる `Syntax Error` の例外が、そのまま発生することを確認します。')
    expect(() => extractIssueSurface('input {', {})).toThrow(/Syntax Error/u)
  })
})

const HANDLERS = ['labels', 'milestone']
const TOOLS = ['issue_create', 'issue_block']

function coverageOf(items: readonly unknown[]): IssueCoverage {
  return issueCoverageSchema.parse({ items })
}

describe('checkIssueCoverage', () => {
  const surface = ['graphql:A.a', 'graphql:A.b', 'graphql:A.c']

  it('スナップショットのすべての項目が一覧に存在し、組み合わせも正しい場合は、問題を返さない', async () => {
    await explains('対応状況の一覧（`issue-coverage.yaml`）を検証する `checkIssueCoverage` のテストです。スナップショットのすべての項目が一覧にあり、`supported` と `excluded` の組み合わせが正しい場合に、問題を 1 件も返さないことを確認します。')
    const coverage = coverageOf([
      { id: 'graphql:A.a', status: 'supported', handler: 'labels' },
      { id: 'graphql:A.b', status: 'supported', tool: 'issue_block' },
      { id: 'graphql:A.c', status: 'excluded', reason: 'preview' },
    ])
    expect(checkIssueCoverage(surface, coverage, HANDLERS, TOOLS)).toEqual([])
  })

  it('問題ごとに id を示し、id の順に返す', async () => {
    await explains('`checkIssueCoverage` が返す問題のテストです。一覧への未登録・`handler` と `tool` の指定の誤り・重複・スナップショットに存在しない項目を、それぞれ id を示した文にして、id の順に返すことを確認します。')
    const coverage = coverageOf([
      { id: 'graphql:A.c', status: 'supported' },
      { id: 'graphql:A.c', status: 'excluded', reason: 'preview' },
      { id: 'graphql:Z.z', status: 'supported', handler: 'labels' },
      { id: 'graphql:A.b', status: 'supported', handler: 'labels', tool: 'issue_create' },
    ])
    expect(checkIssueCoverage(surface, coverage, HANDLERS, TOOLS)).toEqual([
      'graphql:A.a: not in issue-coverage.yaml',
      'graphql:A.b: supported needs exactly one of handler or tool',
      'graphql:A.c: listed more than once',
      'graphql:A.c: supported needs exactly one of handler or tool',
      'graphql:Z.z: not in github-issue-surface.json',
    ])
  })

  it.for([
    { name: 'handler が ATTRIBUTE_HANDLERS に存在しない', entry: { handler: 'parent' }, expected: 'handler parent is not in ATTRIBUTE_HANDLERS' },
    { name: 'tool が TOOLS に存在しない', entry: { tool: 'issue_link' }, expected: 'tool issue_link is not an MCP tool of TOOLS' },
    { name: 'supported に reason がある', entry: { handler: 'labels', reason: 'x' }, expected: 'supported must not have a reason' },
    { name: 'excluded に handler がある', entry: { status: 'excluded', handler: 'labels', reason: 'x' }, expected: 'excluded must not have handler or tool' },
    { name: 'excluded に tool がある', entry: { status: 'excluded', tool: 'issue_create', reason: 'x' }, expected: 'excluded must not have handler or tool' },
  ])('$name 場合は、id を示した問題を返す', async ({ entry, expected }) => {
    await explains('`supported` と `excluded` の項目の指定を検証する `checkIssueCoverage` のテストです。存在しない `handler` や `tool`、`supported` の `reason`、`excluded` の `handler` や `tool` を指定した場合に、id を示した問題を 1 件返すことを確認します。')
    const coverage = coverageOf([{ id: 'graphql:A.a', status: 'supported', ...entry }])
    expect(checkIssueCoverage(['graphql:A.a'], coverage, HANDLERS, TOOLS)).toEqual([`graphql:A.a: ${expected}`])
  })

  it.for([
    { name: 'reason が存在しない', entry: {} },
    { name: 'reason が空白だけ', entry: { reason: '  ' } },
  ])('excluded の $name 場合は、スキーマの検証で止めず、id を示した問題を返す', async ({ entry }) => {
    await explains('`excluded` の項目に `reason` がない場合の `checkIssueCoverage` のテストです。`reason` が存在しない場合も空白だけの場合も、スキーマの検証では拒否せず、`excluded needs a reason` の問題を id とともに返すことを確認します。')
    const coverage = coverageOf([{ id: 'graphql:A.a', status: 'excluded', ...entry }])
    expect(checkIssueCoverage(['graphql:A.a'], coverage, HANDLERS, TOOLS)).toEqual(['graphql:A.a: excluded needs a reason'])
  })
})

describe('issueCoverageSchema', () => {
  it.for([
    { name: '未定義のキー', entry: { id: 'graphql:A.a', status: 'excluded', reason: 'x', note: 'x' } },
    { name: '未定義の status', entry: { id: 'graphql:A.a', status: 'partial' } },
    { name: 'id が存在しない項目', entry: { status: 'excluded', reason: 'x' } },
  ])('$name を含む項目は、スキーマの検証で拒否する', async ({ entry }) => {
    await explains('対応状況の一覧のスキーマ `issueCoverageSchema` のテストです。未定義のキーや `status`、`id` が存在しない項目を含む一覧を渡した場合に、検証に失敗することを確認します。')
    expect(issueCoverageSchema.safeParse({ items: [entry] }).success).toBe(false)
  })
})

describe('diffIssueSurface', () => {
  it('現在あってスナップショットにない id を added に、スナップショットにあって現在にない id を removed に、コードポイントの順に返す', async () => {
    await explains('スナップショットと現在の項目の差を求める `diffIssueSurface` のテストです。現在だけにある id を `added`、スナップショットだけにある id を `removed` として、それぞれコードポイントの順に返すことを確認します。')
    const snapshot = ['graphql:B.b', 'graphql:A.a', 'graphql:a.x']
    const current = ['graphql:a.x', 'rest:POST /repos/{owner}/{repo}/issues#type', 'graphql:Z.z', 'graphql:C.c']
    expect(diffIssueSurface(snapshot, current)).toEqual({
      added: ['graphql:C.c', 'graphql:Z.z', 'rest:POST /repos/{owner}/{repo}/issues#type'],
      removed: ['graphql:A.a', 'graphql:B.b'],
    })
  })

  it('同じ集合の場合は、並びが違っても、差を空にして返す', async () => {
    await explains('スナップショットと現在の項目の差を求める `diffIssueSurface` のテストです。同じ id を別の並びで渡した場合に、`added` と `removed` がどちらも空になることを確認します。')
    expect(diffIssueSurface(['graphql:B.b', 'graphql:A.a'], ['graphql:A.a', 'graphql:B.b'])).toEqual({ added: [], removed: [] })
  })
})

describe('hasIssueSurfaceDifference', () => {
  it.for([
    { name: '増えた id だけ', diff: { added: ['graphql:A.a'], removed: [] }, expected: true },
    { name: '消えた id だけ', diff: { added: [], removed: ['graphql:A.a'] }, expected: true },
    { name: 'どちらも空', diff: { added: [], removed: [] }, expected: false },
  ])('$name なら $expected を返す', async ({ diff, expected }) => {
    await explains('差の有無を判定する `hasIssueSurfaceDifference` のテストです。`added` と `removed` のどちらかに id がある場合は `true`、どちらも空の場合は `false` を返すことを確認します。')
    expect(hasIssueSurfaceDifference(diff)).toBe(expected)
  })
})
