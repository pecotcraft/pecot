// e2e の ceiling に掛ける倍率（tests/_helpers/duration-ceiling.ts）の契約。

import { afterEach, describe, expect, it, vi } from 'vitest'

import { durationCeilingMs } from '../../_helpers/duration-ceiling.js'

describe('durationCeilingMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('環境変数が未設定なら 1 倍にする', () => {
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', undefined)

    expect(durationCeilingMs(45_000)).toBe(45_000)
  })

  it('環境変数が空文字なら 1 倍にする', () => {
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', '')

    expect(durationCeilingMs(45_000)).toBe(45_000)
  })

  it('3 を渡すと 3 倍にする', () => {
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', '3')

    expect(durationCeilingMs(45_000)).toBe(135_000)
  })

  it('下限の 1 と上限の 4 を受け付ける', () => {
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', '1')
    expect(durationCeilingMs(9000)).toBe(9000)

    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', '4')
    expect(durationCeilingMs(130_000)).toBe(520_000)
  })

  it.each(['0.5', '4.1', 'abc', 'Infinity'])('範囲外の %s は変数名と値を含むメッセージで throw する', (value) => {
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', value)

    expect(() => durationCeilingMs(1000)).toThrow(`PECOTV_E2E_CEILING_SCALE="${value}"`)
    expect(() => durationCeilingMs(1000)).toThrow('1 以上 4 以下')
  })
})
