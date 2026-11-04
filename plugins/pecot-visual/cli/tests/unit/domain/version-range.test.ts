// domain/_shared/version-range.ts の unit test。
//
// この判定は eslint-runner の assert の唯一の材料になる。
// assert は、テンプレートが宣言した eslint と実際に解決した eslint のメジャーが違わないかを見る。
// そのため表記ごとの解釈をここで固定する。
// 誤って広く通すと、別メジャーの eslint で lint が実行され、違反の検出結果が変わる。

import { describe, expect, it } from 'vitest'

import { doesRangeAllowMajor } from '../../../src/domain/_shared/version-range.js'

describe('doesRangeAllowMajor: キャレット / チルダ', () => {
  it('^9.17.0 はメジャー 9 だけを通す', () => {
    expect(doesRangeAllowMajor('^9.17.0', 9)).toBe(true)
    expect(doesRangeAllowMajor('^9.17.0', 10)).toBe(false)
    expect(doesRangeAllowMajor('^9.17.0', 8)).toBe(false)
  })

  it('~9.17 もメジャー 9 だけを通す', () => {
    expect(doesRangeAllowMajor('~9.17', 9)).toBe(true)
    expect(doesRangeAllowMajor('~9.17', 10)).toBe(false)
  })

  it('^0.25.0 はメジャー 0 を通す', () => {
    expect(doesRangeAllowMajor('^0.25.0', 0)).toBe(true)
    expect(doesRangeAllowMajor('^0.25.0', 1)).toBe(false)
  })
})

describe('doesRangeAllowMajor: 比較子なし / ワイルドカード', () => {
  it('9 / 9.x / 9.17.0 はメジャー 9 だけを通す', () => {
    for (const range of ['9', '9.x', '9.17.0', '=9.17.0', 'v9.17.0']) {
      expect(doesRangeAllowMajor(range, 9)).toBe(true)
      expect(doesRangeAllowMajor(range, 10)).toBe(false)
    }
  })

  it('* / x / 空文字はどのメジャーも通す', () => {
    for (const range of ['*', 'x', '']) {
      expect(doesRangeAllowMajor(range, 9)).toBe(true)
      expect(doesRangeAllowMajor(range, 42)).toBe(true)
    }
  })

  it('AND 節に含まれたワイルドカードは、その比較子だけを無条件に通す', () => {
    // `>=9 *` では `>=9` の判定だけが結果を決める。ワイルドカード側を fail-closed に倒すと
    // 節全体が AND で潰れ、宣言された下限を満たす eslint まで弾く。
    expect(doesRangeAllowMajor('>=9 *', 9)).toBe(true)
    expect(doesRangeAllowMajor('>=9 *', 8)).toBe(false)
    expect(doesRangeAllowMajor('>=9 x', 10)).toBe(true)
  })

  it('比較子付きでメジャーがワイルドカードなら、どのメジャーも通す', () => {
    // `^x` / `>=x` はメジャーを固定していない。ここを「解釈できない表記」に倒すと
    // 実体がどの版でもメジャー違い扱いになり、lint が起動しない。
    for (const range of ['^x', '~x', '>=x', '=*']) {
      expect(doesRangeAllowMajor(range, 9)).toBe(true)
      expect(doesRangeAllowMajor(range, 42)).toBe(true)
    }
  })
})

