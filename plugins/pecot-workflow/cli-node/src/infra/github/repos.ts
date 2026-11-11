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
  一覧 API を Link ヘッダの next で最後まで辿って集める。
  一覧は cursor 方式で page を持たない。2 ページ目以降は next の絶対 URL をそのまま辿る。
  params を再送すると cursor と二重指定になるため、送らない
  */
  private async listAll(path: string, firstParameters: Readonly<Record<string, number | string>>): Promise<readonly JsonValue[]> {
    const items: JsonValue[] = []
    let target = path
    let parameters: Readonly<Record<string, number | string>> | undefined = firstParameters
    for (;;) {
      const response = await this.restRequest('GET', target, { params: parameters })
      if (!response.isSuccess) this.handleHttpError(response)
      items.push(...asArray(response.json()))
      const next = response.links.get('next')
      if (next === undefined) return items
      target = next.url
      parameters = undefined
    }
  }

  /**
  リポジトリの GraphQL Node ID。見つからなければ GitHubNotFoundError
  */
  async getRepositoryId(owner: string, name: string): Promise<string> {
    const result = await this.executeGraphql(QUERY_GET_REPOSITORY_ID, { owner, name })
    const repository = jsonField(result, 'repository')
    if (!isTruthy(repository)) throw new GitHubNotFoundError(`repository not found: ${owner}/${name}`)
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
    if (!isTruthy(linkedBranch)) throw new GitHubAPIError('failed to create the linked branch')
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
  alerts が無効（403）などで取得できなければ GitHubAPIError
  */
  async listOpenDependabotAlerts(owner: string, repository: string): Promise<readonly JsonValue[]> {
    return this.listAll(`${repositoryPath(owner, repository)}/dependabot/alerts`, { state: 'open', per_page: ALERTS_PER_PAGE })
  }

  /**
  open な code scanning alert を全件取得する（REST）。ref は付けず、既定ブランチが対象になる。
  GHAS が無い（403）・解析が無い（404）などで取得できなければ GitHubAPIError
  */
  async listOpenCodeScanningAlerts(owner: string, repository: string): Promise<readonly JsonValue[]> {
    return this.listAll(`${repositoryPath(owner, repository)}/code-scanning/alerts`, { state: 'open', per_page: ALERTS_PER_PAGE })
  }

  /**
  open な secret scanning alert を全件取得する（REST）。secret の値が応答に載らないよう、hide_secret を必ず付ける。
  secret scanning が無効（404）などで取得できなければ GitHubAPIError
  */
  async listOpenSecretScanningAlerts(owner: string, repository: string): Promise<readonly JsonValue[]> {
    return this.listAll(`${repositoryPath(owner, repository)}/secret-scanning/alerts`, { state: 'open', hide_secret: 'true', per_page: ALERTS_PER_PAGE })
  }

  /**
  リポジトリの secret scanning の状態（enabled・disabled）。
  security_and_analysis は admin 権限が無いと応答に載らない。載っていなければ undefined
  */
  async getSecretScanningStatus(owner: string, repository: string): Promise<string | undefined> {
    const analysis = jsonField(await this.restJson('GET', repositoryPath(owner, repository)), 'security_and_analysis')
    const status = jsonField(jsonField(analysis, 'secret_scanning'), 'status')
    return typeof status === 'string' ? status : undefined
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
