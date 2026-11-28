/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型で、readonly にできない */
// issue_dependency_check。issue_dependency_write に渡す前の引数が、前提（blocked by）の決まりに合うかと、付け外しの後の列を返す
import { z } from 'zod'

import { decideBlock, decideUnblock } from '@pecot/workflow-core/domain/blocked-by-change.js'
import type { BlockDecision } from '@pecot/workflow-core/domain/blocked-by-change.js'
import { COLUMN_CONFIG_KEYS } from '@pecot/workflow-core/domain/board-move.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { readWaitsForMerge } from '@pecot/workflow-core/domain/prerequisites.js'
import { displayReference } from '@pecot/workflow-core/domain/readiness.js'
import type { Prerequisite, Wait } from '@pecot/workflow-core/domain/readiness.js'
import { issueReferenceKey } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { PROJECT_INPUT } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { columnNames, configFor, developmentBranchOf, issueText, judgeMove, parseReads, prerequisiteFacts, READ_BLOCKED_BY, READ_ISSUES, READ_PROJECT_FIELDS, READ_PROJECT_ITEMS, READ_PULL_REQUESTS, stackUndecidedHint, unreadProblem } from './check-reads.js'
import type { BoardShape, ParsedReads } from './check-reads.js'
import { CHECK_RESULT_SHAPE } from './check-result.js'
import type { CheckProblem } from './check-result.js'
import { blockedByOf, issueFactsOf, referenceOf } from './official-reads.js'
import type { IssueDependencyRead, ReadIssue } from './official-reads.js'
import { dependencyReads, readBlockedByOf, workKindOf } from './readiness-reads.js'

const CHECK_PATH = ['issue', 'dependency', 'check']
// GitHub が 1 つの Issue に付けられる blocked by の数
const MAX_BLOCKED_BY = 50
// 輪を探してたどる Issue の数の上限
const MAX_CYCLE_ISSUES = 200

const ISSUE_DEPENDENCY_CHECK_INPUT = z.object({
  method: z.enum(['add', 'remove']).describe('Same as the method of issue_dependency_write'),
  owner: z.string().min(1).describe('Owner of the repository of the waiting Issue'),
  repo: z.string().min(1).describe('Name of the repository of the waiting Issue'),
  issue_number: z.number().int().min(1).describe('Number of the waiting Issue'),
  type: z.enum(['blocked_by', 'blocking']).describe('Same as the type of issue_dependency_write; pecot writes only blocked_by'),
  related_owner: z.string().min(1).optional().describe('Owner of the repository of the prerequisite Issue (defaults to owner)'),
  related_repo: z.string().min(1).optional().describe('Name of the repository of the prerequisite Issue (defaults to repo)'),
  related_issue_number: z.number().int().min(1).describe('Number of the prerequisite Issue'),
  wait: z.enum(['stack', 'merge']).optional().describe('With add only: stack (build on its branch; the default) or merge (wait until it is merged)'),
  reason: z.string().optional().describe('With add and wait merge only: why it waits for the merge, in one line'),
  project: PROJECT_INPUT,
  reads: z.object({
    issues: READ_ISSUES,
    blocked_by: READ_BLOCKED_BY.describe('Results of issue_dependency_read with method get_blocked_by: the waiting Issue, and for add, the prerequisite and the Issues it waits for, until the chain ends'),
    project_items: READ_PROJECT_ITEMS,
    project_fields: READ_PROJECT_FIELDS,
    pull_requests: READ_PULL_REQUESTS,
  }).optional().describe('Results of the official GitHub MCP reads the check needs'),
})

type CheckInput = z.output<typeof ISSUE_DEPENDENCY_CHECK_INPUT>

const ISSUE_DEPENDENCY_CHECK_OUTPUT = z.strictObject({
  ...CHECK_RESULT_SHAPE,
  expected_status: z.string().optional().describe('Column (pecot-status) the waiting Issue should be moved to after the change, by its option name on the board (omitted when it stays)'),
  body: z.string().optional().describe('Body of the waiting Issue with the line of the prerequisite added to or removed from the Waits for merge section; write it with issue_check (method update) and issue_write (method update). Omitted when the body stays'),
})

type CheckOutput = z.input<typeof ISSUE_DEPENDENCY_CHECK_OUTPUT>

function referenceOrProblem(owner: string, repository: string, number: number, field: string, problems: CheckProblem[]): IssueReference | undefined {
  const reference = referenceOf(`${owner}/${repository}`, number)
  if (reference === undefined) problems.push({ field, code: 'value', message: `${owner}/${repository} is not a repository name` })
  return reference
}

