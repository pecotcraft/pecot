import { describe, expect, it } from 'vitest'

import { InvalidValueError, PecotError } from '../../domain/errors.js'
import { AbortedError } from '../output.js'
import { exitCodeOfFailure } from '../failure.js'
import { UsageError } from '../usage-error.js'
import { capture } from './support.js'

describe('exitCodeOfFailure', () => {
  it('使い方の誤りは、枠付きで stderr に出して 2', () => {
    const io = capture()
    expect(exitCodeOfFailure(new UsageError('bad'), io, 80)).toBe(2)
    expect(io.err.join('')).toContain('bad')
  })

  it('確認の中止は、Aborted. を出して 1', () => {
    const io = capture()
    expect(exitCodeOfFailure(new AbortedError(), io, 80)).toBe(1)
    expect(io.err).toEqual(['Aborted.\n'])
  })

  it('報告できる失敗は、error: の行を出して 1', () => {
    const io = capture()
    expect(exitCodeOfFailure(new PecotError('x'), io, 80)).toBe(1)
    expect(exitCodeOfFailure(new InvalidValueError('y'), io, 80)).toBe(1)
    expect(io.err).toEqual(['error: x\n', 'error: y\n'])
  })

  it('それ以外の例外は伝える', () => {
    expect(() => exitCodeOfFailure(new TypeError('bug'), capture(), 80)).toThrow('bug')
  })
})
