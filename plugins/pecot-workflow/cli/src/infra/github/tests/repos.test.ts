// ReposApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// 要求の本文・変数は、cli/core/github/repos.py を読んで写した。
import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubAPIError, GitHubNotFoundError, GitHubRateLimitError } from '../errors.js'
import { failure, graphqlData, graphqlError, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

describe('getRepositoryId', () => {
  it('owner と name を変数に送り、Node ID を返す', async () => {
    const { client, server } = await startClient([graphqlData('GetRepositoryId', { repository: { id: 'R_repo' } })])
    expect(await client.getRepositoryId('owner', 'repo')).toBe('R_repo')
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetRepositoryId', variables: { owner: 'owner', name: 'repo' } }])
  })

  it('リポジトリが無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetRepositoryId', { repository: JSON_NULL })])
    expect(await rejection(client.getRepositoryId('owner', 'nonexistent'))).toMatchObject(failure(GitHubNotFoundError, 'repository not found: owner/nonexistent'))
  })
})

describe('getBranchSha', () => {
  it('ref の object.sha を返す', async () => {
    const { client, server } = await startClient([
      restResponse('GET', '/repos/owner/repo/git/ref/heads/develop', { status: 200, body: { ref: 'refs/heads/develop', object: { sha: 'abc123def456', type: 'commit' } } }),
    ])
    expect(await client.getBranchSha('owner', 'repo', 'develop')).toBe('abc123def456')
    expect(restRequests(server).map(({ method, path }) => [method, path])).toEqual([['GET', '/repos/owner/repo/git/ref/heads/develop']])
  })

  it('スラッシュを含むブランチ名はそのままパスに入れる', async () => {
    const { client, server } = await startClient([
      restResponse('GET', '/repos/owner/repo/git/ref/heads/feat/issue-1', { status: 200, body: { object: { sha: 'f00' } } }),
    ])
    expect(await client.getBranchSha('owner', 'repo', 'feat/issue-1')).toBe('f00')
    expect(restRequests(server).map(({ path }) => path)).toEqual(['/repos/owner/repo/git/ref/heads/feat/issue-1'])
  })

  it('404 は URL つきの GitHubNotFoundError', async () => {
    const { client, server } = await startClient([
      restResponse('GET', '/repos/owner/repo/git/ref/heads/nonexistent', { status: 404, body: { message: 'Not Found' } }),
    ])
    expect(await rejection(client.getBranchSha('owner', 'repo', 'nonexistent'))).toMatchObject(
      failure(GitHubNotFoundError, `resource not found: ${server.url}/repos/owner/repo/git/ref/heads/nonexistent`, { statusCode: 404 }),
    )
  })
})

describe('createLinkedBranch', () => {
  const created = { createLinkedBranch: { linkedBranch: { ref: { name: 'feat/test-branch', prefix: 'refs/heads/' } } } }

  it('repositoryId を省くと、input に issueId・oid・name だけを送る', async () => {
    const { client, server } = await startClient([graphqlData('CreateLinkedBranch', created)])
    expect(await client.createLinkedBranch('I_kwDOtest123', 'abc123def456', 'feat/test-branch')).toBe('feat/test-branch')
    expect(graphqlRequests(server)).toEqual([{
      operation: 'CreateLinkedBranch',
      variables: { input: { issueId: 'I_kwDOtest123', oid: 'abc123def456', name: 'feat/test-branch' } },
    }])
  })

  it('repositoryId を渡すと input に足す', async () => {
    const { client, server } = await startClient([graphqlData('CreateLinkedBranch', created)])
    await client.createLinkedBranch('I_1', 'abc', 'feat/cross-repo-branch', 'R_kwDOrepo456')
    expect(graphqlRequests(server)).toEqual([{
      operation: 'CreateLinkedBranch',
      variables: { input: { issueId: 'I_1', oid: 'abc', name: 'feat/cross-repo-branch', repositoryId: 'R_kwDOrepo456' } },
    }])
  })

  it('repositoryId が空文字なら足さない', async () => {
    const { client, server } = await startClient([graphqlData('CreateLinkedBranch', created)])
    await client.createLinkedBranch('I_1', 'abc', 'n', '')
    expect(graphqlRequests(server)).toEqual([{ operation: 'CreateLinkedBranch', variables: { input: { issueId: 'I_1', oid: 'abc', name: 'n' } } }])
  })

  it('linkedBranch が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('CreateLinkedBranch', { createLinkedBranch: { linkedBranch: JSON_NULL } })])
    expect(await rejection(client.createLinkedBranch('I_1', 'abc', 'n'))).toMatchObject(failure(GitHubAPIError, 'failed to create the linked branch'))
  })

  it('既にブランチがあるときの GraphQL の失敗は、GraphQLクエリ実行エラーになる', async () => {
    const { client } = await startClient([graphqlError('CreateLinkedBranch', 'A branch named \'feat/existing-branch\' already exists')])
    // errors[0] は辞書なので、gql は Python の str(dict) の文にする
    const message = 'GraphQL query error: {\'message\': "A branch named \'feat/existing-branch\' already exists"}'
    expect(await rejection(client.createLinkedBranch('I_1', 'abc', 'feat/existing-branch'))).toMatchObject(failure(GitHubAPIError, message))
  })
})

