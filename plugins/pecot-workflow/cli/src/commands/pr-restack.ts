// pr restack。積んだブランチを、base にしたブランチの新しい位置へ載せ直す。
// 途中で抜ける箇所は CommandExit を投げ、defineCommand が終了コードにする。
import { z } from 'zod'

import { describeApiError } from '../domain/api-error-detail.js'
import { getDevelopBranch } from '../domain/config.js'
import { extractClosingIssueNumbers, FORCE_PUSH_COMMAND } from '../domain/pull-request.js'
import { describeGone, describeRestackCheck, RESTACK_PATH } from '../domain/restack.js'
import type { RestackDecision } from '../domain/restack.js'
import { FLAG_PECOT_RESTACK, formatRestackProgress, interpretRestackProgress } from '../domain/state.js'
import type { BaseReading, BaseRecord, RestackProgress } from '../domain/state.js'
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
} from '../infra/git.js'
import type { FetchResult, PushResult } from '../infra/git.js'
import { findConfigFor } from '../infra/config-store.js'
import type { PullRequestForFinish } from '../infra/github/pulls.js'
import { readBaseRecord, readFlag, removeFlag, writeBaseRecord, writeFlag } from '../infra/state-store.js'
import { defineCommand } from './command-definition.js'
import type { CommandDefinition, CommandIo } from './command-definition.js'
import { commandHint, hinted } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { PROJECT_INPUT, requireConfigFor, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { apiFailureMessage, createGitHubClient } from './github-client.js'
import { createOutput, DRY_RUN_FIELD } from './output.js'
import type { Output } from './output.js'
import { primaryRemote, stopOnMalformedRecord, validatePullRequestContext } from './pr.js'
import { readRestackDecision } from './restack-reading.js'
import { readBaseOrInfer, warnUnresolved } from './base-reading.js'
import { USAGE_EXIT_CODE } from './usage-error.js'

const CONFLICT_EXIT_CODE = 3
const UNCOMMITTED_EXIT_CODE = 2
const MILLISECONDS_PER_SECOND = 1000
// 文の中にロングオプションを書けない（lint）ので、git の引数から組む
const SKIP_COMMAND = ['git', 'rebase', '--skip'].join(' ')

const PR_RESTACK_OUTPUT = z.strictObject({
  branch: z.string().describe('Branch that is restacked'),
  base: z.string().describe('Base branch after the restack (the develop branch when the lower PR is merged)'),
  outcome: z.enum(['up-to-date', 'needs-restack', 'restacked', 'synced', 'conflict', 'aborted']).describe('What happened, or with check, what a restack would do'),
  cause: z.enum(['base-moved', 'base-merged']).optional().describe('Why a restack is needed (only with check or dry_run, when one is needed)'),
  pullRequest: z.int().optional().describe('Merged PR of the lower branch (only when the cause is base-merged)'),
  pushed: z.boolean().optional().describe('Whether the branch was pushed (only when restacked)'),
  conflicts: z.array(z.string()).optional().describe('Files with conflicts (only on conflict)'),
  relinked: z.int().optional().describe('Open PR whose body was saved again so that GitHub links its closing Issues (only after a restack onto the develop branch)'),
  dryRun: DRY_RUN_FIELD,
})

type PrRestackData = z.input<typeof PR_RESTACK_OUTPUT>
type RestackOutput = Readonly<Output<PrRestackData>>

const RestackInputSchema = z.strictObject({
  check: z.boolean().default(false).describe('Only report whether a restack is needed'),
  continue: z.boolean().default(false).describe('Continue a restack that stopped on conflicts, after resolving them'),
  abort: z.boolean().default(false).describe('Abort a restack that stopped on conflicts and go back to the position before it'),
  dry_run: z.boolean().default(false).describe('Show what would be done without rebasing, pushing or writing records'),
  project: PROJECT_INPUT,
})

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
    ? hinted`the rebase stopped without conflicted files (a commit may have become empty)\nskip the commit with: ${SKIP_COMMAND}, then run: ${commandHint(RESTACK_PATH, { continue: true })}\nor go back to the position before the restack: ${commandHint(RESTACK_PATH, { abort: true })}`
    : hinted`conflict in ${conflicts.join(', ')}\nresolve the conflicts and git add the files, then run: ${commandHint(RESTACK_PATH, { continue: true })}\nor go back to the position before the restack: ${commandHint(RESTACK_PATH, { abort: true })}`
  return stopWith(out, message, 'git-conflict', CONFLICT_EXIT_CODE)
}

