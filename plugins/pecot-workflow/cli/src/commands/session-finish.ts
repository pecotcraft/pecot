/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// session finish。cli/commands/pr.py の pr_cleanup の移植。

import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { getDevelopBranch, homeRepositoryOf } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { isEpicIssue } from '../domain/issue-kind.js'
import { extractClosingIssueNumbers } from '../domain/pull-request.js'
import { assumePullRequestState, describeReadinessChange, displayReference, hasReadinessChanged, isDone, isStackedOn } from '../domain/readiness.js'
import type { IssuePullRequest } from '../domain/readiness.js'
import { createIssueReference } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { RESTACK_PATH } from '../domain/restack.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { FLAG_MERGE_SLASH_PENDING, FLAG_PECOT_ACTIVE, FLAG_PECOT_BASE, FLAG_PECOT_QUICK_MODE, FLAG_PECOT_SESSION_TITLE, FLAG_WIP_BRANCH_LINKED } from '../domain/state.js'
import { gitCurrentBranch, GitCommandError, runGit } from '../infra/git.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError, isClosedByAnotherRequest, isMissingReferenceError } from '../infra/github/errors.js'
import type { PullRequestSlim } from '../infra/github/pulls.js'
import { isFileNotFound } from '../infra/os-error.js'
import { consumeFlag, removeFlag } from '../infra/state-store.js'
import { getCurrentWorktreeName, isWorktreeEnvironment } from '../infra/worktree.js'
import type { BoardContext } from './board-judgment.js'
import { commandHint, hinted } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { requireActiveConfigPlain, stopWith } from './command-stop.js'
import { createReadinessCache, judgeAssuming } from './issue-readiness.js'
import type { JudgedIssue, ReadinessCache } from './issue-readiness.js'
import { moveIssuesWaitingFor, prerequisiteOf } from './pr-waiting.js'
import type { WaitingCheck } from './pr-waiting.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Operation, Output } from './output.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo, GlobalInput } from './command-definition.js'
import { settle } from './tracker-sync.js'
import { isPositive, parseReference, PR_REFERENCE_DESCRIPTION, primaryRemote, reasonOf } from './pr.js'

const SKIPPED_ISSUE_DATA = z.strictObject({
  number: z.int().describe('Issue number'),
  reason: z.enum(['epic', 'already-closed', 'not-found', 'failed']).describe('Why it was not closed: epic (protected), already-closed, not-found, or failed (see warnings)'),
})

const DELETED_BRANCH_DATA = z.strictObject({
  branch: z.string().describe('Name of the branch'),
  location: z.enum(['remote', 'local']).describe('Whether the remote or the local branch was deleted'),
})

const READINESS_CHANGE_DATA = z.strictObject({
  issue: z.string().describe('Issue waiting for a closed Issue (#N, or owner/repo#N in another repository)'),
  from: z.string().describe('Readiness before the merge (blocked, startable, or stackable on #N)'),
  to: z.string().describe('Readiness after the merge (blocked, startable, or stackable on #N)'),
})

const RESTACK_DATA = z.strictObject({
  issue: z.string().describe('Started Issue stacked on a closed Issue (#N, or owner/repo#N in another repository)'),
  branch: z.string().optional().describe('Branch linked to that Issue, to restack in its working directory (omitted when none)'),
})

const SESSION_FINISH_OUTPUT = z.strictObject({
  closedIssues: z.array(z.int()).describe('Issue numbers closed (to be closed on dry_run)'),
  skippedIssues: z.array(SKIPPED_ISSUE_DATA).describe('Closing Issues of the PR that this command did not close'),
  deletedBranches: z.array(DELETED_BRANCH_DATA).describe('Branches deleted (to be deleted on dry_run)'),
  readinessChanges: z.array(READINESS_CHANGE_DATA).describe('Issues waiting for the closed Issues whose readiness changed by the merge'),
  restack: z.array(RESTACK_DATA).describe('Upper stacked Issues to restack with pr restack in their working directories'),
  currentBranch: z.string().optional().describe('Current branch after the local cleanup (omitted when the local cleanup was skipped)'),
  dryRun: DRY_RUN_FIELD,
})

