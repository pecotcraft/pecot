import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

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
  it.each(moves)('作業の跡が存在しない Issue で、列 $column と判定 $kind の組み合わせは、$to に動かす', async ({ column, kind, to }) => {
    await explains(`Issue をボードのどの列へ動かすか決める関数（\`decideBoardMove\`）のテストです。作業の跡が存在しない Issue の、列 \`${column}\` と判定 \`${kind}\` の組み合わせでは、\`${to}\` へ動かすことを確認します。`)
    const readiness = stepSync('`readinessOf` を呼ぶ', () => readinessOf(kind))

    stepSync('結果を比べる', () => {
      expect(decide({ column, readiness })?.column).toStrictEqual({ from: column, to, reason: readiness })
    })
  })

  const stays: readonly { readonly column: string, readonly kind: Readiness['kind'] }[] = [
    { column: 'Ready', kind: 'startable' },
    { column: 'Ready', kind: 'stackable' },
    { column: 'Blocked', kind: 'blocked' },
  ]
  it.each(stays)('作業の跡が存在しない Issue で、列 $column と判定 $kind の組み合わせは、動かさない', async ({ column, kind }) => {
    await explains(`Issue をボードのどの列へ動かすか決める関数（\`decideBoardMove\`）のテストです。作業の跡が存在しない Issue の、列 \`${column}\` と判定 \`${kind}\` の組み合わせでは、列を動かさず \`undefined\` を返すことを確認します。`)
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ column, readiness: readinessOf(kind) })).toBeUndefined()
    })
  })

  it.each(['Backlog', 'Pending', 'Archived'])('列が %s の場合は、どの判定でも動かさない', async (column) => {
    await explains('列が `Backlog`・`Pending`・`Archived` の Issue のテストです。要見直しの判定でも、判定の種類にかかわらず、動かさず `undefined` を返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      for (const kind of KINDS) {
        expect(decide({ column, readiness: readinessOf(kind, { needsReview: true }) })).toBeUndefined()
      }
    })
  })

  it.each(['Ready', 'Blocked', 'Active', 'In Review'])('作業の跡がある場合は、列が %s でも、どの判定でも列を動かさない', async (column) => {
    await explains('作業の跡がある Issue のテストです。列が `Ready`・`Blocked`・`Active`・`In Review` のいずれでも、判定の種類にかかわらず、列の移動を返さないことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      for (const kind of KINDS) {
        expect(decide({ column, hasStarted: true, readiness: readinessOf(kind) })?.column).toBeUndefined()
      }
    })
  })

  it.each(['Ready', 'Active', 'In Review'])('作業の跡があり、列 %s と判定 blocked の組み合わせは、食い違いを返す', async (column) => {
    await explains('作業の跡があり、判定が `blocked` の Issue のテストです。列が `Ready`・`Active`・`In Review` のとき、列を動かさず、待っている前提とともに食い違い（`conflict`）を返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ column, hasStarted: true, readiness: readinessOf('blocked') })).toStrictEqual({
        conflict: { column, issues: [blockerReferenceerence] },
        missing: [],
      })
    })
  })

  it('作業の跡があり、列 Blocked と判定 blocked の組み合わせは、食い違いとして扱わない', async () => {
    await explains('作業の跡があり、列 `Blocked` と判定 `blocked` の Issue のテストです。列と判定が一致しているため、食い違いを返さず `undefined` を返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ column: 'Blocked', hasStarted: true, readiness: readinessOf('blocked') })).toBeUndefined()
    })
  })

  it('ボードに追加されていない Issue は、動かさない', async () => {
    await explains('ボードに追加されていない Issue のテストです。列が存在しないため、判定が `blocked` でも、`undefined` を返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ column: undefined, readiness: readinessOf('blocked') })).toBeUndefined()
    })
  })

  it('対象外の Issue は、何も返さない', async () => {
    await explains('対象外の Issue のテストです。判定が `blocked` でも、`undefined` を返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ eligible: false, readiness: readinessOf('blocked') })).toBeUndefined()
    })
  })

  it('判定を取得できない場合は、何も返さない', async () => {
    await explains('判定を取得できない Issue のテストです。判定が存在しない場合も、判定の理由が `unreadable` の場合も、`undefined` を返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ readiness: undefined })).toBeUndefined()
      expect(decide({ readiness: readinessOf('blocked', { reason: { code: 'unreadable' } }) })).toBeUndefined()
    })
  })

  it('Blocked の列が存在しないボードでは、動かさずに missing へ入れる', async () => {
    await explains('`Blocked` の列が存在しないボードのテストです。判定が `blocked` の Issue は動かさず、不足している列として `Blocked` を `missing` に入れて返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ readiness: readinessOf('blocked'), available: { blocked: false, needsAttention: true, todo: true } })).toStrictEqual({ missing: ['Blocked'] })
    })
  })

  it('Blocked の列が存在しなくても、Ready に戻す動きは止めない', async () => {
    await explains('`Blocked` の列が存在しないボードのテストです。列が `Active` で、判定が着手できる場合は、`Ready` へ戻す動きを返し、`missing` は空であることを確認します。')
    const move = stepSync('`decide` を呼ぶ', () => decide({ column: 'Active', available: { blocked: false, needsAttention: true, todo: true } }))

    stepSync('結果を比べる', () => {
      expect(move?.column?.to).toBe('Ready')
      expect(move?.missing).toStrictEqual([])
    })
  })
})

