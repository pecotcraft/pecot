// 前提の読み取り（QUERY_GET_ISSUE_PREREQUISITES など）の応答を、domain/issue-readout.ts の形にする。

import { jsonField } from '../../domain/json.js'
import { JSON_NULL } from '../../domain/json-null.js'
import type {
  BlockedByReadout,
  BlockedByReference,
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

function readFieldValue(value: JsonValue | undefined, fieldName: string): ProjectFieldValueReadout | undefined {
  const fieldId = jsonField(jsonField(value, 'field'), 'id')
  const optionId = jsonField(value, 'optionId')
  const optionName = jsonField(value, 'name')
  return typeof fieldId === 'string' && typeof optionId === 'string' && typeof optionName === 'string' ? { fieldId, fieldName, optionId, optionName } : undefined
}

// 進行の欄は ID で探す。fieldName にはボード上の今の名前を入れる
function readColumnValue(item: JsonValue, columnFieldId: string): ProjectFieldValueReadout | undefined {
  const value = truthyNodes(jsonField(item, 'fieldValues')).find(node => jsonField(jsonField(node, 'field'), 'id') === columnFieldId)
  const name = jsonField(jsonField(value, 'field'), 'name')
  return readFieldValue(value, typeof name === 'string' ? name : '')
}

// 設定のプロジェクトのアイテムだけを見る。同じ Issue が載る別のボードの値は読まない
function readProjectFieldValues(issue: JsonValue, projectId: string, fieldNames: Readonly<PrerequisiteFieldNames>): readonly ProjectFieldValueReadout[] {
  return truthyNodes(jsonField(issue, 'projectItems'))
    .flatMap(item => jsonField(jsonField(item, 'project'), 'id') === projectId
      ? [readColumnValue(item, fieldNames.columnFieldId), readFieldValue(jsonField(item, 'label'), fieldNames.labelFieldName)]
      : [])
    .filter(value => value !== undefined)
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

/**
前提 1 件の参照（node ID・番号・リポ・状態）。node は BlockedByReferenceFields の形
*/
export function readIssueReference(node: JsonValue | undefined): BlockedByReference {
  return {
    id: requireString(jsonField(node, 'id'), 'blockedBy.nodes.id'),
    repository: readRepository(node, 'blockedBy.nodes'),
    number: requireNumber(jsonField(node, 'number'), 'blockedBy.nodes.number'),
    state: readState(node, ['OPEN', 'CLOSED'], 'blockedBy.nodes'),
  }
}
