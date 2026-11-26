/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は可変 */
// GitHub の公開スキーマ（SDL）と REST の OpenAPI を取りに行く（認証なし）。差の Issue を探して書き直す REST の操作も置く。
import { isJsonObject, jsonField, parseJsonText } from '../../domain/json.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { IssueSurface, OpenIssue } from '../../domain/issue-surface.js'
import type { GitHubClient } from './index.js'
import { asArray, requireNumber } from './payload.js'
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

/**
開いた Issue を全件取る（REST）。Link ヘッダの next をたどり、Pull Request を除く
*/
export async function listOpenIssues(client: GitHubClient, owner: string, repository: string): Promise<OpenIssue[]> {
  const issues: OpenIssue[] = []
  let target = `${repositoryPath(owner, repository)}/issues`
  // 2 ページ目以降は next の絶対 URL に cursor が入るので、params を再送しない（ReposApi.listAll と同じ）
  let parameters: Readonly<Record<string, number | string>> | undefined = { state: 'open', per_page: ISSUES_PER_PAGE }
  for (;;) {
    const response = await client.restRequest('GET', target, { params: parameters })
    if (!response.isSuccess) client.handleHttpError(response)
    for (const item of asArray(response.json())) {
      if (!isJsonObject(item) || 'pull_request' in item) continue
      const body = jsonField(item, 'body')
      issues.push({ number: requireNumber(jsonField(item, 'number'), 'number'), body: typeof body === 'string' ? body : '' })
    }
    const next = response.links.get('next')
    if (next === undefined) return issues
    target = next.url
    parameters = undefined
  }
}

/**
Issue の題と本文を PATCH で置き換える
*/
export async function rewriteIssue(client: GitHubClient, owner: string, repository: string, number: number, title: string, body: string): Promise<void> {
  await client.restJson('PATCH', `${repositoryPath(owner, repository)}/issues/${String(number)}`, { json: { title, body } })
}
