import { describe, expect, it } from 'vitest'

import { COLUMN_CONFIG_KEYS, LABEL_CONFIG_KEYS, decideBoardMove } from '../board-move.js'
import type { BoardMoveInput, MovableColumn } from '../board-move.js'
import type { Readiness } from '../readiness.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'

const blockerReferenceerence = createIssueReference(createRepositoryReference('acme', 'app'), 7)

function readinessOf(kind: Readiness['kind'], over: Partial<Readiness> = {}): Readiness {
  return {
    kind,
    stackOn: undefined,
    reason: kind === 'blocked' ? { code: 'waits-merge', issues: [{ issue: blockerReferenceerence, reason: undefined }] } : undefined,
    needsReview: false,
    attention: [],
    ...over,
  }
}

function decide(over: Partial<BoardMoveInput> = {}): ReturnType<typeof decideBoardMove> {
  return decideBoardMove(input(over))
}

function input(over: Partial<BoardMoveInput> = {}): BoardMoveInput {
  return {
    eligible: true,
    column: 'Ready',
    label: 'Todo',
    hasStarted: false,
    hasPrerequisites: true,
    readiness: readinessOf('startable'),
    labelWrittenByAutomation: false,
    available: { blocked: true, needsAttention: true, todo: true },
    ...over,
  }
}

const KINDS: readonly Readiness['kind'][] = ['startable', 'stackable', 'blocked']

describe('decideBoardMove の列', () => {
  const moves: readonly { readonly column: string, readonly kind: Readiness['kind'], readonly to: MovableColumn }[] = [
    { column: 'Ready', kind: 'blocked', to: 'Blocked' },
    { column: 'Blocked', kind: 'startable', to: 'Ready' },
    { column: 'Blocked', kind: 'stackable', to: 'Ready' },
    { column: 'Active', kind: 'blocked', to: 'Blocked' },
    { column: 'In Review', kind: 'blocked', to: 'Blocked' },
    { column: 'Active', kind: 'startable', to: 'Ready' },
    { column: 'Active', kind: 'stackable', to: 'Ready' },
    { column: 'In Review', kind: 'startable', to: 'Ready' },
    { column: 'In Review', kind: 'stackable', to: 'Ready' },
  ]
  it.each(moves)('跡が無い $column × $kind は $to に動かす', ({ column, kind, to }) => {
    const readiness = readinessOf(kind)
    expect(decide({ column, readiness })?.column).toStrictEqual({ from: column, to, reason: readiness })
  })

  const stays: readonly { readonly column: string, readonly kind: Readiness['kind'] }[] = [
    { column: 'Ready', kind: 'startable' },
    { column: 'Ready', kind: 'stackable' },
    { column: 'Blocked', kind: 'blocked' },
  ]
  it.each(stays)('跡が無い $column × $kind は動かさない', ({ column, kind }) => {
    expect(decide({ column, readiness: readinessOf(kind) })).toBeUndefined()
  })

  it.each(['Backlog', 'Pending', 'Archived'])('%s はどの判定でも動かさない', (column) => {
    for (const kind of KINDS) {
      expect(decide({ column, readiness: readinessOf(kind, { needsReview: true }) })).toBeUndefined()
    }
  })

  it.each(['Ready', 'Blocked', 'Active', 'In Review'])('跡がある %s は、どの判定でも列を動かさない', (column) => {
    for (const kind of KINDS) {
      expect(decide({ column, hasStarted: true, readiness: readinessOf(kind) })?.column).toBeUndefined()
    }
  })

  it.each(['Ready', 'Active', 'In Review'])('跡がある %s が blocked なら、食い違いを返す', (column) => {
    expect(decide({ column, hasStarted: true, readiness: readinessOf('blocked') })).toStrictEqual({
      conflict: { column, issues: [blockerReferenceerence] },
      missing: [],
    })
  })

  it('跡がある Blocked が blocked なら、食い違いではない', () => {
    expect(decide({ column: 'Blocked', hasStarted: true, readiness: readinessOf('blocked') })).toBeUndefined()
  })

  it('ボードに無い Issue は動かさない', () => {
    expect(decide({ column: undefined, readiness: readinessOf('blocked') })).toBeUndefined()
  })

  it('対象でない Issue は何も返さない', () => {
    expect(decide({ eligible: false, readiness: readinessOf('blocked') })).toBeUndefined()
  })

  it('判定が読めないときは何も返さない', () => {
    expect(decide({ readiness: undefined })).toBeUndefined()
    expect(decide({ readiness: readinessOf('blocked', { reason: { code: 'unreadable' } }) })).toBeUndefined()
  })

  it('Blocked の列が無いボードでは動かさず、missing に入れる', () => {
    expect(decide({ readiness: readinessOf('blocked'), available: { blocked: false, needsAttention: true, todo: true } })).toStrictEqual({ missing: ['Blocked'] })
  })

  it('Blocked の列が無くても、Ready に戻す動きは止めない', () => {
    const move = decide({ column: 'Active', available: { blocked: false, needsAttention: true, todo: true } })
    expect(move?.column?.to).toBe('Ready')
    expect(move?.missing).toStrictEqual([])
  })
})

