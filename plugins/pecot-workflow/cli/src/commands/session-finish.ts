/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- record は結果を積む入れ物。入力は zod の出力の型 */
// session_finish。マージ済みの PR の手元の後片付け。Issue を閉じて待つ Issue を動かすのは board-sync で、ここは判定の変化とスタックし直す先を返すだけ
import { z } from 'zod'

import { extractIssueNumberFromBranch } from '@pecot/workflow-core/domain/branch-name.js'
import { getDevelopBranch, homeRepositoryOf } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { InvalidValueError } from '@pecot/workflow-core/domain/errors.js'
import { parseRemoteUrl } from '@pecot/workflow-core/domain/git-url.js'
import { extractClosingIssueNumbers } from '@pecot/workflow-core/domain/pull-request.js'
import { assumePullRequestState, describeReadinessChange, displayReference, hasReadinessChanged, isStackedOn } from '@pecot/workflow-core/domain/readiness.js'
import type { IssuePullRequest } from '@pecot/workflow-core/domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '@pecot/workflow-core/domain/reference-parser.js'
import type { IssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { isSameRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { RESTACK_PATH } from '@pecot/workflow-core/domain/restack.js'
import { FLAG_PECOT_BASE, FLAG_PECOT_SESSION_TITLE } from '@pecot/workflow-core/domain/state.js'
import { GIT_TIMED_OUT, gitCurrentBranch, GitCommandError, gitRemoteUrl, NON_INTERACTIVE_GIT, primaryRemoteName, REMOTE_TIMEOUT_MILLISECONDS, runGit, runGitAsync } from '@pecot/workflow-core/infra/git.js'
import { isFileNotFound } from '@pecot/workflow-core/infra/os-error.js'
import { readSessionTitleNumber, removeFlag } from '../infra/state-store.js'
import { getCurrentWorktreeName, isWorktreeEnvironment } from '../infra/worktree.js'
import { commandHint, hinted, RUN } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput, settle } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition, CommandIo, GlobalInput } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { isPositive, parseReference, PR_REFERENCE_DESCRIPTION } from '@pecot/workflow-core/commands-shared/pr-reference.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { boardShapeOf, developmentBranchOf, parseReads, READ_BLOCKED_BY, READ_ISSUES, READ_PROJECT_FIELDS, READ_PROJECT_ITEMS, READ_PULL_REQUESTS } from './check-reads.js'
import type { ParsedReads } from './check-reads.js'
import { blockedByOf, LIST_PULL_REQUESTS, listedPullRequestsOf, parseOfficial, PULL_REQUEST_READ_GET, readPullRequestOf } from './official-reads.js'
import type { IssueDependencyRead } from './official-reads.js'
import { dependencyReads, judgeFromReads } from './readiness-reads.js'

const DELETED_BRANCH_DATA = z.strictObject({
  branch: z.string().describe('Name of the local branch deleted'),
  location: z.enum(['local']).describe('Always local: the remote branch is deleted on GitHub by the merge settings'),
})

const READINESS_CHANGE_DATA = z.strictObject({
  issue: z.string().describe('Issue waiting for a closed Issue (#N, or owner/repo#N in another repository)'),
  from: z.string().describe('Readiness before the merge (blocked, startable, or stackable on #N)'),
  to: z.string().describe('Readiness after the merge (blocked, startable, or stackable on #N)'),
})

const RESTACK_DATA = z.strictObject({
  issue: z.string().describe('Started Issue stacked on the merged branch (#N, or owner/repo#N in another repository)'),
  branch: z.string().optional().describe('Branch of that Issue, to restack in its working directory (omitted when unknown)'),
})

const SESSION_FINISH_OUTPUT = z.strictObject({
  deletedBranches: z.array(DELETED_BRANCH_DATA).describe('Local branches deleted'),
  readinessChanges: z.array(READINESS_CHANGE_DATA).describe('Issues waiting for the closed Issues whose readiness changed by the merge'),
  restack: z.array(RESTACK_DATA).describe('Upper stacked Issues to restack with pr_restack in their working directories'),
  currentBranch: z.string().optional().describe('Current branch after the local cleanup (omitted when the local cleanup was skipped)'),
})

