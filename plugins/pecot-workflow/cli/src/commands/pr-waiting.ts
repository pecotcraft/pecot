/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// pr create と session finish の後に、head の Issue を待つ Issue（blocking）の列と札を、判定で動かす。
// どの失敗も warning にとどめ、終了コードを変えない。
import { setTimeout as delay } from 'node:timers/promises'

import { homeRepositoryOf, workflowFieldId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { boardItemKey } from '../domain/format.js'
import type { BoardItem } from '../domain/format.js'
import type { BlockedByReference } from '../domain/issue-readout.js'
import { displayReference } from '../domain/readiness.js'
import type { Prerequisite } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubNotFoundError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { applyJudgedMoves, judgeBoard, SYNCED_COLUMNS } from './board-judgment.js'
import type { BoardContext, JudgedTarget } from './board-judgment.js'
import { mapWithLimit } from './board-view.js'
import { commandHint, hinted, RUN } from './command-hint.js'
import type { HintedText } from './command-hint.js'
import { apiFailureMessage } from './github-client.js'
import type { BoardMoveLine } from './issue-board.js'
import type { FieldHintState } from './field-write-failure.js'
import { createReadinessCache } from './issue-readiness.js'
import type { JudgedIssue, ReadinessCache } from './issue-readiness.js'
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

/**
待つ Issue の判定に、呼ぶ側の変化（作った PR・閉じた Issue）が出ているかの確かめ方
*/
export interface WaitingCheck {
  readonly isReflected: (judged: JudgedIssue) => boolean
  /**
  読み直しても出ないときの warning の文。name は待つ Issue の表記
  */
  readonly unconfirmed: (name: string) => HintedText
  /**
  列と札を動かす前に、判定を置き換える
  */
  readonly assume?: (judged: JudgedTarget) => Promise<JudgedTarget>
}

export interface WaitingOptions {
  /**
  待たれている Issue。並びの順に読む
  */
  readonly heads: readonly IssueReference[]
  readonly check: WaitingCheck
  readonly isDryRun: boolean
  readonly cache: ReadinessCache
  /**
  選択肢の ID を読み直す案内を 1 回だけ出すための印。省くと applyJudgedMoves が 1 つ作る
  */
  readonly fieldHint?: FieldHintState
}

interface Waiting {
  readonly context: Readonly<BoardContext>
  readonly options: WaitingOptions
}

/**
判定の前提のうち、issue の前提
*/
export function prerequisiteOf(judged: JudgedIssue, issue: IssueReference): Prerequisite | undefined {
  const key = issueReferenceKey(issue)
  return judged.prerequisites.find(({ issue: other }) => issueReferenceKey(other.ref) === key)
}

function isConfirmed(judged: JudgedTarget, waiting: Readonly<Waiting>): boolean {
  return judged.result.kind !== 'judged' || waiting.options.check.isReflected(judged.result)
}

async function judgeKeys(waiting: Readonly<Waiting>, items: readonly BoardItem[], keys: ReadonlySet<string>): Promise<readonly JudgedTarget[] | undefined> {
  const { context: { client, config }, options: { cache } } = waiting
  return await judgeBoard(client, config, items, new Map(), { columns: SYNCED_COLUMNS, withoutRead: target => (keys.has(target.key) ? undefined : 'skip'), cache })
}

interface Confirmed {
  readonly confirmed: readonly JudgedTarget[]
  readonly unconfirmed: readonly JudgedTarget[]
}

// 変化が判定に出ていない分を、少し待ってから 1 回だけ読み直す
async function judgeConfirmed(waiting: Readonly<Waiting>, items: readonly BoardItem[]): Promise<Confirmed | undefined> {
  const first = await judgeKeys(waiting, items, new Set(items.flatMap(item => boardItemKey(item) ?? [])))
  if (first === undefined) return undefined
  const stale = new Set(first.filter(judged => !isConfirmed(judged, waiting)).map(judged => judged.target.key))
  if (stale.size > 0) await delay(RECHECK_DELAY_MILLISECONDS)
  const second = stale.size === 0 ? [] : await judgeKeys(waiting, items, stale)
  if (second === undefined) return undefined
  const latest = [...first.filter(judged => !stale.has(judged.target.key)), ...second]
  return { confirmed: latest.filter(judged => isConfirmed(judged, waiting)), unconfirmed: latest.filter(judged => !isConfirmed(judged, waiting)) }
}

interface WaitingIssues {
  readonly issues: readonly BlockedByReference[]
  /**
  全件読めなかったときの warning の文
  */
  readonly partial: string | undefined
}

// head の Issue が PR のリポに無いとき（集約リポの運用・番号が Issue でないブランチ）と、依存関係に対応しない GHES では、何も出さない
async function readWaitingIssues(context: Readonly<BoardContext>, head: IssueReference): Promise<WaitingIssues | undefined> {
  const { out, client, home } = context
  const name = displayReference(head, home)
  const failed = `could not read the Issues waiting for ${name}`
  let read: Awaited<ReturnType<GitHubClient['getIssueBlockingReferences']>>
  try {
    read = await client.getIssueBlockingReferences(head.repository.owner, head.repository.repository, head.number)
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
  const field = workflowFieldId(config)
  const open = issues.filter(issue => issue.state === 'OPEN')
  const items = await mapWithLimit(open, READ_MAX_WORKERS, async ({ repository, number }) => await client.getIssueBoardItem(config.project.id, repository.owner, repository.repository, number, field))
  return items.flatMap(item => item ?? [])
}

async function moveWaiting(waiting: Readonly<Waiting>, issues: readonly BlockedByReference[], moves: BoardMoveLine[]): Promise<readonly JudgedTarget[]> {
  const { context, options } = waiting
  const items = await readBoardItems(waiting, issues)
  if (items.length === 0) return []
  const judged = await judgeConfirmed(waiting, items)
  if (judged === undefined) return []
  const { assume } = options.check
  const confirmed = assume === undefined ? judged.confirmed : await Promise.all(judged.confirmed.map(async target => await assume(target)))
  await applyJudgedMoves(context, confirmed, options.isDryRun, moves, options.fieldHint)
  for (const { target } of judged.unconfirmed) context.out.warning(options.check.unconfirmed(displayReference(target.ref, context.home)))
  return confirmed
}

function uniqueIssues(issues: readonly BlockedByReference[]): readonly BlockedByReference[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = issueReferenceKey(createIssueReference(issue.repository, issue.number))
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
heads を待つ Issue を読み、判定に合わせてボードの列と札を動かす。読むのは、待つ Issue のボードの項目だけ。
動かした列と札を moves に足していき、確かめた判定（assume の後）を返す。途中で例外が出ても、書けた分は moves に残る
*/
export async function moveIssuesWaitingFor(context: Readonly<BoardContext>, options: WaitingOptions, moves: BoardMoveLine[] = []): Promise<readonly JudgedTarget[]> {
  const waiting: Waiting = { context, options }
  const reads: WaitingIssues[] = []
  for (const head of options.heads) {
    const read = await readWaitingIssues(context, head)
    if (read !== undefined) reads.push(read)
  }
  const issues = uniqueIssues(reads.flatMap(read => read.issues))
  let judged: readonly JudgedTarget[] = []
  try {
    if (issues.length > 0) judged = await moveWaiting(waiting, issues, moves)
  }
  catch (error: unknown) {
    const names = options.heads.map(head => displayReference(head, context.home)).join(', ')
    context.out.warning(`could not move the Issues waiting for ${names}: ${apiFailureMessage(error)}`)
  }
  for (const { partial } of reads) {
    if (partial !== undefined) context.out.warning(partial)
  }
  return judged
}

/**
pr create の後に、head の Issue を待つ Issue の列と札を動かす。作った PR が判定に出るまで 1 回だけ読み直す。
動かした列と札（moved: と set: の行の値）を moves に足していき、それを返す。fieldHint は、in_review の書き込みと同じ印を渡す
*/
export async function moveWaitingIssues(out: Readonly<Output>, client: GitHubClient, config: ProjectConfig, created: CreatedPullRequest, fieldHint: FieldHintState, moves: BoardMoveLine[] = []): Promise<readonly BoardMoveLine[]> {
  const context: BoardContext = { out, client, config, home: homeRepositoryOf(config) }
  const head = createIssueReference(created.repository, created.issueNumber)
  const check: WaitingCheck = {
    isReflected: judged => created.pullRequest === undefined || (prerequisiteOf(judged, head)?.issue.pullRequests.some(pullRequest => pullRequest.number === created.pullRequest) ?? false),
    unconfirmed: name => hinted`could not confirm that GitHub reflects PR #${String(created.pullRequest)} in the readiness of ${name}; its column was not moved; ${RUN} ${commandHint(['board', 'sync'])} later to move it`,
  }
  await moveIssuesWaitingFor(context, { heads: [head], check, isDryRun: false, cache: createReadinessCache(), fieldHint }, moves)
  return moves
}
