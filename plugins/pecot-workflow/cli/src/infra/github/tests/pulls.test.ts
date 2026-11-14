// PullsApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// get_pull_request_slim・get_pull_request_with_reviews の期待値は、同じ応答を Python の GitHubClient に渡して得た辞書。
import { describe, expect, it } from 'vitest'

import { jsonField } from '../../../domain/json.js'
import { JSON_NULL } from '../../../domain/json-null.js'
import type { JsonValue } from '../../../domain/python-format.js'
import { GitHubAPIError, GitHubNotFoundError } from '../errors.js'
import { failure, graphqlData, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

function pullRequest(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    number: 42,
    state: 'OPEN',
    title: 'feat: 新機能追加',
    body: '## Added — 機能A追加\n\n- 機能A追加\n\nRefs #123',
    headRefName: 'feat/issue-123',
    baseRefName: 'develop',
    isDraft: false,
    mergeable: 'MERGEABLE',
    comments: { totalCount: 3 },
    closingIssuesReferences: { nodes: [] },
    reviews: { nodes: [] },
    ...overrides,
  }
}

describe('createPullRequest', () => {
  it('title・body・head・base・draft を、この順で POST する', async () => {
    const created = { number: 42, title: 'feat: 新機能追加', html_url: 'https://github.com/owner/repo/pull/42', state: 'open' }
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/pulls', { status: 201, body: created })])
    const body = '## Added — 機能A追加\n\n- 機能A追加\n\nRefs #123'
    expect(await client.createPullRequest('owner', 'repo', 'feat: 新機能追加', body, 'feat/issue-123', 'develop')).toEqual(created)
    expect(restRequests(server).map(request => JSON.stringify(request.body))).toEqual([
      JSON.stringify({ title: 'feat: 新機能追加', body, head: 'feat/issue-123', base: 'develop', draft: false }),
    ])
  })

  it('draft を true で渡すと、送る本文に draft: true が入る', async () => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/pulls', { status: 201, body: { number: 43, draft: true } })])
    expect(await client.createPullRequest('owner', 'repo', 'WIP: 作業中', '作業中です', 'feat/wip', 'develop', true)).toEqual({ number: 43, draft: true })
    expect(restRequests(server).map(request => request.body)).toMatchObject([{ draft: true }])
  })

  it.each([
    ['base が存在しない', 'Validation failed: base branch does not exist'],
    ['既に PR がある', 'A pull request already exists'],
  ])('422（%s）は GitHubAPIError', async (_label, text) => {
    const { client } = await startClient([restResponse('POST', '/repos/owner/repo/pulls', { status: 422, text })])
    expect(await rejection(client.createPullRequest('owner', 'repo', 'Test', 'body', 'feat/test', 'nonexistent'))).toMatchObject(
      failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: text }),
    )
  })
})

