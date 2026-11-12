// IssuesApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// get_issue_slim の期待値は、同じ応答を Python の GitHubClient に渡して得た辞書。
import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubAPIError, GitHubAuthError, GitHubNotFoundError } from '../errors.js'
import type { GitHubClient } from '../index.js'
import { failure, graphqlData, graphqlError, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

describe('createIssue', () => {
  it('title・body・labels を JSON で POST する', async () => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 201, body: { number: 124, title: 'New Issue' } })])
    const result = await client.createIssue('owner', 'repo', 'New Issue', 'Body text', ['bug'])
    expect(result).toEqual({ number: 124, title: 'New Issue' })
    expect(restRequests(server).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'POST', path: '/repos/owner/repo/issues', body: { title: 'New Issue', body: 'Body text', labels: ['bug'] } },
    ])
  })

  it.each<[readonly string[] | undefined]>([[undefined], [[]]])('labels が %j なら送らない', async (labels) => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 201, body: { number: 125 } })])
    await client.createIssue('owner', 'repo', 'Title', 'Body', labels)
    expect(restRequests(server).map(({ body }) => JSON.stringify(body))).toEqual(['{"title":"Title","body":"Body"}'])
  })

  it('body の既定は空文字', async () => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 201, body: {} })])
    await client.createIssue('owner', 'repo', 'Title')
    expect(restRequests(server).map(({ body }) => body)).toEqual([{ title: 'Title', body: '' }])
  })

  it('失敗の状態コードは例外にする', async () => {
    const { client } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 401, text: 'Bad credentials' })])
    expect(await rejection(client.createIssue('owner', 'repo', 'T'))).toMatchObject(
      failure(GitHubAuthError, 'authentication failed: check the token', { statusCode: 401 }),
    )
  })
})

describe('addIssueComment', () => {
  it('コメントを POST する', async () => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues/123/comments', { status: 201, body: { id: 456, body: 'Test comment' } })])
    const result = await client.addIssueComment('owner', 'repo', 123, 'Test comment')
    expect(result).toEqual({ id: 456, body: 'Test comment' })
    expect(restRequests(server).map(({ body }) => body)).toEqual([{ body: 'Test comment' }])
  })
})

describe('updateIssueComment', () => {
  it('コメント ID 宛てに PATCH する', async () => {
    const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/comments/456', { status: 200, body: { id: 456, body: 'New' } })])
    expect(await client.updateIssueComment('owner', 'repo', 456, 'New')).toEqual({ id: 456, body: 'New' })
    expect(restRequests(server).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PATCH', path: '/repos/owner/repo/issues/comments/456', body: { body: 'New' } },
    ])
  })

  it('404 は GitHubNotFoundError', async () => {
    const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/comments/999', { status: 404, text: 'Not Found' })])
    expect(await rejection(client.updateIssueComment('owner', 'repo', 999, 'x'))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/issues/comments/999`, { statusCode: 404 }),
    )
  })
})

describe('addIssueComment の失敗', () => {
  it('404 は GitHubNotFoundError', async () => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues/999/comments', { status: 404, text: 'Not Found' })])
    expect(await rejection(client.addIssueComment('owner', 'repo', 999, 'x'))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/issues/999/comments`, { statusCode: 404 }),
    )
  })
})

describe('getIssueNodeId / getIssueNodeIdAndTitle', () => {
  it('Node ID を返す。変数は owner・repo・number', async () => {
    const { client, server } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_kwDOtest123' } } })])
    expect(await client.getIssueNodeId('owner', 'repo', 123)).toBe('I_kwDOtest123')
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueNodeId', variables: { owner: 'owner', repo: 'repo', number: 123 } }])
  })

  it('Node ID とタイトルを 1 回のクエリで返す', async () => {
    const { client, server } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_kwDOtest123', title: '[Task] 題名' } } })])
    expect(await client.getIssueNodeIdAndTitle('owner', 'repo', 123)).toEqual({ id: 'I_kwDOtest123', title: '[Task] 題名' })
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('タイトルが無ければ空文字', async () => {
    const { client } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_1' } } })])
    expect(await client.getIssueNodeIdAndTitle('owner', 'repo', 1)).toEqual({ id: 'I_1', title: '' })
  })

  it('リポジトリが無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetIssueNodeId', { repository: JSON_NULL })])
    expect(await rejection(client.getIssueNodeId('owner', 'nonexistent', 123))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
  })

  it('Issue が無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: JSON_NULL } })])
    expect(await rejection(client.getIssueNodeId('owner', 'repo', 999))).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/999'))
  })

  it('id が文字列でなければ GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: { id: 5 } } })])
    expect(await rejection(client.getIssueNodeId('owner', 'repo', 1))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: issue.id'))
  })
})

