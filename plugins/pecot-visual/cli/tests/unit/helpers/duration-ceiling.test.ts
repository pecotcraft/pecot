// e2e の ceiling に掛ける倍率（tests/_helpers/duration-ceiling.ts）の契約。

import { afterEach, describe, expect, it, vi } from 'vitest'

import { durationCeilingMs } from '../../_helpers/duration-ceiling.js'
import { explains } from '../../_helpers/explains.js'

describe('durationCeilingMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('環境変数が設定されていなければ、倍率を 1 倍にする', async () => {
    await explains('e2e の時間の上限に掛ける倍率を求める `durationCeilingMs` のテストです。`PECOTV_E2E_CEILING_SCALE` が設定されていない場合に、渡した 45000 ミリ秒をそのまま返すことを確認します。')
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', undefined)

    expect(durationCeilingMs(45_000)).toBe(45_000)
  })

  it('環境変数が空文字なら、倍率を 1 倍にする', async () => {
    await explains('e2e の時間の上限に掛ける倍率を求める `durationCeilingMs` のテストです。`PECOTV_E2E_CEILING_SCALE` が空文字の場合に、渡した 45000 ミリ秒をそのまま返すことを確認します。')
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', '')

    expect(durationCeilingMs(45_000)).toBe(45_000)
  })

  it('環境変数に 3 を指定すると、倍率を 3 倍にする', async () => {
    await explains('e2e の時間の上限に掛ける倍率を求める `durationCeilingMs` のテストです。`PECOTV_E2E_CEILING_SCALE` が `3` の場合に、45000 ミリ秒を 3 倍の 135000 ミリ秒にして返すことを確認します。')
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', '3')

    expect(durationCeilingMs(45_000)).toBe(135_000)
  })

  it('環境変数に下限の 1 と上限の 4 を指定した場合は、どちらも受け付ける', async () => {
    await explains('e2e の時間の上限に掛ける倍率を求める `durationCeilingMs` のテストです。`PECOTV_E2E_CEILING_SCALE` が `1` の場合は 9000 ミリ秒を 9000 ミリ秒のまま、`4` の場合は 130000 ミリ秒を 520000 ミリ秒にして返すことを確認します。')
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', '1')
    expect(durationCeilingMs(9000)).toBe(9000)

    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', '4')
    expect(durationCeilingMs(130_000)).toBe(520_000)
  })

  it.each(['0.5', '4.1', 'abc', 'Infinity'])('環境変数に範囲外の値（%s）を指定すると、変数名と値を含むメッセージで例外が発生する', async (value) => {
    await explains('e2e の時間の上限に掛ける倍率を求める `durationCeilingMs` のテストです。`PECOTV_E2E_CEILING_SCALE` に 1 以上 4 以下でない値を指定した場合に、変数名と値、`1 以上 4 以下` を含むメッセージで例外が発生することを確認します。')
    vi.stubEnv('PECOTV_E2E_CEILING_SCALE', value)

    expect(() => durationCeilingMs(1000)).toThrow(`PECOTV_E2E_CEILING_SCALE="${value}"`)
    expect(() => durationCeilingMs(1000)).toThrow('1 以上 4 以下')
  })
})
