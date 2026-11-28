import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JsonValue } from '@pecot/workflow-core/domain/python-format.js'
import { extractIssueSurface, fetchIssueSurfaceSources, GRAPHQL_SCHEMA_URL, restDescriptionUrl } from '../src/infra/issue-surface.js'
import { explains } from './_helpers/explains.js'

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

const REST_URL = 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.2022-11-28.json'

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

function stubFetch(responses: ReadonlyMap<string, Response>): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    requested.push(url)
    const response = responses.get(url)
    return Promise.resolve(response ?? new Response('missing', { status: 404, statusText: 'Not Found' }))
  })
  return requested
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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

describe('restDescriptionUrl', () => {
  it('版を、rest-api-description のその版のファイルを指す URL にする', async () => {
    await explains('OpenAPI の取得先を作成する `restDescriptionUrl` のテストです。版 `2022-11-28` を渡した場合に、`rest-api-description` のその版のファイルを指す URL を返すことを確認します。')
    expect(restDescriptionUrl('2022-11-28')).toBe(REST_URL)
  })
})

describe('fetchIssueSurfaceSources', () => {
  it('SDL と指定した版の OpenAPI を取得し、本文と、取得元の URL・版・日時を返す', async () => {
    await explains('GitHub の SDL と OpenAPI を取得する `fetchIssueSurfaceSources` のテストです。2 つの URL へ要求を送り、SDL の本文と解析した OpenAPI、取得元の URL・版・取得日時を返すことを確認します。')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T01:02:03.000Z'))
    const requested = stubFetch(new Map([
      [GRAPHQL_SCHEMA_URL, new Response('type Query { ok: Boolean }')],
      [REST_URL, new Response('{"paths":{}}')],
    ]))
    const fetched = await fetchIssueSurfaceSources('2022-11-28')
    expect(new Set(requested)).toEqual(new Set([GRAPHQL_SCHEMA_URL, REST_URL]))
    expect(fetched).toEqual({
      sdl: 'type Query { ok: Boolean }',
      openapi: { paths: {} },
      sources: { graphql: GRAPHQL_SCHEMA_URL, rest: REST_URL, rest_api_version: '2022-11-28', fetched_at: '2026-11-25T01:02:03.000Z' },
    })
  })

  it('HTTP の取得に失敗した場合は、URL と状態を含む例外を送出する', async () => {
    await explains('OpenAPI の取得が失敗する場合の `fetchIssueSurfaceSources` のテストです。HTTP の状態が `404` の場合に、`GET <URL> failed: 404 Not Found` のメッセージで例外が発生することを確認します。')
    stubFetch(new Map([[GRAPHQL_SCHEMA_URL, new Response('type Query { ok: Boolean }')]]))
    await expect(fetchIssueSurfaceSources('2099-01-01')).rejects.toThrow(`GET ${restDescriptionUrl('2099-01-01')} failed: 404 Not Found`)
  })

  it('OpenAPI が JSON でない場合は、例外を送出する', async () => {
    await explains('OpenAPI の本文が JSON でない場合の `fetchIssueSurfaceSources` のテストです。取得した本文を JSON として読めないときに、例外が発生することを確認します。')
    stubFetch(new Map([[GRAPHQL_SCHEMA_URL, new Response('type Query { ok: Boolean }')], [REST_URL, new Response('{')]]))
    await expect(fetchIssueSurfaceSources('2022-11-28')).rejects.toThrow(Error)
  })
})