describe('addSubIssue', () => {
  it('親と子の Issue 番号を返す。変数は parentId・childId', async () => {
    const { client, server } = await startClient([graphqlData('AddSubIssue', { addSubIssue: { issue: { number: 100 }, subIssue: { number: 101 } } })])
    expect(await client.addSubIssue('I_parent', 'I_child')).toEqual({ parent_number: 100, child_number: 101 })
    expect(graphqlRequests(server)).toEqual([{ operation: 'AddSubIssue', variables: { parentId: 'I_parent', childId: 'I_child' } }])
  })

  it('issue と subIssue が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('AddSubIssue', { addSubIssue: { issue: JSON_NULL, subIssue: JSON_NULL } })])
    expect(await rejection(client.addSubIssue('I_parent', 'I_child'))).toMatchObject(failure(GitHubAPIError, 'failed to link the sub-issue'))
  })

  it('addSubIssue が無くても GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('AddSubIssue', {})])
    expect(await rejection(client.addSubIssue('I_parent', 'I_child'))).toMatchObject(failure(GitHubAPIError, 'failed to link the sub-issue'))
  })
})

describe('getIssueKind', () => {
  const variables = { owner: 'owner', repo: 'repo', number: 100 }

  it.each([
    ['Epic', { name: 'Epic' }, 2, 'Epic', 2],
    ['Task', { name: 'Task' }, 0, 'Task', 0],
    ['issueType が null', JSON_NULL, 3, JSON_NULL, 3],
  ])('%s の種別を返す', async (_label, issueType, total, expectedType, expectedTotal) => {
    const { client, server } = await startClient([
      graphqlData('GetIssueKind', { repository: { issue: { number: 100, state: 'OPEN', issueType, subIssues: { totalCount: total } } } }),
    ])
    expect(await client.getIssueKind('owner', 'repo', 100)).toEqual({ number: 100, state: 'OPEN', issue_type: expectedType, sub_issues_total: expectedTotal })
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueKind', variables }])
  })

  it('subIssues が無ければ 0', async () => {
    const { client } = await startClient([graphqlData('GetIssueKind', { repository: { issue: { number: 1, state: 'CLOSED' } } })])
    expect(await client.getIssueKind('owner', 'repo', 1)).toEqual({ number: 1, state: 'CLOSED', issue_type: JSON_NULL, sub_issues_total: 0 })
  })

  it('キーの順は number・state・issue_type・sub_issues_total', async () => {
    const { client } = await startClient([graphqlData('GetIssueKind', { repository: { issue: { number: 1, state: 'OPEN', issueType: { name: 'Epic' }, subIssues: { totalCount: 1 } } } })])
    expect(Object.keys(await client.getIssueKind('owner', 'repo', 1))).toEqual(['number', 'state', 'issue_type', 'sub_issues_total'])
  })

  it('Issue が無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetIssueKind', { repository: { issue: JSON_NULL } })])
    expect(await rejection(client.getIssueKind('owner', 'repo', 999))).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/999'))
  })

  it('リポジトリが無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetIssueKind', { repository: JSON_NULL })])
    expect(await rejection(client.getIssueKind('owner', 'nonexistent', 1))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
  })

  it('issueType 非対応の GHES は、スキーマの失敗の後に Phase1 のクエリで判定する', async () => {
    const { client, server } = await startClient([
      graphqlError('GetIssueKind', 'Cannot query field \'issueType\' on type \'Issue\''),
      graphqlData('GetIssueKindPhase1', { repository: { issue: { number: 200, state: 'OPEN', subIssues: { totalCount: 4 } } } }),
    ])
    expect(await client.getIssueKind('owner', 'repo', 200)).toEqual({ number: 200, state: 'OPEN', issue_type: JSON_NULL, sub_issues_total: 4 })
    expect(graphqlRequests(server)).toEqual([
      { operation: 'GetIssueKind', variables: { owner: 'owner', repo: 'repo', number: 200 } },
      { operation: 'GetIssueKindPhase1', variables: { owner: 'owner', repo: 'repo', number: 200 } },
    ])
  })

  it.each([
    'Field \'issueType\' doesn\'t exist on type \'Issue\'',
    'Unknown field issueType',
  ])('スキーマの失敗の別の文言（%s）でも Phase1 にフォールバックする', async (message) => {
    const { client } = await startClient([
      graphqlError('GetIssueKind', message),
      graphqlData('GetIssueKindPhase1', { repository: { issue: { number: 1, state: 'OPEN', subIssues: { totalCount: 0 } } } }),
    ])
    const kind = await client.getIssueKind('owner', 'repo', 1)
    expect(kind.issue_type).toBe(JSON_NULL)
  })

  it.each([
    ['issueType を含むがスキーマの失敗ではない', 'issueType is broken'],
    ['スキーマの失敗だが issueType を含まない', 'Cannot query field \'other\''],
  ])('%s場合は、フォールバックせず例外にする', async (_label, message) => {
    const { client, server } = await startClient([graphqlError('GetIssueKind', message)])
    expect(await rejection(client.getIssueKind('owner', 'repo', 1))).toMatchObject({ name: 'GitHubAPIError' })
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('Phase1 で Issue が無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([
      graphqlError('GetIssueKind', 'Cannot query field \'issueType\''),
      graphqlData('GetIssueKindPhase1', { repository: { issue: JSON_NULL } }),
    ])
    expect(await rejection(client.getIssueKind('owner', 'repo', 7))).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/7'))
  })

  it('Phase1 でリポジトリが無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([
      graphqlError('GetIssueKind', 'Cannot query field \'issueType\''),
      graphqlData('GetIssueKindPhase1', { repository: JSON_NULL }),
    ])
    expect(await rejection(client.getIssueKind('owner', 'repo', 7))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/repo'))
  })
})