describe('getPullRequestSlim', () => {
  it('基本のフィールドを snake_case で返す。本文の Refs は referenced_issues に入る', async () => {
    const { client, server } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest() } })], 'ghes.example.com')
    const result = await client.getPullRequestSlim('owner', 'repo', 42)
    expect(JSON.stringify(result)).toBe(JSON.stringify({
      number: 42,
      state: 'OPEN',
      title: 'feat: 新機能追加',
      body: '## Added — 機能A追加\n\n- 機能A追加\n\nRefs #123',
      head_ref: 'feat/issue-123',
      base_ref: 'develop',
      is_draft: false,
      mergeable: 'MERGEABLE',
      comments: 3,
      closing_issues: [],
      referenced_issues: [{ number: 123, title: '' }],
      reviews: [],
    }))
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetPullRequestSlim', variables: { owner: 'owner', repo: 'repo', number: 42 } }])
  })

  it('ドラフトで mergeable が UNKNOWN のとき、そのまま返す', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ isDraft: true, mergeable: 'UNKNOWN', body: '作業中' }) } })])
    expect(await client.getPullRequestSlim('owner', 'repo', 43)).toMatchObject({ is_draft: true, mergeable: 'UNKNOWN', referenced_issues: [] })
  })

  it('MERGED の PR は、state に MERGED を返す', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ state: 'MERGED' }) } })])
    expect(await client.getPullRequestSlim('owner', 'repo', 46)).toMatchObject({ state: 'MERGED' })
  })

  it('closingIssuesReferences は closing_issues になり、Refs と重なる番号は referenced_issues から落ちる', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({
      body: 'Fixes #123\n\nRefs #123\nRefs #456',
      closingIssuesReferences: { nodes: [{ number: 123, title: 'バグ報告' }] },
    }) } })])
    const result = await client.getPullRequestSlim('owner', 'repo', 51)
    expect(result.closing_issues).toEqual([{ number: 123, title: 'バグ報告' }])
    expect(result.referenced_issues).toEqual([{ number: 456, title: '' }])
  })

  it('Fixes だけの本文は referenced_issues に入らない', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({
      body: 'Fixes #123, Closes #456',
      closingIssuesReferences: { nodes: [{ number: 123, title: 'バグ報告' }, { number: 456, title: '関連Issue' }] },
    }) } })])
    const result = await client.getPullRequestSlim('owner', 'repo', 44)
    expect(result.closing_issues).toHaveLength(2)
    expect(result.referenced_issues).toEqual([])
  })

  it('Refs は番号の昇順で、他のリポジトリへの参照は落とす', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({
      body: 'x\nRefs #12\nRefs #5\nRefs other/repo#7\nRefs owner/repo#3',
      closingIssuesReferences: { nodes: [{ number: 12, title: 'closing' }, JSON_NULL] },
    }) } })])
    const result = await client.getPullRequestSlim('owner', 'repo', 9)
    expect(result.referenced_issues).toEqual([{ number: 3, title: '' }, { number: 5, title: '' }])
  })

  it('レビュー（投稿者なしは null、login が空なら空文字のまま）', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ reviews: { nodes: [
      { state: 'APPROVED', author: { login: 'reviewer1' } },
      { state: 'CHANGES_REQUESTED', author: { login: 'reviewer2' } },
      { state: 'COMMENTED', author: JSON_NULL },
      { state: 'COMMENTED', author: { login: '' } },
      JSON_NULL,
    ] } }) } })])
    const result = await client.getPullRequestSlim('owner', 'repo', 45)
    expect(result.reviews).toEqual([
      { state: 'APPROVED', author: 'reviewer1' },
      { state: 'CHANGES_REQUESTED', author: 'reviewer2' },
      { state: 'COMMENTED', author: JSON_NULL },
      { state: 'COMMENTED', author: '' },
    ])
  })

  it('PR が無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: JSON_NULL } })])
    expect(await rejection(client.getPullRequestSlim('owner', 'repo', 999))).toMatchObject(failure(GitHubNotFoundError, 'PR not found: owner/repo/999'))
  })

  it('リポジトリが無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: JSON_NULL })])
    expect(await rejection(client.getPullRequestSlim('owner', 'nonexistent', 42))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
  })

  it('本文が無ければ GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ body: JSON_NULL }) } })])
    expect(await rejection(client.getPullRequestSlim('owner', 'repo', 42))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.body'))
  })

  it('isDraft が真偽値でなければ GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ isDraft: 'no' }) } })])
    expect(await rejection(client.getPullRequestSlim('owner', 'repo', 42))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.isDraft'))
  })
})

