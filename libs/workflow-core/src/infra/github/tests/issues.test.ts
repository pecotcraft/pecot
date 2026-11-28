// IssuesApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// get_issue_slim の期待値は、同じ応答を Python の GitHubClient に渡して得た辞書。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'
import { step } from '../../../../tests/_helpers/step.js'

import { JSON_NULL } from '../../../domain/json-null.js'
import { DependenciesUnsupportedError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError } from '../errors.js'
import type { ResponseRule } from '../../../../tests/_helpers/fake-github/server.js'
import type { GitHubClient } from '../index.js'
import { QUERY_GET_ISSUE_PREREQUISITES } from '../queries.js'
import { failure, graphqlData, graphqlError, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

describe('createIssue', () => {
  it('タイトル・本文・ラベルを渡した場合は、JSON の本文を POST し、応答の Issue を返す', async () => {
    await explains('`createIssue` のテストです。タイトル・本文・ラベルを渡した場合に、JSON の本文を `POST /repos/owner/repo/issues` へ送信し、応答の Issue を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 201, body: { number: 124, title: 'New Issue' } })])
      return { client, server }
    })
    const result = await step('createIssue を呼ぶ', async () => await client.createIssue('owner', 'repo', 'New Issue', 'Body text', ['bug']))
    await step('送った要求を確かめる', () => {
      expect(result).toEqual({ number: 124, title: 'New Issue' })
      expect(restRequests(server).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        { method: 'POST', path: '/repos/owner/repo/issues', body: { title: 'New Issue', body: 'Body text', labels: ['bug'] } },
      ])
    })
  })

  it.each<[readonly string[] | undefined]>([[undefined], [[]]])('labels が %j の場合は、本文に labels を含めない', async (labels) => {
    await explains('`createIssue` のラベル指定のテストです。ラベルが `undefined` または空配列の場合に、リクエスト本文へ `labels` を含めないことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 201, body: { number: 125 } })])
      return { client, server }
    })
    await step('createIssue を呼ぶ', async () => {
      await client.createIssue('owner', 'repo', 'Title', 'Body', labels)
    })
    await step('送った要求を確かめる', () => {
      expect(restRequests(server).map(({ body }) => JSON.stringify(body))).toEqual(['{"title":"Title","body":"Body"}'])
    })
  })

  it('本文を省略した場合は、空文字の body を送信する', async () => {
    await explains('`createIssue` の本文の既定値のテストです。本文を省略した場合に、空文字の `body` を送信することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 201, body: {} })])
      return { client, server }
    })
    await step('createIssue を呼ぶ', async () => {
      await client.createIssue('owner', 'repo', 'Title')
    })
    await step('送った要求を確かめる', () => {
      expect(restRequests(server).map(({ body }) => body)).toEqual([{ title: 'Title', body: '' }])
    })
  })

  it('状態コード 401 が返った場合は、GitHubAuthError が発生する', async () => {
    await explains('`createIssue` の失敗時のテストです。状態コード 401 が返った場合に、認証の失敗を示す `GitHubAuthError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 401, text: 'Bad credentials' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createIssue('owner', 'repo', 'T'))).toMatchObject(
        failure(GitHubAuthError, 'authentication failed: check the token', { statusCode: 401 }),
      )
    })
  })

  it('担当者・マイルストーン番号・Issue type を指定した場合は、同じ POST の本文に含めて送信する', async () => {
    await explains('`createIssue` の追加項目のテストです。担当者・マイルストーン番号・Issue type を指定した場合に、同じ POST の本文へ含めて送信することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 201, body: { number: 126 } })])
      return { client, server }
    })
    await step('createIssue を呼ぶ', async () => {
      await client.createIssue('owner', 'repo', 'Title', 'Body', ['bug'], { assignees: ['alice'], milestone: 3, type: 'Task' })
    })
    await step('送った要求を確かめる', () => {
      expect(restRequests(server).map(({ body }) => body)).toEqual([{ title: 'Title', body: 'Body', labels: ['bug'], assignees: ['alice'], milestone: 3, type: 'Task' }])
    })
  })

  it('追加項目の一部だけを指定した場合は、指定していない項目を本文に含めない', async () => {
    await explains('`createIssue` の追加項目のテストです。マイルストーンだけを指定した場合に、指定していない項目を本文へ含めないことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues', { status: 201, body: { number: 127 } })])
      return { client, server }
    })
    await step('createIssue を呼ぶ', async () => {
      await client.createIssue('owner', 'repo', 'Title', 'Body', undefined, { milestone: 3 })
    })
    await step('送った要求を確かめる', () => {
      expect(restRequests(server).map(({ body }) => JSON.stringify(body))).toEqual(['{"title":"Title","body":"Body","milestone":3}'])
    })
  })
})

describe('addIssueComment', () => {
  it('本文を渡した場合は、コメントを POST し、応答のコメントを返す', async () => {
    await explains('`addIssueComment` のテストです。本文を渡した場合に、コメントの POST を送信し、応答のコメントを返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues/123/comments', { status: 201, body: { id: 456, body: 'Test comment' } })])
      return { client, server }
    })
    const result = await step('addIssueComment を呼ぶ', async () => await client.addIssueComment('owner', 'repo', 123, 'Test comment'))
    await step('送った要求を確かめる', () => {
      expect(result).toEqual({ id: 456, body: 'Test comment' })
      expect(restRequests(server).map(({ body }) => body)).toEqual([{ body: 'Test comment' }])
    })
  })
})

