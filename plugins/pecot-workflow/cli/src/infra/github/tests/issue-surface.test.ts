import { afterEach, describe, expect, it, vi } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubAPIError } from '../errors.js'
import { fetchIssueSurfaceSources, GRAPHQL_SCHEMA_URL, listOpenIssues, restDescriptionUrl, rewriteIssue } from '../issue-surface.js'
import { failure, graphqlData, graphqlError, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'

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

const OPERATION = 'ListOpenIssueBodies'

function issuesPage(nodes: readonly unknown[], endCursor: string | null): unknown {
  return { repository: { issues: { nodes, pageInfo: { hasNextPage: endCursor !== JSON_NULL, endCursor } } } }
}

describe('listOpenIssues', () => {
  it('pageInfo の hasNextPage が真のあいだ endCursor でページを送り、番号と本文を返す', async () => {
    const { client, server } = await startClient([
      graphqlData(OPERATION, issuesPage([{ number: 1, body: 'one' }, { number: 2, body: 'two' }], 'c1')),
      graphqlData(OPERATION, issuesPage([{ number: 3, body: 'three' }], JSON_NULL)),
    ])
    expect(await listOpenIssues(client, 'acme', 'demo')).toEqual([{ number: 1, body: 'one' }, { number: 2, body: 'two' }, { number: 3, body: 'three' }])
    expect(graphqlRequests(server)).toEqual([
      { operation: OPERATION, variables: { owner: 'acme', repo: 'demo', after: JSON_NULL } },
      { operation: OPERATION, variables: { owner: 'acme', repo: 'demo', after: 'c1' } },
    ])
  })

  it('本文が null の Issue は、空の本文として返す', async () => {
    const { client } = await startClient([graphqlData(OPERATION, issuesPage([{ number: 4, body: JSON_NULL }], JSON_NULL))])
    expect(await listOpenIssues(client, 'acme', 'demo')).toEqual([{ number: 4, body: '' }])
  })

  it('GraphQL が errors を返すと、GitHubAPIError を投げる', async () => {
    const { client } = await startClient([graphqlError(OPERATION, 'boom')])
    expect(await rejection(listOpenIssues(client, 'acme', 'demo'))).toMatchObject(failure(GitHubAPIError, 'GraphQL query error: {\'message\': \'boom\'}'))
  })

  it('応答に repository.issues が無いと、0 件と読まずに GitHubAPIError を投げる', async () => {
    const { client } = await startClient([graphqlData(OPERATION, { repository: JSON_NULL })])
    expect(await rejection(listOpenIssues(client, 'acme', 'demo'))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: repository.issues'))
  })

  it('次のページがあるのに endCursor が無いと、GitHubAPIError を投げる', async () => {
    const page = { repository: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: JSON_NULL } } } }
    const { client } = await startClient([graphqlData(OPERATION, page)])
    expect(await rejection(listOpenIssues(client, 'acme', 'demo'))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: repository.issues.pageInfo.endCursor'))
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