function usageProblems(input: Readonly<CheckInput>): readonly CheckProblem[] {
  const problems: CheckProblem[] = []
  if (input.type === 'blocking') {
    problems.push({ field: 'type', code: 'direction', message: 'pecot writes only blocked_by: give the waiting Issue as owner/repo/issue_number, the prerequisite as related_*, and type blocked_by', candidates: ['blocked_by'] })
  }
  const reason = input.reason?.trim()
  if (input.method === 'remove') {
    if (input.wait !== undefined) problems.push({ field: 'wait', code: 'unexpected', message: 'wait is only for add' })
    if (input.reason !== undefined) problems.push({ field: 'reason', code: 'unexpected', message: 'reason is only for add with wait merge' })
    return problems
  }
  if (input.wait === 'merge' && (reason === undefined || reason === '')) problems.push({ field: 'reason', code: 'required', message: 'wait merge needs reason: why it waits for the merge, in one line' })
  if (input.wait !== 'merge' && input.reason !== undefined) problems.push({ field: 'reason', code: 'unexpected', message: 'reason is only for wait merge; a stack prerequisite has no reason' })
  if (reason !== undefined && /[\r\n]/u.test(reason)) problems.push({ field: 'reason', code: 'value', message: 'reason must be a single line' })
  return problems
}

// reason の誤りは usageProblems が出す。本文の節を書けるかを見るため、使えない reason は仮の 1 行にする
function placeholderReason(reason: string | undefined): string {
  return reason === undefined || reason === '' || /[\r\n]/u.test(reason) ? 'x' : reason
}

// 前提の側から blocked by をたどり、待つ側へ戻れば輪。読んでいない Issue があれば、その読み取りを求める
function cycleProblem(target: IssueReference, related: IssueReference, reads: ReadonlyMap<string, IssueDependencyRead>): CheckProblem | undefined {
  const targetKey = issueReferenceKey(target)
  const parents = new Map<string, { readonly ref: IssueReference, readonly parent: string | undefined }>([[issueReferenceKey(related), { ref: related, parent: undefined }]])
  const queue: IssueReference[] = [related]
  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    const read = readBlockedByOf(node, reads)
    if ('problem' in read) return { ...read.problem, message: `${read.problem.message} (to check that the blocked-by forms no cycle)` }
    for (const { ref } of blockedByOf(read.read)) {
      const key = issueReferenceKey(ref)
      if (key === targetKey) {
        const chain: IssueReference[] = []
        for (let current = parents.get(issueReferenceKey(node)); current !== undefined; current = current.parent === undefined ? undefined : parents.get(current.parent)) chain.unshift(current.ref)
        const path = [target, ...chain, target].map(reference => displayReference(reference, target.repository))
        return { field: 'related_issue_number', code: 'cycle', message: `blocked-by would form a cycle: ${path.join(' -> ')}` }
      }
      if (parents.has(key)) continue
      if (parents.size >= MAX_CYCLE_ISSUES) return { field: 'related_issue_number', code: 'unverifiable', message: `more than ${String(MAX_CYCLE_ISSUES)} Issues in the blocked-by chain; the cycle could not be checked` }
      parents.set(key, { ref, parent: issueReferenceKey(node) })
      queue.push(ref)
    }
  }
  return undefined
}

interface After {
  readonly target: IssueReference
  readonly issue: ReadIssue
  readonly body: string
  readonly prerequisites: readonly { readonly ref: IssueReference, readonly state: 'open' | 'closed' | undefined }[]
  readonly hasPrerequisites: boolean
  readonly added: { readonly ref: IssueReference, readonly wait: Wait, readonly reason: string | undefined } | undefined
}

interface ExpectedColumn {
  readonly status?: string
  readonly problems: readonly CheckProblem[]
  readonly warnings: readonly string[]
}

// 付け外しの後の前提で判定し、待つ側の列の行き先を返す。前提の事実が足りなければ、読み取りを求める
function expectedColumn(after: Readonly<After>, reads: ParsedReads, developmentBranch: string | undefined): ExpectedColumn {
  const { board, cards } = reads
  const problems: CheckProblem[] = []
  if (cards === undefined) problems.push(unreadProblem('reads.project_items', 'read the cards with projects_list (method list_project_items) to decide the column of the waiting Issue'))
  if (board === undefined) problems.push(unreadProblem('reads.project_fields', 'read the board fields with projects_list (method list_project_fields) to decide the column of the waiting Issue'))
  if (board === undefined || cards === undefined) return { problems, warnings: [] }
  const section = readWaitsForMerge(after.body, after.target.repository)
  const lines = section.kind === 'ok' ? section.lines : []
  const prerequisites: Prerequisite[] = []
  for (const { ref, state } of after.prerequisites) {
    const facts = prerequisiteFacts(ref, state, reads, board)
    if (facts === undefined || (facts.state === 'closed' && !reads.issues.has(issueReferenceKey(ref)))) {
      problems.push(unreadProblem('reads.issues', `read ${issueText(ref)} with issue_read (method get): whether a closed prerequisite is done depends on its merged pull requests`))
      continue
    }
    const added = after.added !== undefined && issueReferenceKey(after.added.ref) === issueReferenceKey(ref) ? after.added : undefined
    const line = lines.find(candidate => issueReferenceKey(candidate.ref) === issueReferenceKey(ref))
    // 節が読めないときは、前提をすべて merge として扱う
    const listed: Wait = line !== undefined || section.kind === 'malformed' ? 'merge' : 'stack'
    prerequisites.push({ issue: facts, wait: added?.wait ?? listed, reason: added === undefined ? line?.reason : added.reason })
  }
  if (problems.length > 0) return { problems, warnings: [] }
  const target = issueFactsOf(after.issue, cards.get(issueReferenceKey(after.target)), columnNames(board), workKindOf(after.issue.title))
  const judged = judgeMove({ target, prerequisites, hasPrerequisites: after.hasPrerequisites, board, pullRequests: reads.pullRequests, developmentBranch })
  return describeMove(judged, board, displayReference(after.target, after.target.repository))
}