type FinishData = z.input<typeof SESSION_FINISH_OUTPUT>

// 各段の結果を集め、最後に 1 回だけ result に渡す
interface FinishRecord {
  readonly closedIssues: number[]
  readonly skippedIssues: FinishData['skippedIssues']
  readonly deletedBranches: FinishData['deletedBranches']
  readonly readinessChanges: FinishData['readinessChanges']
  readonly restack: FinishData['restack']
  currentBranch?: string
  // PR を確かめる前に止まったときは、空の項目を失敗の data に載せない
  hasStarted: boolean
}

interface FinishContext {
  readonly out: Output
  readonly isDryRun: boolean
  readonly record: FinishRecord
}

async function fetchPullRequestForCleanup(config: Readonly<ProjectConfig>, location: Readonly<RepositoryReference & { readonly number: number }>, out: Readonly<Output>): Promise<{ readonly client: GitHubClient, readonly pr: PullRequestSlim }> {
  try {
    const client = createGitHubClient(out, config.host)
    return { client, pr: await client.getPullRequestSlim(location.owner, location.repository, location.number) }
  }
  catch (error: unknown) {
    if (error instanceof GitHubNotFoundError) return stopWith(out, `PR not found: ${location.owner}/${location.repository}/${String(location.number)}`, 'github-not-found')
    if (error instanceof GitHubAPIError) return stopWith(out, error.message, kindOfFailure(error))
    throw error
  }
}

function collectClosingIssueNumbers(pr: Readonly<{ readonly closing_issues: readonly { readonly number: number }[], readonly body: string, readonly head_ref: string }>): Set<number> {
  const numbers = new Set<number>(pr.closing_issues.map(issue => issue.number))
  for (const number of extractClosingIssueNumbers(pr.body)) numbers.add(number)
  const branchNumber = extractIssueNumberFromBranch(pr.head_ref)
  if (isPositive(branchNumber)) numbers.add(branchNumber)
  return numbers
}

// Epic 保護。Issue Type が Epic か、sub-issue を持つ Issue
async function findEpicProtectedNumbers(client: GitHubClient, location: RepositoryReference, issueNumbers: ReadonlySet<number>, out: Readonly<Output>): Promise<Set<number>> {
  const protectedNumbers = new Set<number>()
  const ordered = [...issueNumbers].toSorted((a, b) => a - b)
  for (const number of ordered) {
    try {
      if (isEpicIssue(await client.getIssueKind(location.owner, location.repository, number))) protectedNumbers.add(number)
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) continue
      if (!(error instanceof GitHubAPIError)) throw error
      out.warning(`kind check of Issue #${String(number)} failed: ${error.message}; not protected`)
    }
  }
  return protectedNumbers
}

async function closeRelatedIssues(context: Readonly<FinishContext>, client: GitHubClient, location: RepositoryReference, closing: ReadonlySet<number>, epicProtected: ReadonlySet<number>): Promise<void> {
  const { out, isDryRun, record } = context
  const protectedOrdered = [...epicProtected].toSorted((a, b) => a - b)
  const closingOrdered = [...closing].toSorted((a, b) => a - b)
  for (const number of protectedOrdered) {
    settle(out, { verb: 'skip', target: `closing Issue #${String(number)} (Epic)` })
    record.skippedIssues.push({ number, reason: 'epic' })
  }
  for (const number of closingOrdered) {
    const operation: Operation = { verb: 'close', target: `Issue #${String(number)}` }
    out.planned(operation)
    if (isDryRun) {
      record.closedIssues.push(number)
      continue
    }
    try {
      await client.closeIssue(location.owner, location.repository, number)
      out.done(operation)
      record.closedIssues.push(number)
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) {
        out.warning(`Issue #${String(number)} not found; skipped`)
        record.skippedIssues.push({ number, reason: 'not-found' })
      }
      else if (error instanceof GitHubAPIError) {
        const isClosed = isClosedByAnotherRequest(error)
        if (isClosed) out.done({ verb: 'unchanged', target: `Issue #${String(number)} (already closed)` })
        else out.warning(`closing Issue #${String(number)} failed: ${describeApiError(error)}`)
        record.skippedIssues.push({ number, reason: isClosed ? 'already-closed' : 'failed' })
      }
      else {
        throw error
      }
    }
  }
}