describe('decideBoardMove の札', () => {
  it.each(['Todo', undefined, 'In Progress'])('作業の跡が存在せず要見直しで、札の値が %s の場合は、Needs Attention を書き込む', async (label) => {
    await explains('作業の跡が存在せず、要見直しと判定された Issue のテストです。札の値が `Todo`・`In Progress`・存在しない場合のいずれでも、札に `Needs Attention` を書き込むことを確認します。')
    const move = stepSync('`decide` を呼ぶ', () => decide({ column: 'Blocked', label, readiness: readinessOf('blocked', { needsReview: true }) }))

    stepSync('結果を比べる', () => {
      expect(move?.label).toBe('Needs Attention')
    })
  })

  it('作業の跡が存在せず要見直しで、札の値が Needs Attention の場合は、書き込まない', async () => {
    await explains('作業の跡が存在せず、要見直しと判定された Issue のテストです。札がすでに `Needs Attention` の場合は、何も書き込まず `undefined` を返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ column: 'Blocked', label: 'Needs Attention', readiness: readinessOf('blocked', { needsReview: true }) })).toBeUndefined()
    })
  })

  it('見直しが不要になり、札が Needs Attention の場合は、Todo に戻す', async () => {
    await explains('札が `Needs Attention` の `Blocked` の Issue が、着手できる状態になった場合のテストです。列を `Ready` へ動かし、札も `Todo` に戻すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ column: 'Blocked', label: 'Needs Attention', readiness: readinessOf('startable') })).toStrictEqual({
        column: { from: 'Blocked', to: 'Ready', reason: readinessOf('startable') },
        label: 'Todo',
        missing: [],
      })
    })
  })

  it('Needs Attention を自動処理が書いた場合は、Todo に戻さない', async () => {
    await explains('札の `Needs Attention` を、自動処理が書いた場合のテストです。人の見直しを待っているため、`Todo` に戻さず `undefined` を返すことを確認します。')
    const move = stepSync('`decide` を呼ぶ', () => decide({ column: 'Ready', label: 'Needs Attention', labelWrittenByAutomation: true }))

    stepSync('結果を比べる', () => {
      expect(move).toBeUndefined()
    })
  })

  it('前提を持たない Issue の Needs Attention は、Todo に戻さない', async () => {
    await explains('前提を持たない Issue の札が `Needs Attention` の場合のテストです。前提の判定とは関係がないため、`Todo` に戻さず `undefined` を返すことを確認します。')
    stepSync('`decide` を呼び、結果を比べる', () => {
      expect(decide({ column: 'Ready', label: 'Needs Attention', hasPrerequisites: false })).toBeUndefined()
    })
  })

  it('作業の跡がある場合は、札を書き込まない', async () => {
    await explains('作業の跡がある Issue が、要見直しと判定された場合のテストです。札は書き込まず、`undefined` を返すことを確認します。')
    const move = stepSync('`decide` を呼ぶ', () => decide({ column: 'Active', label: 'Todo', hasStarted: true, readiness: readinessOf('startable', { needsReview: true }) }))

    stepSync('結果を比べる', () => {
      expect(move).toBeUndefined()
    })
  })

  it('Needs Attention の札が存在しないボードでは、書き込まずに missing へ入れる', async () => {
    await explains('札の `Needs Attention` が存在しないボードのテストです。要見直しの Issue でも札は書き込まず、不足している札として `Needs Attention` を `missing` に入れて返すことを確認します。')
    const move = stepSync('`decide` を呼ぶ', () => decide({ column: 'Blocked', readiness: readinessOf('blocked', { needsReview: true }), available: { blocked: true, needsAttention: false, todo: true } }))

    stepSync('結果を比べる', () => {
      expect(move).toStrictEqual({ missing: ['Needs Attention'] })
    })
  })

  it('Todo の札が存在しないボードでは、書き込まずに missing へ入れる', async () => {
    await explains('札の `Todo` が存在しないボードのテストです。札を戻す場合でも書き込まず、不足している札として `Todo` を `missing` に入れて返すことを確認します。')
    const move = stepSync('`decide` を呼ぶ', () => decide({ column: 'Ready', label: 'Needs Attention', available: { blocked: true, needsAttention: true, todo: false } }))

    stepSync('結果を比べる', () => {
      expect(move).toStrictEqual({ missing: ['Todo'] })
    })
  })
})

describe('設定のキーの対応', () => {
  it('列と札の表示名を、設定のキーに対応づける', async () => {
    await explains('列と札の表示名の対応表（`COLUMN_CONFIG_KEYS`・`LABEL_CONFIG_KEYS`）のテストです。表示名が、設定ファイルのキー（`in_review` など）に対応づけられていることを確認します。')
    stepSync('結果を比べる', () => {
      expect(COLUMN_CONFIG_KEYS).toStrictEqual({ 'Blocked': 'blocked', 'In Review': 'in_review', 'Ready': 'ready' })
      expect(LABEL_CONFIG_KEYS).toStrictEqual({ 'In Progress': 'in_progress', 'Needs Attention': 'needs_attention', 'Todo': 'todo' })
    })
  })
})