function describeMove(judged: ReturnType<typeof judgeMove>, board: BoardShape, name: string): ExpectedColumn {
  const { move } = judged
  const warnings: string[] = []
  if (judged.stackUndecided !== undefined) {
    warnings.push(`whether ${name} can stack on its prerequisites is not decided: ${stackUndecidedHint(judged.stackUndecided)}; keep its column, or move it by the pecot rules`)
    return { problems: [], warnings }
  }
  if (move === undefined) return { problems: [], warnings }
  for (const value of move.missing) warnings.push(`the ${value} option is not on the board, so ${name} stays where it is`)
  if (move.label !== undefined) warnings.push(`set Status of ${name} to ${move.label}`)
  if (move.conflict !== undefined) warnings.push(`${name} was started but its prerequisites are not done; it stays in ${move.conflict.column}`)
  const to = move.column?.to
  // eslint-disable-next-line security/detect-object-injection -- to は MovableColumn の列挙
  return { ...to !== undefined && { status: board.column(COLUMN_CONFIG_KEYS[to]) ?? to }, problems: [], warnings }
}

function changedBody(body: string, decision: BlockDecision | { readonly kind: 'remove', readonly body: string }): string | undefined {
  return 'body' in decision && decision.body !== body ? decision.body : undefined
}

interface Checked {
  readonly problems: readonly CheckProblem[]
  readonly warnings: readonly string[]
  readonly expectedStatus: string | undefined
  readonly body: string | undefined
}

function checkChange(output: Readonly<Output>, input: Readonly<CheckInput>, config: ProjectConfig | undefined, target: IssueReference, related: IssueReference): Checked {
  const problems: CheckProblem[] = []
  const warnings: string[] = []
  const reads = parseReads(output, input.reads, config)
  const dependencies = dependencyReads(output, input.reads?.blocked_by ?? [])
  problems.push(...dependencies.problems)
  const name = displayReference(target, target.repository)
  const relatedName = displayReference(related, target.repository)
  const issue = reads.issues.get(issueReferenceKey(target))
  if (issue === undefined) problems.push(unreadProblem('reads.issues', `read ${issueText(target)} with issue_read (method get): the check needs its body and title`))
  const own = readBlockedByOf(target, dependencies.reads)
  if ('problem' in own) problems.push(own.problem)
  if (issue === undefined || 'problem' in own) return { problems, warnings, expectedStatus: undefined, body: undefined }

  const current = blockedByOf(own.read)
  const linked = current.find(({ ref }) => issueReferenceKey(ref) === issueReferenceKey(related))
  let after: After
  let changed: string | undefined
  if (input.method === 'add') {
    const wait = input.wait ?? 'stack'
    const reason = input.reason?.trim()
    if (linked === undefined && current.length >= MAX_BLOCKED_BY) problems.push({ field: 'related_issue_number', code: 'limit', message: `${name} already has ${String(MAX_BLOCKED_BY)} blocked-by Issues` })
    if (linked === undefined) {
      const cycle = cycleProblem(target, related, dependencies.reads)
      if (cycle !== undefined) problems.push(cycle)
    }
    const decision = decideBlock({ body: issue.body, home: target.repository, by: related, wait, reason: wait === 'merge' ? placeholderReason(reason) : undefined, isLinked: linked !== undefined })
    if (decision.kind === 'malformed') problems.push({ field: 'body', code: 'waits-for-merge', message: `the Waits for merge section of ${name} is malformed: ${decision.reason}; fix the body with issue_check (method update) and issue_write first` })
    if (linked !== undefined) {
      const fix = decision.kind === 'update' ? '; to change the wait kind, change only the Waits for merge section of the body' : ''
      problems.push({ field: 'related_issue_number', code: 'already-linked', message: `${name} is already blocked by ${relatedName}: do not call issue_dependency_write${fix}` })
    }
    changed = changedBody(issue.body, decision)
    after = {
      target,
      issue,
      body: 'body' in decision ? decision.body : issue.body,
      prerequisites: [...current.filter(({ ref }) => issueReferenceKey(ref) !== issueReferenceKey(related)), { ref: related, state: linked?.state ?? reads.issues.get(issueReferenceKey(related))?.state }],
      hasPrerequisites: true,
      added: { ref: related, wait, reason },
    }
  }
  else {
    if (linked === undefined) problems.push({ field: 'related_issue_number', code: 'not-linked', message: `${name} is not blocked by ${relatedName}` })
    const decision = decideUnblock({ body: issue.body, home: target.repository, by: related, isLinked: linked !== undefined })
    if (decision.kind === 'remove' && decision.malformedReason !== undefined) warnings.push(`the Waits for merge section of ${name} is malformed: ${decision.malformedReason}; fix it by hand`)
    changed = changedBody(issue.body, decision)
    const remaining = current.filter(({ ref }) => issueReferenceKey(ref) !== issueReferenceKey(related))
    after = {
      target,
      issue,
      body: decision.kind === 'remove' ? decision.body : issue.body,
      prerequisites: remaining,
      // 人が別の理由で付けた札を、最後の前提を外しただけで戻さない
      hasPrerequisites: remaining.length > 0 || linked?.state === 'closed',
      added: undefined,
    }
  }
  const expected = expectedColumn(after, reads, developmentBranchOf(config, target.repository))
  return { problems: [...problems, ...expected.problems], warnings: [...warnings, ...expected.warnings], expectedStatus: expected.status, body: changed }
}