describe('deleteBranch', () => {
  it('204 なら何も返さない', async () => {
    const { client, server } = await startClient([restResponse('DELETE', '/repos/owner/repo/git/refs/heads/feat/test-branch', { status: 204, text: '' })])
    await client.deleteBranch('owner', 'repo', 'feat/test-branch')
    expect(restRequests(server).map(({ method, path }) => [method, path])).toEqual([['DELETE', '/repos/owner/repo/git/refs/heads/feat/test-branch']])
  })

  it('存在しない ref の 422 は GitHubAPIError（422）', async () => {
    const { client } = await startClient([restResponse('DELETE', '/repos/owner/repo/git/refs/heads/nonexistent', { status: 422, text: 'Reference does not exist' })])
    expect(await rejection(client.deleteBranch('owner', 'repo', 'nonexistent'))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: 'Reference does not exist' }))
  })

  it('保護されたブランチの 403 は、アクセスが拒否されました', async () => {
    const { client } = await startClient([restResponse('DELETE', '/repos/owner/repo/git/refs/heads/main', { status: 403, text: 'Cannot delete a protected branch' })])
    expect(await rejection(client.deleteBranch('owner', 'repo', 'main'))).toMatchObject(failure(GitHubAPIError, 'access denied', { statusCode: 403, responseBody: 'Cannot delete a protected branch' }))
  })
})

describe('createRelease', () => {
  it('既定は target_commitish=main・draft=false・prerelease=false で、キーの順も Python と同じ', async () => {
    const response = { id: 1, tag_name: 'v0.6.1', name: 'v0.6.1', html_url: 'https://github.com/owner/repo/releases/tag/v0.6.1' }
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/releases', { status: 201, body: response })])
    expect(await client.createRelease('owner', 'repo', 'v0.6.1', 'v0.6.1', '### 追加\n\n- 新機能')).toEqual(response)
    const [request] = restRequests(server)
    expect(JSON.stringify(request?.body)).toBe(JSON.stringify({
      tag_name: 'v0.6.1',
      name: 'v0.6.1',
      body: '### 追加\n\n- 新機能',
      target_commitish: 'main',
      draft: false,
      prerelease: false,
    }))
  })

  it('targetCommitish・draft・prerelease を渡すと、送る本文に target_commitish・draft・prerelease が入る', async () => {
    const { client, server } = await startClient([restResponse('POST', '/repos/owner/repo/releases', { status: 201, body: { id: 2, tag_name: 'v1.0.0' } })])
    await client.createRelease('owner', 'repo', 'v1.0.0', 'v1.0.0', 'Release notes', { targetCommitish: 'release', draft: true, prerelease: true })
    expect(restRequests(server).map(({ body }) => body)).toEqual([{
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      body: 'Release notes',
      target_commitish: 'release',
      draft: true,
      prerelease: true,
    }])
  })

  it('422 は GitHubAPIError', async () => {
    const { client } = await startClient([restResponse('POST', '/repos/owner/repo/releases', { status: 422, text: 'Validation Failed' })])
    expect(await rejection(client.createRelease('owner', 'repo', 'v0.6.1', 'v0.6.1', 'notes'))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 422', { statusCode: 422, responseBody: 'Validation Failed' }))
  })
})

describe('getRepositoryDefaultBranch', () => {
  it.each(['main', 'master'])('default_branch（%s）を返す', async (branch) => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: { name: 'repo', default_branch: branch } })])
    expect(await client.getRepositoryDefaultBranch('owner', 'repo')).toBe(branch)
    expect(restRequests(server).map(({ path }) => path)).toEqual(['/repos/owner/repo'])
  })

  it('404 は GitHubNotFoundError', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/nonexistent', { status: 404, text: 'Not Found' })])
    await expect(client.getRepositoryDefaultBranch('owner', 'nonexistent')).rejects.toBeInstanceOf(GitHubNotFoundError)
  })
})