describe('decideBoardMove の札', () => {
  it.each(['Todo', undefined, 'In Progress'])('跡が無く要見直しで、札の値が %s なら Needs Attention を書く', (label) => {
    const move = decide({ column: 'Blocked', label, readiness: readinessOf('blocked', { needsReview: true }) })
    expect(move?.label).toBe('Needs Attention')
  })

  it('跡が無く要見直しで、札の値が Needs Attention なら書かない', () => {
    expect(decide({ column: 'Blocked', label: 'Needs Attention', readiness: readinessOf('blocked', { needsReview: true }) })).toBeUndefined()
  })

  it('見直しが要らなくなり、札が Needs Attention なら Todo に戻す', () => {
    expect(decide({ column: 'Blocked', label: 'Needs Attention', readiness: readinessOf('startable') })).toStrictEqual({
      column: { from: 'Blocked', to: 'Ready', reason: readinessOf('startable') },
      label: 'Todo',
      missing: [],
    })
  })

  it('Needs Attention を自動処理が書いたときは Todo に戻さない', () => {
    const move = decide({ column: 'Ready', label: 'Needs Attention', labelWrittenByAutomation: true })
    expect(move).toBeUndefined()
  })

  it('前提の無い Issue の Needs Attention は Todo に戻さない', () => {
    expect(decide({ column: 'Ready', label: 'Needs Attention', hasPrerequisites: false })).toBeUndefined()
  })

  it('跡があれば札を書かない', () => {
    const move = decide({ column: 'Active', label: 'Todo', hasStarted: true, readiness: readinessOf('startable', { needsReview: true }) })
    expect(move).toBeUndefined()
  })

  it('Needs Attention の札が無いボードでは書かず、missing に入れる', () => {
    const move = decide({ column: 'Blocked', readiness: readinessOf('blocked', { needsReview: true }), available: { blocked: true, needsAttention: false, todo: true } })
    expect(move).toStrictEqual({ missing: ['Needs Attention'] })
  })

  it('Todo の札が無いボードでは書かず、missing に入れる', () => {
    const move = decide({ column: 'Ready', label: 'Needs Attention', available: { blocked: true, needsAttention: true, todo: false } })
    expect(move).toStrictEqual({ missing: ['Todo'] })
  })
})

describe('設定のキーの対応', () => {
  it('列と札の表示名を設定のキーに対応づける', () => {
    expect(COLUMN_CONFIG_KEYS).toStrictEqual({ 'Blocked': 'blocked', 'In Review': 'in_review', 'Ready': 'ready' })
    expect(LABEL_CONFIG_KEYS).toStrictEqual({ 'Needs Attention': 'needs_attention', 'Todo': 'todo' })
  })
})
