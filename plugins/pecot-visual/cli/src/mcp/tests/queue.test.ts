import { describe, expect, it } from 'vitest'

import { verifies } from '../../../tests/_helpers/verifies.js'
import { ReentrantEnqueueError, createExecutionQueue } from '../queue.js'
import { explains } from '../../../tests/_helpers/explains.js'

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
    await explains('実行キュー `createExecutionQueue` に複数のタスクを追加した場合のテストです。先に追加したタスクの処理に時間がかかっても、追加した順に実行され、結果も追加した順に返ることを確認します。')
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

  it('同時に実行されるタスクは 1 件以下に保たれる', async () => {
    await explains('実行キューに 5 つのタスクを追加した場合のテストです。同時に実行されるタスクの最大数が 1 で、すべての完了後は実行中のタスクがないことを確認します。')
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

  it('タスクが失敗した場合は、呼び出し元に失敗を伝え、後続のタスクは続けて処理する', async () => {
    await explains('先に追加したタスクが失敗する場合のテストです。失敗したタスクの呼び出し元には例外が伝わり、後続のタスクは正常に実行されて結果を返すことを確認します。')
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

  it('タスクが失敗した後に追加したタスクも実行される', async () => {
    await explains('タスクの失敗が完了した後に、新しいタスクを追加した場合のテストです。追加したタスクが実行され、結果を返すことを確認します。')
    const queue = createExecutionQueue()

    await expect(queue.enqueue(() => Promise.reject(new Error('first-boom')))).rejects.toThrow('first-boom')
    await expect(queue.enqueue(() => Promise.resolve(42))).resolves.toBe(42)
  })

  it('タスクが Promise を返す前に例外を発生させても、実行の順番待ちは解除される', async () => {
    await explains('タスクが Promise を返す前に、同期的に例外を発生させた場合のテストです。そのタスクは失敗として扱われ、続けて追加したタスクが実行されて結果を返すことを確認します。')
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
    it('実行中のタスクからタスクを追加すると、待たずに ReentrantEnqueueError で失敗する', async () => {
      await explains('実行中のタスクの中から、同じキューにタスクを追加した場合のテストです。キュー自身の完了を待つことなく、`ReentrantEnqueueError` の例外が発生することを確認します。')
      const queue = createExecutionQueue()

      // 再入を許すとキューが自分自身の完了を待ってデッドロックする。
      // 「待たずに throw」を pin するため、test 自体の timeout ではなく戻り値で判定する。
      const outer = queue.enqueue(async () => {
        await delay(1)
        return queue.enqueue(() => Promise.resolve('inner'))
      })

      await expect(outer).rejects.toThrow(ReentrantEnqueueError)
    })

    it('実行中のタスクからの追加に失敗しても、その後に追加したタスクは実行される', async () => {
      await explains('実行中のタスクからの追加が `ReentrantEnqueueError` で失敗した場合のテストです。その後に追加したタスクが実行され、結果を返すことを確認します。')
      const queue = createExecutionQueue()

      await expect(queue.enqueue(() => queue.enqueue(() => Promise.resolve('inner')))).rejects.toThrow(ReentrantEnqueueError)
      await expect(queue.enqueue(() => Promise.resolve('ok'))).resolves.toBe('ok')
    })

    it('タスクの完了後に、同じ呼び出し元からタスクを追加しても、再入とは扱わない', async () => {
      await explains('タスクの完了を待ってから、同じ呼び出し元が次のタスクを追加した場合のテストです。例外が発生せず、2 つのタスクがそれぞれ結果を返すことを確認します。')
      const queue = createExecutionQueue()

      await expect(queue.enqueue(() => Promise.resolve('first'))).resolves.toBe('first')
      await expect(queue.enqueue(() => Promise.resolve('second'))).resolves.toBe('second')
    })
  })
})