describe('addIssueComment の失敗', () => {
  it('存在しない Issue にコメントを追加した場合は、GitHubNotFoundError が発生する', async () => {
    await explains('`addIssueComment` の失敗時のテストです。存在しない Issue で 404 が返った場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/issues/999/comments', { status: 404, text: 'Not Found' })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.addIssueComment('owner', 'repo', 999, 'x'))).toMatchObject(
        failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/issues/999/comments`, { statusCode: 404 }),
      )
    })
  })
})

describe('listIssueCommentRecords / listIssueCommentReadings', () => {
  const comments = [
    { id: 1, body: 'a', user: { login: 'octocat', type: 'User' }, author_association: 'OWNER', created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/owner/repo/issues/7#issuecomment-1' },
    { id: 2, body: 'b' },
  ]

  it('コメント一覧の記録は、投稿者・関係・時刻・URL を含み、存在しない項目は空文字にする', async () => {
    await explains('`listIssueCommentRecords` のテストです。コメントの投稿者・関係・作成時刻・URL を取り出し、応答に存在しない項目は空文字になることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/issues/7/comments', { status: 200, body: comments })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listIssueCommentRecords('owner', 'repo', 7)).toEqual([
        { body: 'a', userType: 'User', login: 'octocat', authorAssociation: 'OWNER', createdAt: '2026-01-01T00:00:00Z', url: 'https://github.com/owner/repo/issues/7#issuecomment-1' },
        { body: 'b', userType: '', login: '', authorAssociation: '', createdAt: '', url: '' },
      ])
    })
  })

  it('コメント一覧の読み取り結果は、本文と投稿者の種類だけを含む', async () => {
    await explains('`listIssueCommentReadings` のテストです。本文と投稿者の種類だけを返し、それ以外の項目を含まないことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/issues/7/comments', { status: 200, body: comments })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listIssueCommentReadings('owner', 'repo', 7)).toEqual([
        { body: 'a', userType: 'User' },
        { body: 'b', userType: '' },
      ])
    })
  })
})

describe('removeIssueLabel', () => {
  it('特殊文字を含むラベル名は、符号化して DELETE し、200 なら removed を返す', async () => {
    await explains('`removeIssueLabel` のテストです。空白・`/`・日本語を含むラベル名を渡した場合に、符号化したパス宛てに DELETE を送信し、200 が返れば `removed` を返すことを確認します。')
    const { path, client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const path = '/repos/owner/repo/issues/7/labels/pecot%20auto%2Fready%20%E6%97%A5%E6%9C%AC'
      const { client, server } = await startClient([restResponse('DELETE', path, { status: 200, body: [] })])
      return { path, client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.removeIssueLabel('owner', 'repo', 7, 'pecot auto/ready 日本')).toBe('removed')
      expect(restRequests(server).map(({ method, path: requested }) => ({ method, path: requested }))).toEqual([{ method: 'DELETE', path }])
    })
  })

  it('ラベルの削除で状態コード 404 が返った場合は、absent を返す', async () => {
    await explains('`removeIssueLabel` のテストです。状態コード 404 が返った場合に、`absent` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('DELETE', '/repos/owner/repo/issues/7/labels/x', { status: 404, body: { message: 'Label does not exist' } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.removeIssueLabel('owner', 'repo', 7, 'x')).toBe('absent')
    })
  })

  it('ラベルの削除で状態コード 500 が返った場合は、GitHubAPIError が発生する', async () => {
    await explains('`removeIssueLabel` の失敗時のテストです。状態コード 500 が返った場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('DELETE', '/repos/owner/repo/issues/7/labels/x', { status: 500, text: 'boom' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.removeIssueLabel('owner', 'repo', 7, 'x'))).toBeInstanceOf(GitHubAPIError)
    })
  })
})

describe('getIssueLinkedBranches', () => {
  it('Issue の Node ID と、Issue のリポにあるつながったブランチの名前だけを返す', async () => {
    await explains('`getIssueLinkedBranches` のテストです。つながったブランチのうち、別のリポのものと `ref` が空のものを除き、Issue のリポのブランチの名前を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const linkedBranches = { nodes: [
        { ref: { name: 'feat/a/1', repository: { nameWithOwner: 'Owner/Repo' } } },
        { ref: { name: 'feat/b/1', repository: { nameWithOwner: 'owner/other' } } },
        { ref: JSON_NULL },
      ] }
      const { client, server } = await startClient([graphqlData('GetIssueLinkedBranches', { repository: { issue: { id: 'I_1', linkedBranches } } })])
      return { client, server }
    })
    await step('送った要求と結果を確かめる', async () => {
      expect(await client.getIssueLinkedBranches('owner', 'repo', 1)).toEqual({ id: 'I_1', branches: ['feat/a/1'] })
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueLinkedBranches', variables: { owner: 'owner', repo: 'repo', number: 1 } }])
    })
  })
})

describe('getIssueNodeId / getIssueNodeIdAndTitle', () => {
  it('owner・repo・番号を変数に送信し、Node ID を返す', async () => {
    await explains('`getIssueNodeId` のテストです。owner・repo・番号を変数にして GraphQL を送信し、Node ID を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_kwDOtest123' } } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getIssueNodeId('owner', 'repo', 123)).toBe('I_kwDOtest123')
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueNodeId', variables: { owner: 'owner', repo: 'repo', number: 123 } }])
    })
  })

  it('Node ID とタイトルを、1 回のクエリで返す', async () => {
    await explains('`getIssueNodeIdAndTitle` のテストです。1 回の GraphQL で、Node ID とタイトルの両方を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_kwDOtest123', title: '[Task] 題名' } } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getIssueNodeIdAndTitle('owner', 'repo', 123)).toEqual({ id: 'I_kwDOtest123', title: '[Task] 題名' })
      expect(graphqlRequests(server)).toHaveLength(1)
    })
  })

  it('タイトルが存在しない場合は、空文字を返す', async () => {
    await explains('`getIssueNodeIdAndTitle` のテストです。応答にタイトルが存在しない場合に、タイトルを空文字として返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_1' } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getIssueNodeIdAndTitle('owner', 'repo', 1)).toEqual({ id: 'I_1', title: '' })
    })
  })

  it('リポジトリが存在しない場合は、Node ID の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueNodeId` の失敗時のテストです。リポジトリが存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueNodeId', { repository: JSON_NULL })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueNodeId('owner', 'nonexistent', 123))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
    })
  })

  it('Issue が存在しない場合は、Node ID の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueNodeId` の失敗時のテストです。Issue が存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: JSON_NULL } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueNodeId('owner', 'repo', 999))).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/999'))
    })
  })

  it('id が文字列でない場合は、GitHubAPIError が発生する', async () => {
    await explains('`getIssueNodeId` の失敗時のテストです。応答の `id` が文字列でない場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueNodeId', { repository: { issue: { id: 5 } } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueNodeId('owner', 'repo', 1))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: issue.id'))
    })
  })
})

describe('addSubIssue', () => {
  it('親と子の Node ID を parentId と childId の変数で送信し、両方の Issue 番号を返す', async () => {
    await explains('`addSubIssue` のテストです。親と子の Node ID を渡した場合に、`parentId` と `childId` を変数にして送信し、両方の Issue 番号を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('AddSubIssue', { addSubIssue: { issue: { number: 100 }, subIssue: { number: 101 } } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.addSubIssue('I_parent', 'I_child')).toEqual({ parent_number: 100, child_number: 101 })
      expect(graphqlRequests(server)).toEqual([{ operation: 'AddSubIssue', variables: { parentId: 'I_parent', childId: 'I_child' } }])
    })
  })

  it('issue と subIssue が null の場合は、GitHubAPIError が発生する', async () => {
    await explains('`addSubIssue` の失敗時のテストです。応答の `issue` と `subIssue` が `null` の場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('AddSubIssue', { addSubIssue: { issue: JSON_NULL, subIssue: JSON_NULL } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.addSubIssue('I_parent', 'I_child'))).toMatchObject(failure(GitHubAPIError, 'failed to link the sub-issue'))
    })
  })

  it('応答に addSubIssue が存在しない場合は、GitHubAPIError が発生する', async () => {
    await explains('`addSubIssue` の失敗時のテストです。応答に `addSubIssue` が含まれない場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('AddSubIssue', {})])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.addSubIssue('I_parent', 'I_child'))).toMatchObject(failure(GitHubAPIError, 'failed to link the sub-issue'))
    })
  })
})

