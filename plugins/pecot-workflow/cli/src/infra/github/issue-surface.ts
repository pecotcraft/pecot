/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は可変 */
// GitHub の公開スキーマ（SDL）と REST の OpenAPI を取りに行く（認証なし）。差の Issue を探す GraphQL と、書き直す REST の操作も置く。
import { isJsonObject, jsonField, parseJsonText } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { IssueSurface, OpenIssue } from '../../domain/issue-surface.js'
import type { GitHubClient } from './index.js'
import { asArray, requireNumber, requireString, throwMalformed } from './payload.js'
import { repositoryPath } from './rest-path.js'

export const GRAPHQL_SCHEMA_URL = 'https://docs.github.com/public/fpt/schema.docs.graphql'

const REST_DESCRIPTION_BASE = 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com'

const FETCH_TIMEOUT_MS = 120_000

const ISSUES_PER_PAGE = 100

export function restDescriptionUrl(apiVersion: string): string {
  return `${REST_DESCRIPTION_BASE}/api.github.com.${apiVersion}.json`
}

export interface IssueSurfaceSources {
  readonly sdl: string
  readonly openapi: JsonValue
  readonly sources: IssueSurface['sources']
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`GET ${url} failed: ${String(response.status)} ${response.statusText}`)
  return response.text()
}

/**
公開スキーマの SDL を取る
*/
export async function fetchGraphqlSchema(): Promise<string> {
  return fetchText(GRAPHQL_SCHEMA_URL)
}

/**
apiVersion の版の OpenAPI を取る
*/
export async function fetchRestDescription(apiVersion: string): Promise<JsonValue> {
  return parseJsonText(await fetchText(restDescriptionUrl(apiVersion)))
}

/**
SDL と、apiVersion の版の OpenAPI を取る。sources には取った URL・版・取り始めの日時を入れる
*/
export async function fetchIssueSurfaceSources(apiVersion: string): Promise<IssueSurfaceSources> {
  const fetchedAt = new Date().toISOString()
  const [sdl, openapi] = await Promise.all([fetchGraphqlSchema(), fetchRestDescription(apiVersion)])
  return {
    sdl,
    openapi,
    sources: { graphql: GRAPHQL_SCHEMA_URL, rest: restDescriptionUrl(apiVersion), rest_api_version: apiVersion, fetched_at: fetchedAt },
  }
}

const QUERY_LIST_OPEN_ISSUE_BODIES = `query ListOpenIssueBodies($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: ${String(ISSUES_PER_PAGE)}, after: $after) {
      nodes {
        number
        body
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`

/**
開いた Issue を全件取る。REST の一覧は 60 秒 cache され、作った直後の Issue が出ないので GraphQL で読む
*/
export async function listOpenIssues(client: GitHubClient, owner: string, repository: string): Promise<OpenIssue[]> {
  const issues: OpenIssue[] = []
  let after: string | null = JSON_NULL
  for (;;) {
    const result = await client.executeGraphql(QUERY_LIST_OPEN_ISSUE_BODIES, { owner, repo: repository, after })
    const connection = jsonField(jsonField(result, 'repository'), 'issues')
    // 0 件と読むと、開いた差の Issue があっても新しく作ってしまう
    if (!isJsonObject(connection)) throwMalformed('repository.issues')
    const nodes = asArray(jsonField(connection, 'nodes'))
    for (const node of nodes) {
      const body = jsonField(node, 'body')
      issues.push({ number: requireNumber(jsonField(node, 'number'), 'repository.issues.nodes.number'), body: typeof body === 'string' ? body : '' })
    }
    const pageInfo = jsonField(connection, 'pageInfo')
    if (jsonField(pageInfo, 'hasNextPage') !== true) return issues
    after = requireString(jsonField(pageInfo, 'endCursor'), 'repository.issues.pageInfo.endCursor')
  }
}

/**
Issue の題と本文を PATCH で置き換える
*/
export async function rewriteIssue(client: GitHubClient, owner: string, repository: string, number: number, title: string, body: string): Promise<void> {
  await client.restJson('PATCH', `${repositoryPath(owner, repository)}/issues/${String(number)}`, { json: { title, body } })
}