type FinishData = z.input<typeof SESSION_FINISH_OUTPUT>

interface FinishRecord {
  readonly deletedBranches: FinishData['deletedBranches']
  readonly readinessChanges: FinishData['readinessChanges']
  readonly restack: FinishData['restack']
  currentBranch?: string
  // PR を確かめる前に止まったときは、空の項目を失敗の data に載せない
  hasStarted: boolean
}

interface FinishContext {
  readonly out: Output
  readonly record: FinishRecord
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 手元と PR の repository が同じなら主の remote 名。違えば警告を出して undefined
function sameRepositoryRemote(cwd: string, location: RepositoryReference, out: Readonly<Output>): string | undefined {
  const skipped = 'skipped local cleanup'
  const name = primaryRemoteName(cwd)
  const url = name === undefined ? undefined : gitRemoteUrl(cwd, name)
  if (name === undefined || url === undefined) {
    out.warning(`cannot read the remote URL; ${skipped}`)
    return undefined
  }
  let found
  try {
    found = parseRemoteUrl(url)
  }
  catch (error: unknown) {
    if (!(error instanceof InvalidValueError)) throw error
    out.warning(`cannot read the repository from the remote URL; ${skipped}`)
    return undefined
  }
  if (!isSameRepository(found, location)) {
    out.warning(`current repository (${found.owner}/${found.repository}) differs from the PR's (${location.owner}/${location.repository}); ${skipped}`)
    return undefined
  }
  return name
}

// worktree では worktree 名、そうでなければ develop ブランチ
function resolveCheckoutTarget(cwd: string, config: Readonly<ProjectConfig>, location: RepositoryReference, out: Readonly<Output>): string | undefined {
  try {
    if (isWorktreeEnvironment(cwd)) {
      const worktreeBranch = getCurrentWorktreeName(cwd)
      if (worktreeBranch === undefined) out.warning('cannot determine the branch to return to in this worktree; skipped local cleanup')
      return worktreeBranch
    }
    const developBranch = getDevelopBranch(config, location.owner, location.repository)
    if (developBranch !== undefined && developBranch !== '') return developBranch
    out.warning('develop_branch is not set; skipped local cleanup')
    return undefined
  }
  catch {
    out.warning('cannot determine the worktree; skipped local cleanup')
    return undefined
  }
}

// isRemote の git（pull）は、認証の入力を待たず、取り消しと時間切れで止める
async function didRunLocalStep(context: Readonly<FinishContext>, operation: Operation, cwd: string, arguments_: readonly string[], failure: string, isRemote = false): Promise<boolean> {
  const { out } = context
  try {
    if (isRemote) {
      const result = await runGitAsync(arguments_, { cwd, check: true, env: NON_INTERACTIVE_GIT, timeoutMilliseconds: REMOTE_TIMEOUT_MILLISECONDS, signal: out.signal })
      if (result.exitCode === GIT_TIMED_OUT) {
        out.warning(`${failure} failed: timed out after ${String(REMOTE_TIMEOUT_MILLISECONDS / 1000)} seconds`)
        return false
      }
    }
    else {
      runGit(arguments_, { cwd, check: true })
    }
  }
  catch (error: unknown) {
    if (!(error instanceof GitCommandError) && !isFileNotFound(error)) throw error
    out.warning(`${failure} failed: ${reasonOf(error)}`)
    return false
  }
  out.done(operation)
  return true
}

async function localCleanupAfterMerge(context: Readonly<FinishContext>, headBranch: string, config: Readonly<ProjectConfig>, location: RepositoryReference): Promise<void> {
  const { out } = context
  const cwd = process.cwd()
  const remote = sameRepositoryRemote(cwd, location, out)
  if (remote === undefined) return
  const currentBranch = gitCurrentBranch(cwd)
  const checkoutTarget = resolveCheckoutTarget(cwd, config, location, out)
  if (checkoutTarget === undefined) return
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  if (developBranch === undefined || developBranch === '') {
    out.warning('develop_branch is not set; skipped local cleanup')
    return
  }

  if (currentBranch === checkoutTarget) {
    settle(out, { verb: 'unchanged', target: `current branch ${checkoutTarget}` })
  }
  else if (!await didRunLocalStep(context, { verb: 'set', target: `current branch to ${checkoutTarget}` }, cwd, ['checkout', checkoutTarget], `checking out ${checkoutTarget}`)) {
    // checkout が失敗したら、pull と branch -D は別のブランチに当たるので止める
    if (currentBranch !== undefined) context.record.currentBranch = currentBranch
    return
  }
  context.record.currentBranch = checkoutTarget
  await didRunLocalStep(context, { verb: 'update', target: `${checkoutTarget} from ${remote}/${developBranch}` }, cwd, ['pull', remote, developBranch], `pulling ${developBranch}`, true)
  if (headBranch === checkoutTarget) {
    settle(out, { verb: 'skip', target: `deleting local branch ${headBranch} (it is the checkout target)` })
  }
  else if (await didRunLocalStep(context, { verb: 'delete', target: `local branch ${headBranch}` }, cwd, ['branch', '-D', headBranch], `deleting local branch ${headBranch}`)) {
    context.record.deletedBranches.push({ branch: headBranch, location: 'local' })
  }
}

// 消すのは終えた PR の Issue の記録だけ。後片付けの前に次の Issue を着手していれば、その記録を残す
function removeActiveFlags(out: Readonly<Output>, issueNumbers: ReadonlySet<number>): void {
  try {
    const titleNumber = readSessionTitleNumber()
    if (titleNumber !== undefined && !issueNumbers.has(titleNumber)) {
      settle(out, { verb: 'skip', target: `removing the work target records (they belong to #${String(titleNumber)})` })
      return
    }
    for (const flag of [FLAG_PECOT_BASE, FLAG_PECOT_SESSION_TITLE]) removeFlag(flag)
  }
  catch (error: unknown) {
    out.warning(`removing flag files failed: ${reasonOf(error)}`)
  }
}

const FinishInputSchema = z.strictObject({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  project: PROJECT_INPUT,
  reads: z.object({
    pull_request: z.unknown().describe('Result of pull_request_read with method get for the PR; it must be merged'),
    blocking: READ_BLOCKED_BY.describe('Results of issue_dependency_read with method get_blocking ({ issue, result }): each Issue the PR closes (the Closes keywords of the body and the number that ends the head branch)'),
    children: z.unknown().optional().describe('Result of list_pull_requests with base <head branch of the PR> and state open: the PRs stacked on the merged branch'),
    issues: READ_ISSUES.describe('Results of issue_read with method get: each open Issue in blocking and its prerequisites, to judge their readiness'),
    blocked_by: READ_BLOCKED_BY.describe('Results of issue_dependency_read with method get_blocked_by ({ issue, result }): each open Issue in blocking'),
    pull_requests: READ_PULL_REQUESTS,
    project_items: READ_PROJECT_ITEMS.describe('Results of projects_list with method list_project_items (every page): the cards of the waiting Issues and their prerequisites'),
    project_fields: READ_PROJECT_FIELDS,
  }).describe('Results of the official GitHub MCP reads'),
})

type FinishInput = Readonly<z.output<typeof FinishInputSchema> & GlobalInput>

interface MergedPullRequest {
  readonly pullRequest: IssuePullRequest
  readonly body: string
}

function requireMerged(out: Readonly<Output>, raw: unknown, reference: Readonly<RepositoryReference & { readonly number: number }>): MergedPullRequest {
  const where = 'reads.pull_request'
  const read = parseOfficial(out, 'pull_request_read', PULL_REQUEST_READ_GET, raw, where)
  const pullRequest = readPullRequestOf(out, read, where)
  const name = `${reference.owner}/${reference.repository}/${String(reference.number)}`
  if (pullRequest.number !== reference.number || !isSameRepository(pullRequest.repository, reference)) {
    return stopWith(out, `${where} is not the PR ${name}: pass the result of pull_request_read (method get) for it`, 'invalid-input', USAGE_EXIT_CODE)
  }
  if (pullRequest.state !== 'merged') stopWith(out, `PR #${String(reference.number)} is not merged yet (state: ${pullRequest.state}); merge it on GitHub first`, 'pr-state')
  return { pullRequest, body: read.body ?? '' }
}

// PR が閉じる Issue。本文の閉じる語と、head ブランチの末尾の番号
function closingReferences(merged: Readonly<MergedPullRequest>): readonly IssueReference[] {
  const { pullRequest } = merged
  const numbers = new Set(extractClosingIssueNumbers(merged.body, pullRequest.repository))
  const branchNumber = extractIssueNumberFromBranch(pullRequest.headRefName)
  if (isPositive(branchNumber)) numbers.add(branchNumber)
  return [...numbers].toSorted((a, b) => a - b).map(number => createIssueReference(pullRequest.repository, number))
}

interface WaitingQuery {
  readonly reads: ParsedReads
  readonly blockedBy: ReadonlyMap<string, IssueDependencyRead>
  readonly config: ProjectConfig
  readonly heads: readonly IssueReference[]
  readonly pullRequest: IssuePullRequest
  readonly home: RepositoryReference | undefined
}

// 閉じた Issue を待つ開いた Issue。get_blocking を読んでいない閉じた Issue は warning にする
function waitingIssues(out: Readonly<Output>, heads: readonly IssueReference[], blocking: ReadonlyMap<string, IssueDependencyRead>, home: RepositoryReference | undefined): ReadonlyMap<string, IssueReference> {
  const waiting = new Map<string, IssueReference>()
  for (const head of heads) {
    const read = blocking.get(issueReferenceKey(head))
    const name = displayReference(head, home)
    if (read === undefined) {
      out.warning(`the Issues waiting for ${name} are not judged: pass the result of issue_dependency_read (method get_blocking) for it in reads.blocking`)
      continue
    }
    if (read.pageInfo?.hasNextPage === true) out.warning(`the Issues blocked by ${name} have more pages: only the first page is judged`)
    for (const { ref, state } of blockedByOf(read)) {
      if (state === 'open') waiting.set(issueReferenceKey(ref), ref)
    }
  }
  return waiting
}

function recordWaiting(context: Readonly<FinishContext>, query: Readonly<WaitingQuery>, waiting: ReadonlyMap<string, IssueReference>): void {
  const { out, record } = context
  const { reads, blockedBy, config, heads, pullRequest, home } = query
  const board = reads.board ?? boardShapeOf([], config)
  for (const reference of waiting.values()) {
    const name = displayReference(reference, home)
    const developmentBranch = developmentBranchOf(config, reference.repository)
    const judge = (state: 'open' | 'merged'): ReturnType<typeof judgeFromReads> => judgeFromReads({ ref: reference, reads, blockedBy, board, developmentBranch, assume: prerequisites => assumePullRequestState(prerequisites, heads, pullRequest, state) })
    const before = judge('open')
    if (before.kind === 'unread') {
      out.warning(`the readiness of ${name} is not judged: ${before.problems.map(problem => problem.message).join('; ')}`)
      continue
    }
    const after = judge('merged')
    if (after.kind === 'unread') {
      out.warning(`the readiness of ${name} is not judged: ${after.problems.map(problem => problem.message).join('; ')}`)
      continue
    }
    const { readiness: from } = before.judged
    const { readiness: to } = after.judged
    if (from !== undefined && to !== undefined && hasReadinessChanged(from, to)) {
      record.readinessChanges.push({ issue: name, from: describeReadinessChange(from, reference.repository), to: describeReadinessChange(to, reference.repository) })
    }
    if (!isStackedOn(after.target, after.prerequisites, heads)) continue
    const branch = after.target.pullRequests.find(candidate => candidate.state === 'open' && candidate.headRefName !== '')?.headRefName
    record.restack.push({ issue: name, ...branch !== undefined && { branch } })
  }
}

// merged の head を base にした開いた子 PR。番号で終わる head ブランチから Issue を求める
function recordChildren(context: Readonly<FinishContext>, raw: unknown, merged: Readonly<IssuePullRequest>, home: RepositoryReference | undefined): void {
  const { out, record } = context
  if (raw === undefined) {
    out.warning(`the PRs stacked on ${merged.headRefName} are not checked: pass the result of list_pull_requests (base ${merged.headRefName}, state open) in reads.children`)
    return
  }
  const children = listedPullRequestsOf(parseOfficial(out, 'list_pull_requests', LIST_PULL_REQUESTS, raw, 'reads.children'))
    .filter(child => child.state === 'open' && child.baseRefName === merged.headRefName && isSameRepository(child.repository, merged.repository))
  for (const child of children) {
    const number = extractIssueNumberFromBranch(child.headRefName)
    if (!isPositive(number)) continue
    const name = displayReference(createIssueReference(child.repository, number), home)
    if (record.restack.every(target => target.issue !== name)) record.restack.push({ issue: name, branch: child.headRefName })
  }
}

function judgeAfterMerge(context: Readonly<FinishContext>, input: FinishInput, config: ProjectConfig, merged: Readonly<MergedPullRequest>, heads: readonly IssueReference[]): void {
  const { out, record } = context
  const home = homeRepositoryOf(config)
  const blocking = dependencyReads(out, input.reads.blocking ?? [], 'reads.blocking')
  const blockedBy = dependencyReads(out, input.reads.blocked_by ?? [])
  for (const problem of [...blocking.problems, ...blockedBy.problems]) out.warning(`${problem.field}: ${problem.message}`)
  const waiting = waitingIssues(out, heads, blocking.reads, home)
  if (waiting.size > 0) {
    const reads = parseReads(out, input.reads, config)
    recordWaiting(context, { reads, blockedBy: blockedBy.reads, config, heads, pullRequest: merged.pullRequest, home }, waiting)
  }
  recordChildren(context, input.reads.children, merged.pullRequest, home)
  if (record.readinessChanges.length > 0) out.data(['Readiness changed:', ...record.readinessChanges.map(change => `- ${change.issue} ${change.from} -> ${change.to}`)].join('\n'))
  for (const target of record.restack) {
    out.warning(hinted`${target.issue} is stacked on ${merged.pullRequest.headRefName}; ${RUN} ${commandHint(RESTACK_PATH)} in the working directory of ${target.branch ?? 'its branch'}`)
  }
}

async function finish(input: FinishInput, context: Readonly<FinishContext>): Promise<void> {
  const { out } = context
  const reference = parseReference(input.pr_ref, input.repo, out)
  const location: RepositoryReference = { owner: reference.owner, repository: reference.repository }
  const config = requireConfigFor(out, location, input.project, ['session', 'finish']).config
  const merged = requireMerged(out, input.reads.pull_request, reference)
  context.record.hasStarted = true
  const heads = closingReferences(merged)
  judgeAfterMerge(context, input, config, merged, heads)
  await localCleanupAfterMerge(context, merged.pullRequest.headRefName, config, location)
  removeActiveFlags(out, new Set(heads.map(head => head.number)))
}

async function runFinish(input: FinishInput, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput<FinishData>(false, io)
  const record: FinishRecord = { deletedBranches: [], readinessChanges: [], restack: [], hasStarted: false }
  try {
    await finish(input, { out, record })
  }
  finally {
    const { deletedBranches, readinessChanges, restack, currentBranch } = record
    if (record.hasStarted) out.result({ deletedBranches, readinessChanges, restack, ...currentBranch !== undefined && { currentBranch } })
  }
}

const sessionFinishCommand = defineTool({
  name: 'session_finish',
  title: 'Clean up after merge',
  writes: { destructive: true, idempotent: true },
  description: 'Clean up the local side after a merged PR: check out the develop branch (or the worktree branch), pull it, delete the local head branch and remove the work records. Also returns the readiness changes of the Issues waiting for the closed Issues and the stacked Issues to restack. It closes no Issue and moves no card; pecot-board-sync does it on the merge. Reads nothing on GitHub; pass the results of the official reads in reads.',
  input: FinishInputSchema,
  output: SESSION_FINISH_OUTPUT,
  run: async (input, io) => {
    await runFinish(input, io)
    return 0
  },
})

export const SESSION_FINISH_TOOLS: readonly ToolDefinition[] = [sessionFinishCommand]
