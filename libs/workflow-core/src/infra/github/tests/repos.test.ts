// ReposApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// 要求の本文・変数は、cli/core/github/repos.py を読んで写した。
import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubAPIError, GitHubNotFoundError, GitHubRateLimitError } from '../errors.js'
import { failure, graphqlData, graphqlError, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'
import { explains } from '../../../../tests/_helpers/explains.js'
import { step } from '../../../../tests/_helpers/step.js'

useFakeGithub()

describe('getRepositoryId', () => {
  it('リポジトリの owner と name を変数として送信し、リポジトリの Node ID を返す', async () => {
    await explains('リポジトリの Node ID を取得する `getRepositoryId` のテストです。owner と name を GraphQL の変数として送信し、応答の `R_repo` を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('GetRepositoryId', { repository: { id: 'R_repo' } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getRepositoryId('owner', 'repo')).toBe('R_repo')
      expect(graphqlRequests(server)).toEqual([{ operation: 'GetRepositoryId', variables: { owner: 'owner', name: 'repo' } }])
    })
  })

  it('リポジトリが存在しない場合は、GitHubNotFoundError を発生させる', async () => {
    await explains('`getRepositoryId` のテストです。応答のリポジトリが `null` の場合に、`repository not found: owner/nonexistent` を持つ `GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlData('GetRepositoryId', { repository: JSON_NULL })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getRepositoryId('owner', 'nonexistent'))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
    })
  })
})

