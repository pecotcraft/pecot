/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// pr create の後に、head の Issue を待つ Issue（blocking）の列と札を、判定で動かす。
// どの失敗も warning にとどめ、終了コードを変えない。
import type { MissingValue } from '../domain/board-move.js'
import { homeRepositoryOf } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import type { BoardItem, BoardProgress } from '../domain/format.js'
import { describeReadiness, displayReference } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { boardMoveOf, judgeBoard, missingWarning, SYNCED_COLUMNS } from './board-judgment.js'
import type { JudgedTarget } from './board-judgment.js'
import { applyBoardMove } from './issue-board.js'
import type { Output } from './output.js'
import { readBoard } from './board-view.js'

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

function messageOf(error: unknown): string {
  if (error instanceof GitHubAPIError) return error.message
  throw error
}

// 判定の前提の中の head の Issue に、作った PR が出ているか
function hasCreatedPullRequest(judged: JudgedTarget, created: CreatedPullRequest): boolean {
  if (created.pullRequest === undefined || judged.result.kind !== 'judged') return true
  const headKey = issueReferenceKey(createIssueReference(created.repository, created.issueNumber))
  const prerequisite = judged.result.prerequisites.find(({ issue }) => issueReferenceKey(issue.ref) === headKey)
  return prerequisite?.issue.pullRequests.some(pullRequest => pullRequest.number === created.pullRequest) ?? false
}

async function judgeKeys(client: GitHubClient, config: ProjectConfig, items: readonly BoardItem[], progress: ReadonlyMap<string, BoardProgress>, keys: ReadonlySet<string>): Promise<readonly JudgedTarget[] | undefined> {
  return await judgeBoard(client, config, items, progress, { columns: SYNCED_COLUMNS, withoutRead: target => (keys.has(target.key) ? undefined : 'skip') })
}

// GitHub は書いた直後の読み取りの一致を保証しないので、作った PR が出ていない分を 1 回だけ読み直す
async function judgeConfirmed(client: GitHubClient, config: ProjectConfig, items: readonly BoardItem[], progress: ReadonlyMap<string, BoardProgress>, keys: ReadonlySet<string>, created: CreatedPullRequest): Promise<{ readonly confirmed: readonly JudgedTarget[], readonly unconfirmed: readonly JudgedTarget[] } | undefined> {
  const first = await judgeKeys(client, config, items, progress, keys)
  const stale = new Set(first?.filter(judged => !hasCreatedPullRequest(judged, created)).map(judged => judged.target.key))
  const second = stale.size === 0 ? [] : await judgeKeys(client, config, items, progress, stale)
  if (first === undefined || second === undefined) return undefined
  const latest = [...first.filter(judged => !stale.has(judged.target.key)), ...second]
  return { confirmed: latest.filter(judged => hasCreatedPullRequest(judged, created)), unconfirmed: latest.filter(judged => !hasCreatedPullRequest(judged, created)) }
}

interface WaitingKeys {
  readonly keys: ReadonlySet<string>
  /**
  全件読めなかったときの warning の文
  */
  readonly partial: string | undefined
}

async function readWaitingKeys(out: Readonly<Output>, client: GitHubClient, created: CreatedPullRequest, head: IssueReference, home: RepositoryReference | undefined): Promise<WaitingKeys | undefined> {
  const name = displayReference(head, home)
  const failed = `could not read the Issues waiting for ${name}`
  let read: Awaited<ReturnType<GitHubClient['getIssueBlockingReferences']>>
  try {
    read = await client.getIssueBlockingReferences(created.repository.owner, created.repository.repository, created.issueNumber)
  }
  catch (error: unknown) {
    if (error instanceof DependenciesUnsupportedError) return undefined
    out.warning(`${failed}: ${messageOf(error)}`)
    return undefined
  }
  if (read.kind === 'read-failed') {
    out.warning(`${failed}: ${read.reason}`)
    return undefined
  }
  const partial = read.total > read.issues.length ? `read ${String(read.issues.length)} of ${String(read.total)} Issues waiting for ${name}; the rest were not moved` : undefined
  const keys = new Set(read.issues.map(issue => issueReferenceKey(createIssueReference(createRepositoryReference(issue.repository.owner, issue.repository.repository), issue.number))))
  return { keys, partial }
}

/**
head の Issue を待つ Issue を読み、判定に合わせてボードの列と札を動かす。待つ Issue が無ければボードを読まない
*/
export async function moveWaitingIssues(out: Readonly<Output>, client: GitHubClient, config: ProjectConfig, created: CreatedPullRequest): Promise<void> {
  const home = homeRepositoryOf(config)
  const head = createIssueReference(created.repository, created.issueNumber)
  const waiting = await readWaitingKeys(out, client, created, head, home)
  if (waiting === undefined) return
  if (waiting.keys.size > 0) await moveKeys(out, client, config, created, waiting.keys, home, head)
  if (waiting.partial !== undefined) out.warning(waiting.partial)
}

async function moveKeys(out: Readonly<Output>, client: GitHubClient, config: ProjectConfig, created: CreatedPullRequest, keys: ReadonlySet<string>, home: RepositoryReference | undefined, head: IssueReference): Promise<void> {
  let judged: Awaited<ReturnType<typeof judgeConfirmed>>
  try {
    const board = await readBoard(client, config, undefined)
    if (board.isLegacy) return
    judged = await judgeConfirmed(client, config, board.items, board.progress, keys, created)
  }
  catch (error: unknown) {
    out.warning(`could not move the Issues waiting for ${displayReference(head, home)}: ${messageOf(error)}`)
    return
  }
  if (judged === undefined) return
  const missing = new Set<MissingValue>()
  for (const { target, result } of judged.confirmed) {
    const name = displayReference(target.ref, home)
    if (result.kind === 'unreadable') {
      out.warning(`could not judge ${name}: ${result.reason.replaceAll(/\s+/gu, ' ')}`)
      continue
    }
    const move = boardMoveOf(config, target, result)
    const itemId = target.item.id
    if (move === undefined || typeof itemId !== 'string' || result.readiness === undefined) continue
    for (const value of move.missing) missing.add(value)
    await applyBoardMove(out, client, config, itemId, { ref: target.ref, home }, move, describeReadiness(result.readiness, result.prerequisites, target.ref.repository))
  }
  for (const { target } of judged.unconfirmed) {
    out.warning(`could not confirm that GitHub reflects PR #${String(created.pullRequest)} in the readiness of ${displayReference(target.ref, home)}; its column was not moved`)
  }
  if (missing.size > 0) out.warning(missingWarning(missing))
}