describe('listOpenDependabotAlerts', () => {
  it('1 ページなら state=open・per_page=100 で 1 回だけ取る', async () => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 200, body: [{ number: 1 }, { number: 2 }] })])
    expect(await client.listOpenDependabotAlerts('owner', 'repo')).toEqual([{ number: 1 }, { number: 2 }])
    expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }])
  })

  it('2 ページ目は Link ヘッダの next の絶対 URL を params 無しで辿る', async () => {
    const { client, server } = await startClient([
      restResponse('GET', '/repos/owner/repo/dependabot/alerts', {
        status: 200,
        body: [{ number: 1 }],
        headers: { link: '<{{GITHUB_API}}/repos/owner/repo/dependabot/alerts?after=abc>; rel="next"' },
      }),
      restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 200, body: [{ number: 2 }] }),
    ])
    expect(await client.listOpenDependabotAlerts('owner', 'repo')).toEqual([{ number: 1 }, { number: 2 }])
    expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }, { after: 'abc' }])
  })

  it('403 は状態コードと本文を持つ GitHubAPIError', async () => {
    const body = '{"message":"Dependabot alerts are disabled for this repository."}'
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 403, text: body })])
    expect(await rejection(client.listOpenDependabotAlerts('owner', 'repo'))).toMatchObject(failure(GitHubAPIError, 'access denied', { statusCode: 403, responseBody: body }))
  })

  it('rate limit の 403 は GitHubRateLimitError', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 403, text: 'API rate limit exceeded' })])
    await expect(client.listOpenDependabotAlerts('owner', 'repo')).rejects.toBeInstanceOf(GitHubRateLimitError)
  })
})

describe('listOpenCodeScanningAlerts', () => {
  it('state=open・per_page=100 で取り、ref は付けない', async () => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/code-scanning/alerts', { status: 200, body: [{ number: 3 }] })])
    expect(await client.listOpenCodeScanningAlerts('owner', 'repo')).toEqual([{ number: 3 }])
    expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }])
  })

  it('2 ページ目は Link ヘッダの next を params 無しで辿る', async () => {
    const { client, server } = await startClient([
      restResponse('GET', '/repos/owner/repo/code-scanning/alerts', { status: 200, body: [{ number: 1 }], headers: { link: '<{{GITHUB_API}}/repos/owner/repo/code-scanning/alerts?after=x>; rel="next"' } }),
      restResponse('GET', '/repos/owner/repo/code-scanning/alerts', { status: 200, body: [{ number: 2 }] }),
    ])
    expect(await client.listOpenCodeScanningAlerts('owner', 'repo')).toEqual([{ number: 1 }, { number: 2 }])
    expect(restRequests(server).map(({ query }) => query)).toEqual([{ per_page: '100', state: 'open' }, { after: 'x' }])
  })

  it('404 は状態コードと本文を持つ GitHubNotFoundError', async () => {
    const body = '{"message":"no analysis found"}'
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/code-scanning/alerts', { status: 404, text: body })])
    expect(await rejection(client.listOpenCodeScanningAlerts('owner', 'repo'))).toMatchObject({ name: 'GitHubNotFoundError', statusCode: 404, responseBody: body })
  })
})

describe('listOpenSecretScanningAlerts', () => {
  it('hide_secret=true を必ず付けて取る', async () => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/secret-scanning/alerts', { status: 200, body: [{ number: 7 }] })])
    expect(await client.listOpenSecretScanningAlerts('owner', 'repo')).toEqual([{ number: 7 }])
    expect(restRequests(server).map(({ query }) => query)).toEqual([{ hide_secret: 'true', per_page: '100', state: 'open' }])
  })

  it('404 は GitHubNotFoundError', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/secret-scanning/alerts', { status: 404, text: 'Not Found' })])
    await expect(client.listOpenSecretScanningAlerts('owner', 'repo')).rejects.toBeInstanceOf(GitHubNotFoundError)
  })
})