describe('getBranchSha', () => {
  it('ブランチの ref を取得すると、object.sha を返す', async () => {
    await explains('ブランチの先頭の SHA を取得する `getBranchSha` のテストです。応答の `object.sha` を返し、`/repos/owner/repo/git/ref/heads/develop` を 1 回だけ要求することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/git/ref/heads/develop', { status: 200, body: { ref: 'refs/heads/develop', object: { sha: 'abc123def456', type: 'commit' } } }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getBranchSha('owner', 'repo', 'develop')).toBe('abc123def456')
      expect(restRequests(server).map(({ method, path }) => [method, path])).toEqual([['GET', '/repos/owner/repo/git/ref/heads/develop']])
    })
  })

  it('スラッシュを含むブランチ名は、そのままパスに含める', async () => {
    await explains('`getBranchSha` のテストです。`feat/issue-1` のようにスラッシュを含むブランチ名の場合に、スラッシュを変換せず、そのままパスに含めて要求することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/git/ref/heads/feat/issue-1', { status: 200, body: { object: { sha: 'f00' } } }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getBranchSha('owner', 'repo', 'feat/issue-1')).toBe('f00')
      expect(restRequests(server).map(({ path }) => path)).toEqual(['/repos/owner/repo/git/ref/heads/feat/issue-1'])
    })
  })

  it('404 が返ると、URL を含む GitHubNotFoundError を発生させる', async () => {
    await explains('`getBranchSha` のテストです。存在しないブランチを指定して 404 が返った場合に、要求した URL を含む `GitHubNotFoundError` が発生し、ステータスコードが 404 であることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/git/ref/heads/nonexistent', { status: 404, body: { message: 'Not Found' } }),
      ])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.getBranchSha('owner', 'repo', 'nonexistent'))).toMatchObject(
        failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/git/ref/heads/nonexistent`, { statusCode: 404 }),
      )
    })
  })
})

describe('listWorkflowRunConclusions', () => {
  it('head_sha で絞った run の id と conclusion を返し、未完了の run の conclusion は空文字にする', async () => {
    await explains('ワークフローの実行結果を取得する `listWorkflowRunConclusions` のテストです。`head_sha` で絞り込んだ run の `id` と `conclusion` を返し、未完了の run の `conclusion` は空文字になることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/actions/runs', { status: 200, body: { total_count: 2, workflow_runs: [{ id: 1, conclusion: 'success' }, { id: 2 }] } }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listWorkflowRunConclusions('owner', 'repo', 'abc')).toEqual([{ id: 1, conclusion: 'success' }, { id: 2, conclusion: '' }])
      expect(restRequests(server).map(({ method, path, query }) => [method, path, query])).toEqual([['GET', '/repos/owner/repo/actions/runs', { head_sha: 'abc', per_page: '100' }]])
    })
  })
})

describe('getMergeBase', () => {
  it('compare の base...head を per_page=1 で取得し、merge_base_commit の SHA を返す', async () => {
    await explains('`getMergeBase` のテストです。`main...feat/x/1` の比較結果を `per_page=1` で要求し、`merge_base_commit.sha` を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/compare/main...feat/x/1', { status: 200, body: { merge_base_commit: { sha: 'base123' } } }),
      ])
      return { client, server }
    })
    await step('送った要求と結果を確かめる', async () => {
      expect(await client.getMergeBase('owner', 'repo', 'main', 'feat/x/1')).toBe('base123')
      expect(restRequests(server).map(({ method, path, query }) => [method, path, query])).toEqual([['GET', '/repos/owner/repo/compare/main...feat/x/1', { per_page: '1' }]])
    })
  })
})

describe('countCommitsAhead', () => {
  it('compare の base...head を per_page=1 で取得し、ahead_by を返す', async () => {
    await explains('ブランチ間の先行コミット数を取得する `countCommitsAhead` のテストです。`main...develop` の比較結果を `per_page=1` で要求し、`ahead_by` の値（4）を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/compare/main...develop', { status: 200, body: { ahead_by: 4, behind_by: 1 } }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.countCommitsAhead('owner', 'repo', 'main', 'develop')).toBe(4)
      expect(restRequests(server).map(({ method, path, query }) => [method, path, query])).toEqual([['GET', '/repos/owner/repo/compare/main...develop', { per_page: '1' }]])
    })
  })

  it('ahead_by が 0 の場合は、0 を返す', async () => {
    await explains('`countCommitsAhead` のテストです。応答の `ahead_by` が 0 の場合に、`0` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([
        restResponse('GET', '/repos/owner/repo/compare/main...develop', { status: 200, body: { ahead_by: 0 } }),
      ])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.countCommitsAhead('owner', 'repo', 'main', 'develop')).toBe(0)
    })
  })

  it.each([
    ['ahead_by が無い', {}],
    ['ahead_by が文字列', { ahead_by: '4' }],
    ['ahead_by が整数でない', { ahead_by: 1.5 }],
  ])('比較の応答で「%s」の場合は、GitHubAPIError を発生させる', async (_label, body) => {
    await explains(`\`countCommitsAhead\` のテストです。比較の応答で「${_label}」の場合に、\`GitHubAPIError\` が発生することを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/compare/main...develop', { status: 200, body })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.countCommitsAhead('owner', 'repo', 'main', 'develop'))).toMatchObject(failure(GitHubAPIError, 'could not read ahead_by from the compare response'))
    })
  })

  it('存在しないブランチで 404 が返ると、GitHubNotFoundError を発生させる', async () => {
    await explains('`countCommitsAhead` のテストです。存在しないブランチを指定して 404 が返った場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([
        restResponse('GET', '/repos/owner/repo/compare/main...nonexistent', { status: 404, body: { message: 'Not Found' } }),
      ])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.countCommitsAhead('owner', 'repo', 'main', 'nonexistent'))).toBeInstanceOf(GitHubNotFoundError)
    })
  })
})

describe('createLinkedBranch', () => {
  const created = { createLinkedBranch: { linkedBranch: { ref: { name: 'feat/test-branch', prefix: 'refs/heads/' } } } }

  it('repositoryId を省略すると、input に issueId・oid・name だけを送信する', async () => {
    await explains('リンクしたブランチを作成する `createLinkedBranch` のテストです。`repositoryId` を省略した場合に、GraphQL の `input` に `issueId`・`oid`・`name` だけを送信し、作成したブランチ名を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('CreateLinkedBranch', created)])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.createLinkedBranch('I_kwDOtest123', 'abc123def456', 'feat/test-branch')).toBe('feat/test-branch')
      expect(graphqlRequests(server)).toEqual([{
        operation: 'CreateLinkedBranch',
        variables: { input: { issueId: 'I_kwDOtest123', oid: 'abc123def456', name: 'feat/test-branch' } },
      }])
    })
  })

  it('repositoryId を指定すると、input に含めて送信する', async () => {
    await explains('`createLinkedBranch` のテストです。`repositoryId` を指定した場合に、GraphQL の `input` に `repositoryId` を含めて送信することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('CreateLinkedBranch', created)])
      return { client, server }
    })
    await step('createLinkedBranch を呼ぶ', async () => {
      await client.createLinkedBranch('I_1', 'abc', 'feat/cross-repo-branch', 'R_kwDOrepo456')
    })
    await step('送った要求を確かめる', () => {
      expect(graphqlRequests(server)).toEqual([{
        operation: 'CreateLinkedBranch',
        variables: { input: { issueId: 'I_1', oid: 'abc', name: 'feat/cross-repo-branch', repositoryId: 'R_kwDOrepo456' } },
      }])
    })
  })

  it('repositoryId が空文字の場合は、input に含めない', async () => {
    await explains('`createLinkedBranch` のテストです。`repositoryId` が空文字の場合に、GraphQL の `input` に `repositoryId` を含めないことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([graphqlData('CreateLinkedBranch', created)])
      return { client, server }
    })
    await step('createLinkedBranch を呼ぶ', async () => {
      await client.createLinkedBranch('I_1', 'abc', 'n', '')
    })
    await step('送った要求を確かめる', () => {
      expect(graphqlRequests(server)).toEqual([{ operation: 'CreateLinkedBranch', variables: { input: { issueId: 'I_1', oid: 'abc', name: 'n' } } }])
    })
  })

  const nullBranch = graphqlData('CreateLinkedBranch', { createLinkedBranch: { linkedBranch: JSON_NULL } })

  it('linkedBranch が null で同じ名前のブランチがあると、そのことと直し方を持つ GitHubAPIError を発生させる', async () => {
    await explains('`createLinkedBranch` のテストです。`linkedBranch` が `null` で作り先のリポに同じ名前のブランチが存在する場合に、リポ名と別の名前を使う直し方をエラーに表示することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([nullBranch, graphqlData('GetBranchRefByNode', { node: { repository: { nameWithOwner: 'owner/repo', ref: { name: 'feat/x/1' } } } })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createLinkedBranch('I_1', 'abc', 'feat/x/1'))).toMatchObject(failure(GitHubAPIError, 'GitHub did not create the linked branch: a branch named feat/x/1 already exists in owner/repo. Use another branch name, or delete that branch if nothing uses it'))
    })
    await step('作り先を読んだ要求を確かめる', () => {
      expect(graphqlRequests(server)[1]).toEqual({ operation: 'GetBranchRefByNode', variables: { id: 'I_1', qualifiedName: 'refs/heads/feat/x/1' } })
    })
  })

  it('linkedBranch が null で同じ名前のブランチが無いと、確かめる所を持つ GitHubAPIError を発生させる', async () => {
    await explains('`createLinkedBranch` のテストです。`linkedBranch` が `null` で同じ名前のブランチが存在しない場合に、ブランチの一覧とトークンの権限を確認するよう表示することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([nullBranch, graphqlData('GetBranchRefByNode', { node: { repository: { nameWithOwner: 'owner/repo', ref: JSON_NULL } } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createLinkedBranch('I_1', 'abc', 'n'))).toMatchObject(failure(GitHubAPIError, 'GitHub did not create the linked branch n and gave no reason: check the branches of owner/repo for the same name, and that the token can write its contents'))
    })
  })

  it('linkedBranch が null で repositoryId を指定していると、そのリポを読んで理由を書く', async () => {
    await explains('`createLinkedBranch` のテストです。`repositoryId` を指定して `linkedBranch` が `null` の場合に、`repositoryId` のリポを読み、その名前で理由を表示することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([nullBranch, graphqlData('GetBranchRefByNode', { node: { nameWithOwner: 'owner/other', ref: { name: 'n' } } })])
      return { client, server }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createLinkedBranch('I_1', 'abc', 'n', 'R_other'))).toMatchObject(failure(GitHubAPIError, 'GitHub did not create the linked branch: a branch named n already exists in owner/other. Use another branch name, or delete that branch if nothing uses it'))
    })
    await step('作り先を読んだ要求を確かめる', () => {
      expect(graphqlRequests(server)[1]).toEqual({ operation: 'GetBranchRefByNode', variables: { id: 'R_other', qualifiedName: 'refs/heads/n' } })
    })
  })

  it.each([
    ['作り先の Node が読めない', graphqlData('GetBranchRefByNode', { node: JSON_NULL })],
    ['作り先を読む query が失敗する', graphqlError('GetBranchRefByNode', 'Could not resolve to a node')],
  ])('linkedBranch が null で「%s」と、リポ名の無い確かめる所の文で GitHubAPIError を発生させる', async (_label, rule) => {
    await explains(`\`createLinkedBranch\` のテストです。\`linkedBranch\` が \`null\` で「${_label}」場合に、リポ名の無い確認先の文をエラーに表示することを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([nullBranch, rule])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createLinkedBranch('I_1', 'abc', 'n'))).toMatchObject(failure(GitHubAPIError, 'GitHub did not create the linked branch n and gave no reason: check the branches of the repository for the same name, and that the token can write its contents'))
    })
  })

  it('GitHub が errors を返してブランチの作成を断ると、GraphQL query error の GitHubAPIError を発生させる', async () => {
    await explains('`createLinkedBranch` のテストです。GraphQL が errors を返してブランチの作成を断った場合に、`GraphQL query error` で始まるメッセージの `GitHubAPIError` が発生することを確認します。')
    const { client, message } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([graphqlError('CreateLinkedBranch', 'A branch named \'feat/existing-branch\' already exists')])
      // errors[0] は辞書なので、gql は Python の str(dict) の文にする
      const message = 'GraphQL query error: {\'message\': "A branch named \'feat/existing-branch\' already exists"}'
      return { client, message }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createLinkedBranch('I_1', 'abc', 'feat/existing-branch'))).toMatchObject(failure(GitHubAPIError, message))
    })
  })
})

describe('createRelease', () => {
  it('オプションを省略すると、target_commitish が main で draft と prerelease が false の本文を、Python と同じキー順で送信する', async () => {
    await explains('リリースを作成する `createRelease` のテストです。オプションを省略した場合に、`target_commitish` が `main`、`draft` と `prerelease` が `false` の本文を、Python と同じキー順で送信することを確認します。')
    const { response, client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const response = { id: 1, tag_name: 'v0.6.1', name: 'v0.6.1', html_url: 'https://github.com/owner/repo/releases/tag/v0.6.1' }
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/releases', { status: 201, body: response })])
      return { response, client, server }
    })
    await step('結果を確かめる', async () => {
      expect(await client.createRelease('owner', 'repo', 'v0.6.1', 'v0.6.1', '### 追加\n\n- 新機能')).toEqual(response)
    })
    const [request] = restRequests(server)
    await step('結果を確かめる', () => {
      expect(JSON.stringify(request?.body)).toBe(JSON.stringify({
        tag_name: 'v0.6.1',
        name: 'v0.6.1',
        body: '### 追加\n\n- 新機能',
        target_commitish: 'main',
        draft: false,
        prerelease: false,
      }))
    })
  })

  it('targetCommitish・draft・prerelease を指定すると、本文に target_commitish・draft・prerelease として含めて送信する', async () => {
    await explains('`createRelease` のテストです。`targetCommitish`・`draft`・`prerelease` を指定した場合に、送信する本文に `target_commitish`・`draft`・`prerelease` の値が含まれることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/releases', { status: 201, body: { id: 2, tag_name: 'v1.0.0' } })])
      return { client, server }
    })
    await step('createRelease を呼ぶ', async () => {
      await client.createRelease('owner', 'repo', 'v1.0.0', 'v1.0.0', 'Release notes', { targetCommitish: 'release', draft: true, prerelease: true })
    })
    await step('送った要求を確かめる', () => {
      expect(restRequests(server).map(({ body }) => body)).toEqual([{
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        body: 'Release notes',
        target_commitish: 'release',
        draft: true,
        prerelease: true,
      }])
    })
  })

  it('422 が返ると、GitHubAPIError を発生させる', async () => {
    await explains('`createRelease` のテストです。422 が返った場合に、ステータスコードと応答本文を持つ `GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('POST', '/repos/owner/repo/releases', { status: 422, text: 'Validation Failed' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.createRelease('owner', 'repo', 'v0.6.1', 'v0.6.1', 'notes'))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: 'Validation Failed' }))
    })
  })
})

