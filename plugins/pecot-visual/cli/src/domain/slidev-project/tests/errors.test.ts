// SlideCreateUsageError / SlideCreateRuntimeError の name・reason・message の検証。

import { describe, expect, it } from 'vitest'

import { SlideCreateRuntimeError, SlideCreateUsageError } from '../errors.js'

describe('SlideCreateUsageError', () => {
  it('message・reason・name を保持し、Error として扱える', () => {
    const error = new SlideCreateUsageError('bad option', 'invalid-option')
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('bad option')
    expect(error.reason).toBe('invalid-option')
    expect(error.name).toBe('SlideCreateUsageError')
  })
})

describe('SlideCreateRuntimeError', () => {
  it('message・reason・name を保持し、Usage とは別のクラスです', () => {
    const error = new SlideCreateRuntimeError('copy failed', 'copy-failed')
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(SlideCreateUsageError)
    expect(error.message).toBe('copy failed')
    expect(error.reason).toBe('copy-failed')
    expect(error.name).toBe('SlideCreateRuntimeError')
  })
})