describe('getIssueKind', () => {
  const variables = { owner: 'owner', repo: 'repo', number: 100 }

  it.each([
    ['Epic', { name: 'Epic' }, 2, 'Epic', 2],
    ['Task', { name: 'Task' }, 0, 'Task', 0],
    ['issueType が null', JSON_NULL, 3, JSON_NULL, 3],
  ])('%s の場合は、種別とサブ Issue の総数を返す', async (_label, issueType, total, expectedType, expectedTotal) => {
    await explains('`getIssueKind` のテストです。Epic・Task・Issue type が `null` の Issue を読み取った場合に、番号・状態・種別・サブ Issue の総数を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        graphqlData('GetIssueKind', { repository: { issue: { number: 100, state: 'OPEN', issueType, subIssues: { totalCount: total } } } }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getIssueKind('owner', 'repo', 100)).toEqual({ number: 100, state: 'OPEN', issue_type: expectedType, sub_issues_total: expectedTotal })
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueKind', variables }])
    })
  })

  it('subIssues が存在しない場合は、サブ Issue の総数を 0 にする', async () => {
    await explains('`getIssueKind` のテストです。応答に `subIssues` が存在しない場合は、サブ Issue の総数を 0 として返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueKind', { repository: { issue: { number: 1, state: 'CLOSED' } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getIssueKind('owner', 'repo', 1)).toEqual({ number: 1, state: 'CLOSED', issue_type: JSON_NULL, sub_issues_total: 0 })
    })
  })

  it('戻り値のキーは、number・state・issue_type・sub_issues_total の順に並ぶ', async () => {
    await explains('`getIssueKind` の戻り値のテストです。キーが `number`・`state`・`issue_type`・`sub_issues_total` の順に並ぶことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueKind', { repository: { issue: { number: 1, state: 'OPEN', issueType: { name: 'Epic' }, subIssues: { totalCount: 1 } } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(Object.keys(await client.getIssueKind('owner', 'repo', 1))).toEqual(['number', 'state', 'issue_type', 'sub_issues_total'])
    })
  })

  it('Issue が存在しない場合は、種別の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueKind` の失敗時のテストです。Issue が存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueKind', { repository: { issue: JSON_NULL } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueKind('owner', 'repo', 999))).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/999'))
    })
  })

  it('リポジトリが存在しない場合は、種別の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueKind` の失敗時のテストです。リポジトリが存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueKind', { repository: JSON_NULL })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueKind('owner', 'nonexistent', 1))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
    })
  })

  it('issueType に対応しない GHES では、スキーマエラーの後に Phase1 のクエリで読み直す', async () => {
    await explains('`getIssueKind` の GHES 対応のテストです。`issueType` に対応しない GHES がスキーマエラーを返した場合に、`GetIssueKindPhase1` のクエリで読み直すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        graphqlError('GetIssueKind', 'Cannot query field \'issueType\' on type \'Issue\''),
        graphqlData('GetIssueKindPhase1', { repository: { issue: { number: 200, state: 'OPEN', subIssues: { totalCount: 4 } } } }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getIssueKind('owner', 'repo', 200)).toEqual({ number: 200, state: 'OPEN', issue_type: JSON_NULL, sub_issues_total: 4 })
      expect(graphqlRequests(server)).toEqual([
        { operation: 'GetIssueKind', variables: { owner: 'owner', repo: 'repo', number: 200 } },
        { operation: 'GetIssueKindPhase1', variables: { owner: 'owner', repo: 'repo', number: 200 } },
      ])
    })
  })

  it.each([
    'Field \'issueType\' doesn\'t exist on type \'Issue\'',
    'Unknown field issueType',
  ])('スキーマエラーの文言が異なる場合（%s）も、Phase1 のクエリで読み直す', async (message) => {
    await explains('`getIssueKind` の GHES 対応のテストです。スキーマエラーの文言が異なる場合も、`GetIssueKindPhase1` のクエリで読み直すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([
        graphqlError('GetIssueKind', message),
        graphqlData('GetIssueKindPhase1', { repository: { issue: { number: 1, state: 'OPEN', subIssues: { totalCount: 0 } } } }),
      ])
      return { client }
    })
    const kind = await step('getIssueKind を呼ぶ', async () => await client.getIssueKind('owner', 'repo', 1))
    await step('結果を確かめる', () => {
      expect(kind.issue_type).toBe(JSON_NULL)
    })
  })

  it.each([
    ['issueType を含むがスキーマの失敗ではない', 'issueType is broken'],
    ['スキーマの失敗だが issueType を含まない', 'Cannot query field \'other\''],
  ])('%s場合は、読み直さずに GitHubAPIError が発生する', async (_label, message) => {
    await explains('`getIssueKind` のテストです。`issueType` を含んでもスキーマエラーでない場合と、スキーマエラーでも `issueType` を含まない場合は、読み直さずに `GitHubAPIError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlError('GetIssueKind', message)])
      return { client, server }
    })
    await step('エラーと送った要求を確かめる', async () => {
      expect(await rejection(client.getIssueKind('owner', 'repo', 1))).toMatchObject({ name: 'GitHubAPIError' })
      expect(graphqlRequests(server)).toHaveLength(1)
    })
  })

  it('Phase1 のクエリで Issue が存在しない場合は、GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueKind` の GHES 対応のテストです。`GetIssueKindPhase1` の応答で Issue が存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([
        graphqlError('GetIssueKind', 'Cannot query field \'issueType\''),
        graphqlData('GetIssueKindPhase1', { repository: { issue: JSON_NULL } }),
      ])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueKind('owner', 'repo', 7))).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/7'))
    })
  })

  it('Phase1 のクエリでリポジトリが存在しない場合は、GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueKind` の GHES 対応のテストです。`GetIssueKindPhase1` の応答でリポジトリが存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([
        graphqlError('GetIssueKind', 'Cannot query field \'issueType\''),
        graphqlData('GetIssueKindPhase1', { repository: JSON_NULL }),
      ])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueKind('owner', 'repo', 7))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/repo'))
    })
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

  it('GraphQL の応答を整形する（投稿者が存在しないコメントは ghost にし、null のノードと重複した PR は除く）', async () => {
    await explains('`getIssueSlim` のテストです。GraphQL の応答を整形し、投稿者が存在しないコメントは `ghost` にして、`null` のノードと重複した PR を除くことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetIssueSlim', response)])
      return { client, server }
    })
    const result = await step('getIssueSlim を呼ぶ', async () => await client.getIssueSlim('owner', 'repo', 460))
    await step('送った要求を確かめる', () => {
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
  })

  it('commentLimit を指定した場合は、GraphQL の変数として送信する', async () => {
    await explains('`getIssueSlim` のテストです。`commentLimit` を指定した場合に、GraphQL の変数としてその値を送信することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetIssueSlim', response)])
      return { client, server }
    })
    await step('getIssueSlim を呼ぶ', async () => {
      await client.getIssueSlim('owner', 'repo', 460, 20)
    })
    await step('送った要求を確かめる', () => {
      expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([{ owner: 'owner', repo: 'repo', number: 460, commentLimit: 20 }])
    })
  })

  it('blockedBy.totalCount を、前提の件数 blockedByCount として返す', async () => {
    await explains('`getIssueSlim` のテストです。応答の `blockedBy.totalCount` を、`blockedByCount` として返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueSlim', { repository: { issue: { ...response.repository.issue, blockedBy: { totalCount: 3 } } } })])
      return { client }
    })
    const issue = await step('getIssueSlim を呼ぶ', async () => await client.getIssueSlim('owner', 'repo', 460))
    await step('結果を確かめる', () => {
      expect(issue.blockedByCount).toBe(3)
    })
  })

  it('blockedBy に対応しない GHES では、件数なしのクエリで読み直し、blockedByCount は undefined にする', async () => {
    await explains('`getIssueSlim` の GHES 対応のテストです。`blockedBy` に対応しない GHES の場合に、件数なしのクエリで読み直し、`blockedByCount` が `undefined` になることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        graphqlError('GetIssueSlim', 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''),
        graphqlData('GetIssueSlimWithoutBlockedBy', response),
      ])
      return { client, server }
    })
    const issue = await step('getIssueSlim を呼ぶ', async () => await client.getIssueSlim('owner', 'repo', 460))
    await step('送った要求を確かめる', () => {
      expect(issue.blockedByCount).toBeUndefined()
      expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetIssueSlim', 'GetIssueSlimWithoutBlockedBy'])
    })
  })

  it('blockedBy と無関係なスキーマエラーは、読み直さずに GitHubAPIError が発生する', async () => {
    await explains('`getIssueSlim` のテストです。`blockedBy` と無関係なスキーマエラーの場合に、読み直さずに `GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlError('GetIssueSlim', 'Field \'linkedBranches\' doesn\'t exist on type \'Issue\'')])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueSlim('owner', 'repo', 460))).toBeInstanceOf(GitHubAPIError)
    })
  })

  it('親・サブ Issue・timelineItems が存在しない Issue は、空の子要素を持つ形で返す', async () => {
    await explains('`getIssueSlim` のテストです。親・サブ Issue・`timelineItems` が存在しない Issue の場合に、空の子要素を持つ形で返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
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
      return { client }
    })
    await step('結果を確かめる', async () => {
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
  })

  it('親にリポジトリが存在しない場合は、owner と repo を null にする', async () => {
    await explains('`getIssueSlim` のテストです。親の応答にリポジトリが存在しない場合に、`owner` と `repo` が `null` になることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueSlim', {
        repository: { issue: { number: 1, state: 'OPEN', title: 't', body: 'b', comments: { totalCount: 0 }, parent: { number: 2, title: 'E', state: 'OPEN' } } },
      })])
      return { client }
    })
    const issue = await step('getIssueSlim を呼ぶ', async () => await client.getIssueSlim('owner', 'repo', 1))
    await step('結果を確かめる', () => {
      expect(issue.parent).toEqual({ number: 2, title: 'E', state: 'OPEN', owner: JSON_NULL, repo: JSON_NULL })
    })
  })

  it('リンク PR は、subject を持つノードから取り出し、source が null のノードと番号が 0 のノードは除く', async () => {
    await explains('`getIssueSlim` のリンク PR のテストです。`subject` を持つノードから PR を取り出し、`source` が `null` のノードと番号が 0 のノードを除くことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueSlim', {
        repository: { issue: { number: 1, state: 'OPEN', title: 't', body: 'b', comments: { totalCount: 0 }, timelineItems: { nodes: [
          { source: JSON_NULL },
          { subject: { number: 455, title: 'PR', state: 'OPEN' } },
          { subject: { number: 0, title: 'zero', state: 'OPEN' } },
        ] } } },
      })])
      return { client }
    })
    const issue = await step('getIssueSlim を呼ぶ', async () => await client.getIssueSlim('owner', 'repo', 1))
    await step('結果を確かめる', () => {
      expect(issue.linked_prs).toEqual([{ number: 455, title: 'PR', state: 'OPEN' }])
    })
  })

  it('Issue が存在しない場合は、Slim の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueSlim` の失敗時のテストです。Issue が存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueSlim', { repository: { issue: JSON_NULL } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueSlim('owner', 'repo', 999))).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/999'))
    })
  })

  it('リポジトリが存在しない場合は、Slim の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueSlim` の失敗時のテストです。リポジトリが存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueSlim', { repository: JSON_NULL })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueSlim('owner', 'nonexistent', 435))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
    })
  })

  it('必須の値が存在しない場合は、存在しなかった場所を示す GitHubAPIError が発生する', async () => {
    await explains('`getIssueSlim` の失敗時のテストです。必須の値 `comments.totalCount` が存在しない場合に、存在しなかった場所を示す `GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueSlim', { repository: { issue: { number: 1, state: 'OPEN', title: 't', body: 'b' } } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueSlim('owner', 'repo', 1))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: issue.comments.totalCount'))
    })
  })
})

