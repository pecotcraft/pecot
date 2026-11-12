// 前提の読み取り（QUERY_GET_ISSUE_PREREQUISITES など）の応答を、domain/issue-readout.ts の形にする。

import { jsonField } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type {
  BlockedByReadout,
  IssueReadout,
  IssueStateReadout,
  LinkedBranchReadout,
  PrerequisiteFieldNames,
  ProjectFieldValueReadout,
  PullRequestReadout,
  PullRequestStateReadout,
} from '../../domain/issue-readout.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { RepositoryReference } from '../../domain/repository-resolver.js'
import { GitHubAPIError } from './errors.js'
import { asArray, isTruthy, requireNumber, requireString, subIssuesTotal, truthyNodes } from './payload.js'

function readRepository(node: JsonValue | undefined, path: string): RepositoryReference {
  const repository = jsonField(node, 'repository')
  return {
    owner: requireString(jsonField(jsonField(repository, 'owner'), 'login'), `${path}.repository.owner.login`),
    repository: requireString(jsonField(repository, 'name'), `${path}.repository.name`),
  }
}

function readState<T extends string>(node: JsonValue | undefined, allowed: readonly T[], path: string): T {
  const state = requireString(jsonField(node, 'state'), `${path}.state`)
  const matched = allowed.find(candidate => candidate === state)
  if (matched === undefined) throw new GitHubAPIError(`malformed GitHub response: ${path}.state (${state})`)
  return matched
}

/**
PR のノード 1 つ。`... on PullRequest` の型でない node は空で届くので、undefined を返す。
PR なのに number が無ければ GitHubAPIError
*/
export function readPullRequest(node: JsonValue | undefined): PullRequestReadout | undefined {
  if (!isTruthy(node)) return undefined
  const path = 'pullRequest'
  return {
    number: requireNumber(jsonField(node, 'number'), `${path}.number`),
    repository: readRepository(node, path),
    state: readState<PullRequestStateReadout>(node, ['OPEN', 'CLOSED', 'MERGED'], path),
    headRefName: requireString(jsonField(node, 'headRefName'), `${path}.headRefName`),
    baseRefName: requireString(jsonField(node, 'baseRefName'), `${path}.baseRefName`),
    isDraft: jsonField(node, 'isDraft') === true,
    isCrossRepository: jsonField(node, 'isCrossRepository') === true,
  }
}

export function readPullRequests(nodes: readonly (JsonValue | undefined)[]): readonly PullRequestReadout[] {
  return nodes.map(node => readPullRequest(node)).filter(pullRequest => pullRequest !== undefined)
}

function readLinkedBranches(issue: JsonValue): readonly LinkedBranchReadout[] {
  return truthyNodes(jsonField(issue, 'linkedBranches'))
    .filter(branch => isTruthy(jsonField(branch, 'ref')))
    .map((branch) => {
      const reference = jsonField(branch, 'ref')
      return {
        name: requireString(jsonField(reference, 'name'), 'linkedBranch.ref.name'),
        pullRequests: readPullRequests(truthyNodes(jsonField(reference, 'associatedPullRequests'))),
      }
    })
}

function readFieldValue(item: JsonValue, alias: string, fieldName: string): ProjectFieldValueReadout | undefined {
  const value = jsonField(item, alias)
  const fieldId = jsonField(jsonField(value, 'field'), 'id')
  const optionId = jsonField(value, 'optionId')
  const optionName = jsonField(value, 'name')
  return typeof fieldId === 'string' && typeof optionId === 'string' && typeof optionName === 'string' ? { fieldId, fieldName, optionId, optionName } : undefined
}

// 設定のプロジェクトのアイテムだけを見る。同じ Issue が載る別のボードの値は読まない
function readProjectFieldValues(issue: JsonValue, projectId: string, fieldNames: Readonly<PrerequisiteFieldNames>): readonly ProjectFieldValueReadout[] {
  return truthyNodes(jsonField(issue, 'projectItems'))
    .flatMap(item => jsonField(jsonField(item, 'project'), 'id') === projectId
      ? [readFieldValue(item, 'column', fieldNames.columnFieldName), readFieldValue(item, 'label', fieldNames.labelFieldName)]
      : [])
    .filter(value => value !== undefined)
}

interface TimelineEntry {
  readonly key: string
  readonly pullRequest: PullRequestReadout
  readonly isConnection: boolean
}

function pullRequestKey(pullRequest: Readonly<PullRequestReadout>): string {
  return `${pullRequest.repository.owner}/${pullRequest.repository.repository}#${String(pullRequest.number)}`
}

function applyTimelineEvent(entries: readonly TimelineEntry[], event: JsonValue, issueNumber: number): readonly TimelineEntry[] {
  const type = jsonField(event, '__typename')
  if (type === 'CrossReferencedEvent') {
    const pullRequest = readPullRequest(jsonField(event, 'source'))
    if (pullRequest === undefined) return entries
    const isRelated = jsonField(event, 'willCloseTarget') === true || pullRequest.headRefName.endsWith(`/${String(issueNumber)}`)
    return isRelated ? [...entries, { key: pullRequestKey(pullRequest), pullRequest, isConnection: false }] : entries
  }
  if (type !== 'ConnectedEvent' && type !== 'DisconnectedEvent') return entries
  const pullRequest = readPullRequest(jsonField(event, 'subject'))
  if (pullRequest === undefined) return entries
  const key = pullRequestKey(pullRequest)
  return type === 'ConnectedEvent'
    ? [...entries, { key, pullRequest, isConnection: true }]
    : entries.filter(entry => !(entry.isConnection && entry.key === key))
}

