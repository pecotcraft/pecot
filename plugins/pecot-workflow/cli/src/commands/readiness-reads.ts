// 公式の MCP の読み取りの結果から、Issue 1 件の前提をそろえて判定する。issue_dependency_check・board_check・branch_check・board_show・session_finish が使う
import { readWaitsForMerge } from '@pecot/workflow-core/domain/prerequisites.js'
import { TRACKER_TITLE_PREFIX } from '@pecot/workflow-core/domain/readiness.js'
import type { IssueFacts, IssueWorkKind, Prerequisite, Wait } from '@pecot/workflow-core/domain/readiness.js'
import { issueReferenceKey, parseIssueReference, ReferenceParseError } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { columnNames, issueText, judgeMove, unreadProblem } from './check-reads.js'
import type { BoardShape, JudgedMove, ParsedReads } from './check-reads.js'
import type { CheckProblem } from './check-result.js'
import { blockedByOf, ISSUE_DEPENDENCY_READ, issueFactsOf, parseOfficial } from './official-reads.js'
import type { IssueDependencyRead, ReadIssue } from './official-reads.js'

export interface BlockedByReads {
  readonly reads: ReadonlyMap<string, IssueDependencyRead>
  readonly problems: readonly CheckProblem[]
}

/**
reads.blocked_by などの `{ issue, result }` の並びを、Issue ごとの issue_dependency_read の結果にする。field は入力の中の置き場所
*/
export function dependencyReads(output: Readonly<Output>, entries: readonly { readonly issue: string, readonly result: unknown }[], field = 'reads.blocked_by'): BlockedByReads {
  const reads = new Map<string, IssueDependencyRead>()
  const problems: CheckProblem[] = []
  for (const [index, entry] of entries.entries()) {
    const where = `${field}[${String(index)}]`
    let reference: IssueReference
    try {
      reference = parseIssueReference(entry.issue)
    }
    catch (error: unknown) {
      if (!(error instanceof ReferenceParseError)) throw error
      problems.push({ field: `${where}.issue`, code: 'value', message: `${entry.issue} is not owner/repo/N` })
      continue
    }
    reads.set(issueReferenceKey(reference), parseOfficial(output, 'issue_dependency_read', ISSUE_DEPENDENCY_READ, entry.result, `${where}.result`))
  }
  return { reads, problems }
}

/**
Issue の get_blocked_by の結果。読んでいないか、ページが残っていれば、読み取りを求める problem
*/
export function readBlockedByOf(reference: IssueReference, reads: ReadonlyMap<string, IssueDependencyRead>): { readonly read: IssueDependencyRead } | { readonly problem: CheckProblem } {
  const read = reads.get(issueReferenceKey(reference))
  const name = issueText(reference)
  if (read === undefined) return { problem: unreadProblem('reads.blocked_by', `read the blocked-by of ${name} with issue_dependency_read (method get_blocked_by) and add it to reads.blocked_by`) }
  if (read.pageInfo?.hasNextPage === true) return { problem: unreadProblem('reads.blocked_by', `the blocked-by of ${name} has more pages: read them all and pass one result with every Issue`) }
  return { read }
}

export function workKindOf(title: string): IssueWorkKind {
  if (title.startsWith('[Epic]')) return 'epic'
  return title.startsWith(TRACKER_TITLE_PREFIX) ? 'tracker' : 'task'
}

export interface JudgeQuery {
  readonly ref: IssueReference
  readonly reads: ParsedReads
  readonly blockedBy: ReadonlyMap<string, IssueDependencyRead>
  readonly board: BoardShape
  readonly developmentBranch: string | undefined
  /**
  判定で今の列の代わりとする列（board_check の書く先）
  */
  readonly column?: string | undefined
  /**
  issue_read が無く前提も無いときに、代わりに使う Issue（board_show のカードの中身）
  */
  readonly fallback?: ReadIssue | undefined
  /**
  前提を判定の前に置き換える（session_finish のマージの前後）
  */
  readonly assume?: ((prerequisites: readonly Prerequisite[]) => readonly Prerequisite[]) | undefined
}

export type ReadJudgment
  = | { readonly kind: 'judged', readonly target: IssueFacts, readonly prerequisites: readonly Prerequisite[], readonly judged: JudgedMove }
    | { readonly kind: 'unread', readonly problems: readonly CheckProblem[] }

/**
前提の事実を読み取りの結果からそろえて判定する。前提はすべて issue_read の結果を求める（済んだか・レビュー中かは PR で決まる）
*/
export function judgeFromReads(query: Readonly<JudgeQuery>): ReadJudgment {
  const { ref, reads, board } = query
  const own = readBlockedByOf(ref, query.blockedBy)
  if ('problem' in own) return { kind: 'unread', problems: [own.problem] }
  const listed = blockedByOf(own.read)
  const issue = reads.issues.get(issueReferenceKey(ref)) ?? (listed.length === 0 ? query.fallback : undefined)
  const problems: CheckProblem[] = []
  if (issue === undefined) problems.push(unreadProblem('reads.issues', `read ${issueText(ref)} with issue_read (method get): the judgment needs its title, body and pull requests`))
  const section = readWaitsForMerge(issue?.body ?? '', ref.repository)
  const lines = section.kind === 'ok' ? section.lines : []
  const names = columnNames(board)
  const prerequisites: Prerequisite[] = []
  for (const { ref: prerequisite } of listed) {
    const read = reads.issues.get(issueReferenceKey(prerequisite))
    if (read === undefined) {
      problems.push(unreadProblem('reads.issues', `read ${issueText(prerequisite)} with issue_read (method get): whether a prerequisite is done or in review depends on its pull requests`))
      continue
    }
    const line = lines.find(candidate => issueReferenceKey(candidate.ref) === issueReferenceKey(prerequisite))
    // 節が読めないときは、前提をすべて merge として扱う
    const wait: Wait = line !== undefined || section.kind === 'malformed' ? 'merge' : 'stack'
    const card = reads.cards?.get(issueReferenceKey(prerequisite))
    prerequisites.push({ issue: issueFactsOf(read, card, names), wait, reason: line?.reason })
  }
  if (issue === undefined || problems.length > 0) return { kind: 'unread', problems }
  const facts = issueFactsOf(issue, reads.cards?.get(issueReferenceKey(ref)), names, workKindOf(issue.title))
  const target = query.column === undefined ? facts : { ...facts, column: query.column }
  const assumed = query.assume === undefined ? prerequisites : query.assume(prerequisites)
  const judged = judgeMove({ target, prerequisites: assumed, hasPrerequisites: listed.length > 0, board, pullRequests: reads.pullRequests, developmentBranch: query.developmentBranch })
  return { kind: 'judged', target, prerequisites: assumed, judged }
}