describe('getIssueSlim', () => {
  // 期待値は Python の get_issue_slim の出力
  const response = {
    repository: {
      issue: {
        number: 460,
        state: 'OPEN',
        title: 'T',
        body: 'B',
        comments: { totalCount: 3, nodes: [
          { author: { login: 'alice' }, createdAt: '2026-01-01T00:00:00Z', body: 'c1' },
          { author: JSON_NULL, createdAt: '2026-01-02T00:00:00Z', body: 'c2' },
          JSON_NULL,
        ] },
        parent: { number: 353, title: 'E', state: 'OPEN', repository: { owner: { login: 'o' }, name: 'r' } },
        subIssues: { nodes: [{ number: 1, state: 'OPEN', title: 's1' }, JSON_NULL, { number: 2, state: 'CLOSED', title: 's2' }] },
        linkedBranches: { nodes: [{ ref: { name: 'feat/a' } }, { ref: JSON_NULL }, JSON_NULL] },
        timelineItems: { nodes: [
          { subject: { number: 455, title: 'p', state: 'MERGED' } },
          { source: { number: 455, title: 'p', state: 'MERGED' } },
          { source: { number: 456, state: 'OPEN' } },
          { source: JSON_NULL },
          JSON_NULL,
        ] },
      },
    },
  }

  it('GraphQL の応答を整形する（コメントの投稿者なしは ghost、null ノードと重複 PR は落とす）', async () => {
    const { client, server } = await startClient([graphqlData('GetIssueSlim', response)])
    const result = await client.getIssueSlim('owner', 'repo', 460)
    expect(JSON.stringify(result)).toBe(JSON.stringify({
      number: 460,
      state: 'OPEN',
      title: 'T',
      body: 'B',
      comments: { total_count: 3, nodes: [
        { author: 'alice', created_at: '2026-01-01T00:00:00Z', body: 'c1' },
        { author: 'ghost', created_at: '2026-01-02T00:00:00Z', body: 'c2' },
      ] },
      parent: { number: 353, title: 'E', state: 'OPEN', owner: 'o', repo: 'r' },
      sub_issues: [{ number: 1, state: 'OPEN', title: 's1' }, { number: 2, state: 'CLOSED', title: 's2' }],
      linked_branches: ['feat/a'],
      linked_prs: [{ number: 455, title: 'p', state: 'MERGED' }, { number: 456, title: '', state: 'OPEN' }],
    }))
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueSlim', variables: { owner: 'owner', repo: 'repo', number: 460, commentLimit: 5 } }])
  })

  it('commentLimit を変数に送る', async () => {
    const { client, server } = await startClient([graphqlData('GetIssueSlim', response)])
    await client.getIssueSlim('owner', 'repo', 460, 20)
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([{ owner: 'owner', repo: 'repo', number: 460, commentLimit: 20 }])
  })

  it('親・サブ Issue・timelineItems が無い Issue は、空の子要素を持つ形で返す', async () => {
    const { client } = await startClient([graphqlData('GetIssueSlim', {
      repository: { issue: {
        number: 435,
        state: 'OPEN',
        title: '[Task] pecot issue readコマンドの実装',
        body: '## タスク概要\n\n実装する。',
        comments: { totalCount: 3 },
        parent: JSON_NULL,
        subIssues: { nodes: [] },
        linkedBranches: { nodes: [] },
      } },
    })])
    expect(await client.getIssueSlim('owner', 'repo', 435)).toEqual({
      number: 435,
      state: 'OPEN',
      title: '[Task] pecot issue readコマンドの実装',
      body: '## タスク概要\n\n実装する。',
      comments: { total_count: 3, nodes: [] },
      parent: JSON_NULL,
      sub_issues: [],
      linked_branches: [],
      linked_prs: [],
    })
  })

  it('親のリポジトリが無ければ owner・repo は null', async () => {
    const { client } = await startClient([graphqlData('GetIssueSlim', {
      repository: { issue: { number: 1, state: 'OPEN', title: 't', body: 'b', comments: { totalCount: 0 }, parent: { number: 2, title: 'E', state: 'OPEN' } } },
    })])
    const issue = await client.getIssueSlim('owner', 'repo', 1)
    expect(issue.parent).toEqual({ number: 2, title: 'E', state: 'OPEN', owner: JSON_NULL, repo: JSON_NULL })
  })

  it('リンク PR は、ConnectedEvent の subject を先に見て、無ければ CrossReferencedEvent の source を見る', async () => {
    const { client } = await startClient([graphqlData('GetIssueSlim', {
      repository: { issue: { number: 1, state: 'OPEN', title: 't', body: 'b', comments: { totalCount: 0 }, timelineItems: { nodes: [
        { source: JSON_NULL },
        { subject: { number: 455, title: 'PR', state: 'OPEN' } },
        { subject: { number: 0, title: 'zero', state: 'OPEN' } },
      ] } } },
    })])
    const issue = await client.getIssueSlim('owner', 'repo', 1)
    expect(issue.linked_prs).toEqual([{ number: 455, title: 'PR', state: 'OPEN' }])
  })

  it('Issue が無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetIssueSlim', { repository: { issue: JSON_NULL } })])
    expect(await rejection(client.getIssueSlim('owner', 'repo', 999))).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/999'))
  })

  it('リポジトリが無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetIssueSlim', { repository: JSON_NULL })])
    expect(await rejection(client.getIssueSlim('owner', 'nonexistent', 435))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
  })

  it('必須の値が無ければ、無かった場所を示す GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('GetIssueSlim', { repository: { issue: { number: 1, state: 'OPEN', title: 't', body: 'b' } } })])
    expect(await rejection(client.getIssueSlim('owner', 'repo', 1))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: issue.comments.totalCount'))
  })
})

