// domain/_shared/version-range.ts の unit test。
//
// この判定は eslint-runner の assert の唯一の材料になる。
// assert は、テンプレートが宣言した eslint と実際に解決した eslint のメジャーが違わないかを見る。
// そのため表記ごとの解釈をここで固定する。
// 誤って広く通すと、別メジャーの eslint で lint が実行され、違反の検出結果が変わる。

import { describe, expect, it } from 'vitest'

import { doesRangeAllowMajor } from '../../../src/domain/_shared/version-range.js'
import { explains } from '../../_helpers/explains.js'

describe('doesRangeAllowMajor: キャレット / チルダ', () => {
  it('^9.17.0 は、メジャーバージョン 9 だけを許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`^9.17.0` を渡した場合に、メジャーが 9 なら `true`、10 や 8 なら `false` を返すことを確認します。')
    expect(doesRangeAllowMajor('^9.17.0', 9)).toBe(true)
    expect(doesRangeAllowMajor('^9.17.0', 10)).toBe(false)
    expect(doesRangeAllowMajor('^9.17.0', 8)).toBe(false)
  })

  it('~9.17 も、メジャーバージョン 9 だけを許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`~9.17` を渡した場合に、メジャーが 9 なら `true`、10 なら `false` を返すことを確認します。')
    expect(doesRangeAllowMajor('~9.17', 9)).toBe(true)
    expect(doesRangeAllowMajor('~9.17', 10)).toBe(false)
  })

  it('^0.25.0 は、メジャーバージョン 0 を許可し、1 は許可しない', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`^0.25.0` を渡した場合に、メジャーが 0 なら `true`、1 なら `false` を返すことを確認します。')
    expect(doesRangeAllowMajor('^0.25.0', 0)).toBe(true)
    expect(doesRangeAllowMajor('^0.25.0', 1)).toBe(false)
  })
})

describe('doesRangeAllowMajor: 比較子なし / ワイルドカード', () => {
  it('9・9.x・9.17.0 などの、比較子がない表記は、メジャーバージョン 9 だけを許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`9`・`9.x`・`9.17.0`・`=9.17.0`・`v9.17.0` のそれぞれで、メジャーが 9 なら `true`、10 なら `false` を返すことを確認します。')
    for (const range of ['9', '9.x', '9.17.0', '=9.17.0', 'v9.17.0']) {
      expect(doesRangeAllowMajor(range, 9)).toBe(true)
      expect(doesRangeAllowMajor(range, 10)).toBe(false)
    }
  })

  it('ワイルドカード（* や x）と空文字は、どのメジャーバージョンも許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`*`・`x`・空文字のそれぞれで、メジャーが 9 でも 42 でも `true` を返すことを確認します。')
    for (const range of ['*', 'x', '']) {
      expect(doesRangeAllowMajor(range, 9)).toBe(true)
      expect(doesRangeAllowMajor(range, 42)).toBe(true)
    }
  })

  it('AND で結んだ範囲にワイルドカードがあっても、もう一方の比較子の結果だけで判定する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`>=9 *` や `>=9 x` のように、ワイルドカードと比較子を AND で並べた場合に、ワイルドカードは常に満たすものとして扱い、`>=9` の判定だけが結果を決めることを確認します。')
    // `>=9 *` では `>=9` の判定だけが結果を決める。ワイルドカード側を fail-closed に倒すと
    // 節全体が AND で潰れ、宣言された下限を満たす eslint まで弾く。
    expect(doesRangeAllowMajor('>=9 *', 9)).toBe(true)
    expect(doesRangeAllowMajor('>=9 *', 8)).toBe(false)
    expect(doesRangeAllowMajor('>=9 x', 10)).toBe(true)
  })

  it('比較子の後ろのメジャーがワイルドカードなら、どのメジャーバージョンも許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`^x`・`~x`・`>=x`・`=*` のように、メジャーを固定していない表記を渡した場合に、メジャーが 9 でも 42 でも `true` を返すことを確認します。')
    // `^x` / `>=x` はメジャーを固定していない。ここを「解釈できない表記」に倒すと
    // 実体がどの版でもメジャー違い扱いになり、lint が起動しない。
    for (const range of ['^x', '~x', '>=x', '=*']) {
      expect(doesRangeAllowMajor(range, 9)).toBe(true)
      expect(doesRangeAllowMajor(range, 42)).toBe(true)
    }
  })
})

