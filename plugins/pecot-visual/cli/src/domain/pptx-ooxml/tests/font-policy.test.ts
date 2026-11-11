import { describe, expect, it } from 'vitest'

import {
  calculateSpcValue,
  doesContainJapanese,
} from '../font-policy.js'

describe('doesContainJapanese', () => {
  it.each([
    ['ひらがな', 'こんにちは', true],
    ['カタカナ', 'コンニチハ', true],
    ['漢字', '東京', true],
    ['ひらがな + 英数字混在', 'Hello こんにちは', true],
    ['漢字 + 英数字混在', 'Tokyo東京 2026', true],
    ['半角英数字のみ', 'Hello World 123', false],
    ['記号のみ', '!@#$%^&*()', false],
    ['空文字列', '', false],
  ])('%s（入力 %j）のとき、%s を返す', (_label, input, expected) => {
    expect(doesContainJapanese(input)).toBe(expected)
  })

  it('undefined を渡しても false を返す', () => {
    expect(doesContainJapanese()).toBe(false)
  })
})

describe('calculateSpcValue', () => {
  // Python 版 _calculate_spc_value は次の式。
  //   spacing_pt = float(letter_spacing_px.replace("px", "")) * 0.75
  //   return round(spacing_pt * 100)
  it.each([
    // [letter-spacing, expected spc value]
    ['1.4px', 105],
    ['1.0px', 75],
    ['2.0px', 150],
    ['0.5px', 38],
    ['0px', 0],
  ])('letter-spacing が %s のとき、spc が %i になる', (letter, expected) => {
    expect(calculateSpcValue(letter)).toBe(expected)
  })

  it('px 接尾辞なしでも数値として扱える', () => {
    expect(calculateSpcValue('1.4')).toBe(105)
  })
})
