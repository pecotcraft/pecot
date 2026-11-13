// IssuesApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// get_issue_slim の期待値は、同じ応答を Python の GitHubClient に渡して得た辞書。
import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
import { DependenciesUnsupportedError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError } from '../errors.js'
import type { ResponseRule } from '../../../../tests/fake-github/server.js'
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

function subIssueNode(number: number): Record<string, unknown> {
  return { number, state: 'OPEN', title: `#3-${String(number).padStart(2, '0')}: s` }
}

function slimData(subIssues: Readonly<Record<string, unknown>>): unknown {
  return { repository: { issue: { number: 3, state: 'OPEN', title: 'E', body: '', comments: { totalCount: 0, nodes: [] }, parent: JSON_NULL, subIssues, linkedBranches: { nodes: [] }, timelineItems: { nodes: [] } } } }
}

function pageData(nodes: readonly unknown[], hasNextPage: boolean, endCursor: string | undefined): unknown {
  return { repository: { issue: { subIssues: { nodes, pageInfo: { hasNextPage, endCursor: endCursor ?? JSON_NULL } } } } }
}

describe('getAllSubIssues', () => {
  it('続きが無いとき、1 ページ目だけを読み、GetSubIssuesPage を送らない', async () => {
    const first = graphqlData('GetIssueSlim', slimData({ nodes: [subIssueNode(1), subIssueNode(2)], pageInfo: { hasNextPage: false, endCursor: JSON_NULL } }))
    const { client, server } = await startClient([first])
    const result = await client.getAllSubIssues('owner', 'repo', 3)
    expect(result.map(({ number }) => number)).toEqual([1, 2])
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueSlim', variables: { owner: 'owner', repo: 'repo', number: 3, commentLimit: 0 } }])
  })

  it('続きがあるとき、endCursor を after に渡して最後のページまで回す', async () => {
    const first = graphqlData('GetIssueSlim', slimData({ nodes: [subIssueNode(1)], pageInfo: { hasNextPage: true, endCursor: 'c1' } }))
    const second = graphqlData('GetSubIssuesPage', pageData([subIssueNode(2), subIssueNode(3)], true, 'c2'))
    const third = graphqlData('GetSubIssuesPage', pageData([subIssueNode(4)], false, undefined))
    const { client, server } = await startClient([first, second, third])
    const result = await client.getAllSubIssues('owner', 'repo', 3)
    expect(result.map(({ number }) => number)).toEqual([1, 2, 3, 4])
    expect(graphqlRequests(server).slice(1)).toEqual([
      { operation: 'GetSubIssuesPage', variables: { owner: 'owner', repo: 'repo', number: 3, after: 'c1' } },
      { operation: 'GetSubIssuesPage', variables: { owner: 'owner', repo: 'repo', number: 3, after: 'c2' } },
    ])
  })

  it('pageInfo が無い応答は、続きが無いものとして読む', async () => {
    const first = graphqlData('GetIssueSlim', slimData({ nodes: [subIssueNode(1)] }))
    const { client } = await startClient([first])
    const result = await client.getAllSubIssues('owner', 'repo', 3)
    expect(result.map(({ number }) => number)).toEqual([1])
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

  it('前提の件数（blockedBy.totalCount）を blockedByCount で返す', async () => {
    const { client } = await startClient([graphqlData('GetIssueSlim', { repository: { issue: { ...response.repository.issue, blockedBy: { totalCount: 3 } } } })])
    const issue = await client.getIssueSlim('owner', 'repo', 460)
    expect(issue.blockedByCount).toBe(3)
  })

  it('blockedBy に対応しない GHES では、件数なしのクエリで読み直し、blockedByCount は undefined', async () => {
    const { client, server } = await startClient([
      graphqlError('GetIssueSlim', 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''),
      graphqlData('GetIssueSlimWithoutBlockedBy', response),
    ])
    const issue = await client.getIssueSlim('owner', 'repo', 460)
    expect(issue.blockedByCount).toBeUndefined()
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetIssueSlim', 'GetIssueSlimWithoutBlockedBy'])
  })

  it('blockedBy と関係の無いスキーマの失敗は、読み直さずに投げる', async () => {
    const { client } = await startClient([graphqlError('GetIssueSlim', 'Field \'linkedBranches\' doesn\'t exist on type \'Issue\'')])
    expect(await rejection(client.getIssueSlim('owner', 'repo', 460))).toBeInstanceOf(GitHubAPIError)
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

const PROJECT_ID = 'PVT_board'
const OTHER_PROJECT_ID = 'PVT_other'
const FIELDS = { columnFieldName: 'pecot-workflow-abc', labelFieldName: 'Status' }

function prNode(number: number, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    number,
    state: 'OPEN',
    headRefName: `feat/issue-${String(number)}`,
    baseRefName: 'main',
    isDraft: false,
    isCrossRepository: false,
    repository: { owner: { login: 'owner' }, name: 'repo' },
    ...overrides,
  }
}

function singleSelect(fieldId: string, optionName: string): Readonly<Record<string, unknown>> {
  return { name: optionName, optionId: `opt_${optionName}`, field: { id: fieldId } }
}

function boardItem(projectId: string, labelName: string, columnName?: string): Readonly<Record<string, unknown>> {
  return {
    project: { id: projectId },
    column: columnName === undefined ? JSON_NULL : singleSelect('FIELD_column', columnName),
    label: singleSelect('FIELD_status', labelName),
  }
}

function connection(nodes: readonly unknown[], totalCount = nodes.length): Readonly<Record<string, unknown>> {
  return { totalCount, nodes }
}

function prerequisiteIssue(number: number, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    id: `I_${String(number)}`,
    number,
    state: 'OPEN',
    title: `Issue ${String(number)}`,
    repository: { owner: { login: 'owner' }, name: 'repo' },
    issueType: { name: 'Task' },
    subIssues: { totalCount: 0 },
    projectItems: connection([]),
    linkedBranches: connection([]),
    closedByPullRequestsReferences: connection([]),
    timelineItems: connection([]),
    ...overrides,
  }
}

function target(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { ...prerequisiteIssue(10), body: '本文', parent: JSON_NULL, blockedBy: { totalCount: 0, nodes: [] }, ...overrides }
}

const prerequisitesVariables = { owner: 'owner', repo: 'repo', number: 10, columnFieldName: FIELDS.columnFieldName, labelFieldName: FIELDS.labelFieldName, blockedByFirst: 50 }

const blockedByCases: readonly Readonly<{ method: 'addBlockedBy' | 'removeBlockedBy', operation: string }>[] = [
  { method: 'addBlockedBy', operation: 'AddBlockedBy' },
  { method: 'removeBlockedBy', operation: 'RemoveBlockedBy' },
]

describe('addBlockedBy・removeBlockedBy', () => {
  it.for(blockedByCases)('$method は node ID を issueId・blockingIssueId で送る', async ({ method, operation }) => {
    const { client, server } = await startClient([graphqlData(operation, { issue: { number: 10 }, blockingIssue: { number: 9 } })])
    await (method === 'addBlockedBy' ? client.addBlockedBy('I_10', 'I_9') : client.removeBlockedBy('I_10', 'I_9'))
    expect(graphqlRequests(server)).toEqual([{ operation, variables: { issueId: 'I_10', blockingIssueId: 'I_9' } }])
  })

  it.for(blockedByCases)('$method の VALIDATION の拒否（HTTP 200）は GitHubAPIError', async ({ method, operation }) => {
    const { client } = await startClient([{
      match: { operation },
      respond: { status: 200, body: { data: JSON_NULL, errors: [{ type: 'VALIDATION', message: 'Blocking relationship would create a cycle' }] } },
      times: 1,
    }])
    const error = await rejection(method === 'addBlockedBy' ? client.addBlockedBy('I_10', 'I_9') : client.removeBlockedBy('I_10', 'I_9'))
    expect(error).toMatchObject({ name: 'GitHubAPIError' })
    expect(error instanceof Error ? error.message : '').toMatch(/^GraphQL query error: .*Blocking relationship would create a cycle/u)
  })

  it.for(blockedByCases)('$method は、Mutation に無い GHES では 3.19 以上が要ると伝える', async ({ method, operation }) => {
    const field = method
    const { client } = await startClient([graphqlError(operation, `Field '${field}' doesn't exist on type 'Mutation'`)])
    const error = await rejection(method === 'addBlockedBy' ? client.addBlockedBy('I_10', 'I_9') : client.removeBlockedBy('I_10', 'I_9'))
    expect(error).toMatchObject(failure(DependenciesUnsupportedError, 'this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required'))
  })
})

async function readWith(issue: Readonly<Record<string, unknown>>): ReturnType<GitHubClient['getIssuePrerequisites']> {
  const { client } = await startClient([graphqlData('GetIssuePrerequisites', { repository: { issue } })])
  return client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS)
}

async function readError(client: Readonly<GitHubClient>): Promise<unknown> {
  return rejection(client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS))
}

function connectedEvent(number: number): Readonly<Record<string, unknown>> {
  return { __typename: 'ConnectedEvent', subject: prNode(number) }
}

function disconnectedEvent(number: number): Readonly<Record<string, unknown>> {
  return { __typename: 'DisconnectedEvent', subject: prNode(number) }
}

function referencedEvent(number: number, willCloseTarget: boolean, head?: string): Readonly<Record<string, unknown>> {
  return { __typename: 'CrossReferencedEvent', willCloseTarget, source: prNode(number, head === undefined ? {} : { headRefName: head }) }
}

function partialResponse(errors: readonly unknown[], issue: Readonly<Record<string, unknown>>): ResponseRule {
  return {
    match: { operation: 'GetIssuePrerequisites' },
    respond: { status: 200, body: { data: { repository: { issue } }, errors } },
    times: 1,
  }
}

const timelineCases: readonly Readonly<{ name: string, events: readonly unknown[], expected: readonly number[] }>[] = [
  { name: '本文やコメントで触れただけの PR（閉じる参照でなく、head が /10 で終わらない）は読まない', events: [referencedEvent(30, false, 'feat/readiness/11')], expected: [] },
  { name: '閉じる参照でなくても、head が /10 で終わる PR は読む', events: [referencedEvent(31, false, 'feat/readiness/10')], expected: [31] },
  { name: 'head が /10 で終わらなくても、閉じる参照なら読む', events: [referencedEvent(32, true, 'fix/something')], expected: [32] },
  { name: '後で DisconnectedEvent が外した ConnectedEvent の PR は読まない', events: [connectedEvent(33), connectedEvent(34), disconnectedEvent(33)], expected: [34] },
  { name: '外した後に繋ぎ直した PR は読む', events: [connectedEvent(35), disconnectedEvent(35), connectedEvent(35)], expected: [35] },
  { name: 'DisconnectedEvent は、別の PR や、閉じる参照で読んだ PR を消さない', events: [referencedEvent(36, true), disconnectedEvent(36), disconnectedEvent(37)], expected: [36] },
  { name: 'PR が空の node は読まない', events: [{ __typename: 'ConnectedEvent', subject: {} }, { __typename: 'DisconnectedEvent', subject: {} }, { __typename: 'CrossReferencedEvent', willCloseTarget: true, source: {} }], expected: [] },
]

describe('getIssuePrerequisites', () => {
  it('親の Issue があれば、親のリポジトリと番号を読む', async () => {
    const result = await readWith(target({ parent: { number: 353, repository: { owner: { login: 'parent-owner' }, name: 'parent-repo' } } }))
    expect(result.issue.parent).toEqual({ repository: { owner: 'parent-owner', repository: 'parent-repo' }, number: 353 })
  })

  it('親が null なら parent は null', async () => {
    const result = await readWith(target({ parent: JSON_NULL }))
    expect(result.issue.parent).toBe(JSON_NULL)
  })

  it('対象の Issue と blockedBy を読み、ボードの値は projectId のものだけにする', async () => {
    const blocking = prerequisiteIssue(9, {
      state: 'CLOSED',
      issueType: JSON_NULL,
      projectItems: connection([boardItem(OTHER_PROJECT_ID, 'Done'), boardItem(PROJECT_ID, 'In Progress', 'In Review')]),
    })
    const { client, server } = await startClient([
      graphqlData('GetIssuePrerequisites', { repository: { issue: target({ blockedBy: { totalCount: 1, nodes: [blocking] } }) } }),
    ])
    const result = await client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS)
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssuePrerequisites', variables: prerequisitesVariables }])
    expect(result.issue).toEqual({
      id: 'I_10',
      repository: { owner: 'owner', repository: 'repo' },
      number: 10,
      state: 'OPEN',
      title: 'Issue 10',
      body: '本文',
      parent: JSON_NULL,
      issueType: 'Task',
      subIssuesTotal: 0,
      projectFieldValues: [],
      linkedBranches: [],
      closingPullRequests: [],
      timelinePullRequests: [],
    })
    expect(result.blockedBy).toEqual({
      kind: 'ok',
      issues: [{
        id: 'I_9',
        repository: { owner: 'owner', repository: 'repo' },
        number: 9,
        state: 'CLOSED',
        title: 'Issue 9',
        issueType: JSON_NULL,
        subIssuesTotal: 0,
        projectFieldValues: [
          { fieldId: 'FIELD_column', fieldName: FIELDS.columnFieldName, optionId: 'opt_In Review', optionName: 'In Review' },
          { fieldId: 'FIELD_status', fieldName: 'Status', optionId: 'opt_In Progress', optionName: 'In Progress' },
        ],
        linkedBranches: [],
        closingPullRequests: [],
        timelinePullRequests: [],
      }],
    })
  })

  it('blockedBy の件数を渡すと、その件数で読む', async () => {
    const { client, server } = await startClient([
      graphqlData('GetIssuePrerequisites', { repository: { issue: target({ blockedBy: { totalCount: 0, nodes: [] } }) } }),
    ])
    await client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS, 3)
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssuePrerequisites', variables: { ...prerequisitesVariables, blockedByFirst: 3 } }])
  })

  it('PR を 3 つの読み口から読む', async () => {
    const fromBranch = prNode(21, { headRefName: 'feat/issue-9' })
    const fromClosing = prNode(22, { state: 'MERGED' })
    const fork = prNode(23, { isCrossRepository: true, isDraft: true, headRefName: 'feat/issue-10', repository: { owner: { login: 'upstream' }, name: 'other' } })
    const issue = target({
      linkedBranches: connection([JSON_NULL, { ref: JSON_NULL }, { ref: { name: 'feat/issue-9', associatedPullRequests: connection([fromBranch]) } }]),
      closedByPullRequestsReferences: connection([fromClosing]),
      timelineItems: connection([
        { __typename: 'ConnectedEvent', subject: fork },
        { __typename: 'CrossReferencedEvent', willCloseTarget: true, source: prNode(24) },
        { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: JSON_NULL },
        { __typename: 'ConnectedEvent', subject: {} },
        {},
      ]),
    })
    const { issue: read } = await readWith(issue)
    expect(read.linkedBranches).toEqual([{
      name: 'feat/issue-9',
      pullRequests: [{ repository: { owner: 'owner', repository: 'repo' }, number: 21, state: 'OPEN', headRefName: 'feat/issue-9', baseRefName: 'main', isDraft: false, isCrossRepository: false }],
    }])
    expect(read.closingPullRequests.map(({ number, state }) => ({ number, state }))).toEqual([{ number: 22, state: 'MERGED' }])
    expect(read.timelinePullRequests).toEqual([
      { repository: { owner: 'upstream', repository: 'other' }, number: 23, state: 'OPEN', headRefName: 'feat/issue-10', baseRefName: 'main', isDraft: true, isCrossRepository: true },
      { repository: { owner: 'owner', repository: 'repo' }, number: 24, state: 'OPEN', headRefName: 'feat/issue-24', baseRefName: 'main', isDraft: false, isCrossRepository: false },
    ])
  })

  it.for(timelineCases)('タイムライン: $name', async ({ events, expected }) => {
    const timelineItems = connection(events)
    const { issue } = await readWith(target({ timelineItems }))
    expect(issue.timelinePullRequests.map(({ number }) => number)).toEqual(expected)
  })

  it('number の無い PR の node は GitHubAPIError', async () => {
    const broken = { state: 'OPEN', headRefName: 'feat/issue-10' }
    const issue = target({ closedByPullRequestsReferences: connection([broken]) })
    const error = await rejection(readWith(issue))
    expect(error).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.number'))
  })

  it('ボードに無い Issue の値は空', async () => {
    const projectItems = connection([boardItem(OTHER_PROJECT_ID, 'Ready')])
    const { issue } = await readWith(target({ projectItems }))
    expect(issue.projectFieldValues).toEqual([])
  })

  it('列だけ、札だけの値は、あるほうだけ読む', async () => {
    const onlyColumn = { project: { id: PROJECT_ID }, column: singleSelect('FIELD_column', 'Done'), label: JSON_NULL }
    const { issue } = await readWith(target({ projectItems: connection([onlyColumn]) }))
    expect(issue.projectFieldValues).toEqual([{ fieldId: 'FIELD_column', fieldName: FIELDS.columnFieldName, optionId: 'opt_Done', optionName: 'Done' }])
  })

  it('blockedBy が空で totalCount も 0 なら、前提なしの ok', async () => {
    const { blockedBy } = await readWith(target())
    expect(blockedBy).toEqual({ kind: 'ok', issues: [] })
  })

  it('blockedBy に null の node があれば read-failed（落とさない）', async () => {
    const { blockedBy } = await readWith(target({ blockedBy: { totalCount: 2, nodes: [prerequisiteIssue(9), JSON_NULL] } }))
    expect(blockedBy).toEqual({ kind: 'read-failed', reason: 'blockedBy has a null node' })
  })

  it('blockedBy の件数が totalCount に足りなければ read-failed', async () => {
    const { blockedBy } = await readWith(target({ blockedBy: { totalCount: 51, nodes: [prerequisiteIssue(9)] } }))
    expect(blockedBy).toEqual({ kind: 'read-failed', reason: 'blockedBy returned 1 of 51 issues' })
  })

  describe('connection の取りこぼし', () => {
    const cut = connection([], 3)
    const nested = { ref: { name: 'feat/issue-9', associatedPullRequests: connection([prNode(21)], 2) } }
    const cases: readonly Readonly<{ name: string, overrides: Readonly<Record<string, unknown>>, reason: string }>[] = [
      { name: 'projectItems', overrides: { projectItems: cut }, reason: 'projectItems of owner/repo#9 returned 0 of 3' },
      { name: 'linkedBranches', overrides: { linkedBranches: cut }, reason: 'linkedBranches of owner/repo#9 returned 0 of 3' },
      { name: 'associatedPullRequests', overrides: { linkedBranches: connection([nested]) }, reason: 'associatedPullRequests of owner/repo#9 returned 1 of 2' },
      { name: 'closedByPullRequestsReferences', overrides: { closedByPullRequestsReferences: cut }, reason: 'closedByPullRequestsReferences of owner/repo#9 returned 0 of 3' },
      { name: 'timelineItems', overrides: { timelineItems: cut }, reason: 'timelineItems of owner/repo#9 returned 0 of 3' },
    ]

    it.for(cases)('前提の Issue の $name が足りなければ read-failed', async ({ overrides, reason }) => {
      const { blockedBy } = await readWith(target({ blockedBy: { totalCount: 1, nodes: [prerequisiteIssue(9, overrides)] } }))
      expect(blockedBy).toEqual({ kind: 'read-failed', reason })
    })

    it('対象の Issue の timelineItems が足りなくても read-failed', async () => {
      const { blockedBy } = await readWith(target({ timelineItems: cut, blockedBy: { totalCount: 1, nodes: [prerequisiteIssue(9)] } }))
      expect(blockedBy).toEqual({ kind: 'read-failed', reason: 'timelineItems of owner/repo#10 returned 0 of 3' })
    })

    it('上限に届いていても、totalCount と同じなら ok', async () => {
      const full = connection([{ __typename: 'ConnectedEvent', subject: prNode(21) }])
      const { blockedBy } = await readWith(target({ blockedBy: { totalCount: 1, nodes: [prerequisiteIssue(9, { timelineItems: full })] } }))
      expect(blockedBy).toMatchObject({ kind: 'ok' })
    })
  })

  describe('部分エラー', () => {
    it('errors が blockedBy の下だけなら、例外にせず blockedBy を read-failed にする', async () => {
      const errors = [{ message: 'Could not resolve to an Issue', path: ['repository', 'issue', 'blockedBy', 'nodes', 1] }]
      const blockedBy = { totalCount: 2, nodes: [prerequisiteIssue(9), JSON_NULL] }
      const { client } = await startClient([partialResponse(errors, target({ blockedBy }))])
      const result = await client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS)
      expect(result.issue.number).toBe(10)
      expect(result.blockedBy).toEqual({ kind: 'read-failed', reason: 'blockedBy could not be read: Could not resolve to an Issue' })
    })

    it('blockedBy ごと null になっても read-failed', async () => {
      const errors = [{ message: 'forbidden', path: ['repository', 'issue', 'blockedBy'] }]
      const { client } = await startClient([partialResponse(errors, target({ blockedBy: JSON_NULL }))])
      const result = await client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS)
      expect(result.blockedBy).toEqual({ kind: 'read-failed', reason: 'blockedBy could not be read: forbidden' })
    })

    it('blockedBy の外の errors がひとつでもあれば、今までどおり例外にする', async () => {
      const errors = [
        { message: 'ok to tolerate', path: ['repository', 'issue', 'blockedBy', 'nodes', 0] },
        { message: 'broken elsewhere', path: ['repository', 'issue', 'timelineItems'] },
      ]
      const { client } = await startClient([partialResponse(errors, target())])
      const error = await readError(client)
      expect(error).toBeInstanceOf(GitHubAPIError)
      expect(error instanceof Error ? error.message : '').toContain('ok to tolerate')
    })

    it('path の無い errors は例外にする', async () => {
      const { client } = await startClient([partialResponse([{ message: 'no path' }], target())])
      expect(await readError(client)).toBeInstanceOf(GitHubAPIError)
    })
  })

  describe('Issue の依存関係に対応しない GHES', () => {
    const unsupported = 'this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required'

    it.for(['Field \'blockedBy\' doesn\'t exist on type \'Issue\'', 'Cannot query field \'issueType\' on type \'Issue\''])('スキーマの失敗（%s）は、3.19 以上が要ると伝える。読み直しはしない', async (message) => {
      const { client, server } = await startClient([graphqlError('GetIssuePrerequisites', message)])
      expect(await readError(client)).toMatchObject(failure(DependenciesUnsupportedError, unsupported))
      expect(graphqlRequests(server)).toHaveLength(1)
    })
  })

  it('blockedBy と関係の無い失敗は、そのまま例外にする', async () => {
    const { client, server } = await startClient([graphqlError('GetIssuePrerequisites', 'Something else broke')])
    const error = await readError(client)
    expect(error).toBeInstanceOf(GitHubAPIError)
    expect(error).not.toBeInstanceOf(DependenciesUnsupportedError)
    expect(error instanceof Error ? error.message : '').toContain('Something else broke')
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('Issue が無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetIssuePrerequisites', { repository: { issue: JSON_NULL } })])
    expect(await readError(client)).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/10'))
  })

  it('必須の値が無ければ GitHubAPIError', async () => {
    const error = await rejection(readWith(target({ id: JSON_NULL })))
    expect(error).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: issue.id'))
  })
})
