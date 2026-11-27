// issue_check・issue_dependency_check が共有する、読み取りの結果の受け方とボードの形
import { z } from 'zod'

import { decideBoardMove } from '@pecot/workflow-core/domain/board-move.js'
import type { BoardMove } from '@pecot/workflow-core/domain/board-move.js'
import { getDevelopBranch, getOptionId, WORKFLOW_FIELD_NAME, workflowFieldId } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { formatHinted } from '@pecot/workflow-core/domain/command-hint.js'
import { hasStarted, isDone, judgeReadiness } from '@pecot/workflow-core/domain/readiness.js'
import type { IssueFacts, IssuePullRequest, Prerequisite, Readiness } from '@pecot/workflow-core/domain/readiness.js'
import { issueReferenceKey, issueReferenceToCliReference } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { repositoryFullName } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { configLookupFailure, findConfigFor } from '@pecot/workflow-core/infra/config-store.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import type { CheckProblem } from './check-result.js'
import { cardsOf, ISSUE_READ_GET, issueFactsOf, parseOfficial, PROJECTS_LIST_FIELDS, PROJECTS_LIST_ITEMS, projectFieldsOf, PULL_REQUEST_READ_GET, readIssueOf, readPullRequestOf } from './official-reads.js'
import type { ReadCard, ReadIssue, ReadProjectField } from './official-reads.js'

export const READ_ISSUES = z.array(z.unknown()).optional().describe('Results of issue_read with method get (the structuredContent, { issue: ... }): the parent, prerequisites and, with update, the target')
export const READ_BLOCKED_BY = z.array(z.object({
  issue: z.string().describe('The Issue whose blocked-by was read (owner/repo/N)'),
  result: z.unknown().describe('Result of issue_dependency_read with method get_blocked_by'),
})).optional()
export const READ_PROJECT_ITEMS = z.array(z.unknown()).optional().describe('Results of projects_list with method list_project_items (every page): the cards of the target, the parent and the prerequisites')
export const READ_PROJECT_FIELDS = z.unknown().optional().describe('Result of projects_list with method list_project_fields')
export const READ_PULL_REQUESTS = z.array(z.unknown()).optional().describe('Results of pull_request_read with method get: each open pull request that closes a prerequisite (closed_by_pull_requests of issue_read), and those its base branch stacks on; they decide whether the Issue can stack')

const STATUS_FIELD_NAME = 'Status'

// 設定のキー → 選択肢の表示名。ボードの選択肢を設定の ID で見つけられないときに名前で探す
const COLUMN_NAMES: Readonly<Record<string, string>> = {
  backlog: 'Backlog',
  pending: 'Pending',
  blocked: 'Blocked',
  ready: 'Ready',
  active: 'Active',
  in_review: 'In Review',
  archived: 'Archived',
}

const LABEL_NAMES: Readonly<Record<string, string>> = {
  needs_attention: 'Needs Attention',
  todo: 'Todo',
}

export function issueText(reference: IssueReference): string {
  return issueReferenceToCliReference(reference)
}

/**
読んでいない結果を求める problem
*/
export function unreadProblem(field: string, message: string, issue?: string): CheckProblem {
  return { ...issue !== undefined && { issue }, field, code: 'read-required', message }
}

/**
ボードの欄のうち、チェックが使うもの。選択肢と表示名は list_project_fields の結果を正にする
*/
export interface BoardShape {
  readonly fields: readonly ReadProjectField[]
  /**
  進行の欄（列）。見つからなければ undefined
  */
  readonly workflow: ReadProjectField | undefined
  readonly status: ReadProjectField | undefined
  /**
  進行の欄の、設定のキー（ready など）の選択肢の表示名。ボードに無ければ undefined
  */
  readonly column: (key: string) => string | undefined
  readonly label: (key: string) => string | undefined
}

function optionName(field: ReadProjectField | undefined, configId: string | undefined, fallback: string | undefined): string | undefined {
  if (field === undefined) return undefined
  const byId = configId === undefined ? undefined : field.options.find(option => option.id === configId)
  return (byId ?? field.options.find(option => option.name.toLowerCase() === fallback?.toLowerCase()))?.name
}

export function boardShapeOf(fields: readonly ReadProjectField[], config: ProjectConfig | undefined): BoardShape {
  const configuredId = config === undefined ? undefined : workflowFieldId(config)
  const workflow = fields.find(field => configuredId !== undefined && field.nodeId === configuredId)
    ?? fields.find(field => field.name.toLowerCase() === WORKFLOW_FIELD_NAME)
  const status = fields.find(field => field.dataType === 'SINGLE_SELECT' && field.name === STATUS_FIELD_NAME)
  return {
    fields,
    workflow,
    status,
    // eslint-disable-next-line security/detect-object-injection -- key は設定のキー
    column: key => optionName(workflow, config === undefined ? undefined : getOptionId(config, 'workflow', key), COLUMN_NAMES[key]),
    // eslint-disable-next-line security/detect-object-injection -- key は設定のキー
    label: key => optionName(status, config === undefined ? undefined : getOptionId(config, 'status', key), LABEL_NAMES[key]),
  }
}