describe('getSecretScanningStatus', () => {
  it.each(['enabled', 'disabled'])('security_and_analysis.secret_scanning.status の %s を返す', async (status) => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body: { security_and_analysis: { secret_scanning: { status } } } })])
    expect(await client.getSecretScanningStatus('owner', 'repo')).toBe(status)
    expect(restRequests(server).map(({ path }) => path)).toEqual(['/repos/owner/repo'])
  })

  it.each([
    ['security_and_analysis が無い', {}],
    ['secret_scanning が無い', { security_and_analysis: {} }],
    ['status が文字列でない', { security_and_analysis: { secret_scanning: { status: 1 } } }],
  ])('%s と undefined', async (_name, body) => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 200, body })])
    expect(await client.getSecretScanningStatus('owner', 'repo')).toBeUndefined()
  })

  it('リポジトリが無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo', { status: 404, text: 'Not Found' })])
    await expect(client.getSecretScanningStatus('owner', 'repo')).rejects.toBeInstanceOf(GitHubNotFoundError)
  })
})

describe('listOpenDependabotAlerts の next', () => {
  it('next が API と異なるホストなら、辿らずに GitHubAPIError。要求は 1 回だけ', async () => {
    const { client, server } = await startClient([
      restResponse('GET', '/repos/owner/repo/dependabot/alerts', {
        status: 200,
        body: [{ number: 1 }],
        headers: { link: '<http://evil.example/x?after=abc>; rel="next"' },
      }),
    ])
    expect(await rejection(client.listOpenDependabotAlerts('owner', 'repo'))).toMatchObject(
      failure(GitHubAPIError, 'refusing to follow a URL on a different host than the API: http://evil.example/x?after=abc'),
    )
    expect(restRequests(server)).toHaveLength(1)
  })

  it('429 は GitHubRateLimitError', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/dependabot/alerts', { status: 429, text: 'slow' })])
    expect(await rejection(client.listOpenDependabotAlerts('owner', 'repo'))).toMatchObject({ name: 'GitHubRateLimitError', statusCode: 429 })
  })
})

describe('URL のパスの符号化', () => {
  it('ブランチ名はセグメントごとに符号化し、スラッシュは残す', async () => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/git/ref/heads/feat/a%20b%23c', { status: 200, body: { object: { sha: 's' } } })])
    expect(await client.getBranchSha('owner', 'repo', 'feat/a b#c')).toBe('s')
    expect(restRequests(server).map(({ path }) => path)).toEqual(['/repos/owner/repo/git/ref/heads/feat/a%20b%23c'])
  })

  it('リポジトリ名の URL の予約文字は符号化する', async () => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/a%3Fb', { status: 200, body: { default_branch: 'main' } })])
    expect(await client.getRepositoryDefaultBranch('owner', 'a?b')).toBe('main')
    expect(restRequests(server).map(request => request.path)).toEqual(['/repos/owner/a%3Fb'])
  })

  it.each(['.', '..'])('リポジトリ名 %j は、パスを辿る意味になるので、送らずに GitHubAPIError', async (repository) => {
    const { client, server } = await startClient([])
    expect(await rejection(client.getRepositoryDefaultBranch('owner', repository))).toMatchObject(failure(GitHubAPIError, `name not usable in a URL path: ${repository}`))
    expect(restRequests(server)).toEqual([])
  })

  it('ブランチ名の記号は符号化し、.. のセグメントは GitHubAPIError', async () => {
    const path = '/repos/owner/repo/git/refs/heads/a%21%27%28%29%2A'
    const { client, server } = await startClient([restResponse('DELETE', path, { status: 204, text: '' })])
    await client.deleteBranch('owner', 'repo', 'a!\'()*')
    expect(restRequests(server).map(request => request.path)).toEqual([path])
    expect(await rejection(client.deleteBranch('owner', 'repo', 'x/../y'))).toMatchObject(failure(GitHubAPIError, 'name not usable in a URL path: ..'))
  })
})

describe('isDependabotAlertsEnabled', () => {
  it.each([[204, true], [404, false]])('%i は %s', async (status, expected) => {
    const { client, server } = await startClient([restResponse('GET', '/repos/owner/repo/vulnerability-alerts', { status, text: '' })])
    expect(await client.isDependabotAlertsEnabled('owner', 'repo')).toBe(expected)
    expect(restRequests(server).map(({ path, query }) => [path, query])).toEqual([['/repos/owner/repo/vulnerability-alerts', {}]])
  })

  it('403 は状態コードつきの例外', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/vulnerability-alerts', { status: 403, text: 'forbidden' })])
    await expect(client.isDependabotAlertsEnabled('owner', 'repo')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('204・404 以外の成功（200）も例外', async () => {
    const { client } = await startClient([restResponse('GET', '/repos/owner/repo/vulnerability-alerts', { status: 200, text: '' })])
    expect(await rejection(client.isDependabotAlertsEnabled('owner', 'repo'))).toMatchObject(failure(GitHubAPIError, 'GitHub API error: 200', { statusCode: 200 }))
  })
})
