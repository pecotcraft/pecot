// Pull Request 操作の API。cli/core/github/pulls.py の移植。
// 返す値のキー名は、Python の辞書と同じ snake_case にする（CLI の JSON 出力がそのまま使う）。

import { isJsonObject, jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type { PullRequestsByHeadReadout } from '../../domain/issue-readout.js'
import { extractReferencesIssueNumbers } from '../../domain/reference-parser.js'
import { isJsonArray } from '../../domain/python-format.js'
import type { JsonValue } from '../../domain/python-format.js'
import { GitHubAPIError, GitHubNotFoundError } from './errors.js'
import { IssuesApi } from './issues.js'
import { asObject, isTruthy, numberOrNull, requireNumber, requireString, requireValue, stringOrNull, throwMalformed, truthyNodes } from './payload.js'
import { QUERY_GET_PULL_REQUEST_SLIM, QUERY_GET_PULL_REQUEST_WITH_REVIEWS, QUERY_LIST_OPEN_PULL_REQUESTS, QUERY_LIST_PULL_REQUESTS_BY_HEAD } from './queries.js'
import { readPullRequests } from './readout.js'
import { repositoryPath } from './rest-path.js'

export interface ClosingIssue {
  readonly number: number
  readonly title: string
}

export interface PullRequestBase {
  readonly number: number
  readonly state: string
  readonly title: string
  readonly body: string
  readonly head_ref: string
  readonly base_ref: string
  readonly is_draft: boolean
  readonly mergeable: string
  readonly comments: number
  readonly closing_issues: readonly ClosingIssue[]
  /**
  PR 本文の Refs で参照された Issue のうち、closing_issues に無いもの。title は空文字
  */
  readonly referenced_issues: readonly ClosingIssue[]
}

export interface PullRequestSlim extends PullRequestBase {
  readonly reviews: readonly { readonly state: string, readonly author: string | null }[]
}

export interface PullRequestReview {
  readonly state: string
  readonly author: string | null
  readonly body: string
  readonly submitted_at: string | null
}

export interface ReviewThreadComment {
  readonly author: string | null
  readonly body: string
  readonly created_at: string | null
}

export interface ReviewThread {
  readonly is_resolved: boolean
  readonly path: string | null
  readonly line: number | null
  readonly comments: readonly ReviewThreadComment[]
}

/**
GitHub のスタック。pullRequests は下の段からの PR 番号
*/
export interface PullRequestStack {
  readonly number: number
  readonly pullRequests: readonly number[]
}

/**
Stacks API が求める X-GitHub-Api-Version（https://docs.github.com/en/rest/pulls/stacks）
*/
export const STACKS_API_VERSION = '2026-03-10'

function readStack(value: JsonValue | undefined): PullRequestStack {
  if (!isJsonObject(value)) throwMalformed('stack')
  const pullRequests = jsonField(value, 'pull_requests')
  if (!isJsonArray(pullRequests)) throwMalformed('stack.pull_requests')
  return {
    number: requireNumber(jsonField(value, 'number'), 'stack.number'),
    pullRequests: pullRequests.map(pullRequest => requireNumber(jsonField(pullRequest, 'number'), 'stack.pull_requests.number')),
  }
}

export interface PullRequestWithReviews extends PullRequestBase {
  readonly reviews: readonly PullRequestReview[]
  readonly review_threads: readonly ReviewThread[]
}

// author がある場合だけ login を読む。author が無い（削除されたユーザーなど）、または login が空なら null
function loginOrNull(author: JsonValue | undefined): string | null {
  const login = jsonField(author, 'login')
  return isTruthy(login) ? stringOrNull(login) : JSON_NULL
}

function formatPullRequestBase(pullRequest: JsonValue, owner: string, repository: string): PullRequestBase {
  const closingIssues = truthyNodes(jsonField(pullRequest, 'closingIssuesReferences')).map(issue => ({
    number: requireNumber(jsonField(issue, 'number'), 'closingIssue.number'),
    title: requireString(jsonField(issue, 'title'), 'closingIssue.title'),
  }))

  // Refs #XXX（本文から抽出）。Closing Issues と重複しないものだけ
  const closingNumbers = new Set(closingIssues.map(issue => issue.number))
  const body = jsonField(pullRequest, 'body')
  const referenced = extractReferencesIssueNumbers(typeof body === 'string' ? body : undefined, { owner, repository })
  const referencedIssues = [...referenced].filter(number => !closingNumbers.has(number)).toSorted((a, b) => a - b).map(number => ({ number, title: '' }))

  const isDraft = jsonField(pullRequest, 'isDraft')
  return {
    number: requireNumber(jsonField(pullRequest, 'number'), 'pullRequest.number'),
    state: requireString(jsonField(pullRequest, 'state'), 'pullRequest.state'),
    title: requireString(jsonField(pullRequest, 'title'), 'pullRequest.title'),
    body: requireString(body, 'pullRequest.body'),
    head_ref: requireString(jsonField(pullRequest, 'headRefName'), 'pullRequest.headRefName'),
    base_ref: requireString(jsonField(pullRequest, 'baseRefName'), 'pullRequest.baseRefName'),
    is_draft: typeof isDraft === 'boolean' ? isDraft : throwMalformed('pullRequest.isDraft'),
    mergeable: requireString(jsonField(pullRequest, 'mergeable'), 'pullRequest.mergeable'),
    comments: requireNumber(jsonField(jsonField(pullRequest, 'comments'), 'totalCount'), 'pullRequest.comments.totalCount'),
    closing_issues: closingIssues,
    referenced_issues: referencedIssues,
  }
}

function isDependabotAuthor(node: JsonValue): node is JsonObject {
  if (!isJsonObject(node)) return false
  const author = jsonField(node, 'author')
  return jsonField(author, '__typename') === 'Bot' && jsonField(author, 'login') === 'dependabot'
}

function requiredTextOrEmpty(value: JsonValue | undefined): string {
  return isTruthy(value) ? requireString(value, 'text') : ''
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
  PR を作る
  */
  async createPullRequest(owner: string, repository: string, title: string, body: string, head: string, base: string, isDraft = false): Promise<JsonObject> {
    return this.restObject('POST', `${repositoryPath(owner, repository)}/pulls`, {
      json: { title, body, head, base, draft: isDraft },
    })
  }

  /**
  PR の詳細を取る（GraphQL）。関連 Issue とレビューを 1 回のクエリで取る
  */
  async getPullRequestSlim(owner: string, repository: string, number: number): Promise<PullRequestSlim> {
    const pullRequest = await this.fetchPullRequest(QUERY_GET_PULL_REQUEST_SLIM, owner, repository, number)
    return {
      ...formatPullRequestBase(pullRequest, owner, repository),
      reviews: truthyNodes(jsonField(pullRequest, 'reviews')).map(review => ({
        state: requireString(jsonField(review, 'state'), 'review.state'),
        author: isTruthy(jsonField(review, 'author')) ? requireString(jsonField(jsonField(review, 'author'), 'login'), 'review.author.login') : JSON_NULL,
      })),
    }
  }

  /**
  PR の詳細をレビュー情報付きで取る。getPullRequestSlim に、レビュー本文と行コメント（reviewThreads）を足したもの
  */
  async getPullRequestWithReviews(owner: string, repository: string, number: number): Promise<PullRequestWithReviews> {
    const pullRequest = await this.fetchPullRequest(QUERY_GET_PULL_REQUEST_WITH_REVIEWS, owner, repository, number)
    return {
      ...formatPullRequestBase(pullRequest, owner, repository),
      reviews: truthyNodes(jsonField(pullRequest, 'reviews')).map(review => ({
        state: requireString(jsonField(review, 'state'), 'review.state'),
        author: loginOrNull(jsonField(review, 'author')),
        body: requiredTextOrEmpty(jsonField(review, 'body')),
        submitted_at: stringOrNull(jsonField(review, 'submittedAt')),
      })),
      review_threads: truthyNodes(jsonField(pullRequest, 'reviewThreads')).map(thread => ({
        is_resolved: jsonField(thread, 'isResolved') === true,
        path: stringOrNull(jsonField(thread, 'path')),
        line: numberOrNull(jsonField(thread, 'line')),
        comments: truthyNodes(jsonField(thread, 'comments')).map(comment => ({
          author: loginOrNull(jsonField(comment, 'author')),
          body: requiredTextOrEmpty(jsonField(comment, 'body')),
          created_at: stringOrNull(jsonField(comment, 'createdAt')),
        })),
      })),
    }
  }

  /**
  PR をマージする。mergeMethod は merge・squash・rebase。既定は squash
  */
  async mergePullRequest(owner: string, repository: string, number: number, mergeMethod = 'squash'): Promise<JsonObject> {
    return this.restObject('PUT', `${repositoryPath(owner, repository)}/pulls/${String(number)}/merge`, {
      json: { merge_method: mergeMethod },
    })
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
    return stacks.map(stack => readStack(stack)).find(stack => stack.pullRequests.includes(pullRequestNumber))
  }

  /**
  スタックを作る。pullRequestNumbers は下の段からの順
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
