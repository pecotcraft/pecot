import { describe, expect, it, vi } from 'vitest'

import { createBoundedExecutor } from '../executor.js'

describe('createBoundedExecutor', () => {
  it('上限まで同時に実行し、超過分は先行の完了を待つ', async () => {
    const executor = createBoundedExecutor(4)
    const gates: PromiseWithResolvers<void>[] = Array.from({ length: 5 }, () => Promise.withResolvers())
    let started = 0
    let running = 0
    let peak = 0

    const runs = gates.map(async (item) => {
      return executor.run(async () => {
        started += 1
        running += 1
        peak = Math.max(peak, running)
        await item.promise
        running -= 1
      })
    })

    // 5 件目は枠が空くまで開始しない（経過時間ではなく開始件数で判定する）。
    await vi.waitFor(() => {
      expect(started).toBe(4)
    })
    expect(peak).toBe(4)

    gates[0]?.resolve()
    await vi.waitFor(() => {
      expect(started).toBe(5)
    })

    for (const item of gates) item.resolve()
    await Promise.all(runs)
    expect(running).toBe(0)
    expect(peak).toBe(4)
  })

  it('到着順に実行する', async () => {
    const executor = createBoundedExecutor(1)
    const order: number[] = []

    await Promise.all([1, 2, 3].map(async (index) => {
      return executor.run(() => {
        order.push(index)
        return Promise.resolve()
      })
    }))

    expect(order).toEqual([1, 2, 3])
  })

  it('タスクの失敗は呼び出し元へ伝播する', async () => {
    const executor = createBoundedExecutor(2)

    await expect(executor.run(() => Promise.reject(new Error('失敗')))).rejects.toThrow('失敗')
  })

  it('タスクが失敗しても後続は実行される（枠を握り潰さない）', async () => {
    const executor = createBoundedExecutor(1)

    await expect(executor.run(() => Promise.reject(new Error('失敗')))).rejects.toThrow('失敗')
    await expect(executor.run(() => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('タスクの戻り値をそのまま返す', async () => {
    const executor = createBoundedExecutor(2)

    await expect(executor.run(() => Promise.resolve(42))).resolves.toBe(42)
  })
})
