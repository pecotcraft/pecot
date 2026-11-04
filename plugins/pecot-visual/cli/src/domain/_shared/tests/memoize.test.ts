import { describe, expect, it } from 'vitest'

import { memoizeAsync } from '../memoize.js'

describe('memoizeAsync', () => {
  it('並行に呼んでも create は 1 回だけ実行され、同じ結果を返す', async () => {
    let calls = 0
    const get = memoizeAsync(async () => {
      calls += 1
      await Promise.resolve()
      return { value: 'loaded' }
    })

    const [first, second] = await Promise.all([get(), get()])

    expect(calls).toBe(1)
    expect(first).toEqual({ value: 'loaded' })
    expect(second).toBe(first)
  })

  it('falsy な値を返す create も再実行しない', async () => {
    let calls = 0
    const get = memoizeAsync(async () => {
      calls += 1
      await Promise.resolve()
      return 0
    })

    await get()
    await get()

    expect(calls).toBe(1)
  })

  it('reject した場合は結果を持たず、次の呼び出しでやり直す', async () => {
    let calls = 0
    const get = memoizeAsync(async () => {
      calls += 1
      await Promise.resolve()
      if (calls === 1) throw new Error('first failure')
      return 'recovered'
    })

    await expect(get()).rejects.toThrow('first failure')
    await expect(get()).resolves.toBe('recovered')
    expect(calls).toBe(2)
  })
})