describe('listOpenDependabotAlerts', () => {
  it('1 ページで終わる場合は、state=open・per_page=100 で 1 回だけ取得する', async () => {
    await explains('オープンな Dependabot alert を取得する `listOpenDependabotAlerts` のテストです。応答が 1 ページで終わる場合に、`state=open`・`per_page=100` で 1 回だけ要求し、alert をすべて返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 200, body: [{ number: 1 }, { number: 2 }] })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listOpenDependabotAlerts('owner', 'repo')).toEqual([{ number: 1 }, { number: 2 }])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }])
    })
  })

  it('2 ページ目は、Link ヘッダの next に書かれた絶対 URL を、パラメーターを付けずに取得する', async () => {
    await explains('`listOpenDependabotAlerts` のテストです。`Link` ヘッダに `next` がある場合に、その絶対 URL をパラメーターなしで取得し、2 ページ分の alert を結合して返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/dependabot/alerts', {
          status: 200,
          body: [{ number: 1 }],
          headers: { link: '<{{GITHUB_API}}/repos/owner/repo/dependabot/alerts?after=abc>; rel="next"' },
        }),
        restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 200, body: [{ number: 2 }] }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listOpenDependabotAlerts('owner', 'repo')).toEqual([{ number: 1 }, { number: 2 }])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }, { after: 'abc' }])
    })
  })

  it('403 が返ると、ステータスコードと本文を持つ GitHubAPIError を発生させる', async () => {
    await explains('`listOpenDependabotAlerts` のテストです。Dependabot alert が無効なリポジトリで 403 が返った場合に、ステータスコードと応答本文を保持する `GitHubAPIError` が発生することを確認します。')
    const { body, client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const body = '{"message":"Dependabot alerts are disabled for this repository."}'
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 403, text: body })])
      return { body, client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.listOpenDependabotAlerts('owner', 'repo'))).toMatchObject(failure(GitHubAPIError, 'access denied', { statusCode: 403, responseBody: body }))
    })
  })

  it('レート制限による 403 が返ると、GitHubRateLimitError を発生させる', async () => {
    await explains('`listOpenDependabotAlerts` のテストです。レート制限による 403 が返った場合に、`GitHubRateLimitError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 403, text: 'API rate limit exceeded' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      await expect(client.listOpenDependabotAlerts('owner', 'repo')).rejects.toBeInstanceOf(GitHubRateLimitError)
    })
  })
})