describe('closeIssue / reopenIssue', () => {
  it('closeIssue は state=closed・state_reason=completed を PATCH する', async () => {
    const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/123', { status: 200, body: { number: 123, state: 'closed', state_reason: 'completed' } })])
    expect(await client.closeIssue('owner', 'repo', 123)).toEqual({ number: 123, state: 'closed', state_reason: 'completed' })
    expect(restRequests(server).map(({ method, body }) => ({ method, body }))).toEqual([{ method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } }])
  })

  it('closeIssue に state_reason を渡すと、送る本文に state_reason が入る', async () => {
    const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/124', { status: 200, body: { number: 124, state: 'closed', state_reason: 'not_planned' } })])
    await client.closeIssue('owner', 'repo', 124, 'not_planned')
    expect(restRequests(server).map(({ body }) => body)).toEqual([{ state: 'closed', state_reason: 'not_planned' }])
  })

  it('reopenIssue は state=open・state_reason=reopened を PATCH する', async () => {
    const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/123', { status: 200, body: { number: 123, state: 'open', title: 'Test Issue' } })])
    expect(await client.reopenIssue('owner', 'repo', 123)).toEqual({ number: 123, state: 'open', title: 'Test Issue' })
    expect(restRequests(server).map(({ method, body }) => ({ method, body }))).toEqual([{ method: 'PATCH', body: { state: 'open', state_reason: 'reopened' } }])
  })

  it('GHES のクライアントでも同じ要求を送る', async () => {
    const { client, server } = await startClient([restResponse('PATCH', '/repos/org/repo/issues/456', { status: 200, body: { number: 456, state: 'open' } })], 'ghes.example.com')
    expect(await client.reopenIssue('org', 'repo', 456)).toEqual({ number: 456, state: 'open' })
    expect(restRequests(server).map(({ auth, path }) => ({ auth, path }))).toEqual([{ auth: 'token', path: '/repos/org/repo/issues/456' }])
  })

  it.each([
    ['closeIssue', async (client: Readonly<GitHubClient>) => client.closeIssue('owner', 'repo', 999)],
    ['reopenIssue', async (client: Readonly<GitHubClient>) => client.reopenIssue('owner', 'repo', 999)],
  ])('%s の 404 は GitHubNotFoundError', async (_name, call) => {
    const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/999', { status: 404, text: 'Not Found' })])
    expect(await rejection(call(client))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/issues/999`, { statusCode: 404 }),
    )
  })
})

describe('listIssuesByLabel', () => {
  it('state=all・labels・per_page=100 を渡し、Pull Request を除く', async () => {
    const { client, server } = await startClient([
      restResponse('GET', '/repos/owner/repo/issues', { status: 200, body: [{ number: 1 }, { number: 2, pull_request: {} }, { number: 3 }] }),
    ])
    expect(await client.listIssuesByLabel('owner', 'repo', 'dependabot-pr')).toEqual([{ number: 1 }, { number: 3 }])
    expect(restRequests(server).map(({ query }) => query)).toEqual([{ state: 'all', labels: 'dependabot-pr', per_page: '100' }])
  })

  it('2 ページ目は Link ヘッダの next を辿る', async () => {
    const { client, server } = await startClient([
      restResponse('GET', '/repos/owner/repo/issues', { status: 200, body: [{ number: 1 }], headers: { link: '<{{GITHUB_API}}/repos/owner/repo/issues?page=2>; rel="next"' } }),
      restResponse('GET', '/repos/owner/repo/issues', { status: 200, body: [{ number: 2 }, { number: 3, pull_request: {} }] }),
    ])
    expect(await client.listIssuesByLabel('owner', 'repo', 'x')).toEqual([{ number: 1 }, { number: 2 }])
    expect(restRequests(server).map(({ query }) => query)).toEqual([{ state: 'all', labels: 'x', per_page: '100' }, { page: '2' }])
  })

  it('404 は URL のクエリを含む GitHubNotFoundError', async () => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/issues', { status: 404, text: 'Not Found' })])
    expect(await rejection(client.listIssuesByLabel('owner', 'repo', 'x'))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/issues?state=all&labels=x&per_page=100`, { statusCode: 404 }),
    )
  })
})

describe('updateIssueBody', () => {
  it('body だけを PATCH する', async () => {
    const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/7', { status: 200, body: { number: 7, body: '新しい本文' } })])
    expect(await client.updateIssueBody('owner', 'repo', 7, '新しい本文')).toEqual({ number: 7, body: '新しい本文' })
    expect(restRequests(server).map(({ method, body }) => ({ method, body }))).toEqual([{ method: 'PATCH', body: { body: '新しい本文' } }])
  })

  it('422 は GitHubAPIError', async () => {
    const { client } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/7', { status: 422, text: 'too long' })])
    expect(await rejection(client.updateIssueBody('owner', 'repo', 7, 'x'))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: 'too long' }))
  })
})
