// GitHubClient の合成のテスト。各 API のクラスの操作が 1 つのクライアントで呼べることを確かめる。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../../tests/_helpers/step.js'
import { GitHubClientBase } from '../client.js'
import { GitHubClient } from '../index.js'
import { IssuesApi } from '../issues.js'
import { ProjectsApi } from '../projects.js'
import { PullsApi } from '../pulls.js'
import { ReposApi } from '../repos.js'
import { ignoredDiagnostics } from '../../../../tests/_helpers/recording-diagnostics.js'
import { startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

describe('GitHubClient', () => {
  it('基底 → repos → projects → issues → pulls の順に継承し、全 API の操作を持つ', async () => {
    await explains('GitHub クライアントの合成のテストです。クライアントが、基底・repos・projects・issues・pulls の順に継承したクラスで、全 API の操作を関数として持つことを確認します。')
    const { client } = await step('クライアントを用意する', async () => await startClient([]))
    stepSync('継承と操作を確かめる', () => {
      expect(client).toBeInstanceOf(PullsApi)
      expect(client).toBeInstanceOf(IssuesApi)
      expect(client).toBeInstanceOf(ProjectsApi)
      expect(client).toBeInstanceOf(ReposApi)
      expect(client).toBeInstanceOf(GitHubClientBase)
      for (const name of ['createIssue', 'getIssueSlim', 'getPullRequestForFinish', 'listProjectItems', 'getRepositoryId', 'createRelease']) {
        expect(Reflect.get(client, name)).toBeTypeOf('function')
      }
    })
  })

  it('コンストラクタに host を渡すと、その host の API の URL になる（GitHubClientBase と同じ）', async () => {
    await explains('GitHub クライアントの合成のテストです。コンストラクタに `host` を渡した場合は、`GitHubClientBase` と同じ API の URL（`https://ghes.example.com/api/v3`）になることを確認します。')
    const client = stepSync('host を指定してクライアントを作る', () => new GitHubClient({ host: 'ghes.example.com', token: 't', diagnostics: ignoredDiagnostics }))
    stepSync('API の URL を比べる', () => {
      expect(client.apiUrl).toBe('https://ghes.example.com/api/v3')
    })
  })
})