interface WaitingSource {
  readonly client: GitHubClient
  readonly config: ProjectConfig
  readonly location: RepositoryReference
  readonly pullRequest: IssuePullRequest
}

function mergedPullRequestOf(location: RepositoryReference, number: number, pr: Readonly<PullRequestSlim>): IssuePullRequest {
  return { repository: location, number, state: 'merged', headRefName: pr.head_ref, baseRefName: pr.base_ref, isDraft: pr.is_draft, isCrossRepository: false }
}

// 閉じた Issue のうち、判定に出ている前提がすべて済んでいるか
function isClosedReflected(judged: JudgedIssue, heads: readonly IssueReference[]): boolean {
  const found = heads.flatMap(head => prerequisiteOf(judged, head) ?? [])
  return found.length > 0 && found.every(({ issue }) => isDone(issue))
}

function waitingCheck(source: Readonly<WaitingSource>, heads: readonly IssueReference[], isDryRun: boolean, cache: ReadinessCache, home: RepositoryReference | undefined): WaitingCheck {
  const { client, config, pullRequest } = source
  const names = heads.map(head => displayReference(head, home)).join(', ')
  const unconfirmed = (name: string): HintedText => hinted`could not confirm that GitHub reflects the close of ${names} in the readiness of ${name}; its column was not moved; run ${commandHint(['board', 'sync'])} later to move it`
  if (!isDryRun) return { isReflected: judged => isClosedReflected(judged, heads), unconfirmed }
  // dry-run では Issue を閉じていないので、閉じた後を置き換えで作る
  return {
    isReflected: () => true,
    unconfirmed,
    assume: async ({ target, result }) => (result.kind === 'judged'
      ? { target, result: await judgeAssuming(client, config, result, prerequisites => assumePullRequestState(prerequisites, heads, pullRequest, 'merged'), cache) }
      : { target, result }),
  }
}

// 閉じた Issue を待つ Issue の列と札を動かし、マージの前と比べた判定の変化と、載せ直す上の段を記録する
async function updateWaitingIssues(context: Readonly<FinishContext>, source: Readonly<WaitingSource>): Promise<void> {
  const { out, isDryRun, record } = context
  const { client, config, location, pullRequest } = source
  const alreadyClosed = record.skippedIssues.filter(({ reason }) => reason === 'already-closed').map(({ number }) => number)
  const heads = [...record.closedIssues, ...alreadyClosed].toSorted((a, b) => a - b).map(number => createIssueReference(location, number))
  if (heads.length === 0) return
  const home = homeRepositoryOf(config)
  const cache = createReadinessCache()
  const board: BoardContext = { out, client, config, home }
  const judged = await moveIssuesWaitingFor(board, { heads, check: waitingCheck(source, heads, isDryRun, cache, home), isDryRun, cache })

  for (const { target, result } of judged) {
    if (result.kind !== 'judged' || result.readiness === undefined) continue
    const before = await judgeAssuming(client, config, result, prerequisites => assumePullRequestState(prerequisites, heads, pullRequest, 'open'), cache)
    if (before.kind !== 'judged' || before.readiness === undefined || !hasReadinessChanged(before.readiness, result.readiness)) continue
    const { repository } = target.ref
    record.readinessChanges.push({ issue: displayReference(target.ref, home), from: describeReadinessChange(before.readiness, repository), to: describeReadinessChange(result.readiness, repository) })
  }
  if (record.readinessChanges.length > 0) out.data(['Readiness changed:', ...record.readinessChanges.map(change => `- ${change.issue} ${change.from} -> ${change.to}`)].join('\n'))

  for (const { target, result } of judged) {
    if (result.kind !== 'judged' || !isStackedOn(result.target, result.prerequisites, heads)) continue
    const name = displayReference(target.ref, home)
    const lower = heads.filter(head => prerequisiteOf(result, head)?.wait === 'stack').map(head => displayReference(head, home)).join(', ')
    const [branch] = result.target.branches
    record.restack.push({ issue: name, ...branch !== undefined && { branch } })
    out.warning(hinted`${name} is stacked on ${lower}; run ${commandHint(RESTACK_PATH)} in the working directory of ${branch ?? 'its branch'}`)
  }
}

