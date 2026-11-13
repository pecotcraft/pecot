/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 引数の型は readonly にできない */
// ボードの Issue の読み取り・判定と、列と札の動かし方。project info（数えるだけ）と board sync（書く）が共有する。
import { decideBoardMove } from '../domain/board-move.js'
import type { BoardMove } from '../domain/board-move.js'
import { getOptionId } from '../domain/config.js'
import type { ProjectConfig } from '../domain/config.js'
import { boardItemKey } from '../domain/format.js'
import type { BoardItem, BoardProgress } from '../domain/format.js'
import { cycleThrough, hasStarted, TRACKER_TITLE_PREFIX } from '../domain/readiness.js'
import { createIssueReference, issueReferenceKey } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { createRepositoryReference, splitOwnerRepository } from '../domain/repository-resolver.js'
import { DependenciesUnsupportedError, GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'
import { blockedByReadCount, createReadinessCache, judgeSnapshot, prerequisiteKeys, readIssueSnapshot } from './issue-readiness.js'
import type { IssueReadiness, IssueSnapshot, JudgedIssue, UnreadableIssue } from './issue-readiness.js'
import { mapWithLimit } from './project-info.js'

/**
前提の読み取りを並列に行う数の上限
*/
const READ_MAX_WORKERS = 8

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