describe('getPullRequestWithReviews', () => {
  // 期待値は Python の get_pull_request_with_reviews の出力
  const response = pullRequest({
    number: 9,
    title: 'T',
    body: 'x\nRefs #12\nRefs #5\nRefs other/repo#7\nRefs owner/repo#3',
    headRefName: 'h',
    baseRefName: 'b',
    comments: { totalCount: 2 },
    closingIssuesReferences: { nodes: [{ number: 12, title: 'closing' }, JSON_NULL] },
    reviews: { nodes: [
      { state: 'APPROVED', author: { login: 'r1' }, body: 'ok', submittedAt: '2026-01-01T00:00:00Z' },
      { state: 'COMMENTED', author: JSON_NULL, body: JSON_NULL },
      { state: 'COMMENTED', author: { login: '' }, body: 'x', submittedAt: JSON_NULL },
      JSON_NULL,
    ] },
    reviewThreads: { nodes: [
      { isResolved: false, path: 'a.py', line: 10, comments: { nodes: [
        { author: { login: 'r1' }, body: 'fix', createdAt: '2026-01-01T00:00:00Z' },
        { author: JSON_NULL, body: JSON_NULL },
        JSON_NULL,
      ] } },
      { isResolved: true, comments: { nodes: [] } },
      JSON_NULL,
    ] },
  })

  it('レビューの本文・投稿日時と、行コメントのスレッドを足して返す', async () => {
    const { client, server } = await startClient([graphqlData('GetPullRequestWithReviews', { repository: { pullRequest: response } })])
    const result = await client.getPullRequestWithReviews('owner', 'repo', 9)
    expect(JSON.stringify(result)).toBe(JSON.stringify({
      number: 9,
      state: 'OPEN',
      title: 'T',
      body: 'x\nRefs #12\nRefs #5\nRefs other/repo#7\nRefs owner/repo#3',
      head_ref: 'h',
      base_ref: 'b',
      is_draft: false,
      mergeable: 'MERGEABLE',
      comments: 2,
      closing_issues: [{ number: 12, title: 'closing' }],
      referenced_issues: [{ number: 3, title: '' }, { number: 5, title: '' }],
      reviews: [
        { state: 'APPROVED', author: 'r1', body: 'ok', submitted_at: '2026-01-01T00:00:00Z' },
        { state: 'COMMENTED', author: JSON_NULL, body: '', submitted_at: JSON_NULL },
        { state: 'COMMENTED', author: JSON_NULL, body: 'x', submitted_at: JSON_NULL },
      ],
      review_threads: [
        { is_resolved: false, path: 'a.py', line: 10, comments: [
          { author: 'r1', body: 'fix', created_at: '2026-01-01T00:00:00Z' },
          { author: JSON_NULL, body: '', created_at: JSON_NULL },
        ] },
        { is_resolved: true, path: JSON_NULL, line: JSON_NULL, comments: [] },
      ],
    }))
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetPullRequestWithReviews', variables: { owner: 'owner', repo: 'repo', number: 9 } }])
  })

  it('PR が無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetPullRequestWithReviews', { repository: { pullRequest: JSON_NULL } })])
    expect(await rejection(client.getPullRequestWithReviews('owner', 'repo', 5))).toMatchObject(failure(GitHubNotFoundError, 'PR not found: owner/repo/5'))
  })
})