describe('doesRangeAllowMajor: 範囲表記', () => {
  it('>=9 <11 は 9 と 10 を通し 11 は通さない', () => {
    expect(doesRangeAllowMajor('>=9 <11', 9)).toBe(true)
    expect(doesRangeAllowMajor('>=9 <11', 10)).toBe(true)
    // `<11` は `<11.0.0` なので、メジャー 11 の版は 1 つも含まれない。
    expect(doesRangeAllowMajor('>=9 <11', 11)).toBe(false)
    expect(doesRangeAllowMajor('>=9 <11', 8)).toBe(false)
  })

  it('上限が X.0.0 ちょうどでなければ、そのメジャーも通す', () => {
    expect(doesRangeAllowMajor('<11.2.0', 11)).toBe(true)
    expect(doesRangeAllowMajor('<11.0.1', 11)).toBe(true)
    expect(doesRangeAllowMajor('<11.0.0', 11)).toBe(false)
    expect(doesRangeAllowMajor('<11.0', 11)).toBe(false)
  })

  it('<= は上限のメジャーを含む', () => {
    expect(doesRangeAllowMajor('>=9 <=11.0.0', 11)).toBe(true)
    expect(doesRangeAllowMajor('<=9.0.0', 9)).toBe(true)
    expect(doesRangeAllowMajor('<=9.0.0', 10)).toBe(false)
  })

  it('> はマイナー以下が指定されていれば、そのメジャーも通す', () => {
    expect(doesRangeAllowMajor('>9.9.9', 9)).toBe(true)
    expect(doesRangeAllowMajor('>9.9.9', 8)).toBe(false)
    expect(doesRangeAllowMajor('>9.0', 9), '`>9.0` は 9.1.0 以上を含む').toBe(true)
  })

  it('メジャーだけの > はそのメジャーを 1 つも含まない', () => {
    // semver では `>9` は `>=10.0.0`。`major >= bound` に倒すとメジャー 9 の eslint を
    // 「テンプレートの要求どおり」と誤認して通す (fail-open)。
    expect(doesRangeAllowMajor('>9', 9)).toBe(false)
    expect(doesRangeAllowMajor('>9', 10)).toBe(true)
    // `9.x` はマイナー無指定と同じ扱い (`>9.x` も `>=10.0.0`)。
    expect(doesRangeAllowMajor('>9.x', 9)).toBe(false)
  })

  it('9 || 10 は両方のメジャーを通す', () => {
    expect(doesRangeAllowMajor('9 || 10', 9)).toBe(true)
    expect(doesRangeAllowMajor('9 || 10', 10)).toBe(true)
    expect(doesRangeAllowMajor('9 || 10', 11)).toBe(false)
  })

  it('^9.0.0 || ^10.0.0 のようなキャレットの OR も通す', () => {
    expect(doesRangeAllowMajor('^9.0.0 || ^10.0.0', 10)).toBe(true)
    expect(doesRangeAllowMajor('^9.0.0 || ^10.0.0', 11)).toBe(false)
  })

  it('ハイフン範囲 9.0.0 - 10.5.0 は 9 と 10 を通す', () => {
    expect(doesRangeAllowMajor('9.0.0 - 10.5.0', 9)).toBe(true)
    expect(doesRangeAllowMajor('9.0.0 - 10.5.0', 10)).toBe(true)
    expect(doesRangeAllowMajor('9.0.0 - 10.5.0', 11)).toBe(false)
    expect(doesRangeAllowMajor('9.0.0 - 10.5.0', 8)).toBe(false)
  })
})

describe('doesRangeAllowMajor: 解釈できない表記', () => {
  it('workspace: / URL / git 依存はどのメジャーも通さない', () => {
    // 解釈できない表記を通すと assert が無効になるので、fail-closed に倒す。
    for (const range of ['workspace:*', 'https://example.invalid/eslint.tgz', 'github:eslint/eslint']) {
      expect(doesRangeAllowMajor(range, 9)).toBe(false)
    }
  })

  it('プレリリース付きの上限は、どのメジャーも通さない', () => {
    // `<10.0.0-rc.1` の上限判定はマイナー・パッチが数字であることを前提にしている。
    // `0-rc` を「0 ではない」と読むとメジャー 10 が通り、方針から外れる (fail-open)。
    expect(doesRangeAllowMajor('<10.0.0-rc.1', 10)).toBe(false)
    expect(doesRangeAllowMajor('<10.0.0-rc.1', 9)).toBe(false)
    expect(doesRangeAllowMajor('^9.0.0-beta.1', 9)).toBe(false)
  })

  it('ビルドメタデータ付きも通さない', () => {
    expect(doesRangeAllowMajor('9.0.0+build.1', 9)).toBe(false)
  })
})
