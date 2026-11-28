// pr restack。スタックしたブランチを、base にしたブランチの新しい位置へスタックし直す。
// 途中で抜ける箇所は CommandExit を投げ、defineTool が終了コードにする。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 入力は zod の出力の型で、readonly にできない */
import { z } from 'zod'

import { getDevelopBranch } from '@pecot/workflow-core/domain/config.js'
import { extractClosingIssueNumbers, FORCE_PUSH_COMMAND, pickLowerPullRequest } from '@pecot/workflow-core/domain/pull-request.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { describeGone, describeRestackCheck, RESTACK_PATH } from '@pecot/workflow-core/domain/restack.js'
import type { RestackDecision } from '@pecot/workflow-core/domain/restack.js'
import { FLAG_PECOT_RESTACK, formatRestackProgress, interpretRestackProgress } from '@pecot/workflow-core/domain/state.js'
import type { BaseReading, BaseRecord, RestackProgress } from '@pecot/workflow-core/domain/state.js'
import {
  abortRebase,
  conflictedFiles,
  continueRebase,
  fetchRemote,
  forkPoint,
  gitStdout,
  hasSameTree,
  isAncestor,
  isRebaseInProgress,
  mergeBase,
  PUSH_TIMEOUT_MILLISECONDS,
  pushWithLease,
  rebaseOnto,
  remoteOnlyChanges,
  resetHardTo,
  resolveCommit,
} from '@pecot/workflow-core/infra/git.js'
import type { PushResult } from '@pecot/workflow-core/infra/git.js'
import { findConfigFor } from '@pecot/workflow-core/infra/config-store.js'
import { readBaseRecord, readFlag, removeFlag, writeBaseRecord, writeFlag } from '../infra/state-store.js'
import { defineTool } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { ToolDefinition, CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { commandHint, hinted, RUN_COLON, runAgain } from '@pecot/workflow-core/commands-shared/command-hint.js'
import type { HintedText } from '@pecot/workflow-core/commands-shared/command-hint.js'
import { gitFailureText } from '@pecot/workflow-core/domain/git-output.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from '@pecot/workflow-core/commands-shared/command-stop.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { parseOfficial, PULL_REQUEST_READ_GET } from './official-reads.js'
import { LISTED_PULL_REQUESTS, pullRequestReadoutsOf } from './official-reads-pr.js'
import { primaryRemote, stopOnMalformedRecord, validatePullRequestContext } from './pr-preflight.js'
import { readRestackDecision } from './restack-reading.js'
import { USAGE_EXIT_CODE } from '@pecot/workflow-core/commands-shared/usage-error.js'

const CONFLICT_EXIT_CODE = 3
const UNCOMMITTED_EXIT_CODE = 2
const MILLISECONDS_PER_SECOND = 1000
// 文の中にロングオプションを書けない（lint）ので、git の引数から組む
const SKIP_COMMAND = ['git', 'rebase', '--skip'].join(' ')

const PR_RESTACK_OUTPUT = z.strictObject({
  branch: z.string().describe('Branch that is restacked'),
  base: z.string().describe('Base branch after the restack (the develop branch when the lower PR is merged)'),
  outcome: z.enum(['up-to-date', 'needs-restack', 'restacked', 'synced', 'conflict', 'aborted']).describe('What happened, or with check, what a restack would do'),
  cause: z.enum(['base-moved', 'base-merged']).optional().describe('Why a restack is needed (only with check, when one is needed)'),
  pullRequest: z.int().optional().describe('Merged PR of the lower branch (only when the cause is base-merged)'),
  pushed: z.boolean().optional().describe('Whether the branch was pushed (only when restacked)'),
  conflicts: z.array(z.string()).optional().describe('Files with conflicts (only on conflict)'),
  relink: z.strictObject({
    pullRequest: z.int().describe('Open PR of the branch whose body closes Issues'),
    reason: z.string().describe('What to write with update_pull_request, and why'),
  }).optional().describe('PR to save again with update_pull_request so that GitHub links its closing Issues (only after a restack onto the develop branch, with reads.pull_request)'),
})

type PrRestackData = z.input<typeof PR_RESTACK_OUTPUT>
type RestackOutput = Readonly<Output<PrRestackData>>

const RestackInputSchema = z.strictObject({
  check: z.boolean().default(false).describe('Only report whether a restack is needed'),
  continue: z.boolean().default(false).describe('Continue a restack that stopped on conflicts, after resolving them'),
  abort: z.boolean().default(false).describe('Abort a restack that stopped on conflicts and go back to the position before it'),
  project: PROJECT_INPUT,
  reads: z.object({
    pull_requests: z.unknown().optional().describe('For a stacked branch: the result of list_pull_requests (head owner:<base branch in .pecot-base>, state all) for the branch it is stacked on'),
    pull_request: z.unknown().optional().describe('The result of pull_request_read with method get for the open PR of the current branch; it decides relink'),
  }).optional().describe('Results of the official GitHub MCP reads the restack needs'),
})

type RestackInput = z.output<typeof RestackInputSchema>

function causeOf(decision: Readonly<RestackDecision>): Pick<PrRestackData, 'cause' | 'pullRequest'> {
  if (decision.kind === 'moved') return { cause: 'base-moved' }
  return decision.kind === 'merged' ? { cause: 'base-merged', pullRequest: decision.pullRequest } : {}
}

// 衝突したファイルと、続行・取りやめの案内を出して、終了コード 3 で止まる。途中の記録は残す
function stopOnConflict(out: RestackOutput, cwd: string, progress: Readonly<RestackProgress>): never {
  const conflicts = conflictedFiles(cwd)
  out.result({ branch: progress.branch, base: progress.ontoBranch, outcome: 'conflict', conflicts: [...conflicts] })
  // 衝突したファイルが無いのに止まるのは、解いた結果が空のコミットになったとき
  const message = conflicts.length === 0
    ? hinted`the rebase stopped without conflicted files (a commit may have become empty)\nskip the commit with: ${SKIP_COMMAND}, then ${RUN_COLON}${commandHint(RESTACK_PATH, { continue: true })}\nor go back to the position before the restack: ${commandHint(RESTACK_PATH, { abort: true })}`
    : hinted`conflict in ${conflicts.join(', ')}\nresolve the conflicts and git add the files, then ${RUN_COLON}${commandHint(RESTACK_PATH, { continue: true })}\nor go back to the position before the restack: ${commandHint(RESTACK_PATH, { abort: true })}`
  return stopWith(out, message, 'git-conflict', CONFLICT_EXIT_CODE)
}

// remote のブランチにだけあるコミット。patch-id は前後の行も含むので、スタックし直す前と後のどちらとも合わないものだけを数える
function remoteOnlyCommits(cwd: string, progress: Readonly<RestackProgress>, remoteBranch: string): readonly string[] {
  // 古い版の途中の記録は、記録の位置を持たないので .pecot-base から読む
  const reading = progress.recordSha === undefined ? readBaseRecord() : undefined
  const recordSha = progress.recordSha ?? (reading?.kind === 'stacked' ? reading.record.sha : undefined)
  const excluded = [progress.ontoSha, ...recordSha === undefined ? [] : [recordSha]]
  const before = remoteOnlyChanges(cwd, progress.originalSha, remoteBranch, excluded)
  if (before.length === 0) return []
  const after = new Set(remoteOnlyChanges(cwd, 'HEAD', remoteBranch, excluded))
  return before.filter(sha => after.has(sha))
}

// remote のブランチが新しい base の上にあり、木が手元と同じか。木が同じでも、remote が新しい base の上に無ければ古い履歴のままなので合わせない
function isSyncedWithRemote(cwd: string, progress: Readonly<RestackProgress>): boolean {
  const remoteBranch = `${progress.remote}/${progress.branch}`
  return progress.leaseSha !== undefined && mergeBase(cwd, progress.ontoSha, remoteBranch) === progress.ontoSha && hasSameTree(cwd, 'HEAD', remoteBranch)
}

// 時間切れは打ち直しても同じところで止まるので、手で push してから打つ道を示す
function describePushFailure(push: Readonly<Extract<PushResult, { pushed: false }>>, remote: string, branch: string): HintedText {
  const unchanged = `${branch} is restacked locally and the base record is unchanged`
  switch (push.reason) {
    case 'timed-out': {
      return hinted`push timed out after ${String(PUSH_TIMEOUT_MILLISECONDS / MILLISECONDS_PER_SECOND)} seconds\n${unchanged}\npush the branch yourself: ${FORCE_PUSH_COMMAND} ${remote} ${branch}\nthen ${RUN_COLON}${commandHint(RESTACK_PATH)}`
    }
    case 'rejected': {
      return hinted`push was rejected: ${push.stderr.trim()}\n${unchanged}\n${runAgain(commandHint(RESTACK_PATH))}`
    }
  }
}

// rebase が終わった後。remote がスタックし直し済みで木が同じなら合わせ、違えば push し、base の記録を書き直す
async function finishRestack(out: RestackOutput, cwd: string, progress: Readonly<RestackProgress>, signal: Readonly<AbortSignal> | undefined): Promise<void> {
  const { remote, branch, ontoBranch, leaseSha } = progress
  const remoteBranch = `${remote}/${branch}`
  if (leaseSha !== undefined && remoteOnlyCommits(cwd, progress, remoteBranch).length > 0) {
    resetHardTo(cwd, progress.originalSha)
    removeFlag(FLAG_PECOT_RESTACK)
    stopWith(out, hinted`${remoteBranch} has commits that are not in ${branch}\n${branch} is back at the position before the restack\nrebase or merge them into ${branch} first, then ${runAgain(commandHint(RESTACK_PATH))}`, 'git-unresolved')
  }
  const isSynced = isSyncedWithRemote(cwd, progress)
  if (isSynced) resetHardTo(cwd, remoteBranch)
  else if (leaseSha !== undefined) {
    let push: PushResult
    try {
      push = await pushWithLease(cwd, remote, branch, leaseSha, { signal })
    }
    catch (error: unknown) {
      // 取り消しでも、記録を書かずに途中の記録を消して止める
      removeFlag(FLAG_PECOT_RESTACK)
      throw error
    }
    if (!push.pushed) {
      removeFlag(FLAG_PECOT_RESTACK)
      stopWith(out, describePushFailure(push, remote, branch), 'git-unresolved')
    }
  }
  const record: BaseRecord = { branch: ontoBranch, sha: mergeBase(cwd, 'HEAD', `${remote}/${ontoBranch}`) ?? progress.ontoSha, stackedOn: progress.stackedOn }
  writeBaseRecord(record)
  removeFlag(FLAG_PECOT_RESTACK)
  out.result({ branch, base: ontoBranch, outcome: isSynced ? 'synced' : 'restacked', ...!isSynced && { pushed: leaseSha !== undefined } })
  out.done({ verb: 'update', target: isSynced ? `${branch} synced with ${remoteBranch}` : `${branch} restacked on ${ontoBranch}` })
}

interface RelinkTarget {
  readonly location: RepositoryReference
  readonly developBranch: string
}

// 開発ブランチへスタックし直した PR の本文を、保存し直すよう返す。GitHub は base の付け替えでは Closes を読み直さず、Issue とリンクしない
function reportRelink(out: RestackOutput, target: Readonly<RelinkTarget>, progress: Readonly<RestackProgress>, read: unknown): void {
  const { location, developBranch } = target
  if (progress.ontoBranch !== developBranch) return
  if (read === undefined) {
    out.warning(`${progress.branch} is now on ${developBranch}: pass the open PR of the branch as reads.pull_request (pull_request_read, method get) to learn whether its body must be saved again to link its closing Issues`)
    return
  }
  const pullRequest = parseOfficial(out, 'pull_request_read', PULL_REQUEST_READ_GET, read, 'reads.pull_request')
  if (pullRequest.state !== 'open' || pullRequest.merged || pullRequest.head.ref !== progress.branch || (extractClosingIssueNumbers(pullRequest.body ?? '', location).length === 0)) return
  const name = `PR #${String(pullRequest.number)}`
  const rebase = pullRequest.base.ref === developBranch ? '' : ` with base ${developBranch}`
  const reason = `GitHub links the closing Issues of ${name} only when its body is saved while the PR goes to ${developBranch}: call update_pull_request for ${name}${rebase}, passing its body unchanged`
  out.result({ relink: { pullRequest: pullRequest.number, reason } })
}

// continue で終えた後の、保存し直しの判断の材料。rebase の間はブランチを読めないので、終えてから求める。求まらなければ判断しない
function relinkTargetOf(cwd: string, project: string | undefined): RelinkTarget | undefined {
  const location = primaryRemote(cwd)?.location
  if (location === undefined) return undefined
  const lookup = findConfigFor(location, project)
  if (lookup.kind !== 'found') return undefined
  const developBranch = getDevelopBranch(lookup.found.config, location.owner, location.repository)
  return developBranch === undefined || developBranch === '' ? undefined : { location, developBranch }
}

// continue と abort。途中の記録だけを読む。記録が無ければ、利用者が始めた rebase を動かさずに止まる
async function resumeRestack(out: RestackOutput, cwd: string, mode: 'continue' | 'abort', signal: Readonly<AbortSignal> | undefined): Promise<RestackProgress | undefined> {
  const reading = interpretRestackProgress(readFlag(FLAG_PECOT_RESTACK))
  if (reading.kind === 'malformed') stopWith(out, `.pecot-restack is malformed: ${reading.content}`, 'content-invalid')
  const isRebasing = isRebaseInProgress(cwd)
  // 利用者が自分で rebase を終えていれば、続行は残りの手順（push と記録の書き直し）だけを行う
  const isRebased = reading.kind === 'progress' && !isRebasing && mode === 'continue'
    && currentBranch(cwd) === reading.progress.branch && mergeBase(cwd, 'HEAD', reading.progress.ontoSha) === reading.progress.ontoSha
  if (reading.kind === 'none' || (!isRebasing && !isRebased)) {
    removeFlag(FLAG_PECOT_RESTACK)
    return stopWith(out, hinted`no restack in progress\nto restack the branch, ${RUN_COLON}${commandHint(RESTACK_PATH)}`, 'invalid-input', USAGE_EXIT_CODE)
  }
  const { progress } = reading
  if (mode === 'abort') {
    abortRebase(cwd)
    removeFlag(FLAG_PECOT_RESTACK)
    out.result({ branch: progress.branch, base: progress.ontoBranch, outcome: 'aborted' })
    out.done({ verb: 'unchanged', target: `${progress.branch} restack aborted` })
    return undefined
  }
  if (isRebasing && continueRebase(cwd) === 'conflict') stopOnConflict(out, cwd, progress)
  await finishRestack(out, cwd, progress, signal)
  return progress
}

function currentBranch(cwd: string): string | undefined {
  return gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })?.trim()
}