describe('closeIssue', () => {
  it('closeIssue は、state=closed と state_reason=completed を PATCH する', async () => {
    await explains('`closeIssue` のテストです。Issue を閉じる場合に、`state=closed` と `state_reason=completed` を PATCH で送信し、応答を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/123', { status: 200, body: { number: 123, state: 'closed', state_reason: 'completed' } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.closeIssue('owner', 'repo', 123)).toEqual({ number: 123, state: 'closed', state_reason: 'completed' })
      expect(restRequests(server).map(({ method, body }) => ({ method, body }))).toEqual([{ method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } }])
    })
  })

  it('closeIssue に state_reason を渡した場合は、送信する本文に state_reason を含める', async () => {
    await explains('`closeIssue` のテストです。`state_reason` を指定した場合に、送信する本文へ指定した値を含めることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/124', { status: 200, body: { number: 124, state: 'closed', state_reason: 'not_planned' } })])
      return { client, server }
    })
    await step('closeIssue を呼ぶ', async () => {
      await client.closeIssue('owner', 'repo', 124, 'not_planned')
    })
    await step('送った要求を確かめる', () => {
      expect(restRequests(server).map(({ body }) => body)).toEqual([{ state: 'closed', state_reason: 'not_planned' }])
    })
  })

  it('GHES のクライアントでも、token 認証で同じパスに PATCH を送信する', async () => {
    await explains('`closeIssue` の GHES 対応のテストです。GHES のホスト名を指定したクライアントでも、`token` 認証で同じパスへ PATCH を送信することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('PATCH', '/repos/org/repo/issues/456', { status: 200, body: { number: 456, state: 'closed' } })], 'ghes.example.com')
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.closeIssue('org', 'repo', 456)).toEqual({ number: 456, state: 'closed' })
      expect(restRequests(server).map(({ auth, path }) => ({ auth, path }))).toEqual([{ auth: 'token', path: '/repos/org/repo/issues/456' }])
    })
  })

  it('404 が返った場合は、GitHubNotFoundError が発生する', async () => {
    await explains('`closeIssue` の失敗時のテストです。存在しない Issue で 404 が返った場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/999', { status: 404, text: 'Not Found' })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.closeIssue('owner', 'repo', 999))).toMatchObject(
        failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/issues/999`, { statusCode: 404 }),
      )
    })
  })
})

describe('listIssuesByLabel', () => {
  it('state=all・labels・per_page=100 を指定して取得し、Pull Request を除く', async () => {
    await explains('`listIssuesByLabel` のテストです。状態・ラベル・1 ページの件数を指定して取得し、結果から Pull Request を除くことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/issues', { status: 200, body: [{ number: 1 }, { number: 2, pull_request: {} }, { number: 3 }] }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listIssuesByLabel('owner', 'repo', 'dependabot-pr')).toEqual([{ number: 1 }, { number: 3 }])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ state: 'all', labels: 'dependabot-pr', per_page: '100' }])
    })
  })

  it('Link ヘッダに next が含まれる場合は、2 ページ目も取得する', async () => {
    await explains('`listIssuesByLabel` のテストです。1 ページ目の `Link` ヘッダに `next` が含まれる場合は、2 ページ目も取得して結果を連結することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/issues', { status: 200, body: [{ number: 1 }], headers: { link: '<{{GITHUB_API}}/repos/owner/repo/issues?page=2>; rel="next"' } }),
        restResponse('GET', '/repos/owner/repo/issues', { status: 200, body: [{ number: 2 }, { number: 3, pull_request: {} }] }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listIssuesByLabel('owner', 'repo', 'x')).toEqual([{ number: 1 }, { number: 2 }])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ state: 'all', labels: 'x', per_page: '100' }, { page: '2' }])
    })
  })

  it('404 が返った場合は、クエリを含む URL を示す GitHubNotFoundError が発生する', async () => {
    await explains('`listIssuesByLabel` の失敗時のテストです。状態コード 404 が返った場合に、クエリを含む URL を示す `GitHubNotFoundError` が発生することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/issues', { status: 404, text: 'Not Found' })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.listIssuesByLabel('owner', 'repo', 'x'))).toMatchObject(
        failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/issues?state=all&labels=x&per_page=100`, { statusCode: 404 }),
      )
    })
  })
})

