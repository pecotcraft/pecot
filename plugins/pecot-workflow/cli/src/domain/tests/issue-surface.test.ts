import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../python-format.js'
import type { IssueCoverage, IssueSurfaceDiff } from '../issue-surface.js'
import {
  buildIssueSurfaceIssue,
  checkIssueCoverage,
  diffIssueSurface,
  extractIssueSurface,
  issueCoverageSchema,
  issueSurfaceMarker,
  planIssueSurfaceDrift,
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
  it('範囲の型の項目・値と Issue を対象にする mutation と REST の起票の本文の項目を、符号位置の順で返す', () => {
    expect(extractIssueSurface(SDL, openapiOf(INLINE_BODY))).toEqual([...SDL_ITEMS, ...REST_ITEMS])
  })

  it('ID の項目が Issue だけを受ける mutation を拾い、Issue 以外の型も受ける mutation と定義の操作を拾わない', () => {
    const mutations = extractIssueSurface(SDL, openapiOf(INLINE_BODY)).filter(id => id.startsWith('graphql:mutation:'))
    expect(mutations).toEqual(['graphql:mutation:addBlockedBy', 'graphql:mutation:createIssue', 'graphql:mutation:updateIssue'])
  })

  it('範囲の外の型と、ほかの REST の path の項目を出さない', () => {
    const items = extractIssueSurface(SDL, openapiOf(INLINE_BODY))
    expect(items.filter(id => /IssueState|AddLabelsToLabelableInput|CreateIssueTypeInput|#head$/u.test(id))).toEqual([])
  })

  it('requestBody と schema が $ref のとき、components をたどって本文の項目を読む', () => {
    const components: JsonValue = {
      requestBodies: { create: { content: { 'application/json': { schema: { $ref: '#/components/schemas/issue-create' } } } } },
      schemas: { 'issue-create': { properties: { body: {}, type: {} } } },
    }
    const items = extractIssueSurface(EMPTY_SDL, openapiOf({ $ref: '#/components/requestBodies/create' }, components))
    expect(items).toEqual(['rest:POST /repos/{owner}/{repo}/issues#body', 'rest:POST /repos/{owner}/{repo}/issues#type'])
  })

  it('範囲の型と Mutation が SDL に無いとき、止まらずにその型の項目を出さない', () => {
    expect(extractIssueSurface(EMPTY_SDL, openapiOf(INLINE_BODY))).toEqual(REST_ITEMS)
  })

  it.for([
    { name: 'path が無い', openapi: { paths: {} } },
    { name: 'paths が無い', openapi: {} },
    { name: 'post が無い', openapi: { paths: { [CREATE_PATH]: { get: {} } } } },
    { name: 'JSON の本文が無い', openapi: openapiOf({ content: { 'text/plain': {} } }) },
    { name: 'properties が無い', openapi: openapiOf({ content: { 'application/json': { schema: { type: 'string' } } } }) },
    { name: '$ref の先が無い', openapi: openapiOf({ $ref: '#/components/requestBodies/missing' }) },
    { name: '$ref が文書の外を指す', openapi: openapiOf({ $ref: 'other.json#/components/requestBodies/create' }) },
  ] satisfies { name: string, openapi: JsonValue }[])('OpenAPI の $name とき、REST の項目を出さない', ({ openapi }) => {
    expect(extractIssueSurface(EMPTY_SDL, openapi)).toEqual([])
  })

  it('$ref の JSON Pointer の ~1 と ~0 を、/ と ~ に戻してたどる', () => {
    const components: JsonValue = { schemas: { 'a/b~c': { properties: { milestone: {} } } } }
    const body: JsonValue = { content: { 'application/json': { schema: { $ref: '#/components/schemas/a~1b~0c' } } } }
    expect(extractIssueSurface(EMPTY_SDL, openapiOf(body, components))).toEqual(['rest:POST /repos/{owner}/{repo}/issues#milestone'])
  })

  it('SDL の構文が誤っていると、graphql の parse の例外を投げる', () => {
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

  it('写しの全項目が一覧にあり、組み合わせが正しいと、問題を返さない', () => {
    const coverage = coverageOf([
      { id: 'graphql:A.a', status: 'supported', handler: 'labels' },
      { id: 'graphql:A.b', status: 'supported', tool: 'issue_block' },
      { id: 'graphql:A.c', status: 'excluded', reason: 'preview' },
    ])
    expect(checkIssueCoverage(surface, coverage, HANDLERS, TOOLS)).toEqual([])
  })

  it('問題ごとに id を挙げ、id の順で返す', () => {
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
    { name: 'handler が ATTRIBUTE_HANDLERS に無い', entry: { handler: 'parent' }, expected: 'handler parent is not in ATTRIBUTE_HANDLERS' },
    { name: 'tool が COMMANDS に無い', entry: { tool: 'issue_link' }, expected: 'tool issue_link is not an MCP tool of COMMANDS' },
    { name: 'supported に reason がある', entry: { handler: 'labels', reason: 'x' }, expected: 'supported must not have a reason' },
    { name: 'excluded に handler がある', entry: { status: 'excluded', handler: 'labels', reason: 'x' }, expected: 'excluded must not have handler or tool' },
    { name: 'excluded に tool がある', entry: { status: 'excluded', tool: 'issue_create', reason: 'x' }, expected: 'excluded must not have handler or tool' },
  ])('$name とき、id を挙げた問題を返す', ({ entry, expected }) => {
    const coverage = coverageOf([{ id: 'graphql:A.a', status: 'supported', ...entry }])
    expect(checkIssueCoverage(['graphql:A.a'], coverage, HANDLERS, TOOLS)).toEqual([`graphql:A.a: ${expected}`])
  })

  it.for([
    { name: 'reason が無い', entry: {} },
    { name: 'reason が空白だけ', entry: { reason: '  ' } },
  ])('excluded の $name とき、zod で止めずに id を挙げた問題を返す', ({ entry }) => {
    const coverage = coverageOf([{ id: 'graphql:A.a', status: 'excluded', ...entry }])
    expect(checkIssueCoverage(['graphql:A.a'], coverage, HANDLERS, TOOLS)).toEqual(['graphql:A.a: excluded needs a reason'])
  })
})

describe('issueCoverageSchema', () => {
  it.for([
    { name: '知らない鍵', entry: { id: 'graphql:A.a', status: 'excluded', reason: 'x', note: 'x' } },
    { name: '知らない status', entry: { id: 'graphql:A.a', status: 'partial' } },
    { name: 'id の無い項目', entry: { status: 'excluded', reason: 'x' } },
  ])('$name を拒む', ({ entry }) => {
    expect(issueCoverageSchema.safeParse({ items: [entry] }).success).toBe(false)
  })
})

const DIFF: IssueSurfaceDiff = { added: ['graphql:A.b'], removed: ['graphql:A.a'] }
// JSON.stringify({ added: DIFF.added, removed: DIFF.removed }) の SHA-256
const DIFF_HASH = '410d6478e41445311b4b8e28cff67f3ca733f6dd0eef2ea5d9dbbcbd20f642cb'
const DIFF_MARKER = `<!-- pecot-issue-surface: ${DIFF_HASH} -->`
const OTHER_MARKER = `<!-- pecot-issue-surface: ${'0'.repeat(64)} -->`

const SOURCES = { graphql: 'https://example.com/schema.graphql', rest: 'openapi.json', rest_api_version: '2022-11-28' }

describe('diffIssueSurface', () => {
  it('今にあって写しに無い id を added に、写しにあって今に無い id を removed に、符号位置の順で返す', () => {
    const snapshot = ['graphql:B.b', 'graphql:A.a', 'graphql:a.x']
    const current = ['graphql:a.x', 'rest:POST /repos/{owner}/{repo}/issues#type', 'graphql:Z.z', 'graphql:C.c']
    expect(diffIssueSurface(snapshot, current)).toEqual({
      added: ['graphql:C.c', 'graphql:Z.z', 'rest:POST /repos/{owner}/{repo}/issues#type'],
      removed: ['graphql:A.a', 'graphql:B.b'],
    })
  })

  it('同じ集合なら、並びが違っても差を空で返す', () => {
    expect(diffIssueSurface(['graphql:B.b', 'graphql:A.a'], ['graphql:A.a', 'graphql:B.b'])).toEqual({ added: [], removed: [] })
  })
})

describe('issueSurfaceMarker', () => {
  it('増えた・消えた id の一覧の JSON の SHA-256 を、16 進 64 文字で印に入れる', () => {
    expect(issueSurfaceMarker(DIFF)).toBe(DIFF_MARKER)
  })

  it.for([
    { name: '増えた id が違う', diff: { added: ['graphql:A.c'], removed: ['graphql:A.a'] } },
    { name: '増えた id と消えた id が入れ替わる', diff: { added: ['graphql:A.a'], removed: ['graphql:A.b'] } },
  ])('$name と、違う印になる', ({ diff }) => {
    expect(issueSurfaceMarker(diff)).not.toBe(DIFF_MARKER)
  })
})

describe('buildIssueSurfaceIssue', () => {
  it('題に増えた数と消えた数を入れ、本文に一覧・比べたスキーマ・直し方を書き、最後の行に印を置く', () => {
    const issue = buildIssueSurfaceIssue({ added: ['graphql:A.b', 'graphql:A.c'], removed: [] }, SOURCES)
    const marker = issueSurfaceMarker({ added: ['graphql:A.b', 'graphql:A.c'], removed: [] })
    expect(issue).toEqual({
      title: 'GitHub の Issue の機能に差がある: 2 件増・0 件減',
      marker,
      body: [
        'GitHub の今のスキーマが、Issue の機能の写し（`plugins/pecot-workflow/interface/github-issue-surface.json`）と違います。',
        '',
        '## 増えた項目',
        '',
        '- `graphql:A.b`',
        '- `graphql:A.c`',
        '',
        '## 消えた項目',
        '',
        'なし',
        '',
        '## 比べたスキーマ',
        '',
        '- SDL: https://example.com/schema.graphql',
        '- OpenAPI: openapi.json',
        '- REST の版: 2022-11-28',
        '',
        '## 直し方',
        '',
        '`plugins/pecot-workflow/CONTRIBUTING.md` の「4. GitHub の Issue の機能の写しと担保の一覧」に従い、写しと担保の一覧を直します。その PR で、この Issue を閉じます。',
        '',
        marker,
        '',
      ].join('\n'),
    })
  })
})

describe('planIssueSurfaceDrift', () => {
  it('差が無いと、開いた差の Issue があっても none を返す', () => {
    expect(planIssueSurfaceDrift({ added: [], removed: [] }, [{ number: 3, body: OTHER_MARKER }])).toEqual({ action: 'none' })
  })

  it('差があり、印の行を持つ開いた Issue が無いと、create を返す', () => {
    const issues = [
      { number: 1, body: '' },
      { number: 2, body: `本文の途中の ${DIFF_MARKER} は行でない` },
      { number: 3, body: '<!-- pecot-issue-surface: short -->' },
    ]
    expect(planIssueSurfaceDrift(DIFF, issues)).toEqual({ action: 'create' })
  })

  it('差があり、開いた差の Issue の印が同じだと、unchanged を返す', () => {
    expect(planIssueSurfaceDrift(DIFF, [{ number: 4, body: `本文\r\n\r\n${DIFF_MARKER}\r\n` }])).toEqual({ action: 'unchanged', number: 4, others: [] })
  })

  it('差があり、開いた差の Issue の印が違うと、update を返す', () => {
    expect(planIssueSurfaceDrift(DIFF, [{ number: 4, body: `本文\n\n${OTHER_MARKER}\n` }])).toEqual({ action: 'update', number: 4, others: [] })
  })

  it('開いた差の Issue が 2 件以上あると、番号の最も小さいものの印で決め、ほかを番号の順で others に返す', () => {
    const issues = [
      { number: 9, body: DIFF_MARKER },
      { number: 2, body: OTHER_MARKER },
      { number: 5, body: DIFF_MARKER },
      { number: 1, body: 'ほかの Issue' },
    ]
    expect(planIssueSurfaceDrift(DIFF, issues)).toEqual({ action: 'update', number: 2, others: [5, 9] })
  })
})
