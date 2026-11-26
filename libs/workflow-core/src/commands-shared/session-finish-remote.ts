/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// マージの後の GitHub 側の片付け（関連 Issue を閉じる・待っていた Issue の列と札を動かす）。cli の session finish と actions/ の session-finish が共有する。
import { describeApiError } from '../domain/api-error-detail.js'
import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { homeRepositoryOf } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { isEpicIssue } from '../domain/issue-kind.js'
import { extractClosingIssueNumbers } from '../domain/pull-request.js'
import { assumePullRequestState, describeReadinessChange, displayReference, hasReadinessChanged, isDone, isStackedOn } from '../domain/readiness.js'
import type { IssuePullRequest } from '../domain/readiness.js'
import { createIssueReference } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { isSameRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { RESTACK_PATH } from '../domain/restack.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError, GitHubNotFoundError, isClosedByAnotherRequest } from '../infra/github/errors.js'
import type { PullRequestForFinish } from '../infra/github/pulls.js'
import { BOARD_SYNC_WORKFLOW } from './board-judgment.js'
import type { BoardContext } from './board-judgment.js'
import { commandHint, hinted, RUN } from './command-hint.js'
import { stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { createGitHubClient } from './github-client.js'
import { createReadinessCache, judgeAssuming } from './issue-readiness.js'
import type { JudgedIssue, ReadinessCache } from './issue-readiness.js'
import { settle } from './output.js'
import type { Operation, Output } from './output.js'
import { isPositive } from './pr-reference.js'
import { moveIssuesWaitingFor, prerequisiteOf } from './pr-waiting.js'
import type { WaitingCheck } from './pr-waiting.js'

/**
閉じなかった理由。epic（守る）・already-closed（マージで GitHub が閉じたものも含む）・not-found・failed（warning を見る）
*/
// eslint-disable-next-line no-restricted-syntax -- 配列から型を作るための as const
export const SKIPPED_ISSUE_REASONS = ['epic', 'already-closed', 'not-found', 'failed'] as const

export interface SkippedIssue {
  readonly number: number
  readonly reason: typeof SKIPPED_ISSUE_REASONS[number]
}

export interface ReadinessChange {
  readonly issue: string
  readonly from: string
  readonly to: string
}

export interface RestackTarget {
  readonly issue: string
  readonly branch?: string
}

/**
GitHub 側の片付けの結果。各段が書き足す
*/
export interface RemoteFinishRecord {
  readonly closedIssues: number[]
  readonly skippedIssues: SkippedIssue[]
  readonly readinessChanges: ReadinessChange[]
  readonly restack: RestackTarget[]
}

export interface RemoteFinishContext {
  readonly out: Output
  readonly isDryRun: boolean
  readonly record: RemoteFinishRecord
}

/**
マージ済みの PR と、それを読んだクライアント
*/
export interface MergedPullRequest {
  readonly client: GitHubClient
  readonly pr: PullRequestForFinish
  readonly location: RepositoryReference
  readonly number: number
}

/**
PR を読み、マージ済みでなければ止める
*/
export async function requireMergedPullRequest(out: Readonly<Output>, config: Readonly<ProjectConfig>, location: Readonly<RepositoryReference & { readonly number: number }>): Promise<MergedPullRequest> {
  let client: GitHubClient
  let pr: PullRequestForFinish
  try {
    client = createGitHubClient(out, config.host)
    pr = await client.getPullRequestForFinish(location.owner, location.repository, location.number)
  }
  catch (error: unknown) {
    if (error instanceof GitHubNotFoundError) return stopWith(out, `PR not found: ${location.owner}/${location.repository}/${String(location.number)}`, 'github-not-found')
    if (error instanceof GitHubAPIError) return stopWith(out, error.message, kindOfFailure(error))
    throw error
  }
  if (pr.state !== 'MERGED') stopWith(out, `PR #${String(location.number)} is not merged yet (state: ${pr.state}); merge it on GitHub first`, 'pr-state')
  return { client, pr, location: { owner: location.owner, repository: location.repository }, number: location.number }
}

/**
PR が閉じる Issue の番号。GitHub はキーワードを既定ブランチ宛ての PR でだけ解釈するので、そのときは closing issues だけを使う
*/
export function collectClosingIssueNumbers(pr: Readonly<PullRequestForFinish>, location: RepositoryReference): Set<number> {
  const numbers = new Set<number>(pr.closing_issues.filter(issue => isSameRepository(issue, location)).map(issue => issue.number))
  if (pr.base_ref !== pr.default_branch) {
    for (const number of extractClosingIssueNumbers(pr.body, location)) numbers.add(number)
  }
  const branchNumber = extractIssueNumberFromBranch(pr.head_ref)
  if (isPositive(branchNumber)) numbers.add(branchNumber)
  return numbers
}

interface ClosingIssues {
  readonly open: Set<number>
  readonly epic: Set<number>
  readonly closed: Set<number>
  readonly unread: Set<number>
}

// Epic（Issue Type が Epic か、sub-issue を持つ）と閉じた Issue を分ける。読めない Issue は、閉じた理由を上書きしないよう閉じない
async function classifyClosingIssues(client: GitHubClient, location: RepositoryReference, issueNumbers: ReadonlySet<number>, out: Readonly<Output>): Promise<ClosingIssues> {
  const classified: ClosingIssues = { open: new Set(), epic: new Set(), closed: new Set(), unread: new Set() }
  const ordered = [...issueNumbers].toSorted((a, b) => a - b)
  for (const number of ordered) {
    try {
      const kind = await client.getIssueKind(location.owner, location.repository, number)
      if (isEpicIssue(kind)) classified.epic.add(number)
      else if (kind.state === 'CLOSED') classified.closed.add(number)
      else classified.open.add(number)
    }
    catch (error: unknown) {
      if (error instanceof GitHubNotFoundError) {
        // 状態は確かめていないが、close の 404 で not-found として記録するため open に入れる
        classified.open.add(number)
        continue
      }
      if (!(error instanceof GitHubAPIError)) throw error
      out.warning(`reading Issue #${String(number)} failed: ${error.message}; not closed`)
      classified.unread.add(number)
    }
  }
  return classified
}

function sorted(numbers: ReadonlySet<number>): number[] {
  return [...numbers].toSorted((a, b) => a - b)
}

async function closeRelatedIssues(context: Readonly<RemoteFinishContext>, client: GitHubClient, location: RepositoryReference, issues: Readonly<ClosingIssues>): Promise<void> {
  const { out, isDryRun, record } = context
  for (const number of sorted(issues.epic)) {
    settle(out, { verb: 'skip', target: `closing Issue #${String(number)} (Epic)` })
    record.skippedIssues.push({ number, reason: 'epic' })
  }
  for (const number of sorted(issues.unread)) record.skippedIssues.push({ number, reason: 'failed' })
  for (const number of sorted(issues.closed)) {
    settle(out, { verb: 'unchanged', target: `Issue #${String(number)} (already closed)` })
    record.skippedIssues.push({ number, reason: 'already-closed' })
  }
  for (const number of sorted(issues.open)) {
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

function mergedPullRequestOf(location: RepositoryReference, number: number, pr: Readonly<PullRequestForFinish>): IssuePullRequest {
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
  const unconfirmed = (name: string): string => `could not confirm that GitHub reflects the close of ${names} in the readiness of ${name}; its column was not moved; run ${BOARD_SYNC_WORKFLOW} later to move it`
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

// 閉じた Issue を待つ Issue の列と札を動かし、マージの前と比べた判定の変化と、スタックし直す子ブランチを記録する
async function updateWaitingIssues(context: Readonly<RemoteFinishContext>, source: Readonly<WaitingSource>): Promise<void> {
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
    out.warning(hinted`${name} is stacked on ${lower}; ${RUN} ${commandHint(RESTACK_PATH)} in the working directory of ${branch ?? 'its branch'}`)
  }
}

/**
マージ済みの PR が閉じる Issue を閉じ、それを待つ Issue の列と札を動かす。閉じる対象の番号（PR が閉じる Issue の全部）を返す
*/
export async function finishOnGithub(context: Readonly<RemoteFinishContext>, config: Readonly<ProjectConfig>, merged: Readonly<MergedPullRequest>): Promise<ReadonlySet<number>> {
  const { out } = context
  const { client, pr, location, number } = merged
  const closingNumbers = collectClosingIssueNumbers(pr, location)
  const issues = await classifyClosingIssues(client, location, closingNumbers, out)
  out.count('Issues to close', issues.open.size)
  await closeRelatedIssues(context, client, location, issues)
  await updateWaitingIssues(context, { client, config, location, pullRequest: mergedPullRequestOf(location, number, pr) })
  return closingNumbers
}