describe('listOpenCodeScanningAlerts', () => {
  it('state=open・per_page=100 で取得し、ref は付けない', async () => {
    await explains('オープンな code scanning の alert を取得する `listOpenCodeScanningAlerts` のテストです。`state=open`・`per_page=100` で要求し、`ref` を付けないことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/code-scanning/alerts', { status: 200, body: [{ number: 3 }] })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listOpenCodeScanningAlerts('owner', 'repo')).toEqual([{ number: 3 }])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }])
    })
  })

  it('2 ページ目は、Link ヘッダの next を、パラメーターを付けずに取得する', async () => {
    await explains('`listOpenCodeScanningAlerts` のテストです。`Link` ヘッダに `next` がある場合に、その URL をパラメーターなしで取得し、2 ページ分の alert を結合して返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/code-scanning/alerts', { status: 200, body: [{ number: 1 }], headers: { link: '<{{GITHUB_API}}/repos/owner/repo/code-scanning/alerts?after=x>; rel="next"' } }),
        restResponse('GET', '/repos/owner/repo/code-scanning/alerts', { status: 200, body: [{ number: 2 }] }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listOpenCodeScanningAlerts('owner', 'repo')).toEqual([{ number: 1 }, { number: 2 }])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }, { after: 'x' }])
    })
  })

  it('404 が返ると、ステータスコードと本文を持つ GitHubNotFoundError を発生させる', async () => {
    await explains('`listOpenCodeScanningAlerts` のテストです。解析が存在しないリポジトリで 404 が返った場合に、ステータスコードと応答本文を保持する `GitHubNotFoundError` が発生することを確認します。')
    const { body, client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const body = '{"message":"no analysis found"}'
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/code-scanning/alerts', { status: 404, text: body })])
      return { body, client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.listOpenCodeScanningAlerts('owner', 'repo'))).toMatchObject({ name: 'GitHubNotFoundError', statusCode: 404, responseBody: body })
    })
  })
})

