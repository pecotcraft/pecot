// Issue 操作の API。cli/core/github/issues.py の移植。
// 返す値のキー名は、Python の辞書と同じ snake_case にする（CLI の JSON 出力がそのまま使う）。

import { isJsonObject, jsonField } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import type { IssuePrerequisitesReadout, PrerequisiteFieldNames, TargetIssueReadout } from '../../domain/issue-readout.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { GraphqlOutcome } from './client.js'
import { DependenciesUnsupportedError, GitHubAPIError, GitHubNotFoundError } from './errors.js'
import { asObject, isTruthy, numberOrNull, requireNumber, requireString, requireValue, stringOrNull, subIssuesTotal, truthyNodes } from './payload.js'
import {
  MUTATION_ADD_BLOCKED_BY,
  MUTATION_ADD_SUB_ISSUE,
  MUTATION_REMOVE_BLOCKED_BY,
  QUERY_GET_ISSUE_KIND,
  QUERY_GET_ISSUE_KIND_PHASE1,
  QUERY_GET_ISSUE_NODE_ID,
  QUERY_GET_ISSUE_PREREQUISITES,
  QUERY_GET_ISSUE_SLIM,
} from './queries.js'
import { readBlockedBy, readIssue } from './readout.js'
import { ProjectsApi } from './projects.js'
import { repositoryPath } from './rest-path.js'

const ISSUES_PER_PAGE = 100

export interface IssueNodeIdAndTitle {
  readonly id: string
  readonly title: string
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
}

const DEFAULT_COMMENT_LIMIT = 5
const SCHEMA_ERROR_PHRASES = ['Cannot query field', 'doesn\'t exist', 'Unknown field']

// issueType フィールドに対応しない GHES が返すスキーマの失敗
function isIssueTypeSchemaError(error: unknown): boolean {
  return error instanceof GitHubAPIError && error.message.includes('issueType') && SCHEMA_ERROR_PHRASES.some(phrase => error.message.includes(phrase))
}

const DEPENDENCIES_UNSUPPORTED = 'this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required'

// blockedBy・addBlockedBy・removeBlockedBy・issueType に対応しない GHES（3.19 より前）が返すスキーマの失敗なら、分かる失敗に替える
function asDependenciesError(error: unknown): unknown {
  const isSchemaError = error instanceof GitHubAPIError && SCHEMA_ERROR_PHRASES.some(phrase => error.message.includes(phrase))
  return isSchemaError && /blockedBy|issueType/iu.test(error.message) ? new DependenciesUnsupportedError(DEPENDENCIES_UNSUPPORTED, { cause: error }) : error
}

// 部分エラーのうち、対象の Issue の blockedBy の下のもの
function isBlockedByPath(path: readonly JsonValue[]): boolean {
  return path[0] === 'repository' && path[1] === 'issue' && path[2] === 'blockedBy'
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

  /**
  Issue を作る。labels が空なら送らない
  */
  async createIssue(owner: string, repository: string, title: string, body = '', labels?: readonly string[]): Promise<JsonObject> {
    const data = {
      title,
      body,
      ...(labels !== undefined && labels.length > 0 && { labels }),
    }
    return this.restObject('POST', `${repositoryPath(owner, repository)}/issues`, { json: data })
  }

  /**
  Issue のコメントを書き換える。見つからなければ GitHubNotFoundError
  */
  async updateIssueComment(owner: string, repository: string, commentId: number, body: string): Promise<JsonObject> {
    return this.restObject('PATCH', `${repositoryPath(owner, repository)}/issues/comments/${String(commentId)}`, { json: { body } })
  }

  /**
  Issue にコメントを足す
  */
  async addIssueComment(owner: string, repository: string, number: number, body: string): Promise<JsonObject> {
    return this.restObject('POST', `${repositoryPath(owner, repository)}/issues/${String(number)}/comments`, { json: { body } })
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
    const result = await this.executeGraphql(QUERY_GET_ISSUE_NODE_ID, { owner, repo: repository, number })
    const issue = issueNode(result, owner, repository, number)
    return {
      id: requireString(jsonField(issue, 'id'), 'issue.id'),
      title: stringOrEmpty(jsonField(issue, 'title')),
    }
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
  Issue と、その前提（blockedBy 先頭 50 件）を 1 回のクエリで読む。ボードの値は projectId のものだけ。
  blockedBy の部分エラーと、件数の上限による取りこぼしは、例外にせず blockedBy の read-failed で返す（呼ぶ側は判定の入力にする）。
  Issue の依存関係に対応しない GHES（3.19 より前）、blockedBy 以外の失敗は GitHubAPIError
  */
  async getIssuePrerequisites(owner: string, repository: string, number: number, projectId: string, fieldNames: Readonly<PrerequisiteFieldNames>): Promise<IssuePrerequisitesReadout> {
    const variables = { owner, repo: repository, number, columnFieldName: fieldNames.columnFieldName, labelFieldName: fieldNames.labelFieldName }
    let outcome: GraphqlOutcome
    try {
      outcome = await this.executeGraphqlTolerating(QUERY_GET_ISSUE_PREREQUISITES, variables, isBlockedByPath)
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
    const result = await this.executeGraphql(QUERY_GET_ISSUE_SLIM, { owner, repo: repository, number, commentLimit })
    const issue = issueNode(result, owner, repository, number)
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
      sub_issues: truthyNodes(jsonField(issue, 'subIssues')).map(sub => ({
        number: requireNumber(jsonField(sub, 'number'), 'subIssue.number'),
        state: requireString(jsonField(sub, 'state'), 'subIssue.state'),
        title: requireString(jsonField(sub, 'title'), 'subIssue.title'),
      })),
      linked_branches: truthyNodes(jsonField(issue, 'linkedBranches'))
        .filter(branch => isTruthy(jsonField(branch, 'ref')))
        .map(branch => requireString(jsonField(jsonField(branch, 'ref'), 'name'), 'linkedBranch.ref.name')),
      linked_prs: extractLinkedPullRequests(jsonField(issue, 'timelineItems')),
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
  Issue を再オープンする
  */
  async reopenIssue(owner: string, repository: string, number: number): Promise<JsonObject> {
    return this.restObject('PATCH', `${repositoryPath(owner, repository)}/issues/${String(number)}`, {
      json: { state: 'open', state_reason: 'reopened' },
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
