/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// session finish。GitHub 側の片付けは lib の session-finish-remote.ts（actions/ の session-finish と共有）、ここは手元の片付けを足す。

import { z } from 'zod'

import { describeApiError } from '@pecot/workflow-core/domain/api-error-detail.js'
import { getDevelopBranch } from '@pecot/workflow-core/domain/config.js'
import type { ProjectConfig } from '@pecot/workflow-core/domain/config.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { FLAG_PECOT_BASE, FLAG_PECOT_SESSION_TITLE } from '@pecot/workflow-core/domain/state.js'
import { GIT_TIMED_OUT, gitCurrentBranch, GitCommandError, NON_INTERACTIVE_GIT, REMOTE_TIMEOUT_MILLISECONDS, runGit, runGitAsync } from '@pecot/workflow-core/infra/git.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { GitHubAPIError, isMissingReferenceError } from '@pecot/workflow-core/infra/github/errors.js'
import { isFileNotFound } from '@pecot/workflow-core/infra/os-error.js'
import { readSessionTitleNumber, removeFlag } from '../infra/state-store.js'
import { getCurrentWorktreeName, isWorktreeEnvironment } from '../infra/worktree.js'
import { PROJECT_INPUT, requireConfigFor } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput, settle } from '@pecot/workflow-core/commands-shared/output.js'
import type { Operation, Output } from '@pecot/workflow-core/commands-shared/output.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition, CommandIo, GlobalInput } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { parseReference, PR_REFERENCE_DESCRIPTION } from '@pecot/workflow-core/commands-shared/pr-reference.js'
import { finishOnGithub, requireMergedPullRequest, SKIPPED_ISSUE_REASONS } from '@pecot/workflow-core/commands-shared/session-finish-remote.js'
import type { RemoteFinishRecord } from '@pecot/workflow-core/commands-shared/session-finish-remote.js'
import { primaryRemote, reasonOf } from './pr.js'

const SKIPPED_ISSUE_DATA = z.strictObject({
  number: z.int().describe('Issue number'),
  reason: z.enum(SKIPPED_ISSUE_REASONS).describe('Why it was not closed: epic (protected), already-closed (including Issues GitHub closed on merge), not-found, or failed (see warnings)'),
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
  closedIssues: z.array(z.int()).describe('Issue numbers this command closed; usually empty for a PR to the default branch, since GitHub closes them on merge'),
  skippedIssues: z.array(SKIPPED_ISSUE_DATA).describe('Closing Issues of the PR that this command did not close'),
  deletedBranches: z.array(DELETED_BRANCH_DATA).describe('Branches deleted'),
  readinessChanges: z.array(READINESS_CHANGE_DATA).describe('Issues waiting for the closed Issues whose readiness changed by the merge'),
  restack: z.array(RESTACK_DATA).describe('Upper stacked Issues to restack with pr_restack in their working directories'),
  currentBranch: z.string().optional().describe('Current branch after the local cleanup (omitted when the local cleanup was skipped)'),
})

type FinishData = z.input<typeof SESSION_FINISH_OUTPUT>

// 各段の結果を集め、最後に 1 回だけ result に渡す
interface FinishRecord extends RemoteFinishRecord {
  readonly deletedBranches: FinishData['deletedBranches']
  currentBranch?: string
  // PR を確かめる前に止まったときは、空の項目を失敗の data に載せない
  hasStarted: boolean
}

interface FinishContext {
  readonly out: Output
  readonly isDryRun: boolean
  readonly record: FinishRecord
}

// head ブランチを消す。無ければ unchanged、ほかの失敗は warning にして続ける
async function deleteMergedBranch(context: Readonly<FinishContext>, client: GitHubClient, location: RepositoryReference, headBranch: string): Promise<void> {
  const { out, record } = context
  const operation: Operation = { verb: 'delete', target: `remote branch ${headBranch}` }
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
  delete_branch: z.boolean().default(false).describe('Delete the branch'),
  project: PROJECT_INPUT,
})

async function runFinish(input: Readonly<z.output<typeof FinishInputSchema> & GlobalInput>, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput<FinishData>(false, io)
  const record: FinishRecord = { closedIssues: [], skippedIssues: [], deletedBranches: [], readinessChanges: [], restack: [], hasStarted: false }
  try {
    await finish(input, { out, isDryRun: false, record })
  }
  finally {
    const { closedIssues, skippedIssues, deletedBranches, readinessChanges, restack, currentBranch } = record
    if (record.hasStarted) out.result({ closedIssues, skippedIssues, deletedBranches, readinessChanges, restack, ...currentBranch !== undefined && { currentBranch } })
  }
}

async function finish(input: Readonly<z.output<typeof FinishInputSchema> & GlobalInput>, context: Readonly<FinishContext>): Promise<void> {
  const { out } = context
  const reference = parseReference(input.pr_ref, input.repo, out)
  const location: RepositoryReference = { owner: reference.owner, repository: reference.repository }
  const config = requireConfigFor(out, location, input.project, ['session', 'finish']).config

  const merged = await requireMergedPullRequest(out, config, reference)
  context.record.hasStarted = true
  const closingNumbers = await finishOnGithub(context, config, merged)
  if (input.delete_branch) await deleteMergedBranch(context, merged.client, location, merged.pr.head_ref)
  await localCleanupAfterMerge(context, merged.pr.head_ref, config, location)

  removeActiveFlags(out, closingNumbers)
}

const sessionFinishCommand = defineTool({
  name: 'session_finish',
  title: 'Clean up after merge',
  description: 'Clean up after a merged PR (close related Issues, delete branches, local cleanup)',
  input: FinishInputSchema,
  output: SESSION_FINISH_OUTPUT,
  run: async (input, io) => {
    await runFinish(input, io)
    return 0
  },
})

export const SESSION_FINISH_TOOLS: readonly ToolDefinition[] = [sessionFinishCommand]