describe('updateIssueBody', () => {
  it('本文を渡した場合は、body だけを PATCH する', async () => {
    await explains('`updateIssueBody` のテストです。本文を渡した場合に、`body` だけを PATCH で送信し、応答を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/7', { status: 200, body: { number: 7, body: '新しい本文' } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.updateIssueBody('owner', 'repo', 7, '新しい本文')).toEqual({ number: 7, body: '新しい本文' })
      expect(restRequests(server).map(({ method, body }) => ({ method, body }))).toEqual([{ method: 'PATCH', body: { body: '新しい本文' } }])
    })
  })

  it('状態コード 422 が返った場合は、GitHubAPIError が発生する', async () => {
    await explains('`updateIssueBody` の失敗時のテストです。状態コード 422 が返った場合に、状態コードと応答本文を保持した `GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('PATCH', '/repos/owner/repo/issues/7', { status: 422, text: 'too long' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.updateIssueBody('owner', 'repo', 7, 'x'))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: 'too long' }))
    })
  })
})

const PROJECT_ID = 'PVT_board'
const OTHER_PROJECT_ID = 'PVT_other'
const FIELDS = { columnFieldId: 'FIELD_column', labelFieldName: 'Status' }
const COLUMN_FIELD_NAME = 'pecot-status'

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

// 進行の欄の値。ID で探すので、名前は問わない
function columnValue(optionName: string, fieldName = COLUMN_FIELD_NAME): Readonly<Record<string, unknown>> {
  return { name: optionName, optionId: `opt_${optionName}`, field: { id: 'FIELD_column', name: fieldName } }
}

function boardItem(projectId: string, labelName: string, columnName?: string): Readonly<Record<string, unknown>> {
  return {
    project: { id: projectId },
    fieldValues: { nodes: columnName === undefined ? [] : [columnValue(columnName)] },
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
    ...overrides,
  }
}

function target(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { ...prerequisiteIssue(10), body: '本文', parent: JSON_NULL, blockedBy: { totalCount: 0, nodes: [] }, ...overrides }
}

const prerequisitesVariables = { owner: 'owner', repo: 'repo', number: 10, labelFieldName: FIELDS.labelFieldName, blockedByFirst: 50 }

const blockedByCases: readonly Readonly<{ method: 'addBlockedBy' | 'removeBlockedBy', operation: string }>[] = [
  { method: 'addBlockedBy', operation: 'AddBlockedBy' },
  { method: 'removeBlockedBy', operation: 'RemoveBlockedBy' },
]

describe('addBlockedBy・removeBlockedBy', () => {
  it.for(blockedByCases)('$method は、Node ID を issueId と blockingIssueId の変数で送信する', async ({ method, operation }) => {
    await explains('`addBlockedBy` と `removeBlockedBy` のテストです。Issue の Node ID を渡した場合に、`issueId` と `blockingIssueId` を変数にして送信することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData(operation, { issue: { number: 10 }, blockingIssue: { number: 9 } })])
      return { client, server }
    })
    await step('addBlockedBy を呼ぶ', async () => {
      await (method === 'addBlockedBy' ? client.addBlockedBy('I_10', 'I_9') : client.removeBlockedBy('I_10', 'I_9'))
    })
    await step('送った要求を確かめる', () => {
      expect(graphqlRequests(server)).toEqual([{ operation, variables: { issueId: 'I_10', blockingIssueId: 'I_9' } }])
    })
  })

  it.for(blockedByCases)('$method は、HTTP 200 の VALIDATION エラーを受け取った場合に GitHubAPIError が発生する', async ({ method, operation }) => {
    await explains('`addBlockedBy` と `removeBlockedBy` の失敗時のテストです。GraphQL が HTTP 200 で `VALIDATION` のエラーを返した場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([{
        match: { operation },
        respond: { status: 200, body: { data: JSON_NULL, errors: [{ type: 'VALIDATION', message: 'Blocking relationship would create a cycle' }] } },
        times: 1,
      }])
      return { client }
    })
    const error = await step('addBlockedBy を呼ぶ', async () => await rejection(method === 'addBlockedBy' ? client.addBlockedBy('I_10', 'I_9') : client.removeBlockedBy('I_10', 'I_9')))
    await step('結果を確かめる', () => {
      expect(error).toMatchObject({ name: 'GitHubAPIError' })
      expect(error instanceof Error ? error.message : '').toMatch(/^GraphQL query error: .*Blocking relationship would create a cycle/u)
    })
  })

  it.for(blockedByCases)('$method は、Mutation が存在しない GHES の場合に、3.19 以上が必要と示す例外が発生する', async ({ method, operation }) => {
    await explains('`addBlockedBy` と `removeBlockedBy` の GHES 対応のテストです。Mutation が存在しない GHES の場合に、3.19 以上が必要であることを示す `DependenciesUnsupportedError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const field = method
      const { client } = await startClient([graphqlError(operation, `Field '${field}' doesn't exist on type 'Mutation'`)])
      return { client }
    })
    const error = await step('addBlockedBy を呼ぶ', async () => await rejection(method === 'addBlockedBy' ? client.addBlockedBy('I_10', 'I_9') : client.removeBlockedBy('I_10', 'I_9')))
    await step('エラーを確かめる', () => {
      expect(error).toMatchObject(failure(DependenciesUnsupportedError, 'this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required'))
    })
  })
})

async function readWith(issue: Readonly<Record<string, unknown>>): ReturnType<GitHubClient['getIssuePrerequisites']> {
  const { client } = await startClient([graphqlData('GetIssuePrerequisites', { repository: { issue } })])
  return client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS)
}

async function readError(client: Readonly<GitHubClient>): Promise<unknown> {
  return rejection(client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS))
}

function partialResponse(errors: readonly unknown[], issue: Readonly<Record<string, unknown>>): ResponseRule {
  return {
    match: { operation: 'GetIssuePrerequisites' },
    respond: { status: 200, body: { data: { repository: { issue } }, errors } },
    times: 1,
  }
}

