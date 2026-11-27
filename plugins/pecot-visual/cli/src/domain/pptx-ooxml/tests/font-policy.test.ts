import { describe, expect, it } from 'vitest'

import {
  calculateSpcValue,
  doesContainJapanese,
} from '../font-policy.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
  ])('%s（入力 %j）のとき、%s を返す', async (_label, input, expected) => {
    await explains('文字列に日本語（ひらがな、カタカナ、漢字）が含まれるかどうかを判定する `doesContainJapanese` のテストです。日本語を含む文字列では `true`、半角英数字や記号だけの文字列と空文字では `false` を返すことを確認します。')
    expect(doesContainJapanese(input)).toBe(expected)
  })

  it('引数を渡さない場合でも、false を返す', async () => {
    await explains('文字列に日本語が含まれるかどうかを判定する `doesContainJapanese` のテストです。引数なしで呼び出した場合は、例外が発生せず、`false` を返すことを確認します。')
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
  ])('letter-spacing が %s のとき、spc が %i になる', async (letter, expected) => {
    await explains('字間（`letter-spacing`）から、PowerPoint の `spc` の値を求める `calculateSpcValue` のテストです。`1.4px` のようなピクセル単位の値をポイントへ換算し、100 倍して四捨五入した整数を返すことを確認します。')
    expect(calculateSpcValue(letter)).toBe(expected)
  })

  it('px の接尾辞がない値も、数値として扱う', async () => {
    await explains('字間（`letter-spacing`）から、PowerPoint の `spc` の値を求める `calculateSpcValue` のテストです。`1.4` のように `px` を付けない値を渡した場合でも、`1.4px` と同じ値（105）を返すことを確認します。')
    expect(calculateSpcValue('1.4')).toBe(105)
  })
})