// remote のブランチにだけあるコミット。patch-id は前後の行も含むので、載せ直しの前と後のどちらとも合わないものだけを数える
function remoteOnlyCommits(cwd: string, progress: Readonly<RestackProgress>, remoteBranch: string): readonly string[] {
  // 記録の位置は途中の記録から読む。積んだ先を求めて始めた載せ直しでは .pecot-base が無い。古い版の途中の記録は .pecot-base から読む
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
      return hinted`push timed out after ${String(PUSH_TIMEOUT_MILLISECONDS / MILLISECONDS_PER_SECOND)} seconds\n${unchanged}\npush the branch yourself: ${FORCE_PUSH_COMMAND} ${remote} ${branch}\nthen run: ${commandHint(RESTACK_PATH)}`
    }
    case 'rejected': {
      return hinted`push was rejected: ${push.stderr.trim()}\n${unchanged}\nrun again: ${commandHint(RESTACK_PATH)}`
    }
  }
}

// rebase が終わった後。remote が載せ直し済みで木が同じなら合わせ、違えば push し、base の記録を書き直す
async function finishRestack(out: RestackOutput, cwd: string, progress: Readonly<RestackProgress>, signal: Readonly<AbortSignal> | undefined): Promise<void> {
  const { remote, branch, ontoBranch, leaseSha } = progress
  const remoteBranch = `${remote}/${branch}`
  if (leaseSha !== undefined && remoteOnlyCommits(cwd, progress, remoteBranch).length > 0) {
    resetHardTo(cwd, progress.originalSha)
    removeFlag(FLAG_PECOT_RESTACK)
    stopWith(out, hinted`${remoteBranch} has commits that are not in ${branch}\n${branch} is back at the position before the restack\nrebase or merge them into ${branch} first, then run again: ${commandHint(RESTACK_PATH)}`, 'git-unresolved')
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
  readonly owner: string
  readonly repository: string
  readonly host: string
  readonly developBranch: string
}

const RELINK_TARGET = 'to its closing Issues'

// 本文の Closes のうち、まだリンクになっていないものがあるか。GitHub がリンクにするのは、既定のブランチに向いた PR だけ
function hasUnlinkedClosingIssues(pullRequest: Readonly<PullRequestForFinish>, target: Readonly<RelinkTarget>): boolean {
  if (pullRequest.state !== 'OPEN' || pullRequest.base_ref !== pullRequest.default_branch) return false
  const linked = new Set(pullRequest.closing_issues.filter(issue => issue.owner === target.owner && issue.repository === target.repository).map(issue => issue.number))
  return extractClosingIssueNumbers(pullRequest.body, target).some(number => !linked.has(number))
}

// 開発ブランチへ載せ直した PR の本文を保存し直す。GitHub は base の付け替えでは Closes を読み直さず、Issue とリンクしない
async function relinkClosingIssues(out: RestackOutput, target: Readonly<RelinkTarget>, progress: Readonly<RestackProgress>): Promise<void> {
  const { owner, repository, developBranch } = target
  if (progress.ontoBranch !== developBranch) return
  let number: number | undefined
  try {
    const client = createGitHubClient(out, target.host)
    const { pullRequests } = await client.listPullRequestsByHead(owner, repository, progress.branch)
    number = pullRequests.find(found => found.state === 'OPEN' && !found.isCrossRepository)?.number
    if (number === undefined) return
    const pullRequest = await client.getPullRequestForFinish(owner, repository, number)
    if (!hasUnlinkedClosingIssues(pullRequest, target)) return
    await client.updatePullRequestBody(owner, repository, number, pullRequest.body)
    out.result({ relinked: number })
    out.done({ verb: 'update', target: `PR #${String(number)} relinked ${RELINK_TARGET}` })
  }
  catch (error: unknown) {
    const label = number === undefined ? `the PR of ${progress.branch}` : `PR #${String(number)}`
    out.warning(`cannot relink ${label} ${RELINK_TARGET}: ${apiFailureMessage(error)}\nto link them, save the body of ${label} again on GitHub without changes`)
  }
}

function planRelink(out: RestackOutput, branch: string, target: Readonly<RelinkTarget>, ontoBranch: string): void {
  if (ontoBranch === target.developBranch) out.planned({ verb: 'update', target: `PR of ${branch} relinked ${RELINK_TARGET}` })
}

// --continue で終えた後に保存し直す先。rebase の間はブランチを読めないので、終えてから求める。求まらなければ保存し直さない
function relinkTargetOf(cwd: string, project: string | undefined): RelinkTarget | undefined {
  const location = primaryRemote(cwd)?.location
  if (location === undefined) return undefined
  const lookup = findConfigFor(location, project)
  if (lookup.kind !== 'found') return undefined
  const { config } = lookup.found
  const developBranch = getDevelopBranch(config, location.owner, location.repository)
  return developBranch === undefined || developBranch === '' ? undefined : { owner: location.owner, repository: location.repository, host: config.host, developBranch }
}

// --continue と --abort。途中の記録だけを読む。記録が無ければ、利用者が始めた rebase を動かさずに止まる
async function resumeRestack(out: RestackOutput, cwd: string, mode: 'continue' | 'abort', isDryRun: boolean, signal: Readonly<AbortSignal> | undefined): Promise<RestackProgress | undefined> {
  const reading = interpretRestackProgress(readFlag(FLAG_PECOT_RESTACK))
  if (reading.kind === 'malformed') stopWith(out, `.pecot-restack is malformed: ${reading.content}`, 'content-invalid')
  const isRebasing = isRebaseInProgress(cwd)
  // 利用者が自分で rebase を終えていれば、続行は残りの手順（push と記録の書き直し）だけを行う
  const isRebased = reading.kind === 'progress' && !isRebasing && mode === 'continue'
    && currentBranch(cwd) === reading.progress.branch && mergeBase(cwd, 'HEAD', reading.progress.ontoSha) === reading.progress.ontoSha
  if (reading.kind === 'none' || (!isRebasing && !isRebased)) {
    if (!isDryRun) removeFlag(FLAG_PECOT_RESTACK)
    return stopWith(out, hinted`no restack in progress\nto restack the branch, run: ${commandHint(RESTACK_PATH)}`, 'invalid-input', USAGE_EXIT_CODE)
  }
  const { progress } = reading
  if (isDryRun) {
    out.result({ branch: progress.branch, base: progress.ontoBranch, outcome: mode === 'abort' ? 'aborted' : 'restacked' })
    out.planned(mode === 'abort' ? { verb: 'unchanged', target: `${progress.branch} restack aborted` } : { verb: 'update', target: `${progress.branch} restacked on ${progress.ontoBranch}` })
    return mode === 'abort' ? undefined : progress
  }
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
  readonly owner: string
  readonly repository: string
  readonly reading: Extract<BaseReading, { kind: 'stacked' }>
  readonly developBranch: string
}

// 下の段の PR と、remote の先頭を読んで、載せ直す先を決める
async function decideFor(out: RestackOutput, cwd: string, host: string, target: Readonly<StackedTarget>): Promise<RestackDecision> {
  const { remote, owner, repository, developBranch, reading } = target
  const { branch } = reading.record
  const read = await readRestackDecision({ client: () => createGitHubClient(out, host), owner, repository, cwd, remote, reading, developBranch, signal: out.signal })
  switch (read.kind) {
    case 'pull-request-unreadable': {
      return stopWith(out, `cannot read the PR of the base branch ${branch}: ${describeApiError(read.error)}`, kindOfFailure(read.error))
    }
    case 'remote-unreachable': {
      return stopWith(out, `cannot reach ${remote} to read the base branch ${branch}`, 'git-unresolved')
    }
    case 'decided': {
      return read.decision
    }
  }
}

// 載せ直す先の ref と SHA。開発ブランチへ載せ直すときは、積んだ先を記録から外す
function progressOf(out: RestackOutput, cwd: string, branch: string, target: Readonly<StackedTarget>, decision: Extract<RestackDecision, { kind: 'moved' | 'merged' | 'rebased' }>): RestackProgress {
  const { remote } = target
  const { record } = target.reading
  const ontoSha = resolveCommit(cwd, `${remote}/${decision.base}`)
  const originalSha = resolveCommit(cwd, 'HEAD')
  if (ontoSha === undefined || originalSha === undefined) return stopWith(out, `branch ${remote}/${decision.base} does not exist\ncheck the remote branches with: git branch -r`, 'git-unresolved')
  // 下の段の上に残るなら積んだ先を残す。rebased の base は、下の段（moved から）か開発ブランチ（merged から）
  const isStillStacked = decision.kind === 'moved' || (decision.kind === 'rebased' && decision.base === record.branch)
  return { remote, branch, originalSha, ontoBranch: decision.base, ontoSha, leaseSha: resolveCommit(cwd, `${remote}/${branch}`), stackedOn: isStillStacked ? record.stackedOn : undefined, recordSha: record.sha }
}

// rebase の起点。記録の位置が HEAD に無いとき（push が拒まれた後に base が進んだときなど）は、別の点から求める。
// 下の段の追跡参照からの fork-point を先に使い、求まらなければ新しい base との merge-base にする。古い下の段のコミットを積み直さない
function rebaseStartOf(out: RestackOutput, cwd: string, target: Readonly<StackedTarget>, ontoSha: string): string {
  const { sha, branch } = target.reading.record
  if (isAncestor(cwd, sha, 'HEAD')) return sha
  const start = forkPoint(cwd, `${target.remote}/${branch}`, 'HEAD') ?? mergeBase(cwd, 'HEAD', ontoSha)
  return start ?? stopWith(out, `cannot find where HEAD forked from ${branch}`, 'git-unresolved')
}

async function runRestack(input: Readonly<z.output<typeof RestackInputSchema>>, io: Readonly<CommandIo>): Promise<void> {
  const out = createOutput<PrRestackData>(input.dry_run, io)
  const modes = [input.check, input.continue, input.abort].filter(Boolean).length
  if (modes > 1) stopWith(out, 'give only one of check, continue and abort', 'invalid-input', USAGE_EXIT_CODE)
  const cwd = '.'
  if (input.continue || input.abort) {
    const finished = await resumeRestack(out, cwd, input.abort ? 'abort' : 'continue', input.dry_run, io.signal)
    const relinkTarget = finished === undefined ? undefined : relinkTargetOf(cwd, input.project)
    if (finished === undefined || relinkTarget === undefined) return
    if (input.dry_run) planRelink(out, finished.branch, relinkTarget, finished.ontoBranch)
    else await relinkClosingIssues(out, relinkTarget, finished)
    return
  }

  const { currentBranch: branch, remoteName: remote, location } = validatePullRequestContext(cwd, out)
  if (isRebaseInProgress(cwd)) {
    stopWith(out, hinted`a rebase is in progress\ncontinue the restack: ${commandHint(RESTACK_PATH, { continue: true })}\nor abort it: ${commandHint(RESTACK_PATH, { abort: true })}`, 'invalid-input', USAGE_EXIT_CODE)
  }
  const config = requireConfigFor(out, location, input.project, RESTACK_PATH).config
  // 記録が無ければ、求める前に fetch して、手元に無い下の段も追跡参照で見る
  let fetched: Promise<FetchResult> | undefined
  const fetchOnce = async (): Promise<FetchResult> => await (fetched ??= fetchRemote(cwd, remote, out.signal))
  const fetchBeforeInfer = async (): Promise<void> => {
    await fetchOnce()
  }
  const base = await readBaseOrInfer({ directory: cwd, project: { config, client: () => createGitHubClient(out, config.host) }, beforeInfer: fetchBeforeInfer })
  warnUnresolved(base, out)
  const { reading } = base
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
  const fetchResult = await fetchOnce()
  if (!fetchResult.succeeded) stopWith(out, `cannot fetch ${remote}: ${fetchResult.stderr.trim()}`, 'git-unresolved')

  const target: StackedTarget = { remote, owner: location.owner, repository: location.repository, reading, developBranch }
  const relinkTarget: RelinkTarget = { owner: location.owner, repository: location.repository, host: config.host, developBranch }
  const decision = await decideFor(out, cwd, config.host, target)
  if (decision.kind === 'gone') return stopWith(out, describeGone(decision), 'pr-state')
  if (input.check) {
    const isNeeded = decision.kind === 'moved' || decision.kind === 'merged'
    out.result({ branch, base: decision.base, outcome: isNeeded ? 'needs-restack' : 'up-to-date', ...causeOf(decision) })
    out.data(describeRestackCheck(branch, decision))
    return
  }
  if (decision.kind === 'rebased') {
    // 載せ直し済みなので rebase をせず、push と記録の書き直しだけを行う
    const progress = progressOf(out, cwd, branch, target, decision)
    if (input.dry_run) {
      const isSynced = isSyncedWithRemote(cwd, progress)
      out.result({ branch, base: decision.base, outcome: isSynced ? 'synced' : 'restacked' })
      out.planned({ verb: 'update', target: isSynced ? `${branch} synced with ${remote}/${branch}` : `${branch} restacked on ${decision.base}` })
      planRelink(out, branch, relinkTarget, decision.base)
      return
    }
    await finishRestack(out, cwd, progress, io.signal)
    await relinkClosingIssues(out, relinkTarget, progress)
    return
  }
  if (decision.kind !== 'moved' && decision.kind !== 'merged') {
    out.result({ branch, base: decision.base, outcome: 'up-to-date' })
    out.done({ verb: 'unchanged', target: `${branch} is up to date` })
    return
  }

  const progress = progressOf(out, cwd, branch, target, decision)
  if (input.dry_run) {
    out.result({ branch, base: decision.base, outcome: 'needs-restack', ...causeOf(decision) })
    out.planned({ verb: 'update', target: `${branch} restacked on ${decision.base}` })
    planRelink(out, branch, relinkTarget, decision.base)
    return
  }
  if (rebaseOnto(cwd, progress.ontoSha, rebaseStartOf(out, cwd, target, progress.ontoSha)) === 'conflict') {
    writeFlag(FLAG_PECOT_RESTACK, formatRestackProgress(progress))
    stopOnConflict(out, cwd, progress)
  }
  await finishRestack(out, cwd, progress, io.signal)
  await relinkClosingIssues(out, relinkTarget, progress)
}

const prRestack = defineCommand({
  path: RESTACK_PATH,
  description: 'Restack the current branch onto the new position of its base branch',
  input: RestackInputSchema,
  output: PR_RESTACK_OUTPUT,
  positional: [],
  shortFlags: { dry_run: '-n' },
  interactive: false,
  run: async (input, io) => {
    await runRestack(input, io)
    return 0
  },
})

/**
pr restack。pr のグループの最後に並ぶ
*/
export const PR_RESTACK_COMMANDS: readonly CommandDefinition[] = [prRestack]