describe('doesRangeAllowMajor: 範囲表記', () => {
  it('>=9 <11 は、メジャーバージョン 9 と 10 を許可し、11 と 8 は許可しない', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`>=9 <11` を渡した場合に、`<11` は `<11.0.0` と同じなので、メジャーが 9 と 10 なら `true`、11 と 8 なら `false` を返すことを確認します。')
    expect(doesRangeAllowMajor('>=9 <11', 9)).toBe(true)
    expect(doesRangeAllowMajor('>=9 <11', 10)).toBe(true)
    // `<11` は `<11.0.0` なので、メジャー 11 の版は 1 つも含まれない。
    expect(doesRangeAllowMajor('>=9 <11', 11)).toBe(false)
    expect(doesRangeAllowMajor('>=9 <11', 8)).toBe(false)
  })

  it('上限が X.0.0 でなければ、上限のメジャーバージョンも許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`<11.2.0` と `<11.0.1` ではメジャー 11 を許可し、`<11.0.0` と `<11.0` ではメジャー 11 を許可しないことを確認します。')
    expect(doesRangeAllowMajor('<11.2.0', 11)).toBe(true)
    expect(doesRangeAllowMajor('<11.0.1', 11)).toBe(true)
    expect(doesRangeAllowMajor('<11.0.0', 11)).toBe(false)
    expect(doesRangeAllowMajor('<11.0', 11)).toBe(false)
  })

  it('<= で指定した上限は、そのメジャーバージョンを含む', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`>=9 <=11.0.0` ではメジャー 11 を許可し、`<=9.0.0` ではメジャー 9 を許可して 10 は許可しないことを確認します。')
    expect(doesRangeAllowMajor('>=9 <=11.0.0', 11)).toBe(true)
    expect(doesRangeAllowMajor('<=9.0.0', 9)).toBe(true)
    expect(doesRangeAllowMajor('<=9.0.0', 10)).toBe(false)
  })

  it('> の後ろにマイナーバージョン以下を指定した場合は、そのメジャーバージョンも許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`>9.9.9` ではメジャー 9 を許可して 8 は許可せず、`>9.0` では 9.1.0 以上を含むためメジャー 9 を許可することを確認します。')
    expect(doesRangeAllowMajor('>9.9.9', 9)).toBe(true)
    expect(doesRangeAllowMajor('>9.9.9', 8)).toBe(false)
    expect(doesRangeAllowMajor('>9.0', 9), '`>9.0` は 9.1.0 以上を含む').toBe(true)
  })

  it('メジャーバージョンだけを指定した > は、そのメジャーバージョンを許可しない', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`>9` は `>=10.0.0` と同じなので、メジャー 9 を許可せず 10 を許可し、`>9.x` もメジャー 9 を許可しないことを確認します。')
    // semver では `>9` は `>=10.0.0`。`major >= bound` に倒すとメジャー 9 の eslint を
    // 「テンプレートの要求どおり」と誤認して通す (fail-open)。
    expect(doesRangeAllowMajor('>9', 9)).toBe(false)
    expect(doesRangeAllowMajor('>9', 10)).toBe(true)
    // `9.x` はマイナー無指定と同じ扱い (`>9.x` も `>=10.0.0`)。
    expect(doesRangeAllowMajor('>9.x', 9)).toBe(false)
  })

  it('9 || 10 は、メジャーバージョン 9 と 10 の両方を許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`9 || 10` を渡した場合に、メジャーが 9 と 10 なら `true`、11 なら `false` を返すことを確認します。')
    expect(doesRangeAllowMajor('9 || 10', 9)).toBe(true)
    expect(doesRangeAllowMajor('9 || 10', 10)).toBe(true)
    expect(doesRangeAllowMajor('9 || 10', 11)).toBe(false)
  })

  it('^9.0.0 || ^10.0.0 のように、キャレットを OR で並べた範囲も許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`^9.0.0 || ^10.0.0` を渡した場合に、メジャーが 10 なら `true`、11 なら `false` を返すことを確認します。')
    expect(doesRangeAllowMajor('^9.0.0 || ^10.0.0', 10)).toBe(true)
    expect(doesRangeAllowMajor('^9.0.0 || ^10.0.0', 11)).toBe(false)
  })

  it('ハイフンで指定した範囲 9.0.0 - 10.5.0 は、メジャーバージョン 9 と 10 を許可する', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`9.0.0 - 10.5.0` を渡した場合に、メジャーが 9 と 10 なら `true`、11 と 8 なら `false` を返すことを確認します。')
    expect(doesRangeAllowMajor('9.0.0 - 10.5.0', 9)).toBe(true)
    expect(doesRangeAllowMajor('9.0.0 - 10.5.0', 10)).toBe(true)
    expect(doesRangeAllowMajor('9.0.0 - 10.5.0', 11)).toBe(false)
    expect(doesRangeAllowMajor('9.0.0 - 10.5.0', 8)).toBe(false)
  })
})

describe('doesRangeAllowMajor: 解釈できない表記', () => {
  it('workspace:・URL・git の依存の指定は、どのメジャーバージョンも許可しない', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`workspace:*`・URL・`github:eslint/eslint` のように解釈できない表記を渡した場合に、判定を無効にしないよう `false` を返すことを確認します。')
    // 解釈できない表記を通すと assert が無効になるので、fail-closed に倒す。
    for (const range of ['workspace:*', 'https://example.invalid/eslint.tgz', 'github:eslint/eslint']) {
      expect(doesRangeAllowMajor(range, 9)).toBe(false)
    }
  })

  it('プレリリースの付いた上限や範囲は、どのメジャーバージョンも許可しない', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`<10.0.0-rc.1` はメジャー 10 と 9 のどちらも、`^9.0.0-beta.1` はメジャー 9 を、許可しないことを確認します。')
    // `<10.0.0-rc.1` の上限判定はマイナー・パッチが数字であることを前提にしている。
    // `0-rc` を「0 ではない」と読むとメジャー 10 が通り、方針から外れる (fail-open)。
    expect(doesRangeAllowMajor('<10.0.0-rc.1', 10)).toBe(false)
    expect(doesRangeAllowMajor('<10.0.0-rc.1', 9)).toBe(false)
    expect(doesRangeAllowMajor('^9.0.0-beta.1', 9)).toBe(false)
  })

  it('ビルドメタデータの付いた表記は、どのメジャーバージョンも許可しない', async () => {
    await explains('eslint のバージョン範囲の表記が、指定したメジャーバージョンを許可するかを判定する `doesRangeAllowMajor` のテストです。`9.0.0+build.1` を渡した場合に、メジャー 9 でも `false` を返すことを確認します。')
    expect(doesRangeAllowMajor('9.0.0+build.1', 9)).toBe(false)
  })
})