/**
入力の reads を確かめて、使う形にしたもの
*/
export interface ParsedReads {
  /**
  閉じる PR は、pull_request_read の結果があればそれに差し替えてある
  */
  readonly issues: ReadonlyMap<string, ReadIssue>
  readonly cards: ReadonlyMap<string, ReadCard> | undefined
  readonly board: BoardShape | undefined
  /**
  pull_request_read（get）で読んだ PR。キーは issueReferenceKey の形
  */
  readonly pullRequests: ReadonlyMap<string, IssuePullRequest>
}

export interface RawReads {
  readonly issues?: readonly unknown[] | undefined
  readonly project_items?: readonly unknown[] | undefined
  readonly project_fields?: unknown
  readonly pull_requests?: readonly unknown[] | undefined
}

function pullRequestKey(pullRequest: Readonly<IssuePullRequest>): string {
  return issueReferenceKey({ repository: pullRequest.repository, number: pullRequest.number })
}

export function parseReads(output: Readonly<Output>, reads: Readonly<RawReads> | undefined, config: ProjectConfig | undefined): ParsedReads {
  const pullRequests = new Map<string, IssuePullRequest>()
  const rawPullRequests = reads?.pull_requests ?? []
  for (const [index, raw] of rawPullRequests.entries()) {
    const where = `reads.pull_requests[${String(index)}]`
    const pullRequest = readPullRequestOf(output, parseOfficial(output, 'pull_request_read', PULL_REQUEST_READ_GET, raw, where), where)
    pullRequests.set(pullRequestKey(pullRequest), pullRequest)
  }
  const issues = new Map<string, ReadIssue>()
  const rawIssues = reads?.issues ?? []
  for (const [index, raw] of rawIssues.entries()) {
    const where = `reads.issues[${String(index)}]`
    const issue = readIssueOf(output, parseOfficial(output, 'issue_read', ISSUE_READ_GET, raw, where), where)
    const closing = issue.pullRequests.map(pullRequest => pullRequests.get(pullRequestKey(pullRequest)) ?? pullRequest)
    issues.set(issueReferenceKey(issue.ref), { ...issue, pullRequests: closing })
  }
  const items = reads?.project_items?.map((raw, index) => parseOfficial(output, 'projects_list', PROJECTS_LIST_ITEMS, raw, `reads.project_items[${String(index)}]`))
  const fields = reads?.project_fields === undefined ? undefined : projectFieldsOf(parseOfficial(output, 'projects_list', PROJECTS_LIST_FIELDS, reads.project_fields, 'reads.project_fields'))
  return {
    issues,
    cards: items === undefined ? undefined : cardsOf(items),
    board: fields === undefined ? undefined : boardShapeOf(fields, config),
    pullRequests,
  }
}

export function columnNames(board: BoardShape): { readonly column: string, readonly label: string } {
  return { column: board.workflow?.name ?? WORKFLOW_FIELD_NAME, label: board.status?.name ?? STATUS_FIELD_NAME }
}

/**
前提 1 件の判定の事実。Issue を読んでいなければ、状態だけの事実にする（閉じた前提は済んだかが分からない）
*/
export function prerequisiteFacts(reference: IssueReference, state: 'open' | 'closed' | undefined, reads: ParsedReads, board: BoardShape): IssueFacts | undefined {
  const key = issueReferenceKey(reference)
  const issue = reads.issues.get(key)
  const card = reads.cards?.get(key)
  if (issue !== undefined) return issueFactsOf(issue, card, columnNames(board))
  if (state === undefined) return undefined
  return issueFactsOf({ ref: reference, title: '', state, body: '', pullRequests: [] }, card, columnNames(board))
}

export interface MoveRequest {
  readonly target: IssueFacts
  readonly prerequisites: readonly Prerequisite[]
  readonly hasPrerequisites: boolean
  readonly board: BoardShape
  /**
  pull_request_read で読んだ PR。スタック先をたどるのに使う
  */
  readonly pullRequests: ReadonlyMap<string, IssuePullRequest>
  /**
  対象のリポの develop_branch。設定に無ければ undefined
  */
  readonly developmentBranch: string | undefined
}

/**
スタックできるかを決められなかった理由
*/
export type StackUndecided
  = | { readonly kind: 'unread-pull-requests', readonly pullRequests: readonly IssuePullRequest[] }
    | { readonly kind: 'missing-bases', readonly branches: readonly string[] }
    | { readonly kind: 'no-develop-branch', readonly repository: RepositoryReference }

export interface JudgedMove {
  readonly readiness: Readiness | undefined
  readonly move: BoardMove | undefined
  /**
  スタックの判定に要る PR か設定が足りず、スタックできるかを決められなかった。決まれば undefined
  */
  readonly stackUndecided: StackUndecided | undefined
}

