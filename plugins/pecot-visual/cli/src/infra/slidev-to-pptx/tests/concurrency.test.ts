import { describe, expect, it } from 'vitest'

import { runWithConcurrency } from '../concurrency.js'
import { explains } from '../../../../tests/_helpers/explains.js'

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

async function delayedReject(): Promise<number> {
  await delay(5)
  throw new Error('first-fail')
}

describe('runWithConcurrency', () => {
  it('全タスク fulfilled のとき全 settled 結果を返す', async () => {
    await explains('`runWithConcurrency` に、すべて成功するタスクを渡した場合のテストです。3 つのタスクを同時実行数 2 で実行した場合に、結果がすべて `fulfilled` で、入力順に並ぶことを確認します。')
    const tasks = [1, 2, 3].map(n => () => Promise.resolve(n * 10))
    const results = await runWithConcurrency(tasks, 2)
    const values = results.map(r => (r.status === 'fulfilled' ? r.value : undefined))
    expect(values).toStrictEqual([10, 20, 30])
  })

  it('失敗するタスクが含まれる場合も、Promise.allSettled と同じ形式で結果を返す', async () => {
    await explains('失敗するタスクを含めて `runWithConcurrency` を実行した場合のテストです。2 番目のタスクが失敗した場合に、その結果が `rejected` になり、前後のタスクは `fulfilled` のまま、エラーメッセージも保持されることを確認します。')
    const tasks: (() => Promise<number>)[] = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve(3),
    ]
    const results = await runWithConcurrency(tasks, 2)
    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]?.status).toBe('rejected')
    expect(results[2]?.status).toBe('fulfilled')
    const second = results[1]
    expect(second?.status).toBe('rejected')
    if (second?.status === 'rejected') {
      expect((second.reason as Error).message).toBe('boom')
    }
  })

  it('concurrency=1 のときタスクが直列実行される', async () => {
    await explains('同時実行数を 1 にした場合の、タスクの実行順序のテストです。4 つのタスクを実行しても、同時に動くタスクが 1 つを超えないことを確認します。')
    let active = 0
    let maxActive = 0
    const task = async (): Promise<number> => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(10)
      active--
      return 0
    }
    await runWithConcurrency([task, task, task, task], 1)
    expect(maxActive).toBe(1)
  })

  it('concurrency=N のとき同時実行数が N を超えない', async () => {
    await explains('同時実行数の上限のテストです。同時実行数を 3 にして 6 つのタスクを実行した場合に、同時に動くタスクが 3 つを超えず、2 つ以上は並行して動くことを確認します。')
    let active = 0
    let maxActive = 0
    const task = async (): Promise<number> => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(15)
      active--
      return 0
    }
    const tasks = Array.from({ length: 6 }, () => task)
    await runWithConcurrency(tasks, 3)
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(maxActive).toBeGreaterThanOrEqual(2)
  })

  it('タスクリストが空の場合は、空の配列を返す', async () => {
    await explains('タスクが 1 つもない場合の戻り値のテストです。空のタスクリストを渡した場合に、空の配列を返すことを確認します。')
    const results = await runWithConcurrency([], 4)
    expect(results).toStrictEqual([])
  })

  it('同時実行数 1 で最初のタスクが失敗しても、後続のタスクを実行して結果を返す', async () => {
    await explains('同時実行数を 1 にして、最初のタスクが失敗する場合のテストです。失敗したタスクの後ろのタスクも実行され、結果が `rejected` と `fulfilled` の順に並ぶことを確認します。')
    // concurrency=1 のとき毎 iteration で Promise.race が呼ばれる。reject task を挟むことで
    // `.catch(() => {})` ハンドラを必ず通る流れを担保する (function coverage 用)。
    const tasks: (() => Promise<number>)[] = [
      delayedReject,
      () => Promise.resolve(2),
    ]
    const results = await runWithConcurrency(tasks, 1)
    expect(results[0]?.status).toBe('rejected')
    expect(results[1]?.status).toBe('fulfilled')
  })
})