describe('listOpenSecretScanningAlerts', () => {
  it('hide_secret=true を必ず付けて取得する', async () => {
    await explains('オープンな secret scanning の alert を取得する `listOpenSecretScanningAlerts` のテストです。`hide_secret=true` を必ず付けて要求し、alert を返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/secret-scanning/alerts', { status: 200, body: [{ number: 7 }] })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listOpenSecretScanningAlerts('owner', 'repo')).toEqual([{ number: 7 }])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ hide_secret: 'true', per_page: '100', state: 'open' }])
    })
  })

  it('404 が返ると、GitHubNotFoundError を発生させる', async () => {
    await explains('`listOpenSecretScanningAlerts` のテストです。404 が返った場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/secret-scanning/alerts', { status: 404, text: 'Not Found' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      await expect(client.listOpenSecretScanningAlerts('owner', 'repo')).rejects.toBeInstanceOf(GitHubNotFoundError)
    })
  })
})

describe('getSecretScanningStatus', () => {
  it.each(['enabled', 'disabled'])('secret_scanning.status が %s の場合は、その値を返す', async (status) => {
    await explains(`secret scanning の状態を取得する \`getSecretScanningStatus\` のテストです。\`security_and_analysis.secret_scanning.status\` が \`${status}\` の場合に、その値を返すことを確認します。`)
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: { security_and_analysis: { secret_scanning: { status } } } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getSecretScanningStatus('owner', 'repo')).toBe(status)
      expect(restRequests(server).map(({ path }) => path)).toEqual(['/repos/owner/repo'])
    })
  })

  it.each([
    ['security_and_analysis が無い', {}],
    ['secret_scanning が無い', { security_and_analysis: {} }],
    ['status が文字列でない', { security_and_analysis: { secret_scanning: { status: 1 } } }],
  ])('応答で「%s」の場合は、undefined を返す', async (_name, body) => {
    await explains(`\`getSecretScanningStatus\` のテストです。応答で「${_name}」の場合に、状態を読み取れないものとして \`undefined\` を返すことを確認します。`)
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getSecretScanningStatus('owner', 'repo')).toBeUndefined()
    })
  })

  it('リポジトリが存在しない場合は、GitHubNotFoundError を発生させる', async () => {
    await explains('`getSecretScanningStatus` のテストです。存在しないリポジトリで 404 が返った場合に、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 404, text: 'Not Found' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      await expect(client.getSecretScanningStatus('owner', 'repo')).rejects.toBeInstanceOf(GitHubNotFoundError)
    })
  })
})

