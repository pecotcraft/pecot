import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { findBatchDuplicate, planOrders, usedOrdersOf } from '../issue-order.js'
import type { UsedOrder } from '../issue-order.js'

const sub = (number: number, title: string): { number: number, state: string, title: string } => ({ number, state: 'OPEN', title })
const used = (order: number, number = order + 100): UsedOrder => ({ number, state: 'OPEN', title: `#3-${String(order).padStart(2, '0')}: 既存`, order })

describe('usedOrdersOf', () => {
  it('親 Epic の番号が付いたタイトルのサブタスクだけを、番号にして返す', async () => {
    await explains('サブタスクのタイトルから使用済みの番号を取り出す、`usedOrdersOf` のテストです。親 Epic の番号が付いたタイトルのサブタスクだけを対象に、Issue の番号と使用済みの番号を返し、別の Epic の番号や番号が付いていないタイトルは対象に含めないことを確認します。')
    const result = usedOrdersOf([sub(9, '#3-02: a'), sub(10, '#4-05: 別の Epic'), sub(11, '番号の無いタイトル'), sub(12, '[Task] #3-07: b')], 3)
    expect(result.map(({ number, order }) => [number, order])).toEqual([[9, 2], [12, 7]])
  })

  it.for([
    { title: '[Task] #353-04a: a', expected: [4] },
    { title: '#3-02: a', expected: [2] },
    { title: 'Fix #3-4: foo', expected: [] },
    { title: 'Fix #3-04: foo', expected: [] },
  ])('タイトル $title は、先頭の番号だけを使用済みとして数える', async ({ title, expected }) => {
    await explains(`サブタスクのタイトルから使用済みの番号を取り出す、\`usedOrdersOf\` のテストです。タイトルが \`${title}\` の場合に、先頭の番号だけを使用済みとして数え、\`${JSON.stringify(expected)}\` を返すことを確認します。`)
    expect(usedOrdersOf([sub(9, title)], title.includes('#353') ? 353 : 3).map(({ order }) => order)).toEqual(expected)
  })

  it('枝番の文字（18a の a）は含めず、数字の部分を番号にする', async () => {
    await explains('サブタスクのタイトルから使用済みの番号を取り出す、`usedOrdersOf` のテストです。`#3-18a` や `#3-18b` のように、番号の後ろに枝番の文字が付いたタイトルの場合に、文字を除いた数字の部分を番号として返すことを確認します。')
    expect(usedOrdersOf([sub(9, '#3-18a: a'), sub(10, '#3-18b: b')], 3).map(({ order }) => order)).toEqual([18, 18])
  })
})

