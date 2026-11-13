// 列と札を直す判断（specs/024 の data-model.md の 6）。I/O を持たない純関数だけを置く。

import { NEEDS_ATTENTION_LABEL } from './readiness.js'
import type { Readiness } from './readiness.js'
import type { IssueReference } from './reference-parser.js'

export type MovableColumn = 'Ready' | 'Blocked'
export type LabelValue = 'Needs Attention' | 'Todo'
export type MissingValue = 'Blocked' | 'Needs Attention' | 'Todo'

/**
進行の欄（列）の表示名と設定のキー（`workflow.options.<key>`）の対応
*/
export const COLUMN_CONFIG_KEYS = {
  'Blocked': 'blocked',
  'In Review': 'in_review',
  'Ready': 'ready',
} satisfies Readonly<Record<'Blocked' | 'In Review' | 'Ready', string>>

/**
札（Status）の表示名と設定のキー（`status.options.<key>`）の対応
*/
export const LABEL_CONFIG_KEYS = {
  'Needs Attention': 'needs_attention',
  'Todo': 'todo',
} satisfies Readonly<Record<LabelValue, string>>

export interface BoardMoveInput {
  /**
  open で、着手の対象（kind が task）か。偽なら何も返さない
  */
  readonly eligible: boolean
  /**
  今の列の表示名。ボードに無ければ undefined
  */
  readonly column: string | undefined
  /**
  今の札（Status の表示名）。無ければ undefined
  */
  readonly label: string | undefined
  /**
  着手の跡（ブランチか PR）がある
  */
  readonly hasStarted: boolean
  /**
  前提を 1 つ以上持つ
  */
  readonly hasPrerequisites: boolean
  /**
  着手の可否の判定。読めないときは undefined（何も返さない）
  */
  readonly readiness: Readiness | undefined
  /**
  今の札を自動処理（spec 023）が書いた
  */
  readonly labelWrittenByAutomation: boolean
  /**
  ボードにある値
  */
  readonly available: {
    readonly blocked: boolean
    readonly needsAttention: boolean
    readonly todo: boolean
  }
}

export interface BoardMove {
  readonly column?: {
    readonly from: string
    readonly to: MovableColumn
    /**
    動かす理由の判定。文は describeReadiness で作る
    */
    readonly reason: Readiness
  }
  readonly label?: LabelValue
  /**
  着手の跡があるのに判定が blocked の食い違い
  */
  readonly conflict?: {
    readonly column: string
    /**
    blocked の理由に当たった Issue
    */
    readonly issues: readonly IssueReference[]
  }
  /**
  動かす先の値がボードに無く、動かせなかったもの
  */
  readonly missing: readonly MissingValue[]
}

// Backlog・Pending・Archived は人が置いた列なので、動かさず札も書かない
const RESETTABLE_COLUMNS: ReadonlySet<string> = new Set(['Ready', 'Active', 'In Review'])
const WORKING_COLUMNS: ReadonlySet<string> = new Set(['Ready', 'Blocked', 'Active', 'In Review'])

function blockingIssues(readiness: Readiness): readonly IssueReference[] {
  const { reason } = readiness
  if (reason === undefined) return []
  switch (reason.code) {
    case 'unreadable':
    case 'cycle': {
      return []
    }
    case 'closed-unmerged':
    case 'other-repository':
    case 'diverged': {
      return reason.issues
    }
    case 'waits-merge':
    case 'not-in-review': {
      return reason.issues.map(({ issue }) => issue)
    }
  }
}

const BACK_TO_READY_COLUMNS: ReadonlySet<string> = new Set(['Blocked', 'Active', 'In Review'])

// 着手の跡が無い Issue の列の行き先。動かさないときは undefined
function targetColumn(column: string, kind: Readiness['kind']): MovableColumn | undefined {
  if (kind === 'blocked') return RESETTABLE_COLUMNS.has(column) ? 'Blocked' : undefined
  return BACK_TO_READY_COLUMNS.has(column) ? 'Ready' : undefined
}

function targetLabel(input: BoardMoveInput, readiness: Readiness): LabelValue | undefined {
  if (readiness.needsReview) return input.label === NEEDS_ATTENTION_LABEL ? undefined : 'Needs Attention'
  const isOwnLabel = input.label === NEEDS_ATTENTION_LABEL && !input.labelWrittenByAutomation
  return isOwnLabel && input.hasPrerequisites ? 'Todo' : undefined
}

// 人が置いた列でも、判定が読めないときでもない
function isDecidable(column: string, readiness: Readiness): boolean {
  return WORKING_COLUMNS.has(column) && readiness.reason?.code !== 'unreadable'
}

/**
data-model.md の 6 の 2 つの表を当てはめる。
対象でない・ボードに無い・判定が読めないときは undefined を返す。
動かす先の値がボードに無いときは動かさず、missing に入れる
*/
export function decideBoardMove(input: BoardMoveInput): BoardMove | undefined {
  const { column, readiness, eligible } = input
  if (!eligible || column === undefined || readiness === undefined || !isDecidable(column, readiness)) return undefined

  const missing: MissingValue[] = []
  let move: BoardMove = { missing }

  if (input.hasStarted) {
    // 着手の跡がある Issue は進めているセッションのものなので、列と札を変えない（FR-084）
    if (readiness.kind === 'blocked' && RESETTABLE_COLUMNS.has(column)) {
      move = { ...move, conflict: { column, issues: blockingIssues(readiness) } }
    }
    return move.conflict === undefined ? undefined : move
  }

  const to = targetColumn(column, readiness.kind)
  if (to !== undefined) {
    if (to === 'Blocked' && !input.available.blocked) missing.push('Blocked')
    else move = { ...move, column: { from: column, to, reason: readiness } }
  }

  const label = targetLabel(input, readiness)
  if (label === 'Needs Attention' && !input.available.needsAttention) missing.push('Needs Attention')
  else if (label === 'Todo' && !input.available.todo) missing.push('Todo')
  else if (label !== undefined) move = { ...move, label }

  return move.column === undefined && move.label === undefined && missing.length === 0 ? undefined : move
}
