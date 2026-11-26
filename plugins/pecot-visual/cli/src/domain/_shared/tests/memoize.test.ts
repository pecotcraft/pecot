import { describe, expect, it } from 'vitest'

import { memoizeAsync } from '../memoize.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('memoizeAsync', () => {
  it('並行に呼んでも create は 1 回だけ実行され、同じ結果を返す', async () => {
    await explains('非同期の関数の結果を保持する `memoizeAsync` のテストです。2 回並行して呼び出した場合に、生成する関数は 1 回だけ実行され、どちらの呼び出しも同じ結果を返すことを確認します。')
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

  it('生成する関数が偽になる値を返す場合でも、再実行しない', async () => {
    await explains('非同期の関数の結果を保持する `memoizeAsync` のテストです。生成する関数が `0` のような偽になる値を返した場合でも、2 回目の呼び出しで再実行しないことを確認します。')
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

  it('生成する関数が reject した場合は、結果を保持せず、次の呼び出しで再実行する', async () => {
    await explains('非同期の関数の結果を保持する `memoizeAsync` のテストです。1 回目の呼び出しで生成する関数が reject した場合に、失敗を保持せず、2 回目の呼び出しで再実行して成功することを確認します。')
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