// ConnectedEvent は、後で同じ PR の DisconnectedEvent が無いものだけ採る。
// CrossReferencedEvent は、本文やコメントで触れただけの PR を除くため、閉じる参照か head が `/<Issue 番号>` で終わるものだけ採る
function readTimelinePullRequests(issue: JsonValue, issueNumber: number): readonly PullRequestReadout[] {
  const events = truthyNodes(jsonField(issue, 'timelineItems'))
  let entries: readonly TimelineEntry[] = []
  for (const event of events) entries = applyTimelineEvent(entries, event, issueNumber)
  return entries.map(entry => entry.pullRequest)
}

export function readIssue(issue: JsonValue, projectId: string, fieldNames: Readonly<PrerequisiteFieldNames>): IssueReadout {
  const issueType = jsonField(jsonField(issue, 'issueType'), 'name')
  const number = requireNumber(jsonField(issue, 'number'), 'issue.number')
  return {
    id: requireString(jsonField(issue, 'id'), 'issue.id'),
    repository: readRepository(issue, 'issue'),
    number,
    state: readState<IssueStateReadout>(issue, ['OPEN', 'CLOSED'], 'issue'),
    title: requireString(jsonField(issue, 'title'), 'issue.title'),
    issueType: typeof issueType === 'string' ? issueType : JSON_NULL,
    subIssuesTotal: subIssuesTotal(issue),
    projectFieldValues: readProjectFieldValues(issue, projectId, fieldNames),
    linkedBranches: readLinkedBranches(issue),
    closingPullRequests: readPullRequests(truthyNodes(jsonField(issue, 'closedByPullRequestsReferences'))),
    timelinePullRequests: readTimelinePullRequests(issue, number),
  }
}

// 件数が totalCount に足りない connection の説明。足りていれば undefined
function shortfall(connection: JsonValue | undefined, name: string, where: string): string | undefined {
  const total = jsonField(connection, 'totalCount')
  const returned = asArray(jsonField(connection, 'nodes')).length
  return typeof total === 'number' && returned < total ? `${name} of ${where} returned ${String(returned)} of ${String(total)}` : undefined
}

// 件数の上限で取りこぼした connection の説明。取りこぼしたまま判定すると、済んだ前提を未完と誤るため
function connectionShortfalls(issue: JsonValue): readonly string[] {
  const { owner: login, repository } = readRepository(issue, 'issue')
  const where = `${login}/${repository}#${String(requireNumber(jsonField(issue, 'number'), 'issue.number'))}`
  const linkedBranches = jsonField(issue, 'linkedBranches')
  return [
    shortfall(jsonField(issue, 'projectItems'), 'projectItems', where),
    shortfall(linkedBranches, 'linkedBranches', where),
    ...truthyNodes(linkedBranches).map(branch => shortfall(jsonField(jsonField(branch, 'ref'), 'associatedPullRequests'), 'associatedPullRequests', where)),
    shortfall(jsonField(issue, 'closedByPullRequestsReferences'), 'closedByPullRequestsReferences', where),
    shortfall(jsonField(issue, 'timelineItems'), 'timelineItems', where),
  ].filter(reason => reason !== undefined)
}

/**
対象の Issue の blockedBy を読む。次のどれかなら read-failed（理由つき）。
取りこぼしたまま前提なしと読むと、ブロック中の Issue を着手できると誤るため
- 部分エラー（errors）で blockedBy が読めなかった
- blockedBy が null、null の node がある、件数が totalCount に足りない
- 対象か前提の Issue の connection が、件数の上限で取りこぼされている
*/
export function readBlockedBy(target: JsonValue, projectId: string, fieldNames: Readonly<PrerequisiteFieldNames>, errorMessages: readonly string[] = []): BlockedByReadout {
  if (errorMessages.length > 0) return { kind: 'read-failed', reason: `blockedBy could not be read: ${errorMessages.join('; ')}` }
  const blockedBy = jsonField(target, 'blockedBy')
  if (!isTruthy(blockedBy)) return { kind: 'read-failed', reason: 'blockedBy is null' }
  const total = requireNumber(jsonField(blockedBy, 'totalCount'), 'issue.blockedBy.totalCount')
  const nodes = asArray(jsonField(blockedBy, 'nodes'))
  if (nodes.some(node => !isTruthy(node))) return { kind: 'read-failed', reason: 'blockedBy has a null node' }
  if (nodes.length < total) return { kind: 'read-failed', reason: `blockedBy returned ${String(nodes.length)} of ${String(total)} issues` }
  const [gap] = [target, ...nodes].flatMap(issue => connectionShortfalls(issue))
  return gap === undefined ? { kind: 'ok', issues: nodes.map(node => readIssue(node, projectId, fieldNames)) } : { kind: 'read-failed', reason: gap }
}