describe('planOrders', () => {
  it('番号を省略したファイルには、既存の最大の番号の次から、ファイルの順に番号を振る', async () => {
    await explains('サブタスクへ付ける番号を決める、`planOrders` のテストです。番号を省略したファイルが 2 つあり、既存の最大の番号が 7 の場合に、8 と 9 をファイルの順に振ることを確認します。')
    const plan = planOrders([used(1), used(7)], [{ file: 'a.md', order: undefined }, { file: 'b.md', order: undefined }])
    expect(plan).toEqual({ kind: 'planned', orders: [8, 9] })
  })

  it('既存の番号が存在しない場合は、1 から番号を振る', async () => {
    await explains('サブタスクへ付ける番号を決める、`planOrders` のテストです。使用済みの番号が 1 つもない場合に、番号を省略したファイルへ 1 から振ることを確認します。')
    expect(planOrders([], [{ file: 'a.md', order: undefined }])).toEqual({ kind: 'planned', orders: [1] })
  })

  it('明示した番号はそのまま使い、番号を振る起点は明示した番号の最大の次にもなる', async () => {
    await explains('サブタスクへ付ける番号を決める、`planOrders` のテストです。番号を明示したファイルと省略したファイルが混在する場合に、明示した番号はそのまま使い、省略したファイルには既存と明示した番号の最大の次から振ることを確認します。')
    const plan = planOrders([used(2)], [{ file: 'a.md', order: undefined }, { file: 'b.md', order: 10 }, { file: 'c.md', order: undefined }])
    expect(plan).toEqual({ kind: 'planned', orders: [11, 10, 12] })
  })

  it('明示した番号が既存の番号と重複する場合は、既存の Issue と次に使える番号を返す', async () => {
    await explains('サブタスクへ付ける番号を決める、`planOrders` のテストです。明示した番号が使用済みの番号と重複する場合に、`kind` が `duplicate-existing` で、既存の Issue と次に使える番号を返すことを確認します。')
    const plan = planOrders([used(1), used(2, 9)], [{ file: 'a.md', order: 2 }])
    expect(plan).toEqual({ kind: 'duplicate-existing', order: 2, existing: used(2, 9), nextAvailable: 3 })
  })

  it('案内する次に使える番号は、自動で振る場合と同じく、既存と明示した番号の最大の次になる', async () => {
    await explains('サブタスクへ付ける番号を決める、`planOrders` のテストです。重複を知らせる結果の `nextAvailable` が、省略したファイルへ自動で振る番号と同じく、既存と明示した番号の最大の次の値になることを確認します。')
    const plan = planOrders([used(1), used(2, 9), used(5)], [{ file: 'a.md', order: 2 }])
    expect(plan).toEqual({ kind: 'duplicate-existing', order: 2, existing: used(2, 9), nextAvailable: 6 })
  })

  it('明示した番号が一括の中で重複する場合は、そのファイルを返す', async () => {
    await explains('サブタスクへ付ける番号を決める、`planOrders` のテストです。一括の中で同じ番号を明示したファイルが 2 つある場合に、`kind` が `duplicate-in-batch` の結果と、該当するファイルの名前を返すことを確認します。')
    const plan = planOrders([], [{ file: 'a.md', order: 4 }, { file: 'b.md', order: undefined }, { file: 'c.md', order: 4 }])
    expect(plan).toEqual({ kind: 'duplicate-in-batch', order: 4, files: ['a.md', 'c.md'] })
  })

  it('使用済みの番号を取得できず、番号を省略したファイルがある場合は、番号を決められない', async () => {
    await explains('サブタスクへ付ける番号を決める、`planOrders` のテストです。使用済みの番号を取得できない場合に、番号を省略したファイルがあると、`kind` が `unreadable-parent` の結果を返すことを確認します。')
    expect(planOrders(undefined, [{ file: 'a.md', order: 1 }, { file: 'b.md', order: undefined }])).toEqual({ kind: 'unreadable-parent' })
  })

  it('使用済みの番号を取得できなくても、すべて番号を明示している場合は、そのまま返す', async () => {
    await explains('サブタスクへ付ける番号を決める、`planOrders` のテストです。使用済みの番号を取得できない場合でも、すべてのファイルが番号を明示していれば、明示した番号をそのまま返すことを確認します。')
    expect(planOrders(undefined, [{ file: 'a.md', order: 1 }, { file: 'b.md', order: 3 }])).toEqual({ kind: 'planned', orders: [1, 3] })
  })
})

describe('findBatchDuplicate', () => {
  it('一括の中で重複する明示した番号と、そのファイルを返す', async () => {
    await explains('一括で作成するファイルの番号の重複を検出する、`findBatchDuplicate` のテストです。同じ番号を明示したファイルが 2 つある場合に、その番号と該当するファイルの名前を返すことを確認します。')
    expect(findBatchDuplicate([{ file: 'a.md', order: 4 }, { file: 'b.md', order: undefined }, { file: 'c.md', order: 4 }])).toEqual({ order: 4, files: ['a.md', 'c.md'] })
  })

  it('重複する番号が存在しない場合は、undefined を返す', async () => {
    await explains('一括で作成するファイルの番号の重複を検出する、`findBatchDuplicate` のテストです。番号の重複がない場合に、`undefined` を返すことを確認します。')
    expect(findBatchDuplicate([{ file: 'a.md', order: 4 }, { file: 'b.md', order: undefined }])).toBeUndefined()
  })
})
