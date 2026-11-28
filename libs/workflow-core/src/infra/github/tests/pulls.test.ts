// PullsApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// get_pull_request_slim・get_pull_request_with_reviews の期待値は、同じ応答を Python の GitHubClient に渡して得た辞書。
import { describe, expect, it } from 'vitest'

import { jsonField } from '../../../domain/json.js'
import { JSON_NULL } from '../../../domain/json-null.js'
import type { JsonValue } from '../../../domain/python-format.js'
import { GitHubAPIError, GitHubNotFoundError } from '../errors.js'
import { failure, graphqlData, graphqlError, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'
import { explains } from '../../../../tests/_helpers/explains.js'
import { step } from '../../../../tests/_helpers/step.js'

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
  it('PR を作成すると、title・body・head・base・draft をこの順に POST する', async () => {
    await explains('PR を作成する `createPullRequest` のテストです。`title`・`body`・`head`・`base`・`draft` をこの順の JSON で送信し、作成された PR を返すことを確認します。')
    const { created, client, server, body } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const created = { number: 42, title: 'feat: 新機能追加', html_url: 'https://github.com/owner/repo/pull/42', state: 'open' }
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/pulls', { status: 201, body: created })])
      const body = '## Added — 機能A追加\n\n- 機能A追加\n\nRefs #123'
      return { created, client, server, body }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.createPullRequest('owner', 'repo', 'feat: 新機能追加', body, 'feat/issue-123', 'develop')).toEqual(created)
      expect(restRequests(server).map(request => JSON.stringify(request.body))).toEqual([
        JSON.stringify({ title: 'feat: 新機能追加', body, head: 'feat/issue-123', base: 'develop', draft: false }),
      ])
    })
  })

  it('draft を true で指定すると、送信する本文に draft: true を含める', async () => {
    await explains('`createPullRequest` のテストです。`draft` を `true` で指定した場合に、送信する本文に `draft: true` が含まれることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/pulls', { status: 201, body: { number: 43, draft: true } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.createPullRequest('owner', 'repo', 'WIP: 作業中', '作業中です', 'feat/wip', 'develop', true)).toEqual({ number: 43, draft: true })
      expect(restRequests(server).map(request => request.body)).toMatchObject([{ draft: true }])
    })
  })

  it.each([
    ['base が存在しない', 'Validation failed: base branch does not exist'],
    ['既に PR がある', 'A pull request already exists'],
  ])('422（%s）が返ると、GitHubAPIError を発生させる', async (_label, text) => {
    await explains(`\`createPullRequest\` のテストです。ステータス 422 で「${_label}」の場合に、ステータスコードと応答本文を保持する \`GitHubAPIError\` が発生することを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('POST', '/repos/owner/repo/pulls', { status: 422, text })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createPullRequest('owner', 'repo', 'Test', 'body', 'feat/test', 'nonexistent'))).toMatchObject(
        failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: text }),
      )
    })
  })
})

describe('getPullRequestSlim', () => {
  it('基本の項目を snake_case で返し、本文の Refs を referenced_issues に含める', async () => {
    await explains('PR の概要を取得する `getPullRequestSlim` のテストです。基本の項目を `snake_case` のキーで返し、本文の `Refs #123` を `referenced_issues` に含めることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest() } })], 'ghes.example.com')
      return { client, server }
    })
    const result = await step('getPullRequestSlim を呼ぶ', async () => await client.getPullRequestSlim('owner', 'repo', 42))
    await step('送った要求を確かめる', () => {
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
  })

  it('ドラフトで mergeable が UNKNOWN の場合は、その値をそのまま返す', async () => {
    await explains('`getPullRequestSlim` のテストです。ドラフトの PR で `mergeable` が `UNKNOWN` の場合に、`UNKNOWN` を変換せずに返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ isDraft: true, mergeable: 'UNKNOWN', body: '作業中' }) } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getPullRequestSlim('owner', 'repo', 43)).toMatchObject({ is_draft: true, mergeable: 'UNKNOWN', referenced_issues: [] })
    })
  })

  it('マージ済みの PR は、state に MERGED を返す', async () => {
    await explains('`getPullRequestSlim` のテストです。マージ済みの PR の場合に、`state` が `MERGED` で返ることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ state: 'MERGED' }) } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getPullRequestSlim('owner', 'repo', 46)).toMatchObject({ state: 'MERGED' })
    })
  })

  it('closingIssuesReferences を closing_issues として返し、Refs と重なる番号は referenced_issues から除く', async () => {
    await explains('`getPullRequestSlim` のテストです。`closingIssuesReferences` を `closing_issues` として返し、`Refs` と重複する番号を `referenced_issues` から除くことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({
        body: 'Fixes #123\n\nRefs #123\nRefs #456',
        closingIssuesReferences: { nodes: [{ number: 123, title: 'バグ報告' }] },
      }) } })])
      return { client }
    })
    const result = await step('getPullRequestSlim を呼ぶ', async () => await client.getPullRequestSlim('owner', 'repo', 51))
    await step('結果を確かめる', () => {
      expect(result.closing_issues).toEqual([{ number: 123, title: 'バグ報告' }])
      expect(result.referenced_issues).toEqual([{ number: 456, title: '' }])
    })
  })

  it('Fixes だけの本文は、referenced_issues に含めない', async () => {
    await explains('`getPullRequestSlim` のテストです。本文が `Fixes #123, Closes #456` だけの場合に、`closing_issues` が 2 件で `referenced_issues` が空であることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({
        body: 'Fixes #123, Closes #456',
        closingIssuesReferences: { nodes: [{ number: 123, title: 'バグ報告' }, { number: 456, title: '関連Issue' }] },
      }) } })])
      return { client }
    })
    const result = await step('getPullRequestSlim を呼ぶ', async () => await client.getPullRequestSlim('owner', 'repo', 44))
    await step('結果を確かめる', () => {
      expect(result.closing_issues).toHaveLength(2)
      expect(result.referenced_issues).toEqual([])
    })
  })

  it('Refs は番号の昇順で返し、ほかのリポジトリへの参照は除く', async () => {
    await explains('`getPullRequestSlim` のテストです。本文に複数の `Refs` と別リポジトリへの参照がある場合に、同じリポジトリの番号だけを昇順で `referenced_issues` に返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({
        body: 'x\nRefs #12\nRefs #5\nRefs other/repo#7\nRefs owner/repo#3',
        closingIssuesReferences: { nodes: [{ number: 12, title: 'closing' }, JSON_NULL] },
      }) } })])
      return { client }
    })
    const result = await step('getPullRequestSlim を呼ぶ', async () => await client.getPullRequestSlim('owner', 'repo', 9))
    await step('結果を確かめる', () => {
      expect(result.referenced_issues).toEqual([{ number: 3, title: '' }, { number: 5, title: '' }])
    })
  })

  it('レビューの投稿者が null の場合は null、login が空の場合は空文字のまま返す', async () => {
    await explains('`getPullRequestSlim` のテストです。レビューの投稿者が `null` の場合は `null`、`login` が空の場合は空文字のまま返し、`null` の要素は除くことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ reviews: { nodes: [
        { state: 'APPROVED', author: { login: 'reviewer1' } },
        { state: 'CHANGES_REQUESTED', author: { login: 'reviewer2' } },
        { state: 'COMMENTED', author: JSON_NULL },
        { state: 'COMMENTED', author: { login: '' } },
        JSON_NULL,
      ] } }) } })])
      return { client }
    })
    const result = await step('getPullRequestSlim を呼ぶ', async () => await client.getPullRequestSlim('owner', 'repo', 45))
    await step('結果を確かめる', () => {
      expect(result.reviews).toEqual([
        { state: 'APPROVED', author: 'reviewer1' },
        { state: 'CHANGES_REQUESTED', author: 'reviewer2' },
        { state: 'COMMENTED', author: JSON_NULL },
        { state: 'COMMENTED', author: '' },
      ])
    })
  })

  it('PR が存在しない場合は、GitHubNotFoundError を発生させる', async () => {
    await explains('`getPullRequestSlim` のテストです。応答の `pullRequest` が `null` の場合に、`PR not found: owner/repo/999` を持つ `GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: JSON_NULL } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getPullRequestSlim('owner', 'repo', 999))).toMatchObject(failure(GitHubNotFoundError, 'PR not found: owner/repo/999'))
    })
  })

  it('リポジトリが存在しない場合は、GitHubNotFoundError を発生させる', async () => {
    await explains('`getPullRequestSlim` のテストです。応答の `repository` が `null` の場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: JSON_NULL })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getPullRequestSlim('owner', 'nonexistent', 42))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
    })
  })

  it('本文が存在しない場合は、GitHubAPIError を発生させる', async () => {
    await explains('`getPullRequestSlim` のテストです。応答の `body` が `null` の場合に、`malformed GitHub response: pullRequest.body` を持つ `GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ body: JSON_NULL }) } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getPullRequestSlim('owner', 'repo', 42))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.body'))
    })
  })

  it('isDraft が真偽値でない場合は、GitHubAPIError を発生させる', async () => {
    await explains('`getPullRequestSlim` のテストです。応答の `isDraft` が真偽値ではない場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestSlim', { repository: { pullRequest: pullRequest({ isDraft: 'no' }) } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getPullRequestSlim('owner', 'repo', 42))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.isDraft'))
    })
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
        { author: { login: 'r1' }, body: 'fix', createdAt: '2026-01-01T00:00:00Z', url: 'https://github.com/owner/repo/pull/9#discussion_r1' },
        { author: JSON_NULL, body: JSON_NULL },
        JSON_NULL,
      ] } },
      { isResolved: true, comments: { nodes: [] } },
      JSON_NULL,
    ] },
  })

  it('レビューの本文と投稿日時、行コメントのスレッドを加えて返す', async () => {
    await explains('レビューと行コメントを含む PR を取得する `getPullRequestWithReviews` のテストです。レビューの本文・投稿日時と、行コメントのスレッドを `snake_case` のキーで返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetPullRequestWithReviews', { repository: { pullRequest: response } })])
      return { client, server }
    })
    const result = await step('getPullRequestWithReviews を呼ぶ', async () => await client.getPullRequestWithReviews('owner', 'repo', 9))
    await step('送った要求を確かめる', () => {
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
            { author: 'r1', body: 'fix', created_at: '2026-01-01T00:00:00Z', url: 'https://github.com/owner/repo/pull/9#discussion_r1' },
            { author: JSON_NULL, body: '', created_at: JSON_NULL, url: JSON_NULL },
          ] },
          { is_resolved: true, path: JSON_NULL, line: JSON_NULL, comments: [] },
        ],
      }))
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetPullRequestWithReviews', variables: { owner: 'owner', repo: 'repo', number: 9 } }])
    })
  })

  it('PR が存在しない場合は、GitHubNotFoundError を発生させる', async () => {
    await explains('`getPullRequestWithReviews` のテストです。応答の `pullRequest` が `null` の場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestWithReviews', { repository: { pullRequest: JSON_NULL } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getPullRequestWithReviews('owner', 'repo', 5))).toMatchObject(failure(GitHubNotFoundError, 'PR not found: owner/repo/5'))
    })
  })
})

