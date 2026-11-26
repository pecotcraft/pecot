import { afterEach, describe, expect, it, vi } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubAPIError, GitHubNotFoundError } from '../errors.js'
import { fetchIssueSurfaceSources, GRAPHQL_SCHEMA_URL, listOpenIssues, restDescriptionUrl, rewriteIssue } from '../issue-surface.js'
import { failure, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

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

const ISSUES_PATH = '/repos/acme/demo/issues'

describe('listOpenIssues', () => {
  it('Link ヘッダの next を 2 ページ目まで params 無しでたどり、Pull Request を除いて番号と本文を返す', async () => {
    const { client, server } = await startClient([
      restResponse('GET', ISSUES_PATH, {
        status: 200,
        body: [{ number: 1, body: 'one' }, { number: 2, body: 'pr', pull_request: { url: 'u' } }],
        headers: { link: `<{{GITHUB_API}}${ISSUES_PATH}?state=open&per_page=100&page=2>; rel="next", <{{GITHUB_API}}${ISSUES_PATH}?page=2>; rel="last"` },
      }),
      restResponse('GET', ISSUES_PATH, { status: 200, body: [{ number: 3, body: 'three' }] }),
    ])
    expect(await listOpenIssues(client, 'acme', 'demo')).toEqual([{ number: 1, body: 'one' }, { number: 3, body: 'three' }])
    expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }, { page: '2', per_page: '100', state: 'open' }])
  })

  it('本文が null の Issue は、空の本文として返す', async () => {
    const { client } = await startClient([restResponse('GET', ISSUES_PATH, { status: 200, body: [{ number: 4, body: JSON_NULL }] })])
    expect(await listOpenIssues(client, 'acme', 'demo')).toEqual([{ number: 4, body: '' }])
  })

  it('一覧の取得が 404 だと、GitHubNotFoundError を投げる', async () => {
    const { client } = await startClient([restResponse('GET', ISSUES_PATH, { status: 404, body: { message: 'Not Found' } })])
    expect(await rejection(listOpenIssues(client, 'acme', 'demo'))).toMatchObject({ name: GitHubNotFoundError.name })
  })
})

describe('rewriteIssue', () => {
  it('題と本文を PATCH で送る', async () => {
    const { client, server } = await startClient([restResponse('PATCH', `${ISSUES_PATH}/7`, { status: 200, body: { number: 7 } })])
    await rewriteIssue(client, 'acme', 'demo', 7, '題', '本文')
    expect(restRequests(server).map(({ method, path, body }) => ({ method, path, body }))).toEqual([{ method: 'PATCH', path: `${ISSUES_PATH}/7`, body: { title: '題', body: '本文' } }])
  })

  it('PATCH が 422 だと、状態コードを持つ GitHubAPIError を投げる', async () => {
    const { client } = await startClient([restResponse('PATCH', `${ISSUES_PATH}/7`, { status: 422, text: 'too long' })])
    expect(await rejection(rewriteIssue(client, 'acme', 'demo', 7, '題', '本文'))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422 }))
  })
})