// head ブランチを消し、続けて wip ブランチを消す。head が無くても wip は試す
async function deleteMergedBranch(context: Readonly<FinishContext>, client: GitHubClient, location: RepositoryReference, headBranch: string): Promise<void> {
  const { out, isDryRun, record } = context
  const operation: Operation = { verb: 'delete', target: `remote branch ${headBranch}` }
  out.planned(operation)
  if (isDryRun) {
    record.deletedBranches.push({ branch: headBranch, location: 'remote' })
    return
  }
  try {
    await client.deleteBranch(location.owner, location.repository, headBranch)
    out.done(operation)
    record.deletedBranches.push({ branch: headBranch, location: 'remote' })
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    if (!isMissingReferenceError(error)) {
      out.warning(`deleting remote branch ${headBranch} failed: ${describeApiError(error)}`)
      return
    }
    out.done({ verb: 'unchanged', target: `remote branch ${headBranch} (already deleted)` })
  }
  const wipBranch = `wip/${headBranch}`
  try {
    await client.deleteBranch(location.owner, location.repository, wipBranch)
    out.done({ verb: 'delete', target: `remote branch ${wipBranch}` })
    record.deletedBranches.push({ branch: wipBranch, location: 'remote' })
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    if (!isMissingReferenceError(error)) out.warning(`deleting remote branch ${wipBranch} failed: ${describeApiError(error)}`)
  }
}

// 手元と PR の repository が同じなら主の remote 名。違えば警告を出して undefined
function sameRepositoryRemote(cwd: string, location: RepositoryReference, out: Readonly<Output>): string | undefined {
  const skipped = 'skipped local cleanup'
  try {
    const found = primaryRemote(cwd)
    if (found === undefined) {
      out.warning(`cannot read the remote URL; ${skipped}`)
      return undefined
    }
    if (found.location === undefined) {
      out.warning(`cannot read the repository from the remote URL; ${skipped}`)
      return undefined
    }
    if (found.location.owner !== location.owner || found.location.repository !== location.repository) {
      out.warning(`current repository (${found.location.owner}/${found.location.repository}) differs from the PR's (${location.owner}/${location.repository}); ${skipped}`)
      return undefined
    }
    return found.name
  }
  catch {
    out.warning(`cannot determine the repository; ${skipped}`)
    return undefined
  }
}