describe('mergePullRequest', () => {
  it.each([[undefined, 'squash'], ['merge', 'merge'], ['rebase', 'rebase'], ['squash', 'squash']])('マージ方法 %s は merge_method=%s で PUT する', async (method, expected) => {
    await explains(`PR をマージする \`mergePullRequest\` のテストです。マージ方法が \`${String(method)}\` の場合に、\`merge_method\` を \`${expected}\` にして PUT することを確認します。`)
    const { merged, client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const merged = { sha: 'abc123def456', merged: true, message: 'Pull Request successfully merged' }
      const { client, server } = await startClient([restResponse('PUT', '/repos/owner/repo/pulls/42/merge', { status: 200, body: merged })])
      return { merged, client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.mergePullRequest('owner', 'repo', 42, method)).toEqual(merged)
      expect(restRequests(server).map(({ method: requestMethod, body }) => ({ method: requestMethod, body }))).toEqual([{ method: 'PUT', body: { merge_method: expected } }])
    })
  })

  it('sha を指定すると、merge_method と sha を送信する', async () => {
    await explains('`mergePullRequest` のテストです。`sha` を指定した場合に、`merge_method` と `sha` を本文に含めて PUT することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('PUT', '/repos/owner/repo/pulls/42/merge', { status: 200, body: { merged: true } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.mergePullRequest('owner', 'repo', 42, 'squash', 'abc123')).toEqual({ merged: true })
      expect(restRequests(server).map(({ body }) => body)).toEqual([{ merge_method: 'squash', sha: 'abc123' }])
    })
  })

  it('404 が返ると、GitHubNotFoundError を発生させる', async () => {
    await explains('`mergePullRequest` のテストです。存在しない PR で 404 が返った場合に、要求した URL を含む `GitHubNotFoundError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('PUT', '/repos/owner/repo/pulls/999/merge', { status: 404, text: 'Not Found' })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.mergePullRequest('owner', 'repo', 999))).toMatchObject(
        failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/pulls/999/merge`, { statusCode: 404 }),
      )
    })
  })

  it.each([
    [405, 'Pull Request is not mergeable'],
    [422, 'Pull Request is not open'],
  ])('%i が返ると、GitHubAPIError を発生させる', async (status, text) => {
    await explains(`\`mergePullRequest\` のテストです。マージできない PR でステータス ${String(status)} が返った場合に、ステータスコードと応答本文を保持する \`GitHubAPIError\` が発生することを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', '/repos/owner/repo/pulls/42/merge', { status, text })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.mergePullRequest('owner', 'repo', 42))).toMatchObject(
        failure(GitHubAPIError, `GitHub API error: ${String(status)}`, { statusCode: status, responseBody: text }),
      )
    })
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
  it('1 ページ目は after に null を送信し、dependabot の PR だけを返す', async () => {
    await explains('dependabot の PR を取得する `listOpenDependabotPullRequests` のテストです。1 ページ目の要求で `after` を `null` にし、投稿者が Bot の `dependabot` の PR だけを返すことを確認します。')
    const { mine, client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const mine = { number: 1, author: BOT }
      const others = [
        { number: 2, author: { __typename: 'User', login: 'dependabot' } },
        { number: 3, author: { __typename: 'Bot', login: 'other-bot' } },
        { number: 4, author: JSON_NULL },
        JSON_NULL,
        {},
      ]
      const { client, server } = await startClient([graphqlData('ListOpenPullRequests', pullRequestPage([mine, ...others], LAST_PAGE))])
      return { mine, client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listOpenDependabotPullRequests('owner', 'repo')).toEqual([mine])
      expect(graphqlRequests(server)).toEqual([{ operation: 'ListOpenPullRequests', variables: { owner: 'owner', repo: 'repo', after: JSON_NULL } }])
    })
  })

  it('次のページは、endCursor を after に指定して取得する', async () => {
    await explains('`listOpenDependabotPullRequests` のテストです。次のページがある場合に、`endCursor` を `after` に指定して続きを取得し、全ページの PR を結合して返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        graphqlData('ListOpenPullRequests', pullRequestPage([{ number: 1, author: BOT }], { hasNextPage: true, endCursor: 'c1' })),
        graphqlData('ListOpenPullRequests', pullRequestPage([{ number: 2, author: BOT }], LAST_PAGE)),
      ])
      return { client, server }
    })
    const nodes = await step('listOpenDependabotPullRequests を呼ぶ', async () => await client.listOpenDependabotPullRequests('owner', 'repo'))
    await step('送った要求を確かめる', () => {
      expect(numbersOf(nodes)).toEqual([1, 2])
      expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([{ owner: 'owner', repo: 'repo', after: JSON_NULL }, { owner: 'owner', repo: 'repo', after: 'c1' }])
    })
  })

  it.for([
    { name: 'repository が null', data: { repository: JSON_NULL }, message: 'the PR list response has no repository.pullRequests' },
    { name: 'pullRequests が null', data: { repository: { pullRequests: JSON_NULL } }, message: 'the PR list response has no repository.pullRequests' },
    { name: 'nodes が配列でない', data: pullRequestPage('x', LAST_PAGE), message: 'nodes in the PR list response is not an array' },
    { name: '次のページがあるのに endCursor が無い', data: pullRequestPage([], { hasNextPage: true, endCursor: JSON_NULL }), message: 'the next page of the PR list has no endCursor' },
  ])('$name の場合は、GitHubAPIError を発生させる', async ({ data, message }) => {
    await explains(`\`listOpenDependabotPullRequests\` のテストです。PR 一覧の応答が不正な場合に、\`${message}\` を持つ \`GitHubAPIError\` が発生することを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('ListOpenPullRequests', data)])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.listOpenDependabotPullRequests('owner', 'repo'))).toMatchObject(failure(GitHubAPIError, message))
    })
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
  it('open・closed・merged の PR を、リポジトリ・番号・状態・ブランチ名・ドラフト・fork かどうかとともに返す', async () => {
    await explains('head のブランチ名で PR を取得する `listPullRequestsByHead` のテストです。状態が `OPEN`・`CLOSED`・`MERGED` の PR を、リポジトリ・番号・状態・ブランチ名・ドラフト・fork かどうかの項目つきで返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        graphqlData('ListPullRequestsByHead', {
          repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node(5, 'MERGED'), node(6, 'OPEN', { isDraft: true, baseRefName: 'feat/issue-8' }), node(7, 'CLOSED', { isCrossRepository: true })] } },
        }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
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
  })

  it('PR が存在しない場合は、空の一覧を返す', async () => {
    await explains('`listPullRequestsByHead` のテストです。該当する PR が存在しない場合に、空の一覧と `hasNextPage` が `false` の結果を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('ListPullRequestsByHead', { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9')).toEqual({ pullRequests: [], hasNextPage: false })
    })
  })

  it('先頭の 20 件に収まらない場合は、hasNextPage を true にする', async () => {
    await explains('`listPullRequestsByHead` のテストです。応答の `pageInfo.hasNextPage` が `true` の場合に、結果の `hasNextPage` が `true` になることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('ListPullRequestsByHead', { repository: { pullRequests: { pageInfo: { hasNextPage: true }, nodes: [node(5, 'OPEN')] } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9')).toMatchObject({ pullRequests: [{ number: 5 }], hasNextPage: true })
    })
  })

  it('リポジトリが存在しない場合は、GitHubNotFoundError を発生させる', async () => {
    await explains('`listPullRequestsByHead` のテストです。応答の `repository` が `null` の場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('ListPullRequestsByHead', { repository: JSON_NULL })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9'))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/repo'))
    })
  })

  it('状態が未知の値の場合は、GitHubAPIError を発生させる', async () => {
    await explains('`listPullRequestsByHead` のテストです。PR の状態が `DRAFT` のように想定外の値の場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('ListPullRequestsByHead', { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [node(5, 'DRAFT')] } } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.listPullRequestsByHead('owner', 'repo', 'feat/issue-9'))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.state (DRAFT)'))
    })
  })
})

function pageByBase(hasNextPage: boolean, ...nodes: readonly Readonly<Record<string, unknown>>[]): Readonly<Record<string, unknown>> {
  return { repository: { pullRequests: { pageInfo: { hasNextPage }, nodes } } }
}

describe('listPullRequestsByBase', () => {
  const variables = { owner: 'owner', repo: 'repo', baseRefName: 'feat/issue-9' }

  it('base のブランチ名で開いている PR を取得し、fork ではない PR の番号と head のブランチ名を返す', async () => {
    await explains('base のブランチ名で PR を取得する `listPullRequestsByBase` のテストです。fork からの PR を除き、PR の番号と head のブランチ名を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const above = node(10, 'OPEN', { headRefName: 'feat/issue-10', baseRefName: 'feat/issue-9' })
      const fork = node(11, 'OPEN', { headRefName: 'feat/issue-11', baseRefName: 'feat/issue-9', isCrossRepository: true })
      const later = node(12, 'OPEN', { headRefName: 'feat/issue-12', baseRefName: 'feat/issue-9' })
      const { client, server } = await startClient([graphqlData('ListPullRequestsByBase', pageByBase(false, above, fork, later))])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listPullRequestsByBase('owner', 'repo', 'feat/issue-9')).toEqual({
        pullRequests: [{ number: 10, headRefName: 'feat/issue-10' }, { number: 12, headRefName: 'feat/issue-12' }],
        hasNextPage: false,
      })
      expect(graphqlRequests(server)).toEqual([{ operation: 'ListPullRequestsByBase', variables }])
    })
  })

  it('PR が存在しない場合は、空の一覧を返す', async () => {
    await explains('`listPullRequestsByBase` のテストです。該当する PR が存在しない場合に、空の一覧を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('ListPullRequestsByBase', pageByBase(false))])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listPullRequestsByBase('owner', 'repo', 'feat/issue-9')).toEqual({ pullRequests: [], hasNextPage: false })
    })
  })

  it('先頭の 20 件に収まらない場合は、hasNextPage を true にする', async () => {
    await explains('`listPullRequestsByBase` のテストです。応答の `pageInfo.hasNextPage` が `true` の場合に、結果の `hasNextPage` が `true` になることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const first = node(10, 'OPEN')
      const { client } = await startClient([graphqlData('ListPullRequestsByBase', pageByBase(true, first))])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listPullRequestsByBase('owner', 'repo', 'feat/issue-9')).toEqual({ pullRequests: [{ number: 10, headRefName: 'feat/issue-9' }], hasNextPage: true })
    })
  })

  it('リポジトリが存在しない場合は、GitHubNotFoundError を発生させる', async () => {
    await explains('`listPullRequestsByBase` のテストです。応答の `repository` が `null` の場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('ListPullRequestsByBase', { repository: JSON_NULL })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.listPullRequestsByBase('owner', 'repo', 'feat/issue-9'))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/repo'))
    })
  })
})

const STACK_VERSION = '2026-03-10'

function stackOf(number: number, pullRequests: readonly number[]): Readonly<Record<string, unknown>> {
  return { id: 900 + number, number, open: true, base: { ref: 'main' }, pull_requests: pullRequests.map(pr => ({ number: pr, state: 'open', head: { ref: `feat/x/${String(pr)}` } })) }
}

describe('getStackOfPullRequest', () => {
  it('pull_request で絞って GET し、その PR を含むスタックの番号と、下から順の PR 番号を返す', async () => {
    await explains('PR が属するスタックを取得する `getStackOfPullRequest` のテストです。`pull_request` を指定して GET し、その PR を含むスタックの番号と、下から順の PR 番号を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        { match: { method: 'GET', path: '/repos/owner/repo/stacks', query: { pull_request: '11' }, apiVersion: STACK_VERSION }, respond: { status: 200, body: [stackOf(3, [11, 12])] }, times: 1 },
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getStackOfPullRequest('owner', 'repo', 11)).toEqual({ number: 3, pullRequests: [11, 12] })
      expect(restRequests(server).map(({ method, path, query }) => ({ method, path, query }))).toEqual([{ method: 'GET', path: '/repos/owner/repo/stacks', query: { pull_request: '11' } }])
    })
  })

  it('応答が空の配列の場合は、undefined を返す', async () => {
    await explains('`getStackOfPullRequest` のテストです。応答が空の配列の場合に、`undefined` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [] })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getStackOfPullRequest('owner', 'repo', 11)).toBeUndefined()
    })
  })

  it('その PR を含むスタックが存在しない場合は、undefined を返す', async () => {
    await explains('`getStackOfPullRequest` のテストです。応答のスタックに対象の PR が含まれない場合に、`undefined` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [stackOf(3, [20, 21])] })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getStackOfPullRequest('owner', 'repo', 11)).toBeUndefined()
    })
  })

  it('対象の PR を含まないスタックの形式が不正でも、読み飛ばして対象を含むスタックを返す', async () => {
    await explains('`getStackOfPullRequest` のテストです。対象の PR を含まないスタックの形式が不正な場合でも、エラーにせず、対象を含むスタックを返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [{ number: 'x', pull_requests: 'broken' }, { pull_requests: [{ number: 20 }] }, stackOf(3, [11, 12])] })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getStackOfPullRequest('owner', 'repo', 11)).toEqual({ number: 3, pullRequests: [11, 12] })
    })
  })

  it('対象の PR を含むスタックの番号が数値でない場合は、GitHubAPIError を発生させる', async () => {
    await explains('`getStackOfPullRequest` のテストです。対象の PR を含むスタックの `number` が数値ではない場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [{ number: 'x', pull_requests: [{ number: 11 }] }] })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getStackOfPullRequest('owner', 'repo', 11))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: stack.number'))
    })
  })

  it('応答が配列でない場合は、GitHubAPIError を発生させる', async () => {
    await explains('`getStackOfPullRequest` のテストです。応答が配列ではない場合に、`malformed GitHub response: stacks` を持つ `GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: { number: 3 } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getStackOfPullRequest('owner', 'repo', 11))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: stacks'))
    })
  })

  it('pull_requests の番号が数値でない場合は、GitHubAPIError を発生させる', async () => {
    await explains('`getStackOfPullRequest` のテストです。`pull_requests` の `number` が数値ではない場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 200, body: [{ number: 3, pull_requests: [{ number: '11' }] }] })])
      return { client }
    })
    await step('エラーと送った要求を確かめる', async () => {
      expect(await rejection(client.getStackOfPullRequest('owner', 'repo', 11))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: stack.pull_requests.number'))
    })
  })

  it('404（スタックの機能がないリポジトリ）が返ると、GitHubNotFoundError を発生させる', async () => {
    await explains('`getStackOfPullRequest` のテストです。スタックの機能がないリポジトリで 404 が返った場合に、要求した URL を含む `GitHubNotFoundError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/stacks', { status: 404, text: 'Not Found' })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getStackOfPullRequest('owner', 'repo', 11))).toMatchObject(
        failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/stacks?pull_request=11`, { statusCode: 404 }),
      )
    })
  })
})

describe('createStack', () => {
  it('PR 番号を指定した順（下から）のまま POST し、作成したスタックを返す', async () => {
    await explains('スタックを作成する `createStack` のテストです。PR 番号を指定した順（下から）のまま送信し、作成したスタックの番号と PR 番号を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        { match: { method: 'POST', path: '/repos/owner/repo/stacks', apiVersion: STACK_VERSION }, respond: { status: 201, body: stackOf(4, [11, 12]) }, times: 1 },
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.createStack('owner', 'repo', [11, 12])).toEqual({ number: 4, pullRequests: [11, 12] })
      expect(restRequests(server).map(request => JSON.stringify(request.body))).toEqual([JSON.stringify({ pull_requests: [11, 12] })])
    })
  })

  it('404 が返ると、GitHubNotFoundError を発生させる', async () => {
    await explains('`createStack` のテストです。404 が返った場合に、要求した URL を含む `GitHubNotFoundError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/stacks', { status: 404, text: 'Not Found' })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createStack('owner', 'repo', [11, 12]))).toMatchObject(
        failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/stacks`, { statusCode: 404 }),
      )
    })
  })

  it('422（base が親の PR の head と合わない）が返ると、GitHubAPIError を発生させる', async () => {
    await explains('`createStack` のテストです。422 が返った場合に、ステータスコードと応答本文を保持する `GitHubAPIError` が発生することを確認します。')
    const { text, client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const text = 'Validation Failed'
      const { client } = await startClient([restResponse('POST', '/repos/owner/repo/stacks', { status: 422, text })])
      return { text, client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createStack('owner', 'repo', [11, 12]))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: text }))
    })
  })
})

describe('addToStack', () => {
  it('スタックの番号のパスに PR 番号を POST し、追加後のスタックを返す', async () => {
    await explains('スタックに PR を追加する `addToStack` のテストです。スタックの番号のパスへ PR 番号を送信し、追加後のスタックを返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        { match: { method: 'POST', path: '/repos/owner/repo/stacks/4/add', apiVersion: STACK_VERSION }, respond: { status: 200, body: stackOf(4, [11, 12, 13]) }, times: 1 },
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.addToStack('owner', 'repo', 4, [13])).toEqual({ number: 4, pullRequests: [11, 12, 13] })
      expect(restRequests(server).map(request => JSON.stringify(request.body))).toEqual([JSON.stringify({ pull_requests: [13] })])
    })
  })

  it('404 が返ると、GitHubNotFoundError を発生させる', async () => {
    await explains('`addToStack` のテストです。404 が返った場合に、要求した URL を含む `GitHubNotFoundError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/stacks/4/add', { status: 404, text: 'Not Found' })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.addToStack('owner', 'repo', 4, [13]))).toMatchObject(
        failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/stacks/4/add`, { statusCode: 404 }),
      )
    })
  })

  it.each([409, 422])('%i が返ると、GitHubAPIError を発生させる', async (status) => {
    await explains(`\`addToStack\` のテストです。ステータス ${String(status)} が返った場合に、ステータスコードと応答本文を保持する \`GitHubAPIError\` が発生することを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('POST', '/repos/owner/repo/stacks/4/add', { status, text: 'conflict' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.addToStack('owner', 'repo', 4, [13]))).toMatchObject(
        failure(GitHubAPIError, `GitHub API error: ${String(status)}`, { statusCode: status, responseBody: 'conflict' }),
      )
    })
  })
})

describe('API の版', () => {
  it('API の版を指定しない要求は、これまでどおり 2022-11-28 を送信する', async () => {
    await explains('API の版のテストです。版を指定しない `mergePullRequest` の要求の場合に、版 `2022-11-28` を送信することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([
        { match: { method: 'PUT', path: '/repos/owner/repo/pulls/42/merge', apiVersion: '2022-11-28' }, respond: { status: 200, body: { merged: true } }, times: 1 },
      ])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.mergePullRequest('owner', 'repo', 42)).toEqual({ merged: true })
    })
  })
})

function finishNode(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    number: 11, state: 'MERGED', body: 'Closes #3', headRefName: 'feat/x/3', baseRefName: 'main', isDraft: false,
    closingIssuesReferences: { nodes: [{ number: 3, repository: { name: 'repo', owner: { login: 'owner' } } }] },
    baseRepository: { defaultBranchRef: { name: 'main' } },
    ...overrides,
  }
}

describe('getPullRequestForFinish', () => {
  it('PR の終了処理で、閉じる Issue を決める項目を返す', async () => {
    await explains('PR の終了処理に必要な情報を取得する `getPullRequestForFinish` のテストです。`state`・`body`・ブランチ名・閉じる Issue・既定ブランチを `snake_case` のキーで返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetPullRequestForFinish', { repository: { pullRequest: finishNode() } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getPullRequestForFinish('owner', 'repo', 11)).toEqual({
        state: 'MERGED', body: 'Closes #3', head_ref: 'feat/x/3', base_ref: 'main', is_draft: false,
        closing_issues: [{ owner: 'owner', repository: 'repo', number: 3 }], default_branch: 'main',
      })
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetPullRequestForFinish', variables: { owner: 'owner', repo: 'repo', number: 11 } }])
    })
  })

  it('既定ブランチがないリポジトリでは、default_branch を undefined にする', async () => {
    await explains('`getPullRequestForFinish` のテストです。既定ブランチの情報が `null` の場合に、`default_branch` が `undefined` になることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      // eslint-disable-next-line unicorn/no-null -- 応答の形（既定ブランチが無いと null）
      const { client } = await startClient([graphqlData('GetPullRequestForFinish', { repository: { pullRequest: finishNode({ baseRepository: { defaultBranchRef: null } }) } })])
      return { client }
    })
    const pullRequest = await step('getPullRequestForFinish を呼ぶ', async () => await client.getPullRequestForFinish('owner', 'repo', 11))
    await step('結果を確かめる', () => {
      expect(pullRequest.default_branch).toBeUndefined()
    })
  })
})

function mergeNode(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { number: 11, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: 'abc123', isMergeQueueEnabled: false, isInMergeQueue: false, ...overrides }
}

describe('getPullRequestForMerge', () => {
  it('マージの可否の判断に使う項目を返す', async () => {
    await explains('マージの判断に必要な情報を取得する `getPullRequestForMerge` のテストです。`state`・`isDraft`・`headRefOid`・`isMergeQueueEnabled` などの項目を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetPullRequestForMerge', { repository: { pullRequest: mergeNode({ isMergeQueueEnabled: true }) } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getPullRequestForMerge('owner', 'repo', 11)).toEqual({
        number: 11, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: 'abc123', isMergeQueueEnabled: true, isInMergeQueue: false,
      })
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetPullRequestForMerge', variables: { owner: 'owner', repo: 'repo', number: 11 } }])
    })
  })

  it('PR が存在しない場合は、GitHubNotFoundError を発生させる', async () => {
    await explains('`getPullRequestForMerge` のテストです。応答の `pullRequest` が `null` の場合に、`PR not found: owner/repo/11` を持つ `GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      // eslint-disable-next-line unicorn/no-null -- 応答の形（PR が無いと null）
      const { client } = await startClient([graphqlData('GetPullRequestForMerge', { repository: { pullRequest: null } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getPullRequestForMerge('owner', 'repo', 11))).toMatchObject(failure(GitHubNotFoundError, 'PR not found: owner/repo/11'))
    })
  })

  it('isMergeQueueEnabled が真偽値でない場合は、GitHubAPIError を発生させる', async () => {
    await explains('`getPullRequestForMerge` のテストです。応答の `isMergeQueueEnabled` が真偽値ではない場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetPullRequestForMerge', { repository: { pullRequest: mergeNode({ isMergeQueueEnabled: 'yes' }) } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getPullRequestForMerge('owner', 'repo', 11))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.isMergeQueueEnabled'))
    })
  })

  it.for([
    'Field \'isMergeQueueEnabled\' doesn\'t exist on type \'PullRequest\'',
    'Cannot query field "isInMergeQueue" on type "PullRequest"',
  ])('merge queue の項目がスキーマに存在しない失敗（%s）は、項目なしのクエリで読み直し、どちらも false にする', async (message) => {
    await explains(`\`getPullRequestForMerge\` のテストです。merge queue の項目が原因で「${message}」のエラーになった場合は、項目なしのクエリで読み直し、2 項目を \`false\` にすることを確認します。`)
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const withoutQueue = { number: 11, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: 'abc123' }
      const { client, server } = await startClient([
        graphqlError('GetPullRequestForMerge', message),
        graphqlData('GetPullRequestForMergeWithoutQueue', { repository: { pullRequest: withoutQueue } }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getPullRequestForMerge('owner', 'repo', 11)).toEqual({
        number: 11, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: 'abc123', isMergeQueueEnabled: false, isInMergeQueue: false,
      })
      expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetPullRequestForMerge', 'GetPullRequestForMergeWithoutQueue'])
    })
  })

  it('merge queue の項目に関係しないスキーマの失敗は、読み直さずにそのまま発生させる', async () => {
    await explains('`getPullRequestForMerge` のテストです。`headRefOid` のように merge queue 以外の項目のスキーマの失敗の場合に、読み直さず `GitHubAPIError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlError('GetPullRequestForMerge', 'Cannot query field "headRefOid" on type "PullRequest"')])
      return { client, server }
    })
    const error = await step('getPullRequestForMerge を呼ぶ', async () => await rejection(client.getPullRequestForMerge('owner', 'repo', 11)))
    await step('送った要求を確かめる', () => {
      expect(error).toBeInstanceOf(GitHubAPIError)
      expect(error).toHaveProperty('message', expect.stringContaining('Cannot query field "headRefOid" on type "PullRequest"'))
      expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetPullRequestForMerge'])
    })
  })
})