function runCheck(output: Readonly<Output<CheckOutput>>, input: Readonly<CheckInput>): void {
  const problems: CheckProblem[] = [...usageProblems(input)]
  const target = referenceOrProblem(input.owner, input.repo, input.issue_number, 'repo', problems)
  const related = referenceOrProblem(input.related_owner ?? input.owner, input.related_repo ?? input.repo, input.related_issue_number, 'related_repo', problems)
  let config: ProjectConfig | undefined
  if (target !== undefined) {
    const chosen = configFor(target.repository, input.project, CHECK_PATH)
    if (chosen.kind === 'problem') problems.push({ field: 'repo', code: 'not-in-project', message: chosen.message })
    else config = chosen.config
  }
  if (target !== undefined && related !== undefined && issueReferenceKey(target) === issueReferenceKey(related)) {
    const name = displayReference(target, target.repository)
    problems.push({ field: 'related_issue_number', code: 'cycle', message: `an Issue cannot wait for itself: ${name} -> ${name}` })
  }
  let checked: Checked | undefined
  if (target !== undefined && related !== undefined && issueReferenceKey(target) !== issueReferenceKey(related)) checked = checkChange(output, input, config, target, related)
  const warnings = checked?.warnings ?? []
  for (const warning of warnings) output.warning(warning)
  const all = [...problems, ...checked?.problems ?? []]
  output.result({
    problems: all,
    ...checked?.expectedStatus !== undefined && { expected_status: checked.expectedStatus },
    ...checked?.body !== undefined && { body: checked.body },
  })
  const lines = all.length === 0 ? ['ok'] : all.map(problem => `${problem.field}: ${problem.message}`)
  if (checked?.expectedStatus !== undefined) lines.push(`expected pecot-status: ${checked.expectedStatus}`)
  if (checked?.body !== undefined) lines.push(`the Waits for merge section of the body changes; write the body below with issue_check (method update) and issue_write\n\n${checked.body}`)
  output.data(lines.join('\n'))
}

const ISSUE_DEPENDENCY_CHECK = defineTool({
  name: 'issue_dependency_check',
  title: 'Check Issue dependency',
  description: 'Check the arguments for issue_dependency_write against the pecot rules before writing: the direction, wait kind and reason, a self reference or cycle, whether the blocked-by is already there, and the column the waiting Issue should move to after the change. Reads and writes nothing on GitHub; pass the results of the official reads in reads.',
  hasOwnRepo: true,
  ignoresGlobalRepo: true,
  openWorld: false,
  input: ISSUE_DEPENDENCY_CHECK_INPUT,
  output: ISSUE_DEPENDENCY_CHECK_OUTPUT,
  run: (input, io) => {
    runCheck(createOutput<CheckOutput>(false, io), input)
    return Promise.resolve(0)
  },
})

export const ISSUE_DEPENDENCY_CHECK_TOOLS: readonly ToolDefinition[] = [ISSUE_DEPENDENCY_CHECK]
