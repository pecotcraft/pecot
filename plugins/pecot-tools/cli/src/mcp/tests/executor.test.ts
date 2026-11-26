import { describe, expect, it, vi } from 'vitest'

import { createBoundedExecutor } from '../executor.js'
import { explains } from '../../../tests/_helpers/explains.js'

describe('createBoundedExecutor', () => {
  it('同時に実行できる上限まで並行して実行し、超えた分は先に始めた処理の完了を待つ', async () => {
    await explains('同時に実行する数を制限する `createBoundedExecutor` のテストです。上限を 4 にして 5 件を投入した場合に、4 件が同時に開始し、1 件が完了した後で 5 件目が開始し、同時に実行した最大の数が 4 であることを確認します。')
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

  it('上限を 1 にしたときは、投入した順に実行する', async () => {
    await explains('同時に実行する数を制限する `createBoundedExecutor` のテストです。上限を 1 にして 3 件を順に投入した場合に、実行の順序が投入した順序と一致することを確認します。')
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

  it('処理が失敗したときは、その失敗を呼び出し元へ伝える', async () => {
    await explains('同時に実行する数を制限する `createBoundedExecutor` のテストです。拒否される処理を実行した場合に、`run` の結果が同じエラーで拒否されることを確認します。')
    const executor = createBoundedExecutor(2)

    await expect(executor.run(() => Promise.reject(new Error('失敗')))).rejects.toThrow('失敗')
  })

  it('処理が失敗しても、後続の処理は実行される', async () => {
    await explains('同時に実行する数を制限する `createBoundedExecutor` のテストです。上限を 1 にして、失敗する処理の後に成功する処理を実行した場合に、後続の処理が実行されて値を返し、実行枠が解放されることを確認します。')
    const executor = createBoundedExecutor(1)

    await expect(executor.run(() => Promise.reject(new Error('失敗')))).rejects.toThrow('失敗')
    await expect(executor.run(() => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('処理の戻り値は、そのまま呼び出し元へ返す', async () => {
    await explains('同時に実行する数を制限する `createBoundedExecutor` のテストです。`42` を返す処理を実行した場合に、`run` の結果が `42` になることを確認します。')
    const executor = createBoundedExecutor(2)

    await expect(executor.run(() => Promise.resolve(42))).resolves.toBe(42)
  })
})
