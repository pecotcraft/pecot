// リポジトリ・ブランチ・リリース操作の API。cli/core/github/repos.py の移植。

import { jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import type { JsonValue } from '../../domain/python-format.js'
import { GitHubClientBase } from './client.js'
import { GitHubAPIError, GitHubNotFoundError } from './errors.js'
import { asArray, isTruthy, requireString } from './payload.js'
import { MUTATION_CREATE_LINKED_BRANCH, QUERY_GET_REPOSITORY_ID } from './queries.js'
import { encodePath, repositoryPath } from './rest-path.js'

export interface CreateReleaseOptions {
  /**
  タグのターゲット。既定は main
  */
  readonly targetCommitish?: string | undefined
  readonly draft?: boolean | undefined
  readonly prerelease?: boolean | undefined
}

const ALERTS_PER_PAGE = 100
const NO_CONTENT = 204
const NOT_FOUND = 404

export class ReposApi extends GitHubClientBase {
  /**
  リポジトリの GraphQL Node ID。見つからなければ GitHubNotFoundError
  */
  async getRepositoryId(owner: string, name: string): Promise<string> {
    const result = await this.executeGraphql(QUERY_GET_REPOSITORY_ID, { owner, name })
    const repository = jsonField(result, 'repository')
    if (!isTruthy(repository)) throw new GitHubNotFoundError(`リポジトリが見つかりません: ${owner}/${name}`)
    return requireString(jsonField(repository, 'id'), 'repository.id')
  }

  /**
  ブランチの最新 commit の SHA（REST）。見つからなければ GitHubNotFoundError
  */
  async getBranchSha(owner: string, repository: string, branch: string): Promise<string> {
    const reference = jsonField(await this.restJson('GET', `${repositoryPath(owner, repository)}/git/ref/heads/${encodePath(branch)}`), 'object')
    return requireString(jsonField(reference, 'sha'), 'object.sha')
  }

  /**
  Issue に紐づいたブランチを作り、その名前を返す（gh issue develop と同等）。
  repositoryId を省くと、Issue と同じリポジトリになる
  */
  async createLinkedBranch(issueId: string, oid: string, name: string, repositoryId?: string): Promise<string> {
    const input = {
      issueId,
      oid,
      name,
      ...(repositoryId !== undefined && repositoryId !== '' && { repositoryId }),
    }
    const result = await this.executeGraphql(MUTATION_CREATE_LINKED_BRANCH, { input })
    const linkedBranch = jsonField(jsonField(result, 'createLinkedBranch'), 'linkedBranch')
    if (!isTruthy(linkedBranch)) throw new GitHubAPIError('リンクブランチの作成に失敗しました')
    return requireString(jsonField(jsonField(linkedBranch, 'ref'), 'name'), 'linkedBranch.ref.name')
  }

  /**
  ブランチを削除する。保護されたブランチなどは GitHubAPIError
  */
  async deleteBranch(owner: string, repository: string, branch: string): Promise<void> {
    const response = await this.restRequest('DELETE', `${repositoryPath(owner, repository)}/git/refs/heads/${encodePath(branch)}`)
    if (!response.isSuccess) this.handleHttpError(response)
  }

  /**
  GitHub のリリースを作る。target_commitish を指定するので、タグも自動で作られる
  */
  async createRelease(owner: string, repository: string, tagName: string, name: string, body: string, options: Readonly<CreateReleaseOptions> = {}): Promise<JsonObject> {
    const data = {
      tag_name: tagName,
      name,
      body,
      target_commitish: options.targetCommitish ?? 'main',
      draft: options.draft ?? false,
      prerelease: options.prerelease ?? false,
    }
    return this.restObject('POST', `${repositoryPath(owner, repository)}/releases`, { json: data })
  }

  /**
  リポジトリの既定ブランチ名
  */
  async getRepositoryDefaultBranch(owner: string, repository: string): Promise<string> {
    const repositoryInfo = await this.restJson('GET', repositoryPath(owner, repository))
    return requireString(jsonField(repositoryInfo, 'default_branch'), 'default_branch')
  }

  /**
  open な Dependabot alert を全件取得する（REST）。
  一覧は cursor 方式で page を持たない。2 ページ目以降は Link ヘッダの next の絶対 URL をそのまま辿る。
  params を再送すると cursor と二重指定になるため、送らない。
  alerts が無効（403）などで取得できなければ GitHubAPIError
  */
  async listOpenDependabotAlerts(owner: string, repository: string): Promise<readonly JsonValue[]> {
    const alerts: JsonValue[] = []
    let target = `${repositoryPath(owner, repository)}/dependabot/alerts`
    let parameters: Readonly<Record<string, number | string>> | undefined = { state: 'open', per_page: ALERTS_PER_PAGE }
    for (;;) {
      const response = await this.restRequest('GET', target, { params: parameters })
      if (!response.isSuccess) this.handleHttpError(response)
      alerts.push(...asArray(response.json()))
      const next = response.links.get('next')
      if (next === undefined) return alerts
      target = next.url
      parameters = undefined
    }
  }

  /**
  リポジトリで Dependabot alerts が有効かを返す（REST）。
  vulnerability-alerts は有効で 204、無効で 404 を返す。それ以外の応答は GitHubAPIError
  */
  async isDependabotAlertsEnabled(owner: string, repository: string): Promise<boolean> {
    const response = await this.restRequest('GET', `${repositoryPath(owner, repository)}/vulnerability-alerts`)
    if (response.statusCode === NO_CONTENT) return true
    if (response.statusCode === NOT_FOUND) return false
    return this.handleHttpError(response)
  }
}
