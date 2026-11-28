// PullsApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// get_pull_request_slim・get_pull_request_with_reviews の期待値は、同じ応答を Python の GitHubClient に渡して得た辞書。
import { describe, expect, it } from 'vitest'

import { jsonField } from '../../../domain/json.js'
import { JSON_NULL } from '../../../domain/json-null.js'
import type { JsonValue } from '../../../domain/python-format.js'
import { GitHubAPIError, GitHubNotFoundError } from '../errors.js'
import { failure, graphqlData, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'
import { explains } from '../../../../tests/_helpers/explains.js'
import { step } from '../../../../tests/_helpers/step.js'

useFakeGithub()

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