describe('mergePullRequest', () => {
  it.each([[undefined, 'squash'], ['merge', 'merge'], ['rebase', 'rebase'], ['squash', 'squash']])('マージ方法 %s は merge_method=%s で PUT する', async (method, expected) => {
    const merged = { sha: 'abc123def456', merged: true, message: 'Pull Request successfully merged' }
    const { client, server } = await startClient([restResponse('PUT', '/repos/owner/repo/pulls/42/merge', { status: 200, body: merged })])
    expect(await client.mergePullRequest('owner', 'repo', 42, method)).toEqual(merged)
    expect(restRequests(server).map(({ method: requestMethod, body }) => ({ method: requestMethod, body }))).toEqual([{ method: 'PUT', body: { merge_method: expected } }])
  })

  it('404 は GitHubNotFoundError', async () => {
    const { client, server } = await startClient([restResponse('PUT', '/repos/owner/repo/pulls/999/merge', { status: 404, text: 'Not Found' })])
    expect(await rejection(client.mergePullRequest('owner', 'repo', 999))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/pulls/999/merge`, { statusCode: 404 }),
    )
  })

  it.each([
    [405, 'Pull Request is not mergeable'],
    [422, 'Pull Request is not open'],
  ])('%i は GitHubAPIError', async (status, text) => {
    const { client } = await startClient([restResponse('PUT', '/repos/owner/repo/pulls/42/merge', { status, text })])
    expect(await rejection(client.mergePullRequest('owner', 'repo', 42))).toMatchObject(
      failure(GitHubAPIError, `GitHub API error: ${String(status)}`, { statusCode: status, responseBody: text }),
    )
  })
})

const BOT = { __typename: 'Bot', login: 'dependabot' }
const LAST_PAGE = { hasNextPage: false, endCursor: JSON_NULL }

function pullRequestPage(nodes: unknown, pageInfo: unknown): unknown {
  return { repository: { pullRequests: { pageInfo, nodes } } }
}

function numbersOf(nodes: readonly JsonValue[]): readonly (JsonValue | undefined)[] {
  return nodes.map(node => jsonField(node, 'number'))
}

describe('listOpenDependabotPullRequests', () => {
  it('1 ページ目は after: null を送り、dependabot の PR だけを返す', async () => {
    const mine = { number: 1, author: BOT }
    const others = [
      { number: 2, author: { __typename: 'User', login: 'dependabot' } },
      { number: 3, author: { __typename: 'Bot', login: 'other-bot' } },
      { number: 4, author: JSON_NULL },
      JSON_NULL,
      {},
    ]
    const { client, server } = await startClient([graphqlData('ListOpenPullRequests', pullRequestPage([mine, ...others], LAST_PAGE))])
    expect(await client.listOpenDependabotPullRequests('owner', 'repo')).toEqual([mine])
    expect(graphqlRequests(server)).toEqual([{ operation: 'ListOpenPullRequests', variables: { owner: 'owner', repo: 'repo', after: JSON_NULL } }])
  })

  it('次のページは endCursor を after に渡して辿る', async () => {
    const { client, server } = await startClient([
      graphqlData('ListOpenPullRequests', pullRequestPage([{ number: 1, author: BOT }], { hasNextPage: true, endCursor: 'c1' })),
      graphqlData('ListOpenPullRequests', pullRequestPage([{ number: 2, author: BOT }], LAST_PAGE)),
    ])
    const nodes = await client.listOpenDependabotPullRequests('owner', 'repo')
    expect(numbersOf(nodes)).toEqual([1, 2])
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([{ owner: 'owner', repo: 'repo', after: JSON_NULL }, { owner: 'owner', repo: 'repo', after: 'c1' }])
  })

  it.for([
    { name: 'repository が null', data: { repository: JSON_NULL }, message: 'the PR list response has no repository.pullRequests' },
    { name: 'pullRequests が null', data: { repository: { pullRequests: JSON_NULL } }, message: 'the PR list response has no repository.pullRequests' },
    { name: 'nodes が配列でない', data: pullRequestPage('x', LAST_PAGE), message: 'nodes in the PR list response is not an array' },
    { name: '次のページがあるのに endCursor が無い', data: pullRequestPage([], { hasNextPage: true, endCursor: JSON_NULL }), message: 'the next page of the PR list has no endCursor' },
  ])('$name なら GitHubAPIError', async ({ data, message }) => {
    const { client } = await startClient([graphqlData('ListOpenPullRequests', data)])
    expect(await rejection(client.listOpenDependabotPullRequests('owner', 'repo'))).toMatchObject(failure(GitHubAPIError, message))
  })
})

function node(number: number, state: string, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    number,
    state,
    headRefName: 'feat/issue-9',
    baseRefName: 'main',
    isDraft: false,
    isCrossRepository: false,
    repository: { owner: { login: 'owner' }, name: 'repo' },
    ...overrides,
  }
}

describe('listPullRequestsByHead', () => {
  const variables = { owner: 'owner', repo: 'repo', headRefName: 'feat/issue-9' }
  it('open・closed・merged の PR を、リポ・番号・状態・head・base・ドラフト・fork かで返す', async () => {
    const { client, server } = await startClient([
      graphqlData('ListPullRequestsByHead', {
        repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node(5, 'MERGED'), node(6, 'OPEN', { isDraft: true, baseRefName: 'feat/issue-8' }), node(7, 'CLOSED', { isCrossRepository: true })] } },
      }),
    ])
    expect(await client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9')).toEqual({
      pullRequests: [
        { repository: { owner: 'owner', repository: 'repo' }, number: 5, state: 'MERGED', headRefName: 'feat/issue-9', baseRefName: 'main', isDraft: false, isCrossRepository: false },
        { repository: { owner: 'owner', repository: 'repo' }, number: 6, state: 'OPEN', headRefName: 'feat/issue-9', baseRefName: 'feat/issue-8', isDraft: true, isCrossRepository: false },
        { repository: { owner: 'owner', repository: 'repo' }, number: 7, state: 'CLOSED', headRefName: 'feat/issue-9', baseRefName: 'main', isDraft: false, isCrossRepository: true },
      ],
      hasNextPage: false,
    })
    expect(graphqlRequests(server)).toEqual([{ operation: 'ListPullRequestsByHead', variables }])
  })

  it('PR が無ければ空', async () => {
    const { client } = await startClient([graphqlData('ListPullRequestsByHead', { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } })])
    expect(await client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9')).toEqual({ pullRequests: [], hasNextPage: false })
  })

  it('先頭の 20 件に収まらないときは、hasNextPage が真', async () => {
    const { client } = await startClient([graphqlData('ListPullRequestsByHead', { repository: { pullRequests: { pageInfo: { hasNextPage: true }, nodes: [node(5, 'OPEN')] } } })])
    expect(await client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9')).toMatchObject({ pullRequests: [{ number: 5 }], hasNextPage: true })
  })

  it('リポが無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('ListPullRequestsByHead', { repository: JSON_NULL })])
    expect(await rejection(client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9'))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/repo'))
  })

  it('状態が未知の値なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('ListPullRequestsByHead', { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node(5, 'DRAFT')] } } })])
    expect(await rejection(client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9'))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.state (DRAFT)'))
  })
})

const STACK_VERSION = '2026-03-10'

function stackOf(number: number, pullRequests: readonly number[]): Readonly<Record<string, unknown>> {
  return { id: 900 + number, number, open: true, base: { ref: 'main' }, pull_requests: pullRequests.map(pr => ({ number: pr, state: 'open', head: { ref: `feat/x/${String(pr)}` } })) }
}

describe('getStackOfPullRequest', () => {
  it('pull_request で絞って GET し、その PR が入っているスタックの番号と、下からの PR 番号を返す', async () => {
    const { client, server } = await startClient([
      { match: { method: 'GET', path: '/repos/owner/repo/stacks', query: { pull_request: '11' }, apiVersion: STACK_VERSION }, respond: { status: 200, body: [stackOf(3, [11, 12])] }, times: 1 },
    ])
    expect(await client.getStackOfPullRequest('owner', 'repo', 11)).toEqual({ number: 3, pullRequests: [11, 12] })
    expect(restRequests(server).map(({ method, path, query }) => ({ method, path, query }))).toEqual([{ method: 'GET', path: '/repos/owner/repo/stacks', query: { pull_request: '11' } }])
  })

  it('空の配列なら undefined', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [] })])
    expect(await client.getStackOfPullRequest('owner', 'repo', 11)).toBeUndefined()
  })

  it('その PR を含まないスタックしか無ければ undefined', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [stackOf(3, [20, 21])] })])
    expect(await client.getStackOfPullRequest('owner', 'repo', 11)).toBeUndefined()
  })

  it('その PR を含まないスタックの形が誤っていても、飛ばして含むスタックを返す', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [{ number: 'x', pull_requests: 'broken' }, { pull_requests: [{ number: 20 }] }, stackOf(3, [11, 12])] })])
    expect(await client.getStackOfPullRequest('owner', 'repo', 11)).toEqual({ number: 3, pullRequests: [11, 12] })
  })

  it('その PR を含むスタックの番号が数でなければ GitHubAPIError', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [{ number: 'x', pull_requests: [{ number: 11 }] }] })])
    expect(await rejection(client.getStackOfPullRequest('owner', 'repo', 11))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: stack.number'))
  })

  it('応答が配列でなければ GitHubAPIError', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: { number: 3 } })])
    expect(await rejection(client.getStackOfPullRequest('owner', 'repo', 11))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: stacks'))
  })

  it('pull_requests の番号が数でなければ GitHubAPIError', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [{ number: 3, pull_requests: [{ number: '11' }] }] })])
    expect(await rejection(client.getStackOfPullRequest('owner', 'repo', 11))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: stack.pull_requests.number'))
  })

  it('404（スタックの機能が無いリポ）は GitHubNotFoundError', async () => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 404, text: 'Not Found' })])
    expect(await rejection(client.getStackOfPullRequest('owner', 'repo', 11))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/stacks?pull_request=11`, { statusCode: 404 }),
    )
  })
})