describe('listOpenDependabotAlerts の next', () => {
  it('next が API と異なるホストの場合は、辿らずに GitHubAPIError を発生させ、要求は 1 回だけにする', async () => {
    await explains('`listOpenDependabotAlerts` のテストです。`Link` ヘッダの `next` が API とは異なるホストを指す場合に、その URL を取得せず `GitHubAPIError` が発生し、要求が 1 回だけであることを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/dependabot/alerts', {
          status: 200,
          body: [{ number: 1 }],
          headers: { link: '<http://evil.example/x?after=abc>; rel="next"' },
        }),
      ])
      return { client, server }
    })
    await step('エラーと送った要求を確かめる', async () => {
      expect(await rejection(client.listOpenDependabotAlerts('owner', 'repo'))).toMatchObject(
        failure(GitHubAPIError, 'refusing to follow a URL on a different host than the API: http://evil.example/x?after=abc'),
      )
      expect(restRequests(server)).toHaveLength(1)
    })
  })

  it('429 が返ると、GitHubRateLimitError を発生させる', async () => {
    await explains('`listOpenDependabotAlerts` のテストです。429 が返った場合に、ステータスコード 429 の `GitHubRateLimitError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 429, text: 'slow' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.listOpenDependabotAlerts('owner', 'repo'))).toMatchObject({ name: 'GitHubRateLimitError', statusCode: 429 })
    })
  })
})

describe('URL のパスの符号化', () => {
  it('ブランチ名を、セグメントごとに URL エンコードし、スラッシュはそのまま残す', async () => {
    await explains('URL のパスのエンコードのテストです。`feat/a b#c` のように記号を含むブランチ名の場合に、空白と `#` をパーセントエンコードし、スラッシュは変換しないことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/git/ref/heads/feat/a%20b%23c', { status: 200, body: { object: { sha: 's' } } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getBranchSha('owner', 'repo', 'feat/a b#c')).toBe('s')
      expect(restRequests(server).map(({ path }) => path)).toEqual(['/repos/owner/repo/git/ref/heads/feat/a%20b%23c'])
    })
  })

  it('リポジトリ名に URL の予約文字を含む場合は、エンコードして要求する', async () => {
    await explains('URL のパスのエンコードのテストです。リポジトリ名が `a?b` のように予約文字を含む場合に、`?` を `%3F` にエンコードして要求することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/a%3Fb/git/ref/heads/main', { status: 200, body: { object: { sha: 's' } } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getBranchSha('owner', 'a?b', 'main')).toBe('s')
      expect(restRequests(server).map(request => request.path)).toEqual(['/repos/owner/a%3Fb/git/ref/heads/main'])
    })
  })

  it.each(['.', '..'])('リポジトリ名 %j は、パスを辿る意味になるので、要求せずに GitHubAPIError を発生させる', async (repository) => {
    await explains(`URL のパスのエンコードのテストです。リポジトリ名が \`${repository}\` の場合に、パスの移動と解釈されるため、要求せずに \`GitHubAPIError\` が発生することを確認します。`)
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([])
      return { client, server }
    })
    await step('エラーと送った要求を確かめる', async () => {
      expect(await rejection(client.getBranchSha('owner', repository, 'main'))).toMatchObject(failure(GitHubAPIError, `name not usable in a URL path: ${repository}`))
      expect(restRequests(server)).toEqual([])
    })
  })

  it('ブランチ名の記号はエンコードし、.. のセグメントは GitHubAPIError を発生させる', async () => {
    await explains('URL のパスのエンコードのテストです。`!`・`\'`・`(`・`)`・`*` を含むブランチ名はエンコードして要求し、`..` のセグメントを含む名前の場合は `GitHubAPIError` が発生することを確認します。')
    const { path, client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const path = '/repos/owner/repo/git/ref/heads/a%21%27%28%29%2A'
      const { client, server } = await startClient([restResponse('GET', path, { status: 200, body: { object: { sha: 's' } } })])
      return { path, client, server }
    })
    await step('getBranchSha を呼ぶ', async () => {
      await client.getBranchSha('owner', 'repo', 'a!\'()*')
    })
    await step('エラーと送った要求を確かめる', async () => {
      expect(restRequests(server).map(request => request.path)).toEqual([path])
      expect(await rejection(client.getBranchSha('owner', 'repo', 'x/../y'))).toMatchObject(failure(GitHubAPIError, 'name not usable in a URL path: ..'))
    })
  })
})

