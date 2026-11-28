// Issue 操作の API。cli/core/github/issues.py の移植。
// 返す値のキー名は、Python の辞書と同じ snake_case にする（CLI の JSON 出力がそのまま使う）。

import { isJsonObject, jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import type { BlockedByReference, BlockedByReferences, IssuePrerequisitesReadout, PrerequisiteFieldNames, TargetIssueReadout } from '../../domain/issue-readout.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { IssueCommentReading, IssueCommentRecord } from '../../domain/review-finish.js'
import type { GraphqlOutcome } from './client.js'
import { DependenciesUnsupportedError, GitHubAPIError, GitHubNotFoundError, isSchemaError } from './errors.js'
import { asArray, asObject, isTruthy, numberOrNull, requireNumber, requireString, requireValue, stringOrNull, subIssuesTotal, truthyNodes } from './payload.js'
import { MUTATION_ADD_BLOCKED_BY, MUTATION_ADD_SUB_ISSUE, MUTATION_REMOVE_BLOCKED_BY, QUERY_GET_ISSUE_BLOCKING_REFERENCES, QUERY_GET_ISSUE_KIND, QUERY_GET_ISSUE_KIND_PHASE1, QUERY_GET_ISSUE_LINKED_BRANCHES, QUERY_GET_ISSUE_NODE_ID, QUERY_GET_ISSUE_PREREQUISITES, QUERY_GET_ISSUE_SLIM, QUERY_GET_ISSUE_SLIM_WITHOUT_BLOCKED_BY } from './queries.js'
import { readBlockedBy, readIssue, readIssueReference } from './readout.js'
import { ProjectsApi } from './projects.js'
import { encodePathSegment, repositoryPath } from './rest-path.js'

const ISSUES_PER_PAGE = 100

export interface IssueNodeIdAndTitle {
  readonly id: string
  readonly title: string
}

export interface IssueLinkedBranches {
  readonly id: string
  readonly branches: readonly string[]
}

export interface SubIssueLink {
  readonly parent_number: number
  readonly child_number: number
}

/**
Issue 種別。issue_type は issueType フィールド非対応の GHES では null になりうる
*/
export interface IssueKindResult {
  readonly number: number
  readonly state: string
  readonly issue_type: string | null
  readonly sub_issues_total: number
}

export interface IssueComment {
  readonly author: string
  readonly created_at: string
  readonly body: string
}

export interface IssueParent {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly owner: string | null
  readonly repo: string | null
}

export interface IssueSubIssue {
  readonly number: number
  readonly state: string
  readonly title: string
}

export interface LinkedPullRequest {
  readonly number: number
  readonly title: string
  readonly state: string
}

/**
Issue の詳細（GraphQL で必要なフィールドだけ取ったもの）
*/
export interface IssueSlim {
  readonly number: number
  readonly state: string
  readonly title: string
  readonly body: string
  readonly comments: {
    readonly total_count: number
    readonly nodes: readonly IssueComment[]
  }
  readonly parent: IssueParent | null
  readonly sub_issues: readonly IssueSubIssue[]
  readonly linked_branches: readonly string[]
  readonly linked_prs: readonly LinkedPullRequest[]
  /**
  前提（blocked by）の件数（closed も数える）。Issue の依存関係に対応しない GHES では undefined
  */
  readonly blockedByCount: number | undefined
}

const DEFAULT_COMMENT_LIMIT = 5

/**
起票の要求に足す組み込みの機能。milestone は番号、type は Issue type の名前
*/
export interface CreateIssueExtras {
  readonly assignees?: readonly string[]
  readonly milestone?: number
  readonly type?: string
}

/**
前提を 1 回で読む件数の上限
*/
export const MAX_BLOCKED_BY = 50

// issueType フィールドに対応しない GHES が返すスキーマの失敗
function isIssueTypeSchemaError(error: unknown): boolean {
  return isSchemaError(error) && error.message.includes('issueType')
}

export const DEPENDENCIES_UNSUPPORTED = 'this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required'

// 依存関係のフィールド（blockedBy・blocking・addBlockedBy・removeBlockedBy）と issueType に対応しない GHES（3.19 より前）。
// そのスキーマの失敗なら、分かる失敗に替える
function asDependenciesError(error: unknown): unknown {
  return isSchemaError(error) && /blockedBy|blocking|issueType/iu.test(error.message) ? new DependenciesUnsupportedError(DEPENDENCIES_UNSUPPORTED, { cause: error }) : error
}

// 部分エラーのうち、対象の Issue の blockedBy の下のもの
function isBlockedByPath(path: readonly JsonValue[]): boolean {
  return path[0] === 'repository' && path[1] === 'issue' && path[2] === 'blockedBy'
}

// 部分エラーのうち、対象の Issue の blocking の下のもの
function isBlockingPath(path: readonly JsonValue[]): boolean {
  return path[0] === 'repository' && path[1] === 'issue' && path[2] === 'blocking'
}

// GitHub は無い Issue・リポを、data の null と、その道筋の NOT_FOUND の errors で返す。null を見て GitHubNotFoundError にする
function isIssueOrRepositoryPath(path: readonly JsonValue[]): boolean {
  return path[0] === 'repository' && (path.length === 1 || (path[1] === 'issue' && path.length === 2))
}

// blockedBy（または blocking）の connection を参照にする。件数が足りないのは呼ぶ側が見るので、ここでは失敗にしない
function readBlockedByReferences(connection: JsonValue | undefined, field: 'blockedBy' | 'blocking' = 'blockedBy'): BlockedByReferences {
  if (!isTruthy(connection)) return { kind: 'read-failed', reason: `${field} is null` }
  const nodes = asArray(jsonField(connection, 'nodes'))
  if (nodes.some(node => !isTruthy(node))) return { kind: 'read-failed', reason: `${field} has a null node` }
  const issues: readonly BlockedByReference[] = nodes.map(node => readIssueReference(node))
  return { kind: 'ok', total: requireNumber(jsonField(connection, 'totalCount'), `${field}.totalCount`), issues }
}

function numberOrUndefined(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function stringOrEmpty(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

// 見つからないときは GitHubNotFoundError。repository と issue の 2 段で確かめる
function issueNode(result: JsonObject, owner: string, repository: string, number: number): JsonValue {
  const repositoryNode = jsonField(result, 'repository')
  if (!isTruthy(repositoryNode)) throw new GitHubNotFoundError(`repository not found: ${owner}/${repository}`)
  const issue = jsonField(repositoryNode, 'issue')
  if (!isTruthy(issue)) throw new GitHubNotFoundError(`Issue not found: ${owner}/${repository}/${String(number)}`)
  return requireValue(issue, 'issue')
}

// 対象の Issue の親の参照。親が無い、またはリポジトリが読めない応答なら null
function readParentReference(issue: JsonValue): TargetIssueReadout['parent'] {
  const parent = jsonField(issue, 'parent')
  if (!isTruthy(parent)) return JSON_NULL
  const repository = jsonField(parent, 'repository')
  const owner = stringOrNull(jsonField(jsonField(repository, 'owner'), 'login'))
  const name = stringOrNull(jsonField(repository, 'name'))
  const number = jsonField(parent, 'number')
  return owner === JSON_NULL || name === JSON_NULL || typeof number !== 'number' ? JSON_NULL : { repository: { owner, repository: name }, number }
}

function formatParent(parent: JsonValue | undefined): IssueParent | null {
  if (!isTruthy(parent)) return JSON_NULL
  const repository = asObject(jsonField(parent, 'repository'))
  return {
    number: requireNumber(jsonField(parent, 'number'), 'parent.number'),
    title: requireString(jsonField(parent, 'title'), 'parent.title'),
    state: requireString(jsonField(parent, 'state'), 'parent.state'),
    owner: stringOrNull(jsonField(repository['owner'], 'login')),
    repo: stringOrNull(repository['name']),
  }
}

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

/**
timelineItems からリンクされた PR を取り出す。
ConnectedEvent は subject、CrossReferencedEvent は source に PR がある。PR 番号で重複を除く
*/
function extractLinkedPullRequests(timelineItems: JsonValue | undefined): readonly LinkedPullRequest[] {
  const seen = new Set<number>()
  const pullRequests: LinkedPullRequest[] = []
  for (const node of truthyNodes(timelineItems)) {
    const subject = jsonField(node, 'subject')
    const pullRequest = isTruthy(subject) ? subject : jsonField(node, 'source')
    if (!isTruthy(pullRequest)) continue
    const number = numberOrNull(jsonField(pullRequest, 'number'))
    if (number === null || number === 0 || seen.has(number)) continue
    seen.add(number)
    pullRequests.push({
      number,
      title: stringOrEmpty(jsonField(pullRequest, 'title')),
      state: stringOrEmpty(jsonField(pullRequest, 'state')),
    })
  }
  return pullRequests
}

function readSubIssueNodes(connection: JsonValue | undefined): readonly IssueSubIssue[] {
  return truthyNodes(connection).map(sub => ({
    number: requireNumber(jsonField(sub, 'number'), 'subIssue.number'),
    state: requireString(jsonField(sub, 'state'), 'subIssue.state'),
    title: requireString(jsonField(sub, 'title'), 'subIssue.title'),
  }))
}

export class IssuesApi extends ProjectsApi {
  private async executeDependencyMutation(mutation: string, variables: Readonly<{ issueId: string, blockingIssueId: string }>): Promise<void> {
    try {
      await this.executeGraphql(mutation, variables)
    }
    catch (error: unknown) {
      throw asDependenciesError(error)
    }
  }

  // issueType フィールド非対応の GHES 用の判定
  private async getIssueKindPhase1(owner: string, repository: string, number: number): Promise<IssueKindResult> {
    const result = await this.executeGraphql(QUERY_GET_ISSUE_KIND_PHASE1, { owner, repo: repository, number })
    const issue = issueNode(result, owner, repository, number)
    return {
      number: requireNumber(jsonField(issue, 'number'), 'issue.number'),
      state: requireString(jsonField(issue, 'state'), 'issue.state'),
      issue_type: JSON_NULL,
      sub_issues_total: subIssuesTotal(issue),
    }
  }

  // GetIssueSlim の応答の issue。前提の件数に対応しない GHES は、件数なしのクエリで読み直す
  private async fetchSlimIssue(owner: string, repository: string, number: number, commentLimit: number): Promise<JsonValue> {
    const variables = { owner, repo: repository, number, commentLimit }
    let result: JsonObject
    try {
      result = await this.queryIssue(QUERY_GET_ISSUE_SLIM, variables)
    }
    catch (error: unknown) {
      if (!isSchemaError(error) || !/blockedBy/iu.test(error.message)) throw error
      result = await this.queryIssue(QUERY_GET_ISSUE_SLIM_WITHOUT_BLOCKED_BY, variables)
    }
    return issueNode(result, owner, repository, number)
  }

  /**
  Issue を作る。labels が空なら送らない。extras は指定のあるものだけを送る
  */
  async createIssue(owner: string, repository: string, title: string, body = '', labels?: readonly string[], extras: Readonly<CreateIssueExtras> = {}): Promise<JsonObject> {
    const data = {
      title,
      body,
      ...(labels !== undefined && labels.length > 0 && { labels }),
      ...(extras.assignees !== undefined && { assignees: extras.assignees }),
      ...(extras.milestone !== undefined && { milestone: extras.milestone }),
      ...(extras.type !== undefined && { type: extras.type }),
    }
    return this.restObject('POST', `${repositoryPath(owner, repository)}/issues`, { json: data })
  }

  /**
  Issue にコメントを足す
  */
  async addIssueComment(owner: string, repository: string, number: number, body: string): Promise<JsonObject> {
    return this.restObject('POST', `${repositoryPath(owner, repository)}/issues/${String(number)}/comments`, { json: { body } })
  }

  /**
  Issue・PR のコメントを全件取る（REST）
  */
  async listIssueComments(owner: string, repository: string, number: number): Promise<readonly JsonValue[]> {
    return this.listAll(`${repositoryPath(owner, repository)}/issues/${String(number)}/comments`, { per_page: ISSUES_PER_PAGE })
  }

  /**
  Issue・PR のコメントを全件取り、本文・書き手・書いた人とリポの関係・作った時刻・URL を返す。順は REST と同じ ID の昇順
  */
  async listIssueCommentRecords(owner: string, repository: string, number: number): Promise<readonly IssueCommentRecord[]> {
    const comments = await this.listIssueComments(owner, repository, number)
    return comments.filter(comment => isJsonObject(comment)).map((comment) => {
      const user = jsonField(comment, 'user')
      return {
        body: text(jsonField(comment, 'body')),
        userType: text(jsonField(user, 'type')),
        login: text(jsonField(user, 'login')),
        authorAssociation: text(jsonField(comment, 'author_association')),
        createdAt: text(jsonField(comment, 'created_at')),
        url: text(jsonField(comment, 'html_url')),
      }
    })
  }

  /**
  Issue・PR のコメントを全件取り、本文と書き手の種類（`user.type`）だけを返す。順は REST と同じ ID の昇順
  */
  async listIssueCommentReadings(owner: string, repository: string, number: number): Promise<readonly IssueCommentReading[]> {
    const records = await this.listIssueCommentRecords(owner, repository, number)
    return records.map(({ body, userType }) => ({ body, userType }))
  }

  /**
  Issue・PR からラベルを外す。付いていなければ（404）'absent'、ほかの失敗は GitHubAPIError
  */
  async removeIssueLabel(owner: string, repository: string, number: number, name: string): Promise<'removed' | 'absent'> {
    const response = await this.restRequest('DELETE', `${repositoryPath(owner, repository)}/issues/${String(number)}/labels/${encodePathSegment(name)}`)
    if (response.statusCode === 404) return 'absent'
    if (!response.isSuccess) this.handleHttpError(response)
    return 'removed'
  }

  /**
  Issue 番号から GraphQL Node ID を取る。見つからなければ GitHubNotFoundError
  */
  async getIssueNodeId(owner: string, repository: string, number: number): Promise<string> {
    const issue = await this.getIssueNodeIdAndTitle(owner, repository, number)
    return issue.id
  }

  /**
  Issue 番号から GraphQL Node ID とタイトルを、1 回のクエリで取る
  */
  async getIssueNodeIdAndTitle(owner: string, repository: string, number: number): Promise<IssueNodeIdAndTitle> {
    const result = await this.queryIssue(QUERY_GET_ISSUE_NODE_ID, { owner, repo: repository, number })
    const issue = issueNode(result, owner, repository, number)
    return {
      id: requireString(jsonField(issue, 'id'), 'issue.id'),
      title: stringOrEmpty(jsonField(issue, 'title')),
    }
  }

  /**
  Issue の Node ID と、Issue のリポにある、つながったブランチの名前。見つからなければ GitHubNotFoundError
  */
  async getIssueLinkedBranches(owner: string, repository: string, number: number): Promise<IssueLinkedBranches> {
    const result = await this.queryIssue(QUERY_GET_ISSUE_LINKED_BRANCHES, { owner, repo: repository, number })
    const issue = issueNode(result, owner, repository, number)
    const fullName = `${owner}/${repository}`.toLowerCase()
    const branches = truthyNodes(jsonField(issue, 'linkedBranches'))
      .map(branch => jsonField(branch, 'ref'))
      .filter(reference => stringOrNull(jsonField(jsonField(reference, 'repository'), 'nameWithOwner'))?.toLowerCase() === fullName)
      .map(reference => requireString(jsonField(reference, 'name'), 'linkedBranch.ref.name'))
    return { id: requireString(jsonField(issue, 'id'), 'issue.id'), branches }
  }

  /**
  サブ Issue を紐づける。紐づけ結果は親と子の Issue 番号
  */
  async addSubIssue(parentIssueId: string, childIssueId: string): Promise<SubIssueLink> {
    const result = await this.executeGraphql(MUTATION_ADD_SUB_ISSUE, { parentId: parentIssueId, childId: childIssueId })
    const linkResult = jsonField(result, 'addSubIssue')
    const parent = jsonField(linkResult, 'issue')
    const child = jsonField(linkResult, 'subIssue')
    if (!isTruthy(parent) || !isTruthy(child)) throw new GitHubAPIError('failed to link the sub-issue')
    return {
      parent_number: requireNumber(jsonField(parent, 'number'), 'issue.number'),
      child_number: requireNumber(jsonField(child, 'number'), 'subIssue.number'),
    }
  }

  /**
  前提（blocked by）を付ける。issueId が待つ側、blockingIssueId が前提（どちらも node ID）。
  GitHub の拒否（輪・件数の上限など）は HTTP 200 の VALIDATION で返り、GitHubAPIError になる。
  Issue の依存関係に対応しない GHES（3.19 より前）も GitHubAPIError
  */
  async addBlockedBy(issueId: string, blockingIssueId: string): Promise<void> {
    await this.executeDependencyMutation(MUTATION_ADD_BLOCKED_BY, { issueId, blockingIssueId })
  }

  /**
  前提（blocked by）を外す。addBlockedBy と同じ失敗をする
  */
  async removeBlockedBy(issueId: string, blockingIssueId: string): Promise<void> {
    await this.executeDependencyMutation(MUTATION_REMOVE_BLOCKED_BY, { issueId, blockingIssueId })
  }

  /**
  Issue と、その前提（blockedBy 先頭 blockedByFirst 件）を 1 回のクエリで読む。ボードの値は projectId のものだけ。
  blockedBy の部分エラーと、件数の上限による取りこぼしは、例外にせず blockedBy の read-failed で返す（呼ぶ側は判定の入力にする）。
  Issue の依存関係に対応しない GHES（3.19 より前）、blockedBy 以外の失敗は GitHubAPIError
  */
  async getIssuePrerequisites(owner: string, repository: string, number: number, projectId: string, fieldNames: Readonly<PrerequisiteFieldNames>, blockedByFirst = MAX_BLOCKED_BY): Promise<IssuePrerequisitesReadout> {
    const variables = { owner, repo: repository, number, labelFieldName: fieldNames.labelFieldName, blockedByFirst }
    let outcome: GraphqlOutcome
    try {
      outcome = await this.queryIssueTolerating(QUERY_GET_ISSUE_PREREQUISITES, variables, isBlockedByPath)
    }
    catch (error: unknown) {
      throw asDependenciesError(error)
    }
    const { data, errors } = outcome
    const issue = issueNode(data, owner, repository, number)
    const messages = errors.map(error => stringOrEmpty(jsonField(error, 'message')))
    return {
      issue: { ...readIssue(issue, projectId, fieldNames), body: requireString(jsonField(issue, 'body'), 'issue.body'), parent: readParentReference(issue) },
      blockedBy: readBlockedBy(issue, projectId, fieldNames, messages),
    }
  }

  /**
  その Issue を前提にしている Issue（blocking 先頭 blockingFirst 件）の参照と、全体の件数を読む。
  total が issues の数より多ければ、読めなかった分がある。blocking の部分エラーと null の node は read-failed。
  Issue の依存関係に対応しない GHES は DependenciesUnsupportedError
  */
  async getIssueBlockingReferences(owner: string, repository: string, number: number, blockingFirst = MAX_BLOCKED_BY): Promise<BlockedByReferences> {
    let outcome: GraphqlOutcome
    try {
      const variables = { owner, repo: repository, number, blockingFirst }
      outcome = await this.executeGraphqlTolerating(QUERY_GET_ISSUE_BLOCKING_REFERENCES, variables, path => isBlockingPath(path) || isIssueOrRepositoryPath(path))
    }
    catch (error: unknown) {
      throw asDependenciesError(error)
    }
    const issue = issueNode(outcome.data, owner, repository, number)
    const messages = outcome.errors.filter(error => isBlockingPath(asArray(error['path']))).map(error => stringOrEmpty(jsonField(error, 'message')))
    return messages.length > 0 ? { kind: 'read-failed', reason: `blocking could not be read: ${messages.join('; ')}` } : readBlockedByReferences(jsonField(issue, 'blocking'), 'blocking')
  }

  /**
  Issue 種別を軽く取る。issueType フィールドに対応しない GHES では、subIssues だけで判定する
  */
  async getIssueKind(owner: string, repository: string, number: number): Promise<IssueKindResult> {
    const variables = { owner, repo: repository, number }
    let result: JsonObject
    try {
      result = await this.executeGraphql(QUERY_GET_ISSUE_KIND, variables)
    }
    catch (error: unknown) {
      if (isIssueTypeSchemaError(error)) {
        return this.getIssueKindPhase1(owner, repository, number)
      }
      throw error
    }
    const issue = issueNode(result, owner, repository, number)
    return {
      number: requireNumber(jsonField(issue, 'number'), 'issue.number'),
      state: requireString(jsonField(issue, 'state'), 'issue.state'),
      issue_type: stringOrNull(jsonField(jsonField(issue, 'issueType'), 'name')),
      sub_issues_total: subIssuesTotal(issue),
    }
  }

  /**
  Issue の詳細を取る（GraphQL）。親・サブ Issue・リンクブランチ・リンク PR を 1 回のクエリで取る
  */
  async getIssueSlim(owner: string, repository: string, number: number, commentLimit = DEFAULT_COMMENT_LIMIT): Promise<IssueSlim> {
    const issue = await this.fetchSlimIssue(owner, repository, number, commentLimit)
    return {
      number: requireNumber(jsonField(issue, 'number'), 'issue.number'),
      state: requireString(jsonField(issue, 'state'), 'issue.state'),
      title: requireString(jsonField(issue, 'title'), 'issue.title'),
      body: requireString(jsonField(issue, 'body'), 'issue.body'),
      comments: {
        total_count: requireNumber(jsonField(jsonField(issue, 'comments'), 'totalCount'), 'issue.comments.totalCount'),
        nodes: truthyNodes(jsonField(issue, 'comments')).map(comment => ({
          author: isTruthy(jsonField(comment, 'author')) ? requireString(jsonField(jsonField(comment, 'author'), 'login'), 'comment.author.login') : 'ghost',
          created_at: requireString(jsonField(comment, 'createdAt'), 'comment.createdAt'),
          body: requireString(jsonField(comment, 'body'), 'comment.body'),
        })),
      },
      parent: formatParent(jsonField(issue, 'parent')),
      sub_issues: readSubIssueNodes(jsonField(issue, 'subIssues')),
      linked_branches: truthyNodes(jsonField(issue, 'linkedBranches'))
        .filter(branch => isTruthy(jsonField(branch, 'ref')))
        .map(branch => requireString(jsonField(jsonField(branch, 'ref'), 'name'), 'linkedBranch.ref.name')),
      linked_prs: extractLinkedPullRequests(jsonField(issue, 'timelineItems')),
      blockedByCount: numberOrUndefined(jsonField(jsonField(issue, 'blockedBy'), 'totalCount')),
    }
  }

  /**
  Issue を閉じる。stateReason は completed か not_planned
  */
  async closeIssue(owner: string, repository: string, number: number, stateReason = 'completed'): Promise<JsonObject> {
    return this.restObject('PATCH', `${repositoryPath(owner, repository)}/issues/${String(number)}`, {
      json: { state: 'closed', state_reason: stateReason },
    })
  }

  /**
  ラベルの付いた Issue を open・closed の両方で全件取る（REST）。Pull Request は除く
  */
  async listIssuesByLabel(owner: string, repository: string, label: string): Promise<readonly JsonValue[]> {
    const items = await this.listAll(`${repositoryPath(owner, repository)}/issues`, { state: 'all', labels: label, per_page: ISSUES_PER_PAGE })
    return items.filter(item => !(isJsonObject(item) && 'pull_request' in item))
  }

  /**
  Issue の本文を丸ごと置き換える。本文が上限を超える 422 は GitHubAPIError
  */
  async updateIssueBody(owner: string, repository: string, number: number, body: string): Promise<JsonObject> {
    return this.restObject('PATCH', `${repositoryPath(owner, repository)}/issues/${String(number)}`, { json: { body } })
  }
}
