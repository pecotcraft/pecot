// 前提の読み取り（QUERY_GET_ISSUE_PREREQUISITES など）の応答を、domain/issue-readout.ts の形にする。

import { jsonField } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type {
  BlockedByReadout,
  IssueReadout,
  IssueStateReadout,
  LinkedBranchReadout,
  ProjectFieldValueReadout,
  PullRequestReadout,
  PullRequestStateReadout,
} from '../../domain/issue-readout.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { RepositoryReference } from '../../domain/repository-resolver.js'
import { GitHubAPIError } from './errors.js'
import { asArray, isTruthy, numberOrNull, requireNumber, requireString, truthyNodes } from './payload.js'

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
PR のノード 1 つ。number が無いノード（timelineItems の別の種類のイベントなど）は undefined
*/
export function readPullRequest(node: JsonValue | undefined): PullRequestReadout | undefined {
  if (!isTruthy(node) || numberOrNull(jsonField(node, 'number')) === JSON_NULL) return undefined
  const path = 'pullRequest'
  return {
    repository: readRepository(node, path),
    number: requireNumber(jsonField(node, 'number'), `${path}.number`),
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

// 設定のプロジェクトのアイテムだけを見る。同じ Issue が載る別のボードの値は読まない
function readProjectFieldValues(issue: JsonValue, projectId: string): readonly ProjectFieldValueReadout[] {
  return truthyNodes(jsonField(issue, 'projectItems'))
    .filter(item => jsonField(jsonField(item, 'project'), 'id') === projectId)
    .flatMap(item => truthyNodes(jsonField(item, 'fieldValues')))
    .map(value => ({
      fieldId: jsonField(jsonField(value, 'field'), 'id'),
      fieldName: jsonField(jsonField(value, 'field'), 'name'),
      optionId: jsonField(value, 'optionId'),
      optionName: jsonField(value, 'name'),
    }))
    .filter(value => typeof value.fieldId === 'string' && typeof value.fieldName === 'string' && typeof value.optionId === 'string' && typeof value.optionName === 'string')
    .map(value => ({
      fieldId: requireString(value.fieldId, 'projectItem.field.id'),
      fieldName: requireString(value.fieldName, 'projectItem.field.name'),
      optionId: requireString(value.optionId, 'projectItem.optionId'),
      optionName: requireString(value.optionName, 'projectItem.name'),
    }))
}

// timelineItems は、ConnectedEvent の subject と CrossReferencedEvent の source のどちらかに PR がある
function readTimelinePullRequests(issue: JsonValue): readonly PullRequestReadout[] {
  return readPullRequests(truthyNodes(jsonField(issue, 'timelineItems')).map((event) => {
    const subject = jsonField(event, 'subject')
    return isTruthy(subject) ? subject : jsonField(event, 'source')
  }))
}

export function readIssue(issue: JsonValue, projectId: string): IssueReadout {
  const issueType = jsonField(jsonField(issue, 'issueType'), 'name')
  const subIssuesTotal = jsonField(jsonField(issue, 'subIssues'), 'totalCount')
  return {
    id: requireString(jsonField(issue, 'id'), 'issue.id'),
    repository: readRepository(issue, 'issue'),
    number: requireNumber(jsonField(issue, 'number'), 'issue.number'),
    state: readState<IssueStateReadout>(issue, ['OPEN', 'CLOSED'], 'issue'),
    title: requireString(jsonField(issue, 'title'), 'issue.title'),
    issueType: typeof issueType === 'string' ? issueType : JSON_NULL,
    subIssuesTotal: typeof subIssuesTotal === 'number' ? subIssuesTotal : 0,
    projectFieldValues: readProjectFieldValues(issue, projectId),
    linkedBranches: readLinkedBranches(issue),
    closingPullRequests: readPullRequests(truthyNodes(jsonField(issue, 'closedByPullRequestsReferences'))),
    timelinePullRequests: readTimelinePullRequests(issue),
  }
}

/**
blockedBy を読む。null の node があるか、件数が totalCount に足りないときは read-failed。
取りこぼしたまま前提なしと読むと、ブロック中の Issue を着手できると誤るため
*/
export function readBlockedBy(blockedBy: JsonValue | undefined, projectId: string): BlockedByReadout {
  const total = requireNumber(jsonField(blockedBy, 'totalCount'), 'issue.blockedBy.totalCount')
  const nodes = asArray(jsonField(blockedBy, 'nodes'))
  if (nodes.some(node => !isTruthy(node))) return { kind: 'read-failed', reason: 'blockedBy has a null node' }
  if (nodes.length < total) return { kind: 'read-failed', reason: `blockedBy returned ${String(nodes.length)} of ${String(total)} issues` }
  return { kind: 'ok', issues: nodes.map(node => readIssue(node, projectId)) }
}
