// GitHubClient の合成のテスト。各 API のクラスの操作が 1 つのクライアントで呼べることと、
// RepositoryMembership（domain/config.ts）を満たすことを確かめる。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'

import { isRepositoryInProject, parseProjectConfig } from '../../../domain/config.js'
import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubClientBase } from '../client.js'
import { GitHubClient } from '../index.js'
import { IssuesApi } from '../issues.js'
import { ProjectsApi } from '../projects.js'
import { PullsApi } from '../pulls.js'
import { ReposApi } from '../repos.js'
import { ignoredDiagnostics } from '../../../../tests/_helpers/recording-diagnostics.js'
import { graphqlData, graphqlRequests, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

describe('GitHubClient', () => {
  it('基底 → repos → projects → issues → pulls の順に継承し、全 API の操作を持つ', async () => {
    await explains('GitHub クライアントの合成のテストです。クライアントが、基底・repos・projects・issues・pulls の順に継承したクラスで、全 API の操作を関数として持つことを確認します。')
    const { client } = await startClient([])
    expect(client).toBeInstanceOf(PullsApi)
    expect(client).toBeInstanceOf(IssuesApi)
    expect(client).toBeInstanceOf(ProjectsApi)
    expect(client).toBeInstanceOf(ReposApi)
    expect(client).toBeInstanceOf(GitHubClientBase)
    for (const name of ['createIssue', 'getIssueSlim', 'createPullRequest', 'getPullRequestSlim', 'listProjectItems', 'getRepositoryId', 'createRelease']) {
      expect(Reflect.get(client, name)).toBeTypeOf('function')
    }
  })

  it('コンストラクタに host を渡すと、その host の API の URL になる（GitHubClientBase と同じ）', async () => {
    await explains('GitHub クライアントの合成のテストです。コンストラクタに `host` を渡した場合は、`GitHubClientBase` と同じ API の URL（`https://ghes.example.com/api/v3`）になることを確認します。')
    const client = new GitHubClient({ host: 'ghes.example.com', token: 't', diagnostics: ignoredDiagnostics })
    expect(client.apiUrl).toBe('https://ghes.example.com/api/v3')
  })

  it('isRepositoryInProject に RepositoryMembership として渡せる', async () => {
    await explains('`isRepositoryInProject` のテストです。クライアントを `RepositoryMembership` として渡した場合に、ボードに含まれるリポジトリは `true`、含まれないものは `false` を返すことを確認します。')
    const { client, server } = await startClient([
      graphqlData('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: [{ owner: { login: 'acme' }, name: 'widgets' }, JSON_NULL] } } } }),
    ])
    const config = parseProjectConfig({
      host: 'github.com',
      owner: 'acme',
      workflow_suffix: 'test',
      project: { number: 7, id: 'PVT', fields: { workflow: { id: 'WF', options: {} } } },
    })
    expect(await isRepositoryInProject(config, 'acme', 'widgets', client)).toBe(true)
    expect(await isRepositoryInProject(config, 'acme', 'other', client)).toBe(false)
    // 2 回目はキャッシュ
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetLinkedRepositoriesUser', variables: { owner: 'acme', projectNumber: 7 } }])
  })
})
