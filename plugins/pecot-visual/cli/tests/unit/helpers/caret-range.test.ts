import { describe, expect, it } from 'vitest'

import { caretRangeOutside, caretRangeViolation } from '../../_helpers/caret-range.js'
import { explains } from '../../_helpers/explains.js'

describe('caretRangeOutside', () => {
  it.each(['^8.3.6', '^8.3.7', '^8.4.0'])('%s は、^8.3.6 の範囲に含まれる', async (inner) => {
    await explains('`caretRangeOutside` のテストです。`^8.3.6` と同じか、その範囲に収まる `^8.3.7` や `^8.4.0` のような指定を渡した場合に、範囲の外とは判定せず `undefined` を返すことを確認します。')
    expect(caretRangeOutside(inner, '^8.3.6')).toBeUndefined()
  })

  it.each([
    ['^8.3.5', '下限未満'],
    ['^8.2.9', '下限未満'],
    ['^9.0.0', 'major 不一致'],
    ['^7.9.9', 'major 不一致'],
    ['8.3.7', 'caret range ではない'],
    ['~8.3.7', 'caret range ではない'],
    ['^08.3.6', 'caret range ではない'],
  ])('%s は ^8.3.6 の範囲の外で、理由が「%s」になる', async (inner, reason) => {
    await explains('`caretRangeOutside` のテストです。`^8.3.5` や `^9.0.0` のように、下限を下回る指定、major が違う指定、caret 指定ではない指定を渡した場合に、範囲の外であることと、その理由を返すことを確認します。')
    expect(caretRangeOutside(inner, '^8.3.6')).toContain(reason)
  })

  it('0.0.x の caret 指定は、patch バージョンが違えば範囲の外と判定する', async () => {
    await explains('`caretRangeOutside` のテストです。`^0.0.4` を `^0.0.3` の範囲と比較した場合に、patch が一致しないことを示す理由を返すことを確認します。')
    expect(caretRangeOutside('^0.0.4', '^0.0.3')).toContain('patch 不一致')
  })

  it('0.x の caret 指定は、minor バージョンが違えば範囲の外と判定する', async () => {
    await explains('`caretRangeOutside` のテストです。`^0.21.0` を `^0.20.3` の範囲と比較した場合に、minor が一致しないことを示す理由を返すことを確認します。')
    expect(caretRangeOutside('^0.21.0', '^0.20.3')).toContain('minor 不一致')
  })

  it('範囲を示す側が caret 指定でなければ、範囲の外と判定する', async () => {
    await explains('`caretRangeOutside` のテストです。範囲に `>=8.0.0` のように `^` で始まらない指定を渡した場合に、caret 指定ではないことを示す理由を返すことを確認します。')
    expect(caretRangeOutside('^8.3.6', '>=8.0.0')).toContain('caret range ではない')
  })
})

describe('caretRangeViolation: 0.x', () => {
  it('0.21.0 は、minor が互換の単位なので、^0.20.3 の範囲の外と判定する', async () => {
    await explains('`caretRangeViolation` のテストです。`0.21.0` を `^0.20.3` と比較した場合に、minor が一致しないことを示す理由を返すことを確認します。')
    expect(caretRangeViolation('0.21.0', '^0.20.3')).toContain('minor 不一致')
  })

  it('0.0.4 は、patch が互換の単位なので、^0.0.3 の範囲の外と判定する', async () => {
    await explains('`caretRangeViolation` のテストです。`0.0.4` を `^0.0.3` と比較した場合に、patch が一致しないことを示す理由を返すことを確認します。')
    expect(caretRangeViolation('0.0.4', '^0.0.3')).toContain('patch 不一致')
  })

  it('0.20.4 は、^0.20.3 の範囲に含まれる', async () => {
    await explains('`caretRangeViolation` のテストです。`0.20.4` を `^0.20.3` と比較した場合に、範囲に含まれるものとして `undefined` を返すことを確認します。')
    expect(caretRangeViolation('0.20.4', '^0.20.3')).toBeUndefined()
  })
})

describe('caretRangeViolation: 入力と下限', () => {
  it.each([
    ['8.3', '^8.3.6', '完全一致指定ではない'],
    ['08.3.6', '^8.3.6', '完全一致指定ではない'],
    ['8.3.6', '~8.3.6', 'caret range ではない'],
    ['8.3.6', '^08.3.6', 'caret range ではない'],
    ['0.20.2', '^0.20.3', '下限未満'],
    ['8.3.5', '^8.3.6', '下限未満'],
  ])('%s は %s の範囲の外で、理由が「%s」になる', async (version, range, reason) => {
    await explains('`caretRangeViolation` のテストです。完全な版の指定ではない入力、caret 指定ではない範囲、下限を下回る版を渡した場合に、範囲の外であることと、その理由を返すことを確認します。')
    expect(caretRangeViolation(version, range)).toContain(reason)
  })

  it('major が 1 以上なら、minor が下限より大きくても範囲に含まれる', async () => {
    await explains('`caretRangeViolation` のテストです。`8.9.0` を `^8.3.6` と比較した場合に、minor が下限より大きくても範囲に含まれるものとして `undefined` を返すことを確認します。')
    expect(caretRangeViolation('8.9.0', '^8.3.6')).toBeUndefined()
  })
})