describe('isDependabotAlertsEnabled', () => {
  it.each([[204, true], [404, false]])('ステータスが %i の場合は、Dependabot alert の有効状態として %s を返す', async (status, expected) => {
    await explains(`Dependabot alert の有効状態を確認する \`isDependabotAlertsEnabled\` のテストです。ステータスが ${String(status)} の場合に、\`${String(expected)}\` を返すことを確認します。`)
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/vulnerability-alerts', { status, text: '' })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.isDependabotAlertsEnabled('owner', 'repo')).toBe(expected)
      expect(restRequests(server).map(({ path, query }) => [path, query])).toEqual([['/repos/owner/repo/vulnerability-alerts', {}]])
    })
  })

  it('403 が返ると、ステータスコードを持つ例外を発生させる', async () => {
    await explains('`isDependabotAlertsEnabled` のテストです。403 が返った場合に、ステータスコード 403 を持つ例外が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/vulnerability-alerts', { status: 403, text: 'forbidden' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      await expect(client.isDependabotAlertsEnabled('owner', 'repo')).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  it('204 と 404 以外の成功（200）が返っても、例外を発生させる', async () => {
    await explains('`isDependabotAlertsEnabled` のテストです。204 と 404 以外の成功のステータス（200）が返った場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/vulnerability-alerts', { status: 200, text: '' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      expect(await rejection(client.isDependabotAlertsEnabled('owner', 'repo'))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 200', { statusCode: 200 }))
    })
  })
})

describe('listActionsSecretNames', () => {
  it('応答の secrets から名前だけを取り出し、per_page=100 でページをたどって返す', async () => {
    await explains('Actions の secret の名前を取得する `listActionsSecretNames` のテストです。リポジトリの単位で `per_page=100` を指定し、`Link` ヘッダをたどって、2 ページ分の名前だけを返すことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([
        restResponse('GET', '/repos/owner/repo/actions/secrets', {
          status: 200,
          body: { total_count: 2, secrets: [{ name: 'A', created_at: 'x' }] },
          headers: { link: '<{{GITHUB_API}}/repos/owner/repo/actions/secrets?page=2>; rel="next"' },
        }),
        restResponse('GET', '/repos/owner/repo/actions/secrets', { status: 200, body: { total_count: 2, secrets: [{ name: 'B' }] } }),
      ])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listActionsSecretNames('owner', 'repo', 'repository')).toEqual(['A', 'B'])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100' }, { page: '2' }])
    })
  })

  it('organization の単位では、リポジトリに適用される organization の secret を取得する', async () => {
    await explains('`listActionsSecretNames` のテストです。`organization` の単位を指定した場合に、`organization-secrets` から名前（`ORG`）を取得することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/actions/organization-secrets', { status: 200, body: { total_count: 1, secrets: [{ name: 'ORG' }] } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listActionsSecretNames('owner', 'repo', 'organization')).toEqual(['ORG'])
    })
  })

  it('403 と 404 が返ると、読み取れないものとして undefined を返す', async () => {
    await explains('`listActionsSecretNames` のテストです。リポジトリの 403 と organization の 404 の場合に、どちらも `undefined` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([
        restResponse('GET', '/repos/owner/repo/actions/secrets', { status: 403, text: '{"message":"Resource not accessible by integration"}' }),
        restResponse('GET', '/repos/owner/repo/actions/organization-secrets', { status: 404, text: '{"message":"Not Found"}' }),
      ])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listActionsSecretNames('owner', 'repo', 'repository')).toBeUndefined()
      expect(await client.listActionsSecretNames('owner', 'repo', 'organization')).toBeUndefined()
    })
  })

  it('レート制限による 403 が返ると、GitHubRateLimitError のまま発生させる', async () => {
    await explains('`listActionsSecretNames` のテストです。レート制限による 403 が返った場合に、`undefined` を返さず `GitHubRateLimitError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/actions/secrets', { status: 403, text: 'API rate limit exceeded' })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      await expect(client.listActionsSecretNames('owner', 'repo', 'repository')).rejects.toBeInstanceOf(GitHubRateLimitError)
    })
  })
})

