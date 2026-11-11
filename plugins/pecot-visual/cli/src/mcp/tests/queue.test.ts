import { describe, expect, it } from 'vitest'

import { verifies } from '../../../tests/_helpers/verifies.js'
import { ReentrantEnqueueError, createExecutionQueue } from '../queue.js'

/**
setTimeout ベースの遅延。task の実行区間を意図的に重ねるために使う。
*/
async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('createExecutionQueue', () => {
  it('到着順に実行する', async (context) => {
    await verifies(context, 'PV-COMMON-08')
    const queue = createExecutionQueue()
    const order: string[] = []

    // 先に入れたものほど長く待たせても順序が入れ替わらないことを見る。
    const first = queue.enqueue(async () => {
      await delay(20)
      order.push('first')
      return 'a'
    })
    const second = queue.enqueue(() => {
      order.push('second')
      return Promise.resolve('b')
    })
    const third = queue.enqueue(() => {
      order.push('third')
      return Promise.resolve('c')
    })

    await expect(Promise.all([first, second, third])).resolves.toEqual(['a', 'b', 'c'])
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('同時に動く task は 1 件以下に保たれる', async () => {
    const queue = createExecutionQueue()
    let running = 0
    let peak = 0

    const tasks = Array.from({ length: 5 }, (_unused, index) => queue.enqueue(async () => {
      running += 1
      peak = Math.max(peak, running)
      await delay(index % 2 === 0 ? 5 : 0)
      running -= 1
      return index
    }))

    await Promise.all(tasks)
    expect(peak).toBe(1)
    expect(running).toBe(0)
  })

  it('task の失敗を呼び出し元へ伝播しつつ後続の task を処理する', async () => {
    const queue = createExecutionQueue()
    const order: string[] = []

    const failing = queue.enqueue(async () => {
      await delay(5)
      order.push('failing')
      throw new Error('boom')
    })
    const following = queue.enqueue(() => {
      order.push('following')
      return Promise.resolve('ok')
    })

    await expect(failing).rejects.toThrow('boom')
    await expect(following).resolves.toBe('ok')
    expect(order).toEqual(['failing', 'following'])
  })

  it('失敗した task の後に enqueue しても実行される', async () => {
    const queue = createExecutionQueue()

    await expect(queue.enqueue(() => Promise.reject(new Error('first-boom')))).rejects.toThrow('first-boom')
    await expect(queue.enqueue(() => Promise.resolve(42))).resolves.toBe(42)
  })

  it('task が Promise を返す前に同期 throw しても gate は解放される', () => {
    const queue = createExecutionQueue()

    const failing = queue.enqueue(() => {
      throw new Error('sync-boom')
    })

    // 後続が動く = finally で gate が解放されている。gate が抜けていれば
    // following は永久 pending になり、この test は timeout で落ちる。
    const following = queue.enqueue(() => Promise.resolve('after-sync-throw'))

    return Promise.all([
      expect(failing).rejects.toThrow('sync-boom'),
      expect(following).resolves.toBe('after-sync-throw'),
    ])
  })

  describe('再入禁止', () => {
    it('走行中の task から enqueue すると待たずに ReentrantEnqueueError で失敗する', async () => {
      const queue = createExecutionQueue()

      // 再入を許すとキューが自分自身の完了を待ってデッドロックする。
      // 「待たずに throw」を pin するため、test 自体の timeout ではなく戻り値で判定する。
      const outer = queue.enqueue(async () => {
        await delay(1)
        return queue.enqueue(() => Promise.resolve('inner'))
      })

      await expect(outer).rejects.toThrow(ReentrantEnqueueError)
    })

    it('再入で失敗しても後続の enqueue は動く', async () => {
      const queue = createExecutionQueue()

      await expect(queue.enqueue(() => queue.enqueue(() => Promise.resolve('inner')))).rejects.toThrow(ReentrantEnqueueError)
      await expect(queue.enqueue(() => Promise.resolve('ok'))).resolves.toBe('ok')
    })

    it('task の完了後に同じ呼び出し元から enqueue するのは再入ではない', async () => {
      const queue = createExecutionQueue()

      await expect(queue.enqueue(() => Promise.resolve('first'))).resolves.toBe('first')
      await expect(queue.enqueue(() => Promise.resolve('second'))).resolves.toBe('second')
    })
  })
})
