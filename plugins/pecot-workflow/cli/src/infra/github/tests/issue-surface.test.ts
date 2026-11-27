import { afterEach, describe, expect, it, vi } from 'vitest'

import { explains } from '../../../../tests/_helpers/explains.js'

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
})