describe('listActionsVariableNames', () => {
  it('応答の variables から名前だけを per_page=30 で取得し、値は返さない', async () => {
    await explains('Actions の変数の名前を取得する `listActionsVariableNames` のテストです。`per_page=30` で要求し、変数の名前（`V`）だけを返して、値を含めないことを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/actions/variables', { status: 200, body: { total_count: 1, variables: [{ name: 'V', value: 'secret-ish' }] } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.listActionsVariableNames('owner', 'repo', 'repository')).toEqual(['V'])
      expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '30' }])
    })
  })

  it('organization の単位では、リポジトリに適用される organization の変数を取得する', async () => {
    await explains('`listActionsVariableNames` のテストです。`organization` の単位を指定した場合に、`organization-variables` から名前（`OV`）を取得することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo/actions/organization-variables', { status: 200, body: { total_count: 1, variables: [{ name: 'OV', value: 'x' }] } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.listActionsVariableNames('owner', 'repo', 'organization')).toEqual(['OV'])
    })
  })
})

describe('getRepositoryOwnerType', () => {
  it('リポジトリの owner.type を返す', async () => {
    await explains('リポジトリの所有者の種類を取得する `getRepositoryOwnerType` のテストです。応答の `owner.type`（`Organization`）を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: { owner: { type: 'Organization' } } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getRepositoryOwnerType('owner', 'repo')).toBe('Organization')
    })
  })

  it('owner.type が存在しない場合は、undefined を返す', async () => {
    await explains('`getRepositoryOwnerType` のテストです。応答の `owner.type` が存在しない場合は、`undefined` を返すことを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: {} })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getRepositoryOwnerType('owner', 'repo')).toBeUndefined()
    })
  })
})

describe('getRepositorySettings', () => {
  it('delete_branch_on_merge・default_branch・owner.type がある場合は、その値を返す', async () => {
    await explains('リポジトリの設定を取得する `getRepositorySettings` のテストです。応答に 3 つの項目がそろっている場合に、値をそのまま返し、`/repos/owner/repo` を 1 回だけ要求することを確認します。')
    const { client, server } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: { default_branch: 'main', delete_branch_on_merge: true, owner: { type: 'Organization' } } })])
      return { client, server }
    })
    await step('送った要求を確かめる', async () => {
      expect(await client.getRepositorySettings('owner', 'repo')).toEqual({ deleteBranchOnMerge: true, defaultBranch: 'main', ownerType: 'Organization' })
      expect(restRequests(server).map(({ path }) => path)).toEqual(['/repos/owner/repo'])
    })
  })

  it('delete_branch_on_merge と owner.type が無い場合は、その 2 項目を undefined にする', async () => {
    await explains('`getRepositorySettings` のテストです。応答に `delete_branch_on_merge` と `owner.type` が無い場合に、2 項目が `undefined` になり、`default_branch` は返ることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: { default_branch: 'trunk' } })])
      return { client }
    })
    await step('結果を確かめる', async () => {
      expect(await client.getRepositorySettings('owner', 'repo')).toEqual({ deleteBranchOnMerge: undefined, defaultBranch: 'trunk', ownerType: undefined })
    })
  })

  it('delete_branch_on_merge が boolean でない場合は、undefined にする', async () => {
    await explains('`getRepositorySettings` のテストです。`delete_branch_on_merge` が文字列で返った場合に、boolean として読まず `undefined` にすることを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: { default_branch: 'main', delete_branch_on_merge: 'true' } })])
      return { client }
    })
    const settings = await step('getRepositorySettings を呼ぶ', async () => await client.getRepositorySettings('owner', 'repo'))
    await step('結果を確かめる', () => {
      expect(settings.deleteBranchOnMerge).toBeUndefined()
    })
  })

  it('default_branch が無い場合は、GitHubAPIError を発生させる', async () => {
    await explains('`getRepositorySettings` のテストです。応答に `default_branch` が無い場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await step('偽の GitHub サーバとクライアントを用意する', async () => {
      const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: { name: 'repo' } })])
      return { client }
    })
    await step('エラーを確かめる', async () => {
      await expect(client.getRepositorySettings('owner', 'repo')).rejects.toBeInstanceOf(GitHubAPIError)
    })
  })
})