// worktree では worktree 名、そうでなければ develop ブランチ
function resolveCheckoutTarget(cwd: string, config: Readonly<ProjectConfig>, location: RepositoryReference, out: Readonly<Output>): string | undefined {
  try {
    if (isWorktreeEnvironment(cwd)) return getCurrentWorktreeName(cwd) ?? 'main'
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

function didRunLocalStep(context: Readonly<FinishContext>, operation: Operation, cwd: string, arguments_: readonly string[], failure: string): boolean {
  const { out, isDryRun } = context
  out.planned(operation)
  if (isDryRun) return true
  try {
    runGit(arguments_, { cwd, check: true })
  }
  catch (error: unknown) {
    if (!(error instanceof GitCommandError) && !isFileNotFound(error)) throw error
    out.warning(`${failure} failed: ${reasonOf(error)}`)
    return false
  }
  out.done(operation)
  return true
}

function localCleanupAfterMerge(context: Readonly<FinishContext>, headBranch: string, config: Readonly<ProjectConfig>, location: RepositoryReference): void {
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
  else if (!didRunLocalStep(context, { verb: 'set', target: `current branch to ${checkoutTarget}` }, cwd, ['checkout', checkoutTarget], `checking out ${checkoutTarget}`)) {
    // checkout が失敗したら、pull と branch -D は別のブランチに当たるので止める
    if (currentBranch !== undefined) context.record.currentBranch = currentBranch
    return
  }
  context.record.currentBranch = checkoutTarget
  didRunLocalStep(context, { verb: 'update', target: `${checkoutTarget} from ${remote}/${developBranch}` }, cwd, ['pull', remote, developBranch], `pulling ${developBranch}`)
  if (headBranch === checkoutTarget) {
    settle(out, { verb: 'skip', target: `deleting local branch ${headBranch} (it is the checkout target)` })
  }
  else if (didRunLocalStep(context, { verb: 'delete', target: `local branch ${headBranch}` }, cwd, ['branch', '-D', headBranch], `deleting local branch ${headBranch}`)) {
    context.record.deletedBranches.push({ branch: headBranch, location: 'local' })
  }
}

function removeActiveFlags(out: Readonly<Output>): void {
  try {
    for (const flag of [FLAG_PECOT_ACTIVE, FLAG_PECOT_BASE, FLAG_PECOT_SESSION_TITLE, FLAG_PECOT_QUICK_MODE, FLAG_WIP_BRANCH_LINKED]) removeFlag(flag)
  }
  catch (error: unknown) {
    out.warning(`removing flag files failed: ${reasonOf(error)}`)
  }
}

const FinishInputSchema = z.strictObject({
  pr_ref: z.string().describe(PR_REFERENCE_DESCRIPTION),
  dry_run: z.boolean().default(false).describe('Dry-run (do not actually clean up)'),
  delete_branch: z.boolean().default(false).describe('Delete the branch'),
  skip_local_cleanup: z.boolean().default(false).describe('Skip the local branch switch and deletion'),
})

async function runFinish(input: Readonly<z.output<typeof FinishInputSchema> & GlobalInput>, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput<FinishData>(input.dry_run, io)
  const record: FinishRecord = { closedIssues: [], skippedIssues: [], deletedBranches: [], readinessChanges: [], restack: [], hasStarted: false }
  try {
    await finish(input, { out, isDryRun: input.dry_run, record })
  }
  finally {
    const { closedIssues, skippedIssues, deletedBranches, readinessChanges, restack, currentBranch } = record
    if (record.hasStarted) out.result({ closedIssues, skippedIssues, deletedBranches, readinessChanges, restack, ...currentBranch !== undefined && { currentBranch } })
  }
}

async function finish(input: Readonly<z.output<typeof FinishInputSchema> & GlobalInput>, context: Readonly<FinishContext>): Promise<void> {
  const { out } = context
  const config = requireActiveConfigPlain(out)
  const reference = parseReference(input.pr_ref, input.repo, out)
  const location: RepositoryReference = { owner: reference.owner, repository: reference.repository }

  const { client, pr } = await fetchPullRequestForCleanup(config, reference, out)
  if (pr.state !== 'MERGED') stopWith(out, hinted`PR #${String(reference.number)} is not merged yet (state: ${pr.state}); merge it with ${commandHint(['pr', 'merge'])} first`, 'pr-state')
  context.record.hasStarted = true

  const closing = collectClosingIssueNumbers(pr)
  const epicProtected = await findEpicProtectedNumbers(client, location, closing, out)
  for (const number of epicProtected) closing.delete(number)

  out.count('Issues to close', closing.size)
  await closeRelatedIssues(context, client, location, closing, epicProtected)
  await updateWaitingIssues(context, { client, config, location, pullRequest: mergedPullRequestOf(location, reference.number, pr) })
  if (input.delete_branch) await deleteMergedBranch(context, client, location, pr.head_ref)
  if (input.skip_local_cleanup) return
  localCleanupAfterMerge(context, pr.head_ref, config, location)
  if (input.dry_run) {
    return
  }

  removeActiveFlags(out)
  consumeFlag(FLAG_MERGE_SLASH_PENDING)
}

const sessionFinishCommand = defineCommand({
  path: ['session', 'finish'],
  description: 'Clean up after a merged PR (close related Issues, delete branches, local cleanup)',
  input: FinishInputSchema,
  output: SESSION_FINISH_OUTPUT,
  positional: ['pr_ref'],
  shortFlags: { dry_run: '-n', delete_branch: '-d' },
  interactive: false,
  run: async (input, io) => {
    await runFinish(input, io)
    return 0
  },
})

export const SESSION_FINISH_COMMANDS: readonly CommandDefinition[] = [sessionFinishCommand]
