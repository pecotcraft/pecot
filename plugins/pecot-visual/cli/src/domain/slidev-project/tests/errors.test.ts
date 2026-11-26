// SlideCreateUsageError / SlideCreateRuntimeError の name・reason・message の検証。

import { describe, expect, it } from 'vitest'

import { SlideCreateRuntimeError, SlideCreateUsageError } from '../errors.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('SlideCreateUsageError', () => {
  it('SlideCreateUsageError は、message、reason、name を保持し、Error として扱える', async () => {
    await explains('スライドの作成で使い方が誤っている場合の例外 `SlideCreateUsageError` のテストです。`message`、`reason`、`name` を保持し、`Error` のインスタンスであることを確認します。')
    const error = new SlideCreateUsageError('bad option', 'invalid-option')
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('bad option')
    expect(error.reason).toBe('invalid-option')
    expect(error.name).toBe('SlideCreateUsageError')
  })
})

describe('SlideCreateRuntimeError', () => {
  it('SlideCreateRuntimeError は、message、reason、name を保持し、SlideCreateUsageError とは別のクラスになる', async () => {
    await explains('スライドの作成の実行中に失敗した場合の例外 `SlideCreateRuntimeError` のテストです。`message`、`reason`、`name` を保持し、`SlideCreateUsageError` のインスタンスではないことを確認します。')
    const error = new SlideCreateRuntimeError('copy failed', 'copy-failed')
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(SlideCreateUsageError)
    expect(error.message).toBe('copy failed')
    expect(error.reason).toBe('copy-failed')
    expect(error.name).toBe('SlideCreateRuntimeError')
  })
})