const MERGE_ASYNC = '/repos/owner/repo/pulls/11/merge-async'

function pendingBody(uuid = 'u-1'): Readonly<Record<string, unknown>> {
  return { status: 'pending', details: { message: 'Merge request accepted', uuid, merge_method: 'squash', merge_action: 'default', expected_head_sha: 'abc123', bypass_rules: false } }
}

describe('requestAsyncMerge', () => {
  it('merge queue のないブランチでは、版 2026-03-10 で sha と merge_method: squash だけを PUT する', async () => {
    await explains('非同期にマージを要求する `requestAsyncMerge` のテストです。merge queue のないブランチの場合に、版 `2026-03-10` で `sha` と `merge_method: squash` だけを送信し、受理された結果を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        { match: { method: 'PUT', path: MERGE_ASYNC, apiVersion: STACK_VERSION }, respond: { status: 202, body: pendingBody() }, times: 1 },
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false })).toEqual({ outcome: 'accepted', result: { status: 'pending', uuid: 'u-1', message: 'Merge request accepted' } })
      expect(restRequests(server).map(request => JSON.stringify(request.body))).toEqual([JSON.stringify({ sha: 'abc123', merge_method: 'squash' })])
    })
  })

  it('merge queue のあるブランチでは、sha だけを PUT し、merge_method・commit_title・commit_message・merge_action は送信しない', async () => {
    await explains('`requestAsyncMerge` のテストです。merge queue のあるブランチの場合に、`sha` だけを送信し、`merge_method` などのほかの項目を送信しないことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        { match: { method: 'PUT', path: MERGE_ASYNC, apiVersion: STACK_VERSION }, respond: { status: 202, body: pendingBody() }, times: 1 },
      ])
      return { client, server }
    })
    await step('requestAsyncMerge を呼ぶ', async () => {
      await client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: true })
    })
    await step('送った要求を確かめる', () => {
      expect(restRequests(server).map(request => JSON.stringify(request.body))).toEqual([JSON.stringify({ sha: 'abc123' })])
    })
  })

  it.each([
    ['既にマージ済み', { status: 'merged', details: { message: 'Pull request merged', sha: 'def456' } }, { status: 'merged', message: 'Pull request merged' }],
    ['キューの中', { status: 'enqueued', details: { message: 'Added to the merge queue' } }, { status: 'enqueued', message: 'Added to the merge queue' }],
  ])('200（%s）が返ると、本文の status と details.message を返す', async (_label, body, expected) => {
    await explains(`\`requestAsyncMerge\` のテストです。ステータス 200 で「${_label}」の応答の場合に、\`outcome\` が \`accepted\` で、本文の \`status\` と \`details.message\` を返すことを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', MERGE_ASYNC, { status: 200, body })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false })).toEqual({ outcome: 'accepted', result: expected })
    })
  })

  it('400（閉じている PR など）が返ると、GitHub の message を rejected として返す', async () => {
    await explains('`requestAsyncMerge` のテストです。閉じている PR などで 400 が返った場合に、`outcome` が `rejected` で、GitHub の `message` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', MERGE_ASYNC, { status: 400, body: { message: 'Pull request is closed', documentation_url: 'https://docs.github.com', status: '400' } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false })).toEqual({ outcome: 'rejected', message: 'Pull request is closed' })
    })
  })

  it('400 の本文が JSON でない場合は、本文の文字列を rejected として返す', async () => {
    await explains('`requestAsyncMerge` のテストです。400 の本文が JSON ではない場合に、`outcome` が `rejected` で、本文の文字列を `message` に返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', MERGE_ASYNC, { status: 400, text: 'Bad Request' })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false })).toEqual({ outcome: 'rejected', message: 'Bad Request' })
    })
  })

  it('409（同じ PR の要求が既に存在する）が返ると、本文の uuid を conflict として返す', async () => {
    await explains('`requestAsyncMerge` のテストです。同じ PR の要求が既に存在して 409 が返った場合に、`outcome` が `conflict` で、本文の `uuid` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', MERGE_ASYNC, { status: 409, body: pendingBody('u-old') })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false })).toEqual({ outcome: 'conflict', uuid: 'u-old' })
    })
  })

  it('409 の本文に uuid が存在しない場合は、uuid を持たない conflict を返す', async () => {
    await explains('`requestAsyncMerge` のテストです。409 の本文に `uuid` が存在しない場合は、`uuid` なしの `conflict` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', MERGE_ASYNC, { status: 409, body: { message: 'A merge request already exists' } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false })).toEqual({ outcome: 'conflict' })
    })
  })

  it.each([403, 422])('%i が返ると、ほかの API と同じ GitHubAPIError を発生させる', async (status) => {
    await explains(`\`requestAsyncMerge\` のテストです。ステータス ${String(status)} が返った場合に、ステータスコードと応答本文を保持する \`GitHubAPIError\` が発生することを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', MERGE_ASYNC, { status, text: 'nope' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false }))).toMatchObject(
        failure(GitHubAPIError, status === 403 ? 'access denied' : 'GitHub API error: 422', { statusCode: status, responseBody: 'nope' }),
      )
    })
  })

  it('status が未知の値の場合は、GitHubAPIError を発生させる', async () => {
    await explains('`requestAsyncMerge` のテストです。本文の `status` が `queued` のように想定外の値の場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', MERGE_ASYNC, { status: 202, body: { status: 'queued', details: {} } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false }))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: mergeAsync.status (queued)'))
    })
  })

  it('pending なのに uuid が存在しない場合は、GitHubAPIError を発生させる', async () => {
    await explains('`requestAsyncMerge` のテストです。`status` が `pending` で `uuid` が存在しない場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PUT', MERGE_ASYNC, { status: 202, body: { status: 'pending', details: { message: 'x' } } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.requestAsyncMerge('owner', 'repo', 11, { sha: 'abc123', mergeQueue: false }))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: mergeAsync.details.uuid'))
    })
  })
})

describe('getAsyncMergeResult', () => {
  it('uuid のパスを版 2026-03-10 で GET し、status を返す', async () => {
    await explains('非同期のマージ結果を取得する `getAsyncMergeResult` のテストです。uuid のパスへ版 `2026-03-10` で GET し、`status` と `message` を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        { match: { method: 'GET', path: `${MERGE_ASYNC}/u-1`, apiVersion: STACK_VERSION }, respond: { status: 200, body: { status: 'merged', details: { message: 'Pull request merged', sha: 'def456' } } }, times: 1 },
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getAsyncMergeResult('owner', 'repo', 11, 'u-1')).toEqual({ status: 'merged', message: 'Pull request merged' })
      expect(restRequests(server).map(({ method, path }) => [method, path])).toEqual([['GET', `${MERGE_ASYNC}/u-1`]])
    })
  })

  it.each([
    ['enqueued', 'Added to the merge queue'],
    ['failed', 'Repository rule violations found'],
  ])('status が %s の場合は、details.message をそのまま返す', async (status, message) => {
    await explains(`\`getAsyncMergeResult\` のテストです。\`status\` が \`${status}\` の場合に、\`details.message\` をそのまま返すことを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', `${MERGE_ASYNC}/u-1`, { status: 200, body: { status, details: { message } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getAsyncMergeResult('owner', 'repo', 11, 'u-1')).toEqual({ status, message })
    })
  })

  it('status が pending の場合は、uuid も返す', async () => {
    await explains('`getAsyncMergeResult` のテストです。`status` が `pending` の場合に、`uuid` も合わせて返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', `${MERGE_ASYNC}/u-1`, { status: 200, body: pendingBody() })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getAsyncMergeResult('owner', 'repo', 11, 'u-1')).toEqual({ status: 'pending', uuid: 'u-1', message: 'Merge request accepted' })
    })
  })

  it('404（24 時間を過ぎて結果が消えた）が返ると、undefined を返す', async () => {
    await explains('`getAsyncMergeResult` のテストです。24 時間を過ぎて結果が消え、404 が返った場合に、`undefined` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', `${MERGE_ASYNC}/u-1`, { status: 404, text: 'Not Found' })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getAsyncMergeResult('owner', 'repo', 11, 'u-1')).toBeUndefined()
    })
  })

  it('403 が返ると、GitHubAPIError を発生させる', async () => {
    await explains('`getAsyncMergeResult` のテストです。403 が返った場合に、`access denied` を持つ `GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', `${MERGE_ASYNC}/u-1`, { status: 403, text: 'nope' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getAsyncMergeResult('owner', 'repo', 11, 'u-1'))).toMatchObject(failure(GitHubAPIError, 'access denied', { statusCode: 403 }))
    })
  })
})
