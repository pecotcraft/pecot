import { describe, expect, it } from 'vitest'

import { PipelineRuntimeError, PipelineTimeoutError } from '../errors.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('PipelineTimeoutError', () => {
  it('PipelineTimeoutError は、Error と PipelineTimeoutError のどちらの instanceof も真になる', async () => {
    await explains('タイムアウトを表す `PipelineTimeoutError` のテストです。インスタンスを作成した場合に、`Error` のインスタンスでもあり、`PipelineTimeoutError` のインスタンスでもあることを確認します。')
    const error = new PipelineTimeoutError(1234, { elapsedMs: 1234 })
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(PipelineTimeoutError)
  })

  it('idleTimeoutMs・elapsedMs・lastProgress を保持し、message に含める', async () => {
    await explains('タイムアウトを表す `PipelineTimeoutError` のテストです。3 つの値を渡した場合に、それぞれが保持され、`message` に同じ値を含む文が設定されることを確認します。')
    const error = new PipelineTimeoutError(5000, { elapsedMs: 12_345, lastProgress: 'スライド #3 変換完了' })
    expect(error.idleTimeoutMs).toBe(5000)
    expect(error.elapsedMs).toBe(12_345)
    expect(error.lastProgress).toBe('スライド #3 変換完了')
    expect(error.message).toBe('no progress for 5000ms (elapsed 12345ms, last progress: スライド #3 変換完了)')
    expect(error.name).toBe('PipelineTimeoutError')
  })

  it('lastProgress を省略した場合は、スキャン開始前を表す文で message を作成する', async () => {
    await explains('タイムアウトを表す `PipelineTimeoutError` のテストです。`lastProgress` を省略した場合に、`lastProgress` が `undefined` になり、`message` にスキャン開始前を示す文が入ることを確認します。')
    const error = new PipelineTimeoutError(5000, { elapsedMs: 5000 })
    expect(error.elapsedMs).toBe(5000)
    expect(error.lastProgress).toBeUndefined()
    expect(error.message).toBe('no progress for 5000ms (elapsed 5000ms, last progress: no progress (before the scan started))')
  })

  it('options.errors を渡した場合は、errors として保持する', async () => {
    await explains('タイムアウトを表す `PipelineTimeoutError` のテストです。`options.errors` にエラーの一覧を渡した場合に、同じ内容が `errors` に保持されることを確認します。')
    const errors = [{ level: 'slide', slideNumber: 2, message: 'worker-failed' }]
    const error = new PipelineTimeoutError(5000, { elapsedMs: 5000, errors })
    expect(error.errors).toStrictEqual(errors)
  })

  it('options.errors を省略した場合は、errors が undefined になる', async () => {
    await explains('タイムアウトを表す `PipelineTimeoutError` のテストです。`options.errors` を渡さず `warnings` だけを渡した場合に、`errors` が `undefined` になることを確認します。')
    const error = new PipelineTimeoutError(5000, { elapsedMs: 5000, warnings: ['w'] })
    expect(error.errors).toBeUndefined()
  })
})

describe('PipelineRuntimeError', () => {
  it('PipelineRuntimeError は、Error と PipelineRuntimeError のどちらの instanceof も真になる', async () => {
    await explains('実行時のエラーを表す `PipelineRuntimeError` のテストです。インスタンスを作成した場合に、`Error` のインスタンスでもあり、`PipelineRuntimeError` のインスタンスでもあることを確認します。')
    const error = new PipelineRuntimeError('boom')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(PipelineRuntimeError)
  })

  it('message を保持し、name が PipelineRuntimeError になる', async () => {
    await explains('実行時のエラーを表す `PipelineRuntimeError` のテストです。メッセージを渡して作成した場合に、`message` がそのまま保持され、`name` が `PipelineRuntimeError` になることを確認します。')
    const error = new PipelineRuntimeError('something failed')
    expect(error.message).toBe('something failed')
    expect(error.name).toBe('PipelineRuntimeError')
  })

  it('options.cause を渡した場合は、Error.cause に設定する', async () => {
    await explains('実行時のエラーを表す `PipelineRuntimeError` のテストです。`options.cause` に別の `Error` を渡した場合に、同じオブジェクトが `cause` に設定されることを確認します。')
    const cause = new Error('root cause')
    const error = new PipelineRuntimeError('wrap', { cause })
    expect(error.cause).toBe(cause)
  })

  it('options を省略した場合は、cause が undefined になる', async () => {
    await explains('実行時のエラーを表す `PipelineRuntimeError` のテストです。`options` を渡さずに作成した場合は、`cause` が `undefined` になることを確認します。')
    const error = new PipelineRuntimeError('no cause')
    expect(error.cause).toBeUndefined()
  })

  it('options.errors を渡した場合は、errors として保持する', async () => {
    await explains('実行時のエラーを表す `PipelineRuntimeError` のテストです。`options.errors` にエラーの一覧を渡した場合に、同じ内容が `errors` に保持されることを確認します。')
    const errors = [
      { level: 'slide', slideNumber: 1, message: 'worker-failed' },
      { level: 'element', slideNumber: 1, selector: '.x', message: 'pr-fail' },
    ]
    const error = new PipelineRuntimeError('boom', { errors })
    expect(error.errors).toStrictEqual(errors)
  })

  it('options.errors を省略した場合は、errors が undefined になる', async () => {
    await explains('実行時のエラーを表す `PipelineRuntimeError` のテストです。`options.errors` を渡さず `warnings` だけを渡した場合に、`errors` が `undefined` になることを確認します。')
    const error = new PipelineRuntimeError('boom', { warnings: ['w'] })
    expect(error.errors).toBeUndefined()
  })
})
