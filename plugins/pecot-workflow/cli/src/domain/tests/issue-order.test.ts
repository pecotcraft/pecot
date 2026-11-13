import { describe, expect, it } from 'vitest'

import { findBatchDuplicate, planOrders, usedOrdersOf } from '../issue-order.js'
import type { UsedOrder } from '../issue-order.js'

const sub = (number: number, title: string): { number: number, state: string, title: string } => ({ number, state: 'OPEN', title })
const used = (order: number, number = order + 100): UsedOrder => ({ number, state: 'OPEN', title: `#3-${String(order).padStart(2, '0')}: 既存`, order })

describe('usedOrdersOf', () => {
  it('タイトルが親 Epic の番号付きのサブタスクだけを、番号にして返す', () => {
    const result = usedOrdersOf([sub(9, '#3-02: a'), sub(10, '#4-05: 別の Epic'), sub(11, '番号の無いタイトル'), sub(12, '[Task] #3-07: b')], 3)
    expect(result.map(({ number, order }) => [number, order])).toEqual([[9, 2], [12, 7]])
  })

  it.for([
    { title: '[Task] #353-04a: a', expected: [4] },
    { title: '#3-02: a', expected: [2] },
    { title: 'Fix #3-4: foo', expected: [] },
    { title: 'Fix #3-04: foo', expected: [] },
  ])('タイトル $title は、先頭の番号だけを数える', ({ title, expected }) => {
    expect(usedOrdersOf([sub(9, title)], title.includes('#353') ? 353 : 3).map(({ order }) => order)).toEqual(expected)
  })

  it('枝の文字（18a）は数えず、数字の部分を番号にする', () => {
    expect(usedOrdersOf([sub(9, '#3-18a: a'), sub(10, '#3-18b: b')], 3).map(({ order }) => order)).toEqual([18, 18])
  })
})

describe('planOrders', () => {
  it('番号を省いたファイルに、既存の最大の次から、ファイルの順に振る', () => {
    const plan = planOrders([used(1), used(7)], [{ file: 'a.md', order: undefined }, { file: 'b.md', order: undefined }])
    expect(plan).toEqual({ kind: 'planned', orders: [8, 9] })
  })

  it('既存が無ければ 1 から振る', () => {
    expect(planOrders([], [{ file: 'a.md', order: undefined }])).toEqual({ kind: 'planned', orders: [1] })
  })

  it('明示の番号はそのまま使い、起点は明示の番号の最大の次にもなる', () => {
    const plan = planOrders([used(2)], [{ file: 'a.md', order: undefined }, { file: 'b.md', order: 10 }, { file: 'c.md', order: undefined }])
    expect(plan).toEqual({ kind: 'planned', orders: [11, 10, 12] })
  })

  it('明示の番号が既存の番号と重なると、既存の Issue と次の空きを返す', () => {
    const plan = planOrders([used(1), used(2, 9)], [{ file: 'a.md', order: 2 }])
    expect(plan).toEqual({ kind: 'duplicate-existing', order: 2, existing: used(2, 9), nextAvailable: 3 })
  })

  it('案内の次の空きは、自動の採番と同じく既存と明示の最大の次になる', () => {
    const plan = planOrders([used(1), used(2, 9), used(5)], [{ file: 'a.md', order: 2 }])
    expect(plan).toEqual({ kind: 'duplicate-existing', order: 2, existing: used(2, 9), nextAvailable: 6 })
  })

  it('明示の番号が一括の中で重なると、そのファイルを返す', () => {
    const plan = planOrders([], [{ file: 'a.md', order: 4 }, { file: 'b.md', order: undefined }, { file: 'c.md', order: 4 }])
    expect(plan).toEqual({ kind: 'duplicate-in-batch', order: 4, files: ['a.md', 'c.md'] })
  })

  it('使われた番号を読めず、番号を省いたファイルがあると、決められない', () => {
    expect(planOrders(undefined, [{ file: 'a.md', order: 1 }, { file: 'b.md', order: undefined }])).toEqual({ kind: 'unreadable-parent' })
  })

  it('使われた番号を読めなくても、すべて明示の番号なら、そのまま返す', () => {
    expect(planOrders(undefined, [{ file: 'a.md', order: 1 }, { file: 'b.md', order: 3 }])).toEqual({ kind: 'planned', orders: [1, 3] })
  })
})

describe('findBatchDuplicate', () => {
  it('一括の中で重なる明示の番号と、そのファイルを返す', () => {
    expect(findBatchDuplicate([{ file: 'a.md', order: 4 }, { file: 'b.md', order: undefined }, { file: 'c.md', order: 4 }])).toEqual({ order: 4, files: ['a.md', 'c.md'] })
  })

  it('重なりが無ければ undefined を返す', () => {
    expect(findBatchDuplicate([{ file: 'a.md', order: 4 }, { file: 'b.md', order: undefined }])).toBeUndefined()
  })
})