describe('getIssuePrerequisites', () => {
  it('親の Issue が存在する場合は、親のリポジトリと番号を取り出す', async () => {
    await explains('`getIssuePrerequisites` のテストです。親の Issue が存在する場合に、親のリポジトリと番号を取り出すことを確認します。')
    const result = await step('readWith を呼ぶ', async () => await readWith(target({ parent: { number: 353, repository: { owner: { login: 'parent-owner' }, name: 'parent-repo' } } })))
    await step('結果を確かめる', () => {
      expect(result.issue.parent).toEqual({ repository: { owner: 'parent-owner', repository: 'parent-repo' }, number: 353 })
    })
  })

  it('親が null の場合は、parent を null にする', async () => {
    await explains('`getIssuePrerequisites` のテストです。親が `null` の場合に、`parent` が `null` になることを確認します。')
    const result = await step('readWith を呼ぶ', async () => await readWith(target({ parent: JSON_NULL })))
    await step('結果を確かめる', () => {
      expect(result.issue.parent).toBe(JSON_NULL)
    })
  })

  it('対象の Issue と blockedBy を取り出し、ボードの値は projectId のものだけにする', async () => {
    await explains('`getIssuePrerequisites` のテストです。対象の Issue と `blockedBy` を取り出し、ボードの値を `projectId` のものだけに絞ることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const blocking = prerequisiteIssue(9, {
        state: 'CLOSED',
        issueType: JSON_NULL,
        projectItems: connection([boardItem(OTHER_PROJECT_ID, 'Done'), boardItem(PROJECT_ID, 'In Progress', 'In Review')]),
      })
      const { client, server } = await startClient([
        graphqlData('GetIssuePrerequisites', { repository: { issue: target({ blockedBy: { totalCount: 1, nodes: [blocking] } }) } }),
      ])
      return { client, server }
    })
    const result = await step('getIssuePrerequisites を呼ぶ', async () => await client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS))
    await step('送った要求を確かめる', () => {
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
            { fieldId: 'FIELD_column', fieldName: COLUMN_FIELD_NAME, optionId: 'opt_In Review', optionName: 'In Review' },
            { fieldId: 'FIELD_status', fieldName: 'Status', optionId: 'opt_In Progress', optionName: 'In Progress' },
          ],
          linkedBranches: [],
          closingPullRequests: [],
        }],
      })
    })
  })

  it('blockedBy の取得件数を指定した場合は、その件数で読み取る', async () => {
    await explains('`getIssuePrerequisites` のテストです。`blockedBy` の取得件数を指定した場合に、その値を `blockedByFirst` として送信することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        graphqlData('GetIssuePrerequisites', { repository: { issue: target({ blockedBy: { totalCount: 0, nodes: [] } }) } }),
      ])
      return { client, server }
    })
    await step('getIssuePrerequisites を呼ぶ', async () => {
      await client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS, 3)
    })
    await step('送った要求を確かめる', () => {
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssuePrerequisites', variables: { ...prerequisitesVariables, blockedByFirst: 3 } }])
    })
  })

  it('PR は、リンクされたブランチと、Issue を閉じる PR の参照の 2 つから取り出す', async () => {
    await explains('`getIssuePrerequisites` のテストです。リンクされたブランチと、Issue を閉じる PR の参照の 2 つから PR を取り出すことを確認します。')
    const { issue } = await step('テストの値を用意する', () => {
      const fromBranch = prNode(21, { headRefName: 'feat/issue-9' })
      const fromClosing = prNode(22, { state: 'MERGED' })
      const issue = target({
        linkedBranches: connection([JSON_NULL, { ref: JSON_NULL }, { ref: { name: 'feat/issue-9', associatedPullRequests: connection([fromBranch]) } }]),
        closedByPullRequestsReferences: connection([fromClosing]),
      })
      return { issue }
    })
    const { read } = await step('readWith を呼ぶ', async () => {
      const { issue: read } = await readWith(issue)
      return { read }
    })
    await step('結果を確かめる', () => {
      expect(read.linkedBranches).toEqual([{
        name: 'feat/issue-9',
        pullRequests: [{ repository: { owner: 'owner', repository: 'repo' }, number: 21, state: 'OPEN', headRefName: 'feat/issue-9', baseRefName: 'main', isDraft: false, isCrossRepository: false }],
      }])
      expect(read.closingPullRequests.map(({ number, state }) => ({ number, state }))).toEqual([{ number: 22, state: 'MERGED' }])
    })
  })

  it('number が存在しない PR のノードは、GitHubAPIError が発生する', async () => {
    await explains('`getIssuePrerequisites` の失敗時のテストです。`number` を持たない PR のノードがある場合に、`GitHubAPIError` が発生することを確認します。')
    const broken = { state: 'OPEN', headRefName: 'feat/issue-10' }
    const issue = target({ closedByPullRequestsReferences: connection([broken]) })
    const error = await step('失敗を受け取る', async () => await rejection(readWith(issue)))
    await step('エラーを確かめる', () => {
      expect(error).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: pullRequest.number'))
    })
  })

  it('対象のボードに登録されていない Issue は、ボードの値を空にする', async () => {
    await explains('`getIssuePrerequisites` のテストです。対象のボードに登録されていない Issue の場合に、`projectFieldValues` が空配列になることを確認します。')
    const projectItems = connection([boardItem(OTHER_PROJECT_ID, 'Ready')])
    const { issue } = await step('readWith を呼ぶ', async () => {
      const { issue } = await readWith(target({ projectItems }))
      return { issue }
    })
    await step('結果を確かめる', () => {
      expect(issue.projectFieldValues).toEqual([])
    })
  })

  it('進行の欄の値だけを持つ項目は、その値だけを取り出す', async () => {
    await explains('`getIssuePrerequisites` のテストです。進行の欄の値だけを持つ項目の場合に、その値だけを取り出すことを確認します。')
    const onlyColumn = { project: { id: PROJECT_ID }, fieldValues: { nodes: [{}, columnValue('Done')] }, label: JSON_NULL }
    const { issue } = await step('readWith を呼ぶ', async () => {
      const { issue } = await readWith(target({ projectItems: connection([onlyColumn]) }))
      return { issue }
    })
    await step('結果を確かめる', () => {
      expect(issue.projectFieldValues).toEqual([{ fieldId: 'FIELD_column', fieldName: COLUMN_FIELD_NAME, optionId: 'opt_Done', optionName: 'Done' }])
    })
  })

  it('進行の欄は名前でなく ID で特定し、旧い名前のままでも値を取り出す', async () => {
    await explains('`getIssuePrerequisites` のテストです。進行の欄を名前ではなく ID で特定する場合に、旧い名前（`pecot-workflow-abc`）のままでも値を取り出すことを確認します。')
    const legacy = { project: { id: PROJECT_ID }, fieldValues: { nodes: [columnValue('Ready', 'pecot-workflow-abc')] }, label: JSON_NULL }
    const { issue } = await step('readWith を呼ぶ', async () => {
      const { issue } = await readWith(target({ projectItems: connection([legacy]) }))
      return { issue }
    })
    await step('結果を確かめる', () => {
      expect(issue.projectFieldValues).toEqual([{ fieldId: 'FIELD_column', fieldName: 'pecot-workflow-abc', optionId: 'opt_Ready', optionName: 'Ready' }])
    })
  })

  it('blockedBy が空で totalCount も 0 の場合は、前提なしの ok にする', async () => {
    await explains('`getIssuePrerequisites` のテストです。`blockedBy` が空で `totalCount` も 0 の場合に、前提なしの `ok` になることを確認します。')
    const { blockedBy } = await step('readWith を呼ぶ', async () => {
      const { blockedBy } = await readWith(target())
      return { blockedBy }
    })
    await step('結果を確かめる', () => {
      expect(blockedBy).toEqual({ kind: 'ok', issues: [] })
    })
  })

  it('blockedBy の nodes が null を含む場合は、read-failed にし、例外は発生しない', async () => {
    await explains('`getIssuePrerequisites` のテストです。`blockedBy` の `nodes` が `null` を含む場合は、例外が発生せず `read-failed` になることを確認します。')
    const { blockedBy } = await step('readWith を呼ぶ', async () => {
      const { blockedBy } = await readWith(target({ blockedBy: { totalCount: 2, nodes: [prerequisiteIssue(9), JSON_NULL] } }))
      return { blockedBy }
    })
    await step('結果を確かめる', () => {
      expect(blockedBy).toEqual({ kind: 'read-failed', reason: 'blockedBy has a null node' })
    })
  })

  it('blockedBy の取得件数が totalCount より少ない場合は、read-failed にする', async () => {
    await explains('`getIssuePrerequisites` のテストです。`blockedBy` の取得件数が `totalCount` より少ない場合は、不足した件数を理由とする `read-failed` を返すことを確認します。')
    const { blockedBy } = await step('readWith を呼ぶ', async () => {
      const { blockedBy } = await readWith(target({ blockedBy: { totalCount: 51, nodes: [prerequisiteIssue(9)] } }))
      return { blockedBy }
    })
    await step('結果を確かめる', () => {
      expect(blockedBy).toEqual({ kind: 'read-failed', reason: 'blockedBy returned 1 of 51 issues' })
    })
  })

  describe('connection の取りこぼし', () => {
    const cut = connection([], 3)
    const nested = { ref: { name: 'feat/issue-9', associatedPullRequests: connection([prNode(21)], 2) } }
    const cases: readonly Readonly<{ name: string, overrides: Readonly<Record<string, unknown>>, reason: string }>[] = [
      { name: 'projectItems', overrides: { projectItems: cut }, reason: 'projectItems of owner/repo#9 returned 0 of 3' },
      { name: 'linkedBranches', overrides: { linkedBranches: cut }, reason: 'linkedBranches of owner/repo#9 returned 0 of 3' },
      { name: 'associatedPullRequests', overrides: { linkedBranches: connection([nested]) }, reason: 'associatedPullRequests of owner/repo#9 returned 1 of 2' },
      { name: 'closedByPullRequestsReferences', overrides: { closedByPullRequestsReferences: cut }, reason: 'closedByPullRequestsReferences of owner/repo#9 returned 0 of 3' },
    ]

    it.for(cases)('前提の Issue の $name の件数が不足している場合は、read-failed にする', async ({ overrides, reason }) => {
      await explains('`getIssuePrerequisites` のテストです。前提の Issue の connection が `totalCount` より少ない件数しか返らない場合は、不足した項目を理由とする `read-failed` を返すことを確認します。')
      const { blockedBy } = await step('readWith を呼ぶ', async () => {
        const { blockedBy } = await readWith(target({ blockedBy: { totalCount: 1, nodes: [prerequisiteIssue(9, overrides)] } }))
        return { blockedBy }
      })
      await step('結果を確かめる', () => {
        expect(blockedBy).toEqual({ kind: 'read-failed', reason })
      })
    })

    it('言及の件数が多くても、タイムラインを読み取らないので ok にする', async () => {
      await explains('`getIssuePrerequisites` のテストです。クエリにタイムラインを含めないため、言及の件数が多くても `ok` になることを確認します。')
      await step('結果を確かめる', () => {
        expect(QUERY_GET_ISSUE_PREREQUISITES).not.toContain('timelineItems')
      })
      const mentions = { timelineItems: connection([], 29) }
      const merged = { state: 'CLOSED', closedByPullRequestsReferences: connection([prNode(21, { state: 'MERGED' })]), ...mentions }
      const { blockedBy } = await step('readWith を呼ぶ', async () => {
        const { blockedBy } = await readWith(target({ ...mentions, blockedBy: { totalCount: 1, nodes: [prerequisiteIssue(9, merged)] } }))
        return { blockedBy }
      })
      await step('結果を確かめる', () => {
        expect(blockedBy).toMatchObject({ kind: 'ok', issues: [{ number: 9, closingPullRequests: [{ number: 21, state: 'MERGED' }] }] })
      })
    })
  })

  describe('部分エラー', () => {
    it('errors が blockedBy の下だけの場合は、例外にせず blockedBy を read-failed にする', async () => {
      await explains('`getIssuePrerequisites` の部分エラーのテストです。`errors` のパスが `blockedBy` の下だけの場合に、例外にせず `blockedBy` を `read-failed` にし、Issue 自体は取り出すことを確認します。')
      const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
        const errors = [{ message: 'Could not resolve to an Issue', path: ['repository', 'issue', 'blockedBy', 'nodes', 1] }]
        const blockedBy = { totalCount: 2, nodes: [prerequisiteIssue(9), JSON_NULL] }
        const { client } = await startClient([partialResponse(errors, target({ blockedBy }))])
        return { client }
      })
      const result = await step('getIssuePrerequisites を呼ぶ', async () => await client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS))
      await step('結果を確かめる', () => {
        expect(result.issue.number).toBe(10)
        expect(result.blockedBy).toEqual({ kind: 'read-failed', reason: 'blockedBy could not be read: Could not resolve to an Issue' })
      })
    })

    it('blockedBy 自体が null の場合も、read-failed にする', async () => {
      await explains('`getIssuePrerequisites` の部分エラーのテストです。`blockedBy` 自体が `null` になった場合も、`read-failed` になることを確認します。')
      const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
        const errors = [{ message: 'forbidden', path: ['repository', 'issue', 'blockedBy'] }]
        const { client } = await startClient([partialResponse(errors, target({ blockedBy: JSON_NULL }))])
        return { client }
      })
      const result = await step('getIssuePrerequisites を呼ぶ', async () => await client.getIssuePrerequisites('owner', 'repo', 10, PROJECT_ID, FIELDS))
      await step('結果を確かめる', () => {
        expect(result.blockedBy).toEqual({ kind: 'read-failed', reason: 'blockedBy could not be read: forbidden' })
      })
    })

    it('blockedBy の外のパスの errors が 1 つでも含まれる場合は、例外が発生する', async () => {
      await explains('`getIssuePrerequisites` の部分エラーのテストです。`blockedBy` の外のパスの `errors` が 1 つでも含まれる場合に、`GitHubAPIError` が発生することを確認します。')
      const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
        const errors = [
          { message: 'ok to tolerate', path: ['repository', 'issue', 'blockedBy', 'nodes', 0] },
          { message: 'broken elsewhere', path: ['repository', 'issue', 'linkedBranches'] },
        ]
        const { client } = await startClient([partialResponse(errors, target())])
        return { client }
      })
      const error = await step('readError を呼ぶ', async () => await readError(client))
      await step('結果を確かめる', () => {
        expect(error).toBeInstanceOf(GitHubAPIError)
        expect(error instanceof Error ? error.message : '').toContain('ok to tolerate')
      })
    })

    it('path を持たない errors の場合は、例外が発生する', async () => {
      await explains('`getIssuePrerequisites` の部分エラーのテストです。`path` を持たない `errors` の場合に、`GitHubAPIError` が発生することを確認します。')
      const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
        const { client } = await startClient([partialResponse([{ message: 'no path' }], target())])
        return { client }
      })
      await step('結果を確かめる', async () => {
        expect(await readError(client)).toBeInstanceOf(GitHubAPIError)
      })
    })
  })

  describe('Issue の依存関係に対応しない GHES', () => {
    const unsupported = 'this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required'

    it.for(['Field \'blockedBy\' doesn\'t exist on type \'Issue\'', 'Cannot query field \'issueType\' on type \'Issue\''])('スキーマエラー（%s）の場合は、3.19 以上が必要と示す例外が発生し、読み直さない', async (message) => {
      await explains('`getIssuePrerequisites` の GHES 対応のテストです。スキーマエラーの場合に、3.19 以上が必要であることを示す `DependenciesUnsupportedError` が発生し、読み直しを行わないことを確認します。')
      const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
        const { client, server } = await startClient([graphqlError('GetIssuePrerequisites', message)])
        return { client, server }
      })
      await step('エラーと送った要求を確かめる', async () => {
        expect(await readError(client)).toMatchObject(failure(DependenciesUnsupportedError, unsupported))
        expect(graphqlRequests(server)).toHaveLength(1)
      })
    })
  })

  it('blockedBy と無関係なエラーの場合は、そのまま例外が発生する', async () => {
    await explains('`getIssuePrerequisites` の失敗時のテストです。`blockedBy` と無関係なエラーの場合に、`DependenciesUnsupportedError` ではない `GitHubAPIError` が発生し、読み直しを行わないことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlError('GetIssuePrerequisites', 'Something else broke')])
      return { client, server }
    })
    const error = await step('readError を呼ぶ', async () => await readError(client))
    await step('送った要求を確かめる', () => {
      expect(error).toBeInstanceOf(GitHubAPIError)
      expect(error).not.toBeInstanceOf(DependenciesUnsupportedError)
      expect(error instanceof Error ? error.message : '').toContain('Something else broke')
      expect(graphqlRequests(server)).toHaveLength(1)
    })
  })

  it('Issue が存在しない場合は、前提の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getIssuePrerequisites` の失敗時のテストです。Issue が存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssuePrerequisites', { repository: { issue: JSON_NULL } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await readError(client)).toMatchObject(failure(GitHubNotFoundError, 'Issue not found: owner/repo/10'))
    })
  })

  it('必須の値が存在しない場合は、前提の取得で GitHubAPIError が発生する', async () => {
    await explains('`getIssuePrerequisites` の失敗時のテストです。必須の値 `issue.id` が `null` の場合に、存在しなかった場所を示す `GitHubAPIError` が発生することを確認します。')
    const error = await step('失敗を受け取る', async () => await rejection(readWith(target({ id: JSON_NULL }))))
    await step('エラーを確かめる', () => {
      expect(error).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: issue.id'))
    })
  })
})

