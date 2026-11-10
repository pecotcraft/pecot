import { describe, expect, it } from 'vitest'

import { PipelineRuntimeError, PipelineTimeoutError } from '../errors.js'

describe('PipelineTimeoutError', () => {
  it('Error / PipelineTimeoutError 双方の instanceof', () => {
    const error = new PipelineTimeoutError(1234, { elapsedMs: 1234 })
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(PipelineTimeoutError)
  })

  it('idleTimeoutMs / elapsedMs / lastProgress を保持し message に埋め込む (#1097)', () => {
    const error = new PipelineTimeoutError(5000, { elapsedMs: 12_345, lastProgress: 'スライド #3 変換完了' })
    expect(error.idleTimeoutMs).toBe(5000)
    expect(error.elapsedMs).toBe(12_345)
    expect(error.lastProgress).toBe('スライド #3 変換完了')
    expect(error.message).toBe('no progress for 5000ms (elapsed 12345ms, last progress: スライド #3 変換完了)')
    expect(error.name).toBe('PipelineTimeoutError')
  })

  it('lastProgress 省略時は「スキャン開始前」で message を組む (#1097)', () => {
    const error = new PipelineTimeoutError(5000, { elapsedMs: 5000 })
    expect(error.elapsedMs).toBe(5000)
    expect(error.lastProgress).toBeUndefined()
    expect(error.message).toBe('no progress for 5000ms (elapsed 5000ms, last progress: no progress (before the scan started))')
  })

  it('options.errors を保持する (#945)', () => {
    const errors = [{ level: 'slide', slideNumber: 2, message: 'worker-failed' }]
    const error = new PipelineTimeoutError(5000, { elapsedMs: 5000, errors })
    expect(error.errors).toStrictEqual(errors)
  })

  it('options.errors 省略時は undefined (#945)', () => {
    const error = new PipelineTimeoutError(5000, { elapsedMs: 5000, warnings: ['w'] })
    expect(error.errors).toBeUndefined()
  })
})

describe('PipelineRuntimeError', () => {
  it('Error / PipelineRuntimeError 双方の instanceof', () => {
    const error = new PipelineRuntimeError('boom')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(PipelineRuntimeError)
  })

  it('message を保持し name は PipelineRuntimeError', () => {
    const error = new PipelineRuntimeError('something failed')
    expect(error.message).toBe('something failed')
    expect(error.name).toBe('PipelineRuntimeError')
  })

  it('options.cause を Error.cause として伝播する', () => {
    const cause = new Error('root cause')
    const error = new PipelineRuntimeError('wrap', { cause })
    expect(error.cause).toBe(cause)
  })

  it('options 省略時は cause が undefined', () => {
    const error = new PipelineRuntimeError('no cause')
    expect(error.cause).toBeUndefined()
  })

  it('options.errors を保持する (#945)', () => {
    const errors = [
      { level: 'slide', slideNumber: 1, message: 'worker-failed' },
      { level: 'element', slideNumber: 1, selector: '.x', message: 'pr-fail' },
    ]
    const error = new PipelineRuntimeError('boom', { errors })
    expect(error.errors).toStrictEqual(errors)
  })

  it('options.errors 省略時は undefined (#945)', () => {
    const error = new PipelineRuntimeError('boom', { warnings: ['w'] })
    expect(error.errors).toBeUndefined()
  })
})