describe('createStack', () => {
  it('PR 番号を渡した順（下から）のまま POST し、できたスタックを返す', async () => {
    const { client, server } = await startClient([
      { match: { method: 'POST', path: '/repos/owner/repo/stacks', apiVersion: STACK_VERSION }, respond: { status: 201, body: stackOf(4, [11, 12]) }, times: 1 },
    ])
    expect(await client.createStack('owner', 'repo', [11, 12])).toEqual({ number: 4, pullRequests: [11, 12] })
    expect(restRequests(server).map(request => JSON.stringify(request.body))).toEqual([JSON.stringify({ pull_requests: [11, 12] })])
  })

  it('404 は GitHubNotFoundError', async () => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/stacks', { status: 404, text: 'Not Found' })])
    expect(await rejection(client.createStack('owner', 'repo', [11, 12]))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/stacks`, { statusCode: 404 }),
    )
  })

  it('422（base が下の段の head と合わない）は GitHubAPIError', async () => {
    const text = 'Validation Failed'
    const { client } = await startClient([restResponse('POST', '/repos/owner/repo/stacks', { status: 422, text })])
    expect(await rejection(client.createStack('owner', 'repo', [11, 12]))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: text }))
  })
})

describe('addToStack', () => {
  it('スタックの番号のパスへ、PR 番号を POST し、足した後のスタックを返す', async () => {
    const { client, server } = await startClient([
      { match: { method: 'POST', path: '/repos/owner/repo/stacks/4/add', apiVersion: STACK_VERSION }, respond: { status: 200, body: stackOf(4, [11, 12, 13]) }, times: 1 },
    ])
    expect(await client.addToStack('owner', 'repo', 4, [13])).toEqual({ number: 4, pullRequests: [11, 12, 13] })
    expect(restRequests(server).map(request => JSON.stringify(request.body))).toEqual([JSON.stringify({ pull_requests: [13] })])
  })

  it('404 は GitHubNotFoundError', async () => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/stacks/4/add', { status: 404, text: 'Not Found' })])
    expect(await rejection(client.addToStack('owner', 'repo', 4, [13]))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/stacks/4/add`, { statusCode: 404 }),
    )
  })

  it.each([409, 422])('%i は GitHubAPIError', async (status) => {
    const { client } = await startClient([restResponse('POST', '/repos/owner/repo/stacks/4/add', { status, text: 'conflict' })])
    expect(await rejection(client.addToStack('owner', 'repo', 4, [13]))).toMatchObject(
      failure(GitHubAPIError, `GitHub API error: ${String(status)}`, { statusCode: status, responseBody: 'conflict' }),
    )
  })
})

describe('API の版', () => {
  it('版を渡さない要求は、今までどおり 2022-11-28 を送る', async () => {
    const { client } = await startClient([
      { match: { method: 'PUT', path: '/repos/owner/repo/pulls/42/merge', apiVersion: '2022-11-28' }, respond: { status: 200, body: { merged: true } }, times: 1 },
    ])
    expect(await client.mergePullRequest('owner', 'repo', 42)).toEqual({ merged: true })
  })
})
