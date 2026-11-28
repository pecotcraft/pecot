// tracker-sync の issue-surface のテストが共有する準備。写し・今のスキーマの応答・Tracker の Issue・書き込みの読み取りを置く。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { vi } from 'vitest'

import { diffIssueSurface, issueSurfaceSchema } from '@pecot/workflow-core/domain/issue-surface.js'
import { renderTrackerBody, SURFACE_LABEL } from '@pecot/workflow-core/domain/issue-surface-tracker.js'
import type { JsonObject } from '@pecot/workflow-core/domain/json.js'
import { DEFAULT_API_VERSION } from '@pecot/workflow-core/infra/github/client.js'
import type { RecordedRequest, ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { GRAPHQL_SCHEMA_URL, restDescriptionUrl } from '../../src/infra/issue-surface.js'
import { issueListRule } from './tracker-sync-case.js'

export const SURFACE_FILE = path.resolve(import.meta.dirname, '../../../plugins/pecot-workflow/interface/github-issue-surface.json')
export const SNAPSHOT = issueSurfaceSchema.parse(JSON.parse(readFileSync(SURFACE_FILE, 'utf8')))
export const REST_URL = restDescriptionUrl(DEFAULT_API_VERSION)
export const TODAY_TITLE = '[Tracker] GitHub issue surface — 2026-11-09'
export const ADDED = 'graphql:enum:IssueFieldDataType.CUJ708A'
export const ADDED_B = 'graphql:enum:IssueFieldDataType.CUJ708B'
export const CHANGED = [...SNAPSHOT.items, ADDED]
export const ISSUES_PATH = '/repos/acme/demo/issues'

const REST_PREFIX = 'rest:POST /repos/{owner}/{repo}/issues#'

function pushTo(groups: Map<string, string[]>, key: string, value: string): void {
  groups.set(key, [...groups.get(key) ?? [], value])
}

/**
写しの id の集合から、extractIssueSurface がちょうどその集合を返す SDL を組む
*/
export function sdlOf(ids: readonly string[]): string {
  const enums = new Map<string, string[]>()
  const inputs = new Map<string, string[]>()
  const mutations: string[] = []
  for (const id of ids) {
    if (id.startsWith('graphql:enum:')) {
      const [type = '', value = ''] = id.slice('graphql:enum:'.length).split('.', 2)
      pushTo(enums, type, value)
    }
    else if (id.startsWith('graphql:mutation:')) {
      mutations.push(id.slice('graphql:mutation:'.length))
    }
    else if (id.startsWith('graphql:')) {
      const [type = '', field = ''] = id.slice('graphql:'.length).split('.', 2)
      pushTo(inputs, type, field)
    }
  }
  return [
    'directive @possibleTypes(concreteTypes: [String!]!, abstractType: String) on INPUT_FIELD_DEFINITION | ARGUMENT_DEFINITION',
    'type Issue { id: ID! }',
    ...[...enums].map(([type, values]) => `enum ${type} { ${values.join(' ')} }`),
    ...[...inputs].map(([type, fields]) => `input ${type} { ${fields.map(field => `${field}: String`).join(' ')} }`),
    ...mutations.map(name => `input Drift_${name}Input { issueId: ID! @possibleTypes(concreteTypes: ["Issue"]) }`),
    `type Mutation { ${mutations.map(name => `${name}(input: Drift_${name}Input!): Issue`).join(' ')} }`,
  ].join('\n')
}

/**
写しの id の集合から、REST の起票の本文の項目だけを持つ OpenAPI を組む
*/
export function openapiOf(ids: readonly string[]): string {
  const properties = Object.fromEntries(ids.filter(id => id.startsWith(REST_PREFIX)).map(id => [id.slice(REST_PREFIX.length), {}]))
  return JSON.stringify({ paths: { '/repos/{owner}/{repo}/issues': { post: { requestBody: { content: { 'application/json': { schema: { properties } } } } } } } })
}

/**
SDL と OpenAPI の URL の応答を、ids を返すものへ差し替える。偽の GitHub（127.0.0.1）への要求はそのまま通す。
返すのは、偽の GitHub を除いて要求した URL の並び。overrides で URL ごとの応答を差し替える
*/
export function stubSchemas(ids: readonly string[], overrides: ReadonlyMap<string, Response> = new Map()): string[] {
  const requested: string[] = []
  const realFetch = fetch
  const responses = new Map([[GRAPHQL_SCHEMA_URL, sdlOf(ids)], [REST_URL, openapiOf(ids)]])
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- fetch の型に合わせる
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
    requested.push(url)
    const override = overrides.get(url)
    if (override !== undefined) return override
    const text = responses.get(url)
    return text === undefined ? new Response('missing', { status: 404, statusText: 'Not Found' }) : new Response(text)
  })
  return requested
}

/**
ids を今のスキーマとしたときの Tracker の本文。existing があれば一覧の外を残す
*/
export function bodyOf(ids: readonly string[], existing?: string): string {
  return renderTrackerBody(diffIssueSurface(SNAPSHOT.items, ids), { graphql: GRAPHQL_SCHEMA_URL, rest: REST_URL }, existing)
}

export function trackers(...issues: readonly JsonObject[]): ResponseRule {
  return issueListRule(SURFACE_LABEL, issues)
}

export function trackerIssue(number: number, body: string, state = 'open'): JsonObject {
  return { number, state, body }
}

/**
Tracker #5 の PATCH の応答。body は要求の本文と照らす
*/
export function patched(body: unknown): ResponseRule {
  return { match: { method: 'PATCH', path: `${ISSUES_PATH}/5`, body }, respond: { status: 200, body: { number: 5 } }, times: 1 }
}

/**
REST の書き込み（Issue の作成・本文・状態）
*/
export function restWrites(requests: readonly RecordedRequest[]): readonly RecordedRequest[] {
  return requests.filter(request => request.type === 'rest' && request.method !== 'GET')
}
