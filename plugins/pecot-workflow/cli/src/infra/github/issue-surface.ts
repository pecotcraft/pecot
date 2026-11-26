// GitHub の公開スキーマ（SDL）と REST の OpenAPI を取りに行く。どちらも認証なしで取れる。
import { parseJsonText } from '../../domain/json.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { IssueSurface } from '../../domain/issue-surface.js'

export const GRAPHQL_SCHEMA_URL = 'https://docs.github.com/public/fpt/schema.docs.graphql'

const REST_DESCRIPTION_BASE = 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com'

const FETCH_TIMEOUT_MS = 120_000

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
