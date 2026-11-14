/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// ボードの Issue の読み取り・判定と、列と札の動かし方。board show（数えるだけ）と、board sync・pr create（書く）が共有する。
import { decideBoardMove } from '../domain/board-move.js'
import type { BoardMove, MissingValue } from '../domain/board-move.js'
import { getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { boardItemKey } from '../domain/format.js'
import type { BoardItem, BoardProgress } from '../domain/format.js'
import { compareStrings } from '../domain/python-format.js'
import { cycleThrough, describeReadiness, displayReference, hasStarted, TRACKER_TITLE_PREFIX } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference, splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { blockedByReadCount, createReadinessCache, judgeSnapshot, prerequisiteKeys, readIssueSnapshot } from './issue-readiness.js'
import type { IssueReadiness, IssueSnapshot, JudgedIssue, UnreadableIssue } from './issue-readiness.js'
import { mapWithLimit } from './board-view.js'
import { applyBoardMove, planBoardMove } from './issue-board.js'
import type { Output } from './output.js'

/**
前提の読み取りを並列に行う数の上限
*/
const READ_MAX_WORKERS = 8

/**
board sync と pr create が判定し直す列
*/
export const SYNCED_COLUMNS: ReadonlySet<string> = new Set(['Ready', 'Blocked', 'Active', 'In Review'])

/**
動かす先の値がボードに無いときの warning の文
*/
export function missingWarning(missing: ReadonlySet<MissingValue>): string {
  const names = [...missing].toSorted(compareStrings)
  return `the board has no option ${names.join(', ')}; add ${names.length === 1 ? 'it' : 'them'} with pecot project init`
}

export interface BoardTarget {
  readonly item: BoardItem
  readonly key: string
  readonly ref: IssueReference
}

export interface JudgedTarget {
  readonly target: BoardTarget
  readonly result: IssueReadiness
}

export interface JudgeBoardOptions {
  /**
  判定の対象にする列
  */
  readonly columns: ReadonlySet<string>
  /**
  個別の読み取りを省く Issue。'skip' は判定から外し、IssueSnapshot は一覧の値だけで判定し、undefined は個別に読む
  */
  readonly withoutRead: (target: BoardTarget, progress: BoardProgress | undefined) => IssueSnapshot | 'skip' | undefined
}

// 対象の列の Issue か。PR と Tracker は対象にしない
function toTarget(item: BoardItem, columns: ReadonlySet<string>): BoardTarget | undefined {
  const key = boardItemKey(item)
  const split = splitOwnerRepository(item.content.repository ?? '')
  const { number } = item.content
  const url = typeof item.content.url === 'string' ? item.content.url : ''
  const title = typeof item.title === 'string' ? item.title : ''
  const isExcluded = url.includes('/pull/') || title.startsWith(TRACKER_TITLE_PREFIX)
  const isTarget = !isExcluded && typeof item.workflow === 'string' && columns.has(item.workflow) && key !== undefined && split !== undefined && typeof number === 'number'
  return isTarget ? { item, key, ref: createIssueReference(createRepositoryReference(split.owner, split.repository), number) } : undefined
}

/**
対象の列の Issue の前提と着手の跡を読み、輪も含めて判定する。
Issue の依存関係に対応しない GHES では undefined を返す。warning は呼ぶ側が出す
*/
export async function judgeBoard(client: GitHubClient, config: ProjectConfig, items: readonly BoardItem[], progress: ReadonlyMap<string, BoardProgress>, options: JudgeBoardOptions): Promise<readonly JudgedTarget[] | undefined> {
  type Snapshot = IssueSnapshot | UnreadableIssue
  const targets = items.flatMap(item => toTarget(item, options.columns) ?? [])
  const state = { isUnsupported: false }
  const reads = await mapWithLimit(targets, READ_MAX_WORKERS, async (target): Promise<{ target: BoardTarget, snapshot: Snapshot } | undefined> => {
    if (state.isUnsupported) return undefined
    const known = progress.get(target.key)
    const local = options.withoutRead(target, known)
    if (local === 'skip') return undefined
    if (local !== undefined) return { target, snapshot: local }
    try {
      return { target, snapshot: await readIssueSnapshot(client, config, target.ref, blockedByReadCount(known?.blockedBy)) }
    }
    catch (error: unknown) {
      if (!(error instanceof DependenciesUnsupportedError)) throw error
      state.isUnsupported = true
      return undefined
    }
  })
  if (state.isUnsupported) return undefined
  const pairs = reads.flatMap(read => read ?? [])

  const edges = new Map<string, readonly string[]>()
  for (const { target, snapshot } of pairs) {
    if (snapshot.kind === 'snapshot') edges.set(issueReferenceKey(target.ref), prerequisiteKeys(snapshot))
  }

  const cache = createReadinessCache()
  return await mapWithLimit(pairs, READ_MAX_WORKERS, async ({ target, snapshot }): Promise<JudgedTarget> => {
    if (snapshot.kind === 'unreadable') return { target, result: snapshot }
    try {
      return { target, result: await judgeSnapshot(client, snapshot, cache, cycleThrough(issueReferenceKey(target.ref), edges)) }
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return { target, result: { kind: 'unreadable', reason: error.message } }
      throw error
    }
  })
}

/**
列と札を動かす処理が共有する、出力先・クライアント・設定・表示の基準のリポ
*/
export interface BoardContext {
  readonly out: Readonly<Output>
  readonly client: GitHubClient
  readonly config: ProjectConfig
  readonly home: RepositoryReference | undefined
}

/**
判定の結果に合わせて、列と札を動かす。読めない Issue は warning にし、ボードに無い値は最後に 1 行の warning にまとめる。
isDryRun は同じ文を予定の行で出し、書かない。書き込みに失敗した Issue の数を返す
*/
export async function applyJudgedMoves(context: Readonly<BoardContext>, judged: readonly JudgedTarget[], isDryRun = false): Promise<number> {
  const { out, client, config, home } = context
  const missing = new Set<MissingValue>()
  let failures = 0
  for (const { target, result } of judged) {
    if (result.kind === 'unreadable') {
      out.warning(`could not judge ${displayReference(target.ref, home)}: ${result.reason.replaceAll(/\s+/gu, ' ')}`)
      continue
    }
    const { readiness } = result
    const move = boardMoveOf(config, target, result)
    if (readiness === undefined || move === undefined) continue
    for (const value of move.missing) missing.add(value)
    const text = describeReadiness(readiness, result.prerequisites, target.ref.repository)
    const destination = { ref: target.ref, home }
    const itemId = target.item.id
    if (isDryRun) planBoardMove(out, destination, move, text)
    else if (typeof itemId === 'string') {
      const applied = await applyBoardMove(out, client, config, itemId, destination, move, text)
      if (applied.hasFailed) failures += 1
    }
  }
  if (missing.size > 0) out.warning(missingWarning(missing))
  return failures
}

/**
判定から、列と札の動かし方を決める。info の数え方と board sync の書き込みが同じ規則を使う（FR-083）
*/
export function boardMoveOf(config: ProjectConfig, target: BoardTarget, result: JudgedIssue): BoardMove | undefined {
  return decideBoardMove({
    // 常に真でよい。readBoard が返すのは OPEN の Issue だけで、Tracker を対象から外し、Epic の readiness が undefined になる
    eligible: true,
    column: target.item.workflow ?? undefined,
    label: result.target.label,
    hasStarted: hasStarted(result.target),
    hasPrerequisites: result.prerequisites.length > 0,
    readiness: result.readiness,
    // 札を書いたのが自動処理かは記録していない（data-model.md の 6）
    labelWrittenByAutomation: false,
    available: {
      blocked: getOptionId(config, 'workflow', 'blocked') !== undefined,
      needsAttention: getOptionId(config, 'status', 'needs_attention') !== undefined,
      todo: getOptionId(config, 'status', 'todo') !== undefined,
    },
  })
}
