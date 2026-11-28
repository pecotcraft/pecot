// リポジトリ・ブランチ・リリース操作の API。cli/core/github/repos.py の移植。

import { jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import type { JsonValue } from '../../domain/python-format.js'
import { GitHubClientBase } from './client.js'
import { GitHubAPIError, GitHubNotFoundError, GitHubRateLimitError } from './errors.js'
import { asArray, isTruthy, requireNumber, requireString } from './payload.js'
import { MUTATION_CREATE_LINKED_BRANCH, QUERY_GET_BRANCH_REF_BY_NODE, QUERY_GET_REPOSITORY_ID } from './queries.js'
import { encodePath, encodePathSegment, repositoryPath } from './rest-path.js'

export interface CreateReleaseOptions {
  /**
  タグのターゲット。既定は main
  */
  readonly targetCommitish?: string | undefined
  readonly draft?: boolean | undefined
  readonly prerelease?: boolean | undefined
}

export interface WorkflowRunConclusion {
  readonly id: number
  readonly conclusion: string
}

export interface GraphqlRateLimit {
  readonly limit: number
  readonly used: number
  readonly remaining: number
  /**
  窓が切り替わる時刻（UNIX 秒）
  */
  readonly reset: number
}

/**
Actions の secret と変数を読む単位。organization は、organization の値のうち、そのリポに渡るもの
*/
export type ActionsScope = 'repository' | 'organization'

/**
リポジトリの設定のうち、action が読むもの
*/
export interface RepositorySettings {
  /**
  マージしたブランチを自動で消すか。merge の設定は contents:write の無い token では応答に載らず、その場合は undefined
  */
  readonly deleteBranchOnMerge: boolean | undefined
  readonly defaultBranch: string
  /**
  持ち主の種類（`User`・`Organization`）。読めない形なら undefined
  */
  readonly ownerType: string | undefined
}

const ALERTS_PER_PAGE = 100
// 一覧の per_page の上限。secret は 100、変数は 30（REST の文書）
const SECRETS_PER_PAGE = 100
const VARIABLES_PER_PAGE = 30
const NO_CONTENT = 204
const FORBIDDEN = 403
const NOT_FOUND = 404

export class ReposApi extends GitHubClientBase {
  // 名前だけを返し、変数の値は外へ渡さない。読めない（403・404）ときは undefined
  private async listNamesOrUndefined(path: string, perPage: number, itemsKey: string): Promise<readonly string[] | undefined> {
    let items: readonly JsonValue[]
    try {
      items = await this.listAll(path, { per_page: perPage }, itemsKey)
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError && (error.statusCode === FORBIDDEN || error.statusCode === NOT_FOUND) && !(error instanceof GitHubRateLimitError)) return undefined
      throw error
    }
    return items.map(item => jsonField(item, 'name')).filter(name => typeof name === 'string')
  }

  // GitHub は同じ名前のブランチがあっても errors を返さず linkedBranch を null にするので、作り先のリポを読んで理由を書く
  private async linkedBranchFailure(id: string, name: string): Promise<string> {
    let repository: string | undefined
    let hasBranch = false
    try {
      const node = jsonField(await this.executeGraphql(QUERY_GET_BRANCH_REF_BY_NODE, { id, qualifiedName: `refs/heads/${name}` }), 'node')
      const target = jsonField(node, 'repository') ?? node
      const fullName = jsonField(target, 'nameWithOwner')
      repository = typeof fullName === 'string' ? fullName : undefined
      hasBranch = repository !== undefined && isTruthy(jsonField(target, 'ref'))
    }
    catch (error: unknown) {
      if (!(error instanceof GitHubAPIError)) throw error
    }
    return hasBranch
      ? `GitHub did not create the linked branch: a branch named ${name} already exists in ${repository ?? ''}. Use another branch name, or delete that branch if nothing uses it`
      : `GitHub did not create the linked branch ${name} and gave no reason: check the branches of ${repository ?? 'the repository'} for the same name, and that the token can write its contents`
  }

  /**
  Link ヘッダの next を最後まで辿る。2 ページ目以降は next の絶対 URL を使い、params を再送すると cursor と二重になる
  */
  protected async listAll(path: string, firstParameters: Readonly<Record<string, number | string>>, itemsKey?: string): Promise<readonly JsonValue[]> {
    const items: JsonValue[] = []
    let target = path
    let parameters: Readonly<Record<string, number | string>> | undefined = firstParameters
    for (;;) {
      const response = await this.restRequest('GET', target, { params: parameters })
      if (!response.isSuccess) this.handleHttpError(response)
      // 応答が `{ total_count, <itemsKey>: [...] }` の形の一覧は、キーで配列を取り出す
      const body = response.json()
      items.push(...asArray(itemsKey === undefined ? body : jsonField(body, itemsKey)))
      const next = response.links.get('next')
      if (next === undefined) return items
      target = next.url
      parameters = undefined
    }
  }

  /**
  GraphQL の点数の上限・使用量・残り・窓の切り替わり（REST の /rate_limit。点数を使わない）。読めない・形が違うときは undefined
  */
  async getGraphqlRateLimit(): Promise<GraphqlRateLimit | undefined> {
    let body: JsonValue
    try {
      body = await this.restJson('GET', '/rate_limit')
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return undefined
      throw error
    }
    const graphql = jsonField(jsonField(body, 'resources'), 'graphql')
    const limit = jsonField(graphql, 'limit')
    const used = jsonField(graphql, 'used')
    const remaining = jsonField(graphql, 'remaining')
    const reset = jsonField(graphql, 'reset')
    return typeof limit === 'number' && typeof used === 'number' && typeof remaining === 'number' && typeof reset === 'number' ? { limit, used, remaining, reset } : undefined
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
  利用者のリポへの権限（REST の collaborators の permission）。maintain は write、triage は read で返る
  */
  async getCollaboratorPermission(owner: string, repository: string, user: string): Promise<string> {
    const result = await this.restObject('GET', `${repositoryPath(owner, repository)}/collaborators/${encodePathSegment(user)}/permission`)
    return requireString(jsonField(result, 'permission'), 'permission')
  }

  /**
  ブランチの最新 commit の SHA（REST）。見つからなければ GitHubNotFoundError
  */
  async getBranchSha(owner: string, repository: string, branch: string): Promise<string> {
    const reference = jsonField(await this.restJson('GET', `${repositoryPath(owner, repository)}/git/ref/heads/${encodePath(branch)}`), 'object')
    return requireString(jsonField(reference, 'sha'), 'object.sha')
  }

  /**
  head_sha の workflow の run の id と conclusion。終わっていない run の conclusion は空。先頭の 100 件だけ読む
  */
  async listWorkflowRunConclusions(owner: string, repository: string, headSha: string): Promise<readonly WorkflowRunConclusion[]> {
    const runs = jsonField(await this.restJson('GET', `${repositoryPath(owner, repository)}/actions/runs`, { params: { head_sha: headSha, per_page: 100 } }), 'workflow_runs')
    return asArray(runs).map((run, index) => {
      const conclusion = jsonField(run, 'conclusion')
      return { id: requireNumber(jsonField(run, 'id'), `workflow_runs[${String(index)}].id`), conclusion: typeof conclusion === 'string' ? conclusion : '' }
    })
  }

  /**
  head が base より進んでいる commit の数（REST の compare の ahead_by）。手元の git を使わない。
  per_page=1 で commit の一覧を削っても、ahead_by は変わらない
  */
  async countCommitsAhead(owner: string, repository: string, base: string, head: string): Promise<number> {
    const comparison = await this.restJson('GET', `${repositoryPath(owner, repository)}/compare/${encodePath(base)}...${encodePath(head)}`, { params: { per_page: 1 } })
    const ahead = jsonField(comparison, 'ahead_by')
    if (typeof ahead !== 'number' || !Number.isSafeInteger(ahead)) throw new GitHubAPIError('could not read ahead_by from the compare response')
    return ahead
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
    if (!isTruthy(linkedBranch)) throw new GitHubAPIError(await this.linkedBranchFailure(repositoryId === undefined || repositoryId === '' ? issueId : repositoryId, name))
    return requireString(jsonField(jsonField(linkedBranch, 'ref'), 'name'), 'linkedBranch.ref.name')
  }

  /**
  base と head の分かれ目の commit の SHA（REST の compare の merge_base_commit）
  */
  async getMergeBase(owner: string, repository: string, base: string, head: string): Promise<string> {
    const comparison = await this.restJson('GET', `${repositoryPath(owner, repository)}/compare/${encodePath(base)}...${encodePath(head)}`, { params: { per_page: 1 } })
    return requireString(jsonField(jsonField(comparison, 'merge_base_commit'), 'sha'), 'merge_base_commit.sha')
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
  Actions の secret の名前の一覧。scope が organization なら、organization の secret のうち、このリポに渡るもの
  */
  async listActionsSecretNames(owner: string, repository: string, scope: ActionsScope): Promise<readonly string[] | undefined> {
    const kind = scope === 'organization' ? 'organization-secrets' : 'secrets'
    return await this.listNamesOrUndefined(`${repositoryPath(owner, repository)}/actions/${kind}`, SECRETS_PER_PAGE, 'secrets')
  }

  /**
  Actions の変数の名前の一覧。scope が organization なら、organization の変数のうち、このリポに渡るもの
  */
  async listActionsVariableNames(owner: string, repository: string, scope: ActionsScope): Promise<readonly string[] | undefined> {
    const kind = scope === 'organization' ? 'organization-variables' : 'variables'
    return await this.listNamesOrUndefined(`${repositoryPath(owner, repository)}/actions/${kind}`, VARIABLES_PER_PAGE, 'variables')
  }

  /**
  リポジトリの設定（`GET /repos/{owner}/{repo}` を 1 回読む）
  */
  async getRepositorySettings(owner: string, repository: string): Promise<RepositorySettings> {
    const repositoryInfo = await this.restJson('GET', repositoryPath(owner, repository))
    const autoDelete = jsonField(repositoryInfo, 'delete_branch_on_merge')
    const ownerType = jsonField(jsonField(repositoryInfo, 'owner'), 'type')
    return {
      deleteBranchOnMerge: typeof autoDelete === 'boolean' ? autoDelete : undefined,
      defaultBranch: requireString(jsonField(repositoryInfo, 'default_branch'), 'default_branch'),
      ownerType: typeof ownerType === 'string' ? ownerType : undefined,
    }
  }

  /**
  リポジトリの持ち主の種類（`User`・`Organization`）。読めない形なら undefined
  */
  async getRepositoryOwnerType(owner: string, repository: string): Promise<string | undefined> {
    const repositoryInfo = await this.restJson('GET', repositoryPath(owner, repository))
    const type = jsonField(jsonField(repositoryInfo, 'owner'), 'type')
    return typeof type === 'string' ? type : undefined
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