const BLOCKER_NODE = { id: 'I_8', number: 8, state: 'OPEN', repository: { owner: { login: 'acme' }, name: 'demo' } }

describe('getIssueBlockingReferences', () => {
  it('その Issue を前提としている Issue の参照（別のリポジトリのものを含む）と件数を取り出す', async () => {
    await explains('`getIssueBlockingReferences` のテストです。その Issue を前提としている Issue の参照（別のリポジトリのものを含む）と件数を取り出すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const other = { id: 'I_9', number: 9, state: 'OPEN', repository: { owner: { login: 'acme' }, name: 'other' } }
      const issue = { blocking: { totalCount: 2, nodes: [BLOCKER_NODE, other] } }
      const { client, server } = await startClient([graphqlData('GetIssueBlockingReferences', { repository: { issue } })])
      return { client, server }
    })

    const result = await step('getIssueBlockingReferences を呼ぶ', async () => await client.getIssueBlockingReferences('acme', 'demo', 7))
    await step('送った要求を確かめる', () => {
      expect(result).toEqual({
        kind: 'ok',
        total: 2,
        issues: [
          { id: 'I_8', number: 8, repository: { owner: 'acme', repository: 'demo' }, state: 'OPEN' },
          { id: 'I_9', number: 9, repository: { owner: 'acme', repository: 'other' }, state: 'OPEN' },
        ],
      })
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueBlockingReferences', variables: { owner: 'acme', repo: 'demo', number: 7, blockingFirst: 50 } }])
    })
  })

  it('取得した件数より全体の件数が多い場合は、total に全体の件数を返す', async () => {
    await explains('`getIssueBlockingReferences` のテストです。全体の件数が取得した件数より多い場合に、`total` に全体の件数を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const issue = { blocking: { totalCount: 3, nodes: [BLOCKER_NODE] } }
      const { client } = await startClient([graphqlData('GetIssueBlockingReferences', { repository: { issue } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getIssueBlockingReferences('acme', 'demo', 7, 1)).toMatchObject({ kind: 'ok', total: 3, issues: [{ number: 8 }] })
    })
  })

  it('blocking が null の場合は、read-failed にする', async () => {
    await explains('`getIssueBlockingReferences` のテストです。`blocking` が `null` の場合に、`read-failed` になることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueBlockingReferences', { repository: { issue: { blocking: JSON_NULL } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getIssueBlockingReferences('acme', 'demo', 7)).toEqual({ kind: 'read-failed', reason: 'blocking is null' })
    })
  })

  it('blocking の nodes に null が含まれる場合は、read-failed にする', async () => {
    await explains('`getIssueBlockingReferences` のテストです。`nodes` に `null` が含まれる場合は、`read-failed` になることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: 1, nodes: [JSON_NULL] } } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getIssueBlockingReferences('acme', 'demo', 7)).toEqual({ kind: 'read-failed', reason: 'blocking has a null node' })
    })
  })

  it('blocking の下の部分エラーは、例外にせず read-failed で返す', async () => {
    await explains('`getIssueBlockingReferences` の部分エラーのテストです。`blocking` の下の部分エラーの場合に、例外にせず `read-failed` で返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const errors = [{ message: 'forbidden', path: ['repository', 'issue', 'blocking', 'nodes', 0] }]
      const { client } = await startClient([{ match: { operation: 'GetIssueBlockingReferences' }, respond: { status: 200, body: { data: { repository: { issue: { blocking: JSON_NULL } } }, errors } }, times: 1 }])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getIssueBlockingReferences('acme', 'demo', 7)).toEqual({ kind: 'read-failed', reason: 'blocking could not be read: forbidden' })
    })
  })

  it('Issue が存在しない場合は、前提にしている Issue の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getIssueBlockingReferences` の失敗時のテストです。Issue が存在しない場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetIssueBlockingReferences', { repository: { issue: JSON_NULL } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueBlockingReferences('acme', 'demo', 7))).toBeInstanceOf(GitHubNotFoundError)
    })
  })

  it.for([
    { name: 'Issue', data: { repository: { issue: JSON_NULL } }, path: ['repository', 'issue'], message: 'Issue not found: acme/demo/7' },
    { name: 'リポジトリ', data: { repository: JSON_NULL }, path: ['repository'], message: 'repository not found: acme/demo' },
  ])('GitHub が $name の不在を NOT_FOUND の errors で返した場合は、GitHubNotFoundError が発生する', async (row) => {
    await explains('`getIssueBlockingReferences` の失敗時のテストです。GitHub が Issue またはリポジトリの不在を `NOT_FOUND` の `errors` で返した場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const errors = [{ type: 'NOT_FOUND', path: row.path, message: 'Could not resolve' }]
      const { client } = await startClient([{ match: { operation: 'GetIssueBlockingReferences' }, respond: { status: 200, body: { data: row.data, errors } }, times: 1 }])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueBlockingReferences('acme', 'demo', 7))).toMatchObject(failure(GitHubNotFoundError, row.message))
    })
  })

  it('依存関係に対応しない GHES では、前提にしている Issue の取得で DependenciesUnsupportedError が発生する', async () => {
    await explains('`getIssueBlockingReferences` の GHES 対応のテストです。依存関係に対応しない GHES の場合に、`DependenciesUnsupportedError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlError('GetIssueBlockingReferences', 'Field \'blocking\' doesn\'t exist on type \'Issue\'')])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getIssueBlockingReferences('acme', 'demo', 7))).toBeInstanceOf(DependenciesUnsupportedError)
    })
  })
})
