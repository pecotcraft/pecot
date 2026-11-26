import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchIssueSurfaceSources, GRAPHQL_SCHEMA_URL, restDescriptionUrl } from '../issue-surface.js'

const REST_URL = 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.2022-11-28.json'

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

describe('restDescriptionUrl', () => {
  it('版を、rest-api-description の版の付いたファイル名にする', () => {
    expect(restDescriptionUrl('2022-11-28')).toBe(REST_URL)
  })
})

describe('fetchIssueSurfaceSources', () => {
  it('SDL と指定の版の OpenAPI を取り、本文と取った URL・版・日時を返す', async () => {
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

  it('HTTP の失敗で、URL と状態を挙げて投げる', async () => {
    stubFetch(new Map([[GRAPHQL_SCHEMA_URL, new Response('type Query { ok: Boolean }')]]))
    await expect(fetchIssueSurfaceSources('2099-01-01')).rejects.toThrow(`GET ${restDescriptionUrl('2099-01-01')} failed: 404 Not Found`)
  })
})
