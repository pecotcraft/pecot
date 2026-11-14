/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// pr create の後に、head の Issue を待つ Issue（blocking）の列と札を、判定で動かす。
// どの失敗も warning にとどめ、終了コードを変えない。
import { setTimeout as delay } from 'node:timers/promises'

import { homeRepositoryOf, workflowFieldName } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { boardItemKey } from '../domain/format.js'
import type { BoardItem } from '../domain/format.js'
import type { BlockedByReference } from '../domain/issue-readout.js'
import { displayReference } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubNotFoundError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { applyJudgedMoves, judgeBoard, SYNCED_COLUMNS } from './board-judgment.js'
import type { BoardContext, JudgedTarget } from './board-judgment.js'
import { mapWithLimit } from './board-view.js'
import { commandHint, hinted } from './command-hint.js'
import { apiFailureMessage } from './github-client.js'
import type { Output } from './output.js'

// GitHub は書いた直後の読み取りの一致を保証しない。読み直す前に、反映を待つ時間
const RECHECK_DELAY_MILLISECONDS = 1500
const READ_MAX_WORKERS = 8

export interface CreatedPullRequest {
  readonly repository: RepositoryReference
  /**
  head ブランチの末尾の番号の Issue
  */
  readonly issueNumber: number
  /**
  作った PR の番号。応答に無ければ undefined（読み直しの確かめを省く）
  */
  readonly pullRequest: number | undefined
}

interface Waiting {
  readonly context: Readonly<BoardContext>
  readonly created: CreatedPullRequest
  readonly head: IssueReference
}

// 判定の前提の中の head の Issue に、作った PR が出ているか
function hasCreatedPullRequest(judged: JudgedTarget, waiting: Readonly<Waiting>): boolean {
  const { created, head } = waiting
  if (created.pullRequest === undefined || judged.result.kind !== 'judged') return true
  const headKey = issueReferenceKey(head)
  const prerequisite = judged.result.prerequisites.find(({ issue }) => issueReferenceKey(issue.ref) === headKey)
  return prerequisite?.issue.pullRequests.some(pullRequest => pullRequest.number === created.pullRequest) ?? false
}

async function judgeKeys(waiting: Readonly<Waiting>, items: readonly BoardItem[], keys: ReadonlySet<string>): Promise<readonly JudgedTarget[] | undefined> {
  const { client, config } = waiting.context
  return await judgeBoard(client, config, items, new Map(), { columns: SYNCED_COLUMNS, withoutRead: target => (keys.has(target.key) ? undefined : 'skip') })
}

interface Confirmed {
  readonly confirmed: readonly JudgedTarget[]
  readonly unconfirmed: readonly JudgedTarget[]
}

// 作った PR が判定に出ていない分を、少し待ってから 1 回だけ読み直す
async function judgeConfirmed(waiting: Readonly<Waiting>, items: readonly BoardItem[]): Promise<Confirmed | undefined> {
  const first = await judgeKeys(waiting, items, new Set(items.flatMap(item => boardItemKey(item) ?? [])))
  if (first === undefined) return undefined
  const stale = new Set(first.filter(judged => !hasCreatedPullRequest(judged, waiting)).map(judged => judged.target.key))
  if (stale.size > 0) await delay(RECHECK_DELAY_MILLISECONDS)
  const second = stale.size === 0 ? [] : await judgeKeys(waiting, items, stale)
  if (second === undefined) return undefined
  const latest = [...first.filter(judged => !stale.has(judged.target.key)), ...second]
  return { confirmed: latest.filter(judged => hasCreatedPullRequest(judged, waiting)), unconfirmed: latest.filter(judged => !hasCreatedPullRequest(judged, waiting)) }
}

interface WaitingIssues {
  readonly issues: readonly BlockedByReference[]
  /**
  全件読めなかったときの warning の文
  */
  readonly partial: string | undefined
}

// head の Issue が PR のリポに無いとき（集約リポの運用・番号が Issue でないブランチ）と、依存関係に対応しない GHES では、何も出さない
async function readWaitingIssues(waiting: Readonly<Waiting>): Promise<WaitingIssues | undefined> {
  const { context: { out, client, home }, created, head } = waiting
  const name = displayReference(head, home)
  const failed = `could not read the Issues waiting for ${name}`
  let read: Awaited<ReturnType<GitHubClient['getIssueBlockingReferences']>>
  try {
    read = await client.getIssueBlockingReferences(created.repository.owner, created.repository.repository, created.issueNumber)
  }
  catch (error: unknown) {
    if (error instanceof DependenciesUnsupportedError || error instanceof GitHubNotFoundError) return undefined
    out.warning(`${failed}: ${apiFailureMessage(error)}`)
    return undefined
  }
  if (read.kind === 'read-failed') {
    out.warning(`${failed}: ${read.reason}`)
    return undefined
  }
  const partial = read.total > read.issues.length ? `read ${String(read.issues.length)} of ${String(read.total)} Issues waiting for ${name}; the rest were not moved` : undefined
  return { issues: read.issues, partial }
}

// 待つ Issue のうち、開いていてボードに載っているものの項目だけを読む
async function readBoardItems(waiting: Readonly<Waiting>, issues: readonly BlockedByReference[]): Promise<readonly BoardItem[]> {
  const { client, config } = waiting.context
  const field = workflowFieldName(config)
  const open = issues.filter(issue => issue.state === 'OPEN')
  const items = await mapWithLimit(open, READ_MAX_WORKERS, async ({ repository, number }) => await client.getIssueBoardItem(config.project.id, repository.owner, repository.repository, number, field))
  return items.flatMap(item => item ?? [])
}

async function moveWaiting(waiting: Readonly<Waiting>, issues: readonly BlockedByReference[]): Promise<void> {
  const { context, created } = waiting
  const items = await readBoardItems(waiting, issues)
  if (items.length === 0) return
  const judged = await judgeConfirmed(waiting, items)
  if (judged === undefined) return
  await applyJudgedMoves(context, judged.confirmed)
  for (const { target } of judged.unconfirmed) {
    context.out.warning(hinted`could not confirm that GitHub reflects PR #${String(created.pullRequest)} in the readiness of ${displayReference(target.ref, context.home)}; its column was not moved; run ${commandHint(['board', 'sync'])} later to move it`)
  }
}

/**
head の Issue を待つ Issue を読み、判定に合わせてボードの列と札を動かす。読むのは、待つ Issue のボードの項目だけ
*/
export async function moveWaitingIssues(out: Readonly<Output>, client: GitHubClient, config: ProjectConfig, created: CreatedPullRequest): Promise<void> {
  const context: BoardContext = { out, client, config, home: homeRepositoryOf(config) }
  const waiting: Waiting = { context, created, head: createIssueReference(created.repository, created.issueNumber) }
  const read = await readWaitingIssues(waiting)
  if (read === undefined) return
  try {
    if (read.issues.length > 0) await moveWaiting(waiting, read.issues)
  }
  catch (error: unknown) {
    out.warning(`could not move the Issues waiting for ${displayReference(waiting.head, context.home)}: ${apiFailureMessage(error)}`)
  }
  if (read.partial !== undefined) out.warning(read.partial)
}