function hasUncommittedChanges(cwd: string): boolean {
  return (gitStdout(['status', '--porcelain', '--untracked-files=no'], { cwd }) ?? '').trim() !== ''
}

interface StackedTarget {
  readonly remote: string
  readonly location: RepositoryReference
  readonly reading: Extract<BaseReading, { kind: 'stacked' }>
  readonly developBranch: string
}

// 読み取りの結果の親 PR と、remote の先頭から、スタックし直す先を決める
async function decideFor(out: RestackOutput, cwd: string, target: Readonly<StackedTarget>, reads: RestackInput['reads']): Promise<RestackDecision> {
  const { remote, location, developBranch, reading } = target
  const { branch } = reading.record
  if (reads?.pull_requests === undefined) {
    return stopWith(out, `${currentBranch(cwd) ?? 'the branch'} is stacked on ${branch}: read its PRs with list_pull_requests (owner ${location.owner}, repo ${location.repository}, head ${location.owner}:${branch}, state all) and pass its result as reads.pull_requests`, 'invalid-input', USAGE_EXIT_CODE)
  }
  const listed = parseOfficial(out, 'list_pull_requests', LISTED_PULL_REQUESTS, reads.pull_requests, 'reads.pull_requests')
  const lowerPullRequest = pickLowerPullRequest(pullRequestReadoutsOf(listed).filter(pullRequest => pullRequest.headRefName === branch))
  const read = await readRestackDecision({ cwd, remote, reading, developBranch, lowerPullRequest, signal: out.signal })
  return read.kind === 'decided' ? read.decision : stopWith(out, `cannot reach ${remote} to read the base branch ${branch}`, 'git-unresolved')
}