export function developmentBranchOf(config: ProjectConfig | undefined, repository: Readonly<RepositoryReference>): string | undefined {
  return config === undefined ? undefined : getDevelopBranch(config, repository.owner, repository.repository)
}

// PR から base をたどり、開発ブランチにも読んだ PR の head にも当たらない base を返す。届くか輪になれば undefined
function missingBaseOf(start: Readonly<IssuePullRequest>, byHead: ReadonlyMap<string, IssuePullRequest>, developmentBranch: string): string | undefined {
  const seen = new Set([start.headRefName])
  let current = start
  while (current.baseRefName !== developmentBranch) {
    const next = byHead.get(current.baseRefName)
    if (next === undefined) return current.baseRefName
    if (seen.has(next.headRefName)) return undefined
    seen.add(next.headRefName)
    current = next
  }
  return undefined
}

function missingBases(heads: readonly IssuePullRequest[], byHead: ReadonlyMap<string, IssuePullRequest>, developmentBranch: string): readonly string[] {
  const missing = heads.map(start => missingBaseOf(start, byHead, developmentBranch)).filter(branch => branch !== undefined)
  return [...new Set(missing)]
}

function stackUndecidedOf(request: Readonly<MoveRequest>, byHead: ReadonlyMap<string, IssuePullRequest>, readiness: Readiness): StackUndecided | undefined {
  const { prerequisites, developmentBranch } = request
  const heads = prerequisites.filter(({ issue }) => !isDone(issue)).flatMap(({ issue }) => issue.pullRequests.filter(pullRequest => pullRequest.state === 'open'))
  // 公式の issue_read の PR は head・base が空。pull_request_read で読んだ PR だけが持つ
  const unread = heads.filter(pullRequest => pullRequest.headRefName === '')
  if (unread.length > 0) return { kind: 'unread-pull-requests', pullRequests: unread }
  if (developmentBranch === undefined || developmentBranch === '') return { kind: 'no-develop-branch', repository: request.target.ref.repository }
  const missing = readiness.kind === 'blocked' ? missingBases(heads, byHead, developmentBranch) : []
  return missing.length > 0 ? { kind: 'missing-bases', branches: missing } : undefined
}

/**
スタックできるかを決めるのに足りない読み取りの案内
*/
export function stackUndecidedHint(undecided: StackUndecided): string {
  switch (undecided.kind) {
    case 'unread-pull-requests': {
      const names = undecided.pullRequests.map(pullRequest => `${repositoryFullName(pullRequest.repository)}#${String(pullRequest.number)}`).join(', ')
      return `pass the result of pull_request_read (method get) for ${names} in reads.pull_requests to decide it`
    }
    case 'missing-bases': {
      return `find the open pull request whose head is ${undecided.branches.join(', ')} (list_pull_requests with head) and pass its pull_request_read (method get) result in reads.pull_requests to decide it`
    }
    case 'no-develop-branch': {
      return `develop_branch is not set for ${repositoryFullName(undecided.repository)} in the project config`
    }
  }
}

/**
前提をそろえた後の判定と、列と札の動き。スタックの判定に要る PR のブランチは、pull_request_read の結果から取る
*/
export function judgeMove(request: Readonly<MoveRequest>): JudgedMove {
  const { target, prerequisites, board } = request
  const byHead = new Map(Array.from(request.pullRequests.values(), pullRequest => [pullRequest.headRefName, pullRequest]))
  const readiness = judgeReadiness({ target, prerequisites, cycle: undefined, pullRequestsByHead: byHead, developmentBranch: request.developmentBranch ?? '' })
  // スタック先を探すのは、stackable と diverged に当たったときだけ。ほかの判定は PR のブランチに依らない
  const isStackJudged = readiness?.kind === 'stackable' || readiness?.reason?.code === 'diverged'
  const stackUndecided = readiness !== undefined && isStackJudged ? stackUndecidedOf(request, byHead, readiness) : undefined
  const move = decideBoardMove({
    eligible: target.state === 'open' && target.kind === 'task',
    column: target.column,
    label: target.label,
    hasStarted: hasStarted(target),
    hasPrerequisites: request.hasPrerequisites,
    readiness,
    labelWrittenByAutomation: false,
    available: {
      blocked: board.column('blocked') !== undefined,
      needsAttention: board.label('needs_attention') !== undefined,
      todo: board.label('todo') !== undefined,
    },
  })
  return { readiness, move, stackUndecided }
}

export type ConfigChoice
  = | { readonly kind: 'found', readonly config: ProjectConfig, readonly source: string }
    | { readonly kind: 'problem', readonly message: string }

/**
起票先のリポの設定を選ぶ。選べなければ、その理由の文
*/
export function configFor(target: Readonly<RepositoryReference>, project: string | undefined, commandPath: readonly string[]): ConfigChoice {
  const lookup = findConfigFor(target, project)
  return lookup.kind === 'found' ? { kind: 'found', config: lookup.found.config, source: lookup.found.path } : { kind: 'problem', message: formatHinted(configLookupFailure(lookup, target, commandPath).message) }
}
