/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// session finish。cli/commands/pr.py の pr_cleanup の移植。

import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { getDevelopBranch } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { isEpicIssue } from '../domain/issue-kind.js'
import { extractClosingIssueNumbers } from '../domain/pull-request.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { FLAG_MERGE_SLASH_PENDING, FLAG_PECOT_ACTIVE, FLAG_PECOT_BASE, FLAG_PECOT_QUICK_MODE, FLAG_PECOT_SESSION_TITLE, FLAG_WIP_BRANCH_LINKED } from '../domain/state.js'
import { gitCurrentBranch, GitCommandError, runGit } from '../infra/git.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError, isClosedByAnotherRequest, isMissingReferenceError } from '../infra/github/errors.js'
import type { PullRequestSlim } from '../infra/github/pulls.js'
import { isFileNotFound } from '../infra/os-error.js'
import { consumeFlag, removeFlag } from '../infra/state-store.js'
import { getCurrentWorktreeName, isWorktreeEnvironment } from '../infra/worktree.js'
import { requireActiveConfigPlain, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { createOutput } from './output.js'
import type { Operation, Output } from './output.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo, GlobalInput } from './command-definition.js'
import { settle } from './tracker-sync.js'
import { isPositive, parseReference, PR_REFERENCE_DESCRIPTION, primaryRemote, reasonOf } from './pr.js'

interface FinishContext {
  readonly out: Output
  readonly isDryRun: boolean
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
  const { out, isDryRun } = context
  const protectedOrdered = [...epicProtected].toSorted((a, b) => a - b)
  const closingOrdered = [...closing].toSorted((a, b) => a - b)
  for (const number of protectedOrdered) settle(out, { verb: 'skip', target: `closing Issue #${String(number)} (Epic)` })
  for (const number of closingOrdered) {
    const operation: Operation = { verb: 'close', target: `Issue #${String(number)}` }
    out.planned(operation)
    if (isDryRun) continue
    try {
      await client.closeIssue(location.owner, location.repository, number)
      out.done(operation)
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) {
        out.warning(`Issue #${String(number)} not found; skipped`)
      }
      else if (error instanceof GitHubAPIError) {
        if (isClosedByAnotherRequest(error)) out.done({ verb: 'unchanged', target: `Issue #${String(number)} (already closed)` })
        else out.warning(`closing Issue #${String(number)} failed: ${describeApiError(error)}`)
      }
      else {
        throw error
      }
    }
  }
}

// head ブランチを消し、続けて wip ブランチを消す。head が無くても wip は試す
async function deleteMergedBranch(context: Readonly<FinishContext>, client: GitHubClient, location: RepositoryReference, headBranch: string): Promise<void> {
  const { out, isDryRun } = context
  const operation: Operation = { verb: 'delete', target: `remote branch ${headBranch}` }
  out.planned(operation)
  if (isDryRun) return
  try {
    await client.deleteBranch(location.owner, location.repository, headBranch)
    out.done(operation)
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
    return
  }
  didRunLocalStep(context, { verb: 'update', target: `${checkoutTarget} from ${remote}/${developBranch}` }, cwd, ['pull', remote, developBranch], `pulling ${developBranch}`)
  if (headBranch === checkoutTarget) {
    settle(out, { verb: 'skip', target: `deleting local branch ${headBranch} (it is the checkout target)` })
  }
  else {
    didRunLocalStep(context, { verb: 'delete', target: `local branch ${headBranch}` }, cwd, ['branch', '-D', headBranch], `deleting local branch ${headBranch}`)
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
  const out = createOutput(input.dry_run, io)
  const context: FinishContext = { out, isDryRun: input.dry_run }
  const config = requireActiveConfigPlain(out)
  const reference = parseReference(input.pr_ref, input.repo, out)
  const location: RepositoryReference = { owner: reference.owner, repository: reference.repository }

  const { client, pr } = await fetchPullRequestForCleanup(config, reference, out)
  if (pr.state !== 'MERGED') stopWith(out, `PR #${String(reference.number)} is not merged yet (state: ${pr.state}); merge it with gh pr merge first`, 'pr-state')

  const closing = collectClosingIssueNumbers(pr)
  const epicProtected = await findEpicProtectedNumbers(client, location, closing, out)
  for (const number of epicProtected) closing.delete(number)

  out.count('Issues to close', closing.size)
  await closeRelatedIssues(context, client, location, closing, epicProtected)
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
  positional: ['pr_ref'],
  shortFlags: { dry_run: '-n', delete_branch: '-d' },
  interactive: false,
  run: async (input, io) => {
    await runFinish(input, io)
    return 0
  },
})

export const SESSION_FINISH_COMMANDS: readonly CommandDefinition[] = [sessionFinishCommand]
