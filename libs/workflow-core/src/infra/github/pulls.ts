// Pull Request 操作の API。cli/core/github/pulls.py の移植。
// 返す値のキー名は、Python の辞書と同じ snake_case にする（CLI の JSON 出力がそのまま使う）。

import { isJsonObject, jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type { PullRequestsByHeadReadout } from '../../domain/issue-readout.js'
import { isJsonArray } from '../../domain/python-format.js'
import type { JsonValue } from '../../domain/python-format.js'
import { GitHubAPIError, GitHubNotFoundError } from './errors.js'
import { IssuesApi } from './issues.js'
import { asObject, isTruthy, requireNumber, requireString, requireValue, throwMalformed, truthyNodes } from './payload.js'
import { QUERY_GET_PULL_REQUEST_FOR_FINISH, QUERY_LIST_OPEN_PULL_REQUESTS, QUERY_LIST_PULL_REQUESTS_BY_HEAD } from './queries.js'
import { readPullRequests } from './readout.js'
import { repositoryPath } from './rest-path.js'

const REVIEW_COMMENTS_PER_PAGE = 100

/**
GitHub のスタック。pullRequests は親から子の順の PR 番号
*/
export interface PullRequestStack {
  readonly number: number
  readonly pullRequests: readonly number[]
}

/**
Stacks API が求める X-GitHub-Api-Version（https://docs.github.com/en/rest/pulls/stacks）
*/
export const STACKS_API_VERSION = '2026-03-10'

/**
session finish が読む PR
*/
export interface PullRequestForFinish {
  readonly state: string
  readonly body: string
  readonly head_ref: string
  readonly base_ref: string
  readonly is_draft: boolean
  readonly closing_issues: readonly { readonly owner: string, readonly repository: string, readonly number: number }[]
  /**
  base のリポの既定ブランチ。空のリポなどで無ければ undefined
  */
  readonly default_branch: string | undefined
}

function requiresBoolean(value: JsonValue | undefined, path: string): boolean {
  return typeof value === 'boolean' ? value : throwMalformed(path)
}

function readStack(value: JsonValue | undefined): PullRequestStack {
  if (!isJsonObject(value)) throwMalformed('stack')
  const pullRequests = jsonField(value, 'pull_requests')
  if (!isJsonArray(pullRequests)) throwMalformed('stack.pull_requests')
  return {
    number: requireNumber(jsonField(value, 'number'), 'stack.number'),
    pullRequests: pullRequests.map(pullRequest => requireNumber(jsonField(pullRequest, 'number'), 'stack.pull_requests.number')),
  }
}

// 番号の型を問わずに、その PR を含むか。数でない番号でも含めば、readStack が形の誤りとして止める
function hasPullRequestNumber(stack: JsonValue, pullRequestNumber: number): boolean {
  const pullRequests = jsonField(stack, 'pull_requests')
  return isJsonArray(pullRequests) && pullRequests.some((pullRequest) => {
    const number = jsonField(pullRequest, 'number')
    return number === pullRequestNumber || number === String(pullRequestNumber)
  })
}

function isDependabotAuthor(node: JsonValue): node is JsonObject {
  if (!isJsonObject(node)) return false
  const author = jsonField(node, 'author')
  return jsonField(author, '__typename') === 'Bot' && jsonField(author, 'login') === 'dependabot'
}

export class PullsApi extends IssuesApi {
  // PR の取得クエリを実行し、pullRequest ノードを返す
  private async fetchPullRequest(query: string, owner: string, repository: string, number: number): Promise<JsonValue> {
    const result = await this.executeGraphql(query, { owner, repo: repository, number })
    const repositoryNode = jsonField(result, 'repository')
    if (!isTruthy(repositoryNode)) throw new GitHubNotFoundError(`repository not found: ${owner}/${repository}`)
    const pullRequest = jsonField(repositoryNode, 'pullRequest')
    if (!isTruthy(pullRequest)) throw new GitHubNotFoundError(`PR not found: ${owner}/${repository}/${String(number)}`)
    return requireValue(pullRequest, 'pullRequest')
  }

  /**
  head のブランチ名で PR を引く（open・closed・merged。新しい順に先頭 20 件）。
  20 件に収まらないときは hasNextPage が真。リポが無ければ GitHubNotFoundError
  */
  async listPullRequestsByHead(owner: string, repository: string, headReferenceName: string): Promise<PullRequestsByHeadReadout> {
    const result = await this.executeGraphql(QUERY_LIST_PULL_REQUESTS_BY_HEAD, { owner, repo: repository, headRefName: headReferenceName })
    const repositoryNode = jsonField(result, 'repository')
    if (!isTruthy(repositoryNode)) throw new GitHubNotFoundError(`repository not found: ${owner}/${repository}`)
    const connection = jsonField(repositoryNode, 'pullRequests')
    return {
      pullRequests: readPullRequests(truthyNodes(connection)),
      hasNextPage: jsonField(jsonField(connection, 'pageInfo'), 'hasNextPage') === true,
    }
  }

  /**
  session finish が閉じる Issue を決めるのに使う PR を読む（GraphQL）。PR が無ければ GitHubNotFoundError
  */
  async getPullRequestForFinish(owner: string, repository: string, number: number): Promise<PullRequestForFinish> {
    const pullRequest = await this.fetchPullRequest(QUERY_GET_PULL_REQUEST_FOR_FINISH, owner, repository, number)
    const defaultBranch = jsonField(jsonField(jsonField(pullRequest, 'baseRepository'), 'defaultBranchRef'), 'name')
    return {
      state: requireString(jsonField(pullRequest, 'state'), 'pullRequest.state'),
      body: requireString(jsonField(pullRequest, 'body'), 'pullRequest.body'),
      head_ref: requireString(jsonField(pullRequest, 'headRefName'), 'pullRequest.headRefName'),
      base_ref: requireString(jsonField(pullRequest, 'baseRefName'), 'pullRequest.baseRefName'),
      is_draft: requiresBoolean(jsonField(pullRequest, 'isDraft'), 'pullRequest.isDraft'),
      closing_issues: truthyNodes(jsonField(pullRequest, 'closingIssuesReferences')).map((issue) => {
        const issueRepository = jsonField(issue, 'repository')
        return {
          owner: requireString(jsonField(jsonField(issueRepository, 'owner'), 'login'), 'closingIssue.repository.owner.login'),
          repository: requireString(jsonField(issueRepository, 'name'), 'closingIssue.repository.name'),
          number: requireNumber(jsonField(issue, 'number'), 'closingIssue.number'),
        }
      }),
      default_branch: typeof defaultBranch === 'string' ? defaultBranch : undefined,
    }
  }

  /**
  その PR が入っているスタックを読む。入っていなければ undefined。
  スタックの機能が無いリポは GitHubNotFoundError
  */
  async getStackOfPullRequest(owner: string, repository: string, pullRequestNumber: number): Promise<PullRequestStack | undefined> {
    const stacks = await this.restJson('GET', `${repositoryPath(owner, repository)}/stacks`, {
      params: { pull_request: pullRequestNumber },
      apiVersion: STACKS_API_VERSION,
    })
    if (!isJsonArray(stacks)) throwMalformed('stacks')
    // 関係の無いスタックの形の誤りで登録を止めないよう、探している PR を含むものだけ厳しく読む
    const found = stacks.find(stack => hasPullRequestNumber(stack, pullRequestNumber))
    return found === undefined ? undefined : readStack(found)
  }

  /**
  スタックを作る。pullRequestNumbers は親から子の順
  */
  async createStack(owner: string, repository: string, pullRequestNumbers: readonly number[]): Promise<PullRequestStack> {
    return readStack(await this.restJson('POST', `${repositoryPath(owner, repository)}/stacks`, {
      json: { pull_requests: [...pullRequestNumbers] },
      apiVersion: STACKS_API_VERSION,
    }))
  }

  /**
  既にあるスタックの一番上に PR を足す。pullRequestNumbers は下からの順
  */
  async addToStack(owner: string, repository: string, stackNumber: number, pullRequestNumbers: readonly number[]): Promise<PullRequestStack> {
    return readStack(await this.restJson('POST', `${repositoryPath(owner, repository)}/stacks/${String(stackNumber)}/add`, {
      json: { pull_requests: [...pullRequestNumbers] },
      apiVersion: STACKS_API_VERSION,
    }))
  }

  /**
  PR の state（REST の `open`・`closed`）
  */
  async getPullRequestState(owner: string, repository: string, number: number): Promise<string> {
    const pullRequest = await this.restObject('GET', `${repositoryPath(owner, repository)}/pulls/${String(number)}`)
    return requireString(pullRequest['state'], 'state')
  }

  /**
  PR のレビューのコメント（行に付いたインラインコメント）を全件取る（REST）
  */
  async listPullRequestReviewComments(owner: string, repository: string, number: number): Promise<readonly JsonValue[]> {
    return this.listAll(`${repositoryPath(owner, repository)}/pulls/${String(number)}/comments`, { per_page: REVIEW_COMMENTS_PER_PAGE })
  }

  /**
  open の dependabot の PR を全件取る（GraphQL）。pullRequests に author の引数が無いので、全ページを辿ってから絞る。
  GraphQL のノードをそのまま返す
  */
  async listOpenDependabotPullRequests(owner: string, repository: string): Promise<readonly JsonObject[]> {
    const nodes: JsonValue[] = []
    let after: string | null = JSON_NULL
    for (;;) {
      const result = await this.executeGraphql(QUERY_LIST_OPEN_PULL_REQUESTS, { owner, repo: repository, after })
      const connection = jsonField(jsonField(result, 'repository'), 'pullRequests')
      // null を PR 0 件と読むと、sync が待つ PR は無いと判断して Tracker を閉じてしまう
      if (!isJsonObject(connection)) throw new GitHubAPIError('the PR list response has no repository.pullRequests')
      const pageNodes = jsonField(connection, 'nodes')
      if (!isJsonArray(pageNodes)) throw new GitHubAPIError('nodes in the PR list response is not an array')
      nodes.push(...pageNodes.filter(node => isTruthy(node)))
      const pageInfo = asObject(jsonField(connection, 'pageInfo'))
      if (!isTruthy(pageInfo['hasNextPage'])) break
      const cursor = pageInfo['endCursor']
      if (typeof cursor !== 'string' || cursor === '') throw new GitHubAPIError('the next page of the PR list has no endCursor')
      after = cursor
    }
    return nodes.filter(node => isDependabotAuthor(node))
  }
}