// スタックし直す先の ref と SHA。開発ブランチへスタックし直すときは、スタック先を記録から外す
function progressOf(out: RestackOutput, cwd: string, branch: string, target: Readonly<StackedTarget>, decision: Extract<RestackDecision, { kind: 'moved' | 'merged' | 'rebased' }>): RestackProgress {
  const { remote } = target
  const { record } = target.reading
  const ontoSha = resolveCommit(cwd, `${remote}/${decision.base}`)
  const originalSha = resolveCommit(cwd, 'HEAD')
  if (ontoSha === undefined || originalSha === undefined) return stopWith(out, `branch ${remote}/${decision.base} does not exist\ncheck the remote branches with: git branch -r`, 'git-unresolved')
  // 親ブランチの上に残るならスタック先を残す。rebased の base は、親ブランチ（moved から）か開発ブランチ（merged から）
  const isStillStacked = decision.kind === 'moved' || (decision.kind === 'rebased' && decision.base === record.branch)
  return { remote, branch, originalSha, ontoBranch: decision.base, ontoSha, leaseSha: resolveCommit(cwd, `${remote}/${branch}`), stackedOn: isStillStacked ? record.stackedOn : undefined, recordSha: record.sha }
}

// rebase の起点。記録の位置が HEAD に無いとき（push が拒まれた後に base が進んだときなど）は、別の点から求める。
// 親ブランチの追跡参照からの fork-point を先に使い、求まらなければ新しい base との merge-base にする。古い親ブランチのコミットを当て直さない
function rebaseStartOf(out: RestackOutput, cwd: string, target: Readonly<StackedTarget>, ontoSha: string): string {
  const { sha, branch } = target.reading.record
  if (isAncestor(cwd, sha, 'HEAD')) return sha
  const start = forkPoint(cwd, `${target.remote}/${branch}`, 'HEAD') ?? mergeBase(cwd, 'HEAD', ontoSha)
  return start ?? stopWith(out, `cannot find where HEAD forked from ${branch}`, 'git-unresolved')
}

