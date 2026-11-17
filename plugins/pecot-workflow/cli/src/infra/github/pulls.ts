// Pull Request 操作の API。cli/core/github/pulls.py の移植。
// 返す値のキー名は、Python の辞書と同じ snake_case にする（CLI の JSON 出力がそのまま使う）。

import { isJsonObject, jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type { PullRequestsByHeadReadout } from '../../domain/issue-readout.js'
import { extractReferencesIssueNumbers } from '../../domain/reference-parser.js'
import { isJsonArray } from '../../domain/python-format.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { RestResponse } from './client.js'
import { GitHubAPIError, GitHubNotFoundError, isSchemaError } from './errors.js'
import { IssuesApi } from './issues.js'
import { asObject, isTruthy, numberOrNull, requireNumber, requireString, requireValue, stringOrNull, throwMalformed, truthyNodes } from './payload.js'
import { QUERY_GET_PULL_REQUEST_FOR_FINISH, QUERY_GET_PULL_REQUEST_FOR_MERGE, QUERY_GET_PULL_REQUEST_FOR_MERGE_WITHOUT_QUEUE, QUERY_GET_PULL_REQUEST_SLIM, QUERY_GET_PULL_REQUEST_WITH_REVIEWS, QUERY_LIST_OPEN_PULL_REQUESTS, QUERY_LIST_PULL_REQUESTS_BY_BASE, QUERY_LIST_PULL_REQUESTS_BY_HEAD } from './queries.js'
import { readPullRequests } from './readout.js'
import { repositoryPath } from './rest-path.js'

/**
base のブランチ名で引いた、同じリポの開いている PR
*/
export interface PullRequestsByBase {
  readonly pullRequests: readonly { readonly number: number, readonly headRefName: string }[]
  /**
  先頭の件数に収まらず、続きがあるか
  */
  readonly hasNextPage: boolean
}

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

/**
pr merge が読む PR の状態
*/
export interface PullRequestForMerge {
  readonly number: number
  readonly state: string
  readonly isDraft: boolean
  readonly baseRefName: string
  readonly headRefOid: string
  readonly isMergeQueueEnabled: boolean
  readonly isInMergeQueue: boolean
}

const MERGE_QUEUE_FIELD_ERROR = /(?:Field '|field ")(?:isMergeQueueEnabled|isInMergeQueue)['"]/u

// eslint-disable-next-line no-restricted-syntax -- 配列から型を作るための as const
const ASYNC_MERGE_STATUSES = ['pending', 'merged', 'enqueued', 'failed'] as const

export type AsyncMergeStatus = typeof ASYNC_MERGE_STATUSES[number]

/**
非同期のマージの結果。uuid は pending のときだけ、message は details.message
*/
export interface AsyncMergeResult {
  readonly status: AsyncMergeStatus
  readonly uuid?: string
  readonly message?: string
}

/**
非同期のマージの要求への応答。accepted は 200・202、rejected は 400、conflict は 409
*/
export type AsyncMergeRequestOutcome
  = | { readonly outcome: 'accepted', readonly result: AsyncMergeResult }
    | { readonly outcome: 'rejected', readonly message: string }
    | { readonly outcome: 'conflict', readonly uuid?: string }

export interface AsyncMergeOptions {
  /**
  読んだ head の SHA。読んだ後に push された PR をマージしない
  */
  readonly sha: string
  /**
  base が merge queue を使うか。使うときはマージの方法の値を渡さない
  */
  readonly mergeQueue: boolean
}

function requiresBoolean(value: JsonValue | undefined, path: string): boolean {
  return typeof value === 'boolean' ? value : throwMalformed(path)
}

function isAsyncMergeStatus(value: JsonValue | undefined): value is AsyncMergeStatus {
  return ASYNC_MERGE_STATUSES.some(status => status === value)
}

function readAsyncMergeResult(value: JsonValue): AsyncMergeResult {
  const status = jsonField(value, 'status')
  if (!isAsyncMergeStatus(status)) throwMalformed(`mergeAsync.status (${typeof status === 'string' ? status : JSON.stringify(status)})`)
  const details = jsonField(value, 'details')
  const uuid = jsonField(details, 'uuid')
  const message = jsonField(details, 'message')
  if (status === 'pending' && typeof uuid !== 'string') throwMalformed('mergeAsync.details.uuid')
  return {
    status,
    ...status === 'pending' && typeof uuid === 'string' && { uuid },
    ...typeof message === 'string' && { message },
  }
}

// 文書は 400・409 の本文の形を示していないので、JSON でなくても止めない
function bodyOrUndefined(response: Readonly<RestResponse>): JsonValue | undefined {
  try {
    return response.json()
  }
  catch {
    return undefined
  }
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
  base のブランチ名で開いている PR を引き、同じリポの PR だけを返す（古い順に先頭 20 件）。
  20 件に収まらないときは hasNextPage が真。リポが無ければ GitHubNotFoundError
  */
  async listPullRequestsByBase(owner: string, repository: string, baseReferenceName: string): Promise<PullRequestsByBase> {
    const result = await this.executeGraphql(QUERY_LIST_PULL_REQUESTS_BY_BASE, { owner, repo: repository, baseRefName: baseReferenceName })
    const repositoryNode = jsonField(result, 'repository')
    if (!isTruthy(repositoryNode)) throw new GitHubNotFoundError(`repository not found: ${owner}/${repository}`)
    const connection = jsonField(repositoryNode, 'pullRequests')
    return {
      pullRequests: readPullRequests(truthyNodes(connection))
        .filter(pullRequest => !pullRequest.isCrossRepository)
        .map(pullRequest => ({ number: pullRequest.number, headRefName: pullRequest.headRefName })),
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
  PR をマージする。mergeMethod は merge・squash・rebase。既定は squash。
  sha を渡すと、head がその SHA でなければ GitHub が 409 で拒む
  */
  async mergePullRequest(owner: string, repository: string, number: number, mergeMethod = 'squash', sha?: string): Promise<JsonObject> {
    return this.restObject('PUT', `${repositoryPath(owner, repository)}/pulls/${String(number)}/merge`, {
      json: sha === undefined ? { merge_method: mergeMethod } : { merge_method: mergeMethod, sha },
    })
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
  pr merge の判断に使う PR の状態を読む（GraphQL）。
  merge queue の項目を持たない GHES は、項目なしのクエリで読み直し、どちらも false にする
  */
  async getPullRequestForMerge(owner: string, repository: string, number: number): Promise<PullRequestForMerge> {
    let pullRequest: JsonValue
    let hasQueueFields = true
    try {
      pullRequest = await this.fetchPullRequest(QUERY_GET_PULL_REQUEST_FOR_MERGE, owner, repository, number)
    }
    catch (error: unknown) {
      if (!isSchemaError(error) || !MERGE_QUEUE_FIELD_ERROR.test(error.message)) throw error
      pullRequest = await this.fetchPullRequest(QUERY_GET_PULL_REQUEST_FOR_MERGE_WITHOUT_QUEUE, owner, repository, number)
      hasQueueFields = false
    }
    return {
      number: requireNumber(jsonField(pullRequest, 'number'), 'pullRequest.number'),
      state: requireString(jsonField(pullRequest, 'state'), 'pullRequest.state'),
      isDraft: requiresBoolean(jsonField(pullRequest, 'isDraft'), 'pullRequest.isDraft'),
      baseRefName: requireString(jsonField(pullRequest, 'baseRefName'), 'pullRequest.baseRefName'),
      headRefOid: requireString(jsonField(pullRequest, 'headRefOid'), 'pullRequest.headRefOid'),
      isMergeQueueEnabled: hasQueueFields && requiresBoolean(jsonField(pullRequest, 'isMergeQueueEnabled'), 'pullRequest.isMergeQueueEnabled'),
      isInMergeQueue: hasQueueFields && requiresBoolean(jsonField(pullRequest, 'isInMergeQueue'), 'pullRequest.isInMergeQueue'),
    }
  }

  /**
  非同期のマージを頼む（https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously）。
  403・422 などは handleHttpError の例外
  */
  async requestAsyncMerge(owner: string, repository: string, number: number, options: Readonly<AsyncMergeOptions>): Promise<AsyncMergeRequestOutcome> {
    const response = await this.restRequest('PUT', `${repositoryPath(owner, repository)}/pulls/${String(number)}/merge-async`, {
      json: options.mergeQueue ? { sha: options.sha } : { sha: options.sha, merge_method: 'squash' },
      apiVersion: STACKS_API_VERSION,
    })
    if (response.statusCode === 400) {
      const message = jsonField(bodyOrUndefined(response), 'message')
      return { outcome: 'rejected', message: typeof message === 'string' ? message : response.text }
    }
    if (response.statusCode === 409) {
      const uuid = jsonField(jsonField(bodyOrUndefined(response), 'details'), 'uuid')
      return typeof uuid === 'string' ? { outcome: 'conflict', uuid } : { outcome: 'conflict' }
    }
    if (!response.isSuccess) this.handleHttpError(response)
    return { outcome: 'accepted', result: readAsyncMergeResult(response.json()) }
  }

  /**
  非同期のマージの結果を読む。結果が消えていれば（24 時間で消える）undefined
  */
  async getAsyncMergeResult(owner: string, repository: string, number: number, uuid: string): Promise<AsyncMergeResult | undefined> {
    const response = await this.restRequest('GET', `${repositoryPath(owner, repository)}/pulls/${String(number)}/merge-async/${encodeURIComponent(uuid)}`, {
      apiVersion: STACKS_API_VERSION,
    })
    if (response.statusCode === 404) return undefined
    if (!response.isSuccess) this.handleHttpError(response)
    return readAsyncMergeResult(response.json())
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
