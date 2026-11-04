// GitHubClient の合成のテスト。各 API のクラスの操作が 1 つのクライアントで呼べることと、
// RepositoryMembership（domain/config.ts）を満たすことを確かめる。
import { describe, expect, it } from 'vitest'

import { isRepositoryInProject, parseProjectConfig } from '../../../domain/config.js'
import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubClientBase } from '../client.js'
import { GitHubClient } from '../index.js'
import { IssuesApi } from '../issues.js'
import { ProjectsApi } from '../projects.js'
import { PullsApi } from '../pulls.js'
import { ReposApi } from '../repos.js'
import { graphqlData, graphqlRequests, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

describe('GitHubClient', () => {
  it('基底 → repos → projects → issues → pulls の順に継承し、全 API の操作を持つ', async () => {
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

  it('コンストラクタに host を渡せる（GitHubClientBase と同じ）', () => {
    const client = new GitHubClient({ host: 'ghes.example.com', token: 't' })
    expect(client.apiUrl).toBe('https://ghes.example.com/api/v3')
  })

  it('isRepositoryInProject に RepositoryMembership として渡せる', async () => {
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