async function runRestack(input: Readonly<RestackInput>, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput<PrRestackData>(false, io)
  const modes = [input.check, input.continue, input.abort].filter(Boolean).length
  if (modes > 1) stopWith(out, 'give only one of check, continue and abort', 'invalid-input', USAGE_EXIT_CODE)
  const cwd = '.'
  if (input.continue || input.abort) {
    const finished = await resumeRestack(out, cwd, input.abort ? 'abort' : 'continue', io.signal)
    const relinkTarget = finished === undefined ? undefined : relinkTargetOf(cwd, input.project)
    if (finished !== undefined && relinkTarget !== undefined) reportRelink(out, relinkTarget, finished, input.reads?.pull_request)
    return
  }

  const { currentBranch: branch, remoteName: remote, location } = validatePullRequestContext(cwd, out)
  if (isRebaseInProgress(cwd)) {
    stopWith(out, hinted`a rebase is in progress\ncontinue the restack: ${commandHint(RESTACK_PATH, { continue: true })}\nor abort it: ${commandHint(RESTACK_PATH, { abort: true })}`, 'invalid-input', USAGE_EXIT_CODE)
  }
  const config = requireConfigFor(out, location, input.project, RESTACK_PATH).config
  const reading = readBaseRecord()
  stopOnMalformedRecord(reading, out)
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  if (developBranch === undefined || developBranch === '') return stopWith(out, `develop_branch is not set for ${location.owner}/${location.repository}`, 'repo-setting-missing')

  if (reading.kind !== 'stacked') {
    out.result({ branch, base: developBranch, outcome: 'up-to-date' })
    if (input.check) out.data(describeRestackCheck(branch, { kind: 'not-stacked', base: developBranch }))
    else out.done({ verb: 'unchanged', target: `${branch} is up to date` })
    return
  }
  if (!input.check && hasUncommittedChanges(cwd)) stopWith(out, 'working tree has uncommitted changes', 'preflight-failed', UNCOMMITTED_EXIT_CODE)
  const fetchResult = await fetchRemote(cwd, remote, out.signal)
  if (!fetchResult.succeeded) {
    out.log(fetchResult.stderr)
    stopWith(out, gitFailureText(`cannot fetch ${remote}: `, fetchResult.stderr.trim()), 'git-unresolved')
  }

  const target: StackedTarget = { remote, location, reading, developBranch }
  const relinkTarget: RelinkTarget = { location, developBranch }
  const decision = await decideFor(out, cwd, target, input.reads)
  if (decision.kind === 'gone') return stopWith(out, describeGone(decision), 'pr-state')
  if (input.check) {
    const isNeeded = decision.kind === 'moved' || decision.kind === 'merged'
    out.result({ branch, base: decision.base, outcome: isNeeded ? 'needs-restack' : 'up-to-date', ...causeOf(decision) })
    out.data(describeRestackCheck(branch, decision))
    return
  }
  if (decision.kind === 'rebased') {
    // スタックし直し済みなので rebase をせず、push と記録の書き直しだけを行う
    const progress = progressOf(out, cwd, branch, target, decision)
    await finishRestack(out, cwd, progress, io.signal)
    reportRelink(out, relinkTarget, progress, input.reads?.pull_request)
    return
  }
  if (decision.kind !== 'moved' && decision.kind !== 'merged') {
    out.result({ branch, base: decision.base, outcome: 'up-to-date' })
    out.done({ verb: 'unchanged', target: `${branch} is up to date` })
    return
  }

  const progress = progressOf(out, cwd, branch, target, decision)
  if (rebaseOnto(cwd, progress.ontoSha, rebaseStartOf(out, cwd, target, progress.ontoSha)) === 'conflict') {
    writeFlag(FLAG_PECOT_RESTACK, formatRestackProgress(progress))
    stopOnConflict(out, cwd, progress)
  }
  await finishRestack(out, cwd, progress, io.signal)
  reportRelink(out, relinkTarget, progress, input.reads?.pull_request)
}

const prRestack = defineTool({
  name: 'pr_restack',
  title: 'Restack branch',
  writes: { destructive: true, idempotent: true },
  description: 'Restack the current branch onto the new position of its base branch. Reads nothing on GitHub; pass the results of the official reads in reads',
  input: RestackInputSchema,
  output: PR_RESTACK_OUTPUT,
  run: async (input, io) => {
    await runRestack(input, io)
    return 0
  },
})

/**
pr restack。pr のグループの最後に並ぶ
*/
export const PR_RESTACK_TOOLS: readonly ToolDefinition[] = [prRestack]
