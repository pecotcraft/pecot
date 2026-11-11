// PullsApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// get_pull_request_slim・get_pull_request_with_reviews の期待値は、同じ応答を Python の GitHubClient に渡して得た辞書。
import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
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
