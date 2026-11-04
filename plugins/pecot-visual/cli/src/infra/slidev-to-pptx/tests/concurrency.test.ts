import { describe, expect, it } from 'vitest'

import { runWithConcurrency } from '../concurrency.js'

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
    const tasks = [1, 2, 3].map(n => () => Promise.resolve(n * 10))
    const results = await runWithConcurrency(tasks, 2)
    const values = results.map(r => (r.status === 'fulfilled' ? r.value : undefined))
    expect(values).toStrictEqual([10, 20, 30])
  })

  it('rejected も Promise.allSettled 形式で返す', async () => {
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

  it('空タスクリストには空配列を返す', async () => {
    const results = await runWithConcurrency([], 4)
    expect(results).toStrictEqual([])
  })

  it('concurrency=1 + reject タスクのとき Promise.race の catch ハンドラが呼ばれる', async () => {
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
