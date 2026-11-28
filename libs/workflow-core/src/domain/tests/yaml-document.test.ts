import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { JSON_NULL } from '../json-null.js'
import { parseYamlDocument } from '../yaml-document.js'

// 期待値は、Python の CLI が使っていた YAML ライブラリ（safe_load）の実出力から作った表
const PYTHON_RESULTS: readonly (readonly [string, unknown])[] = [
  ['v: y', { v: 'y' }],
  ['v: n', { v: 'n' }],
  ['v: Y', { v: 'Y' }],
  ['v: N', { v: 'N' }],
  ['v: yes', { v: true }],
  ['v: No', { v: false }],
  ['v: on', { v: true }],
  ['v: OFF', { v: false }],
  ['v: true', { v: true }],
  ['v: True', { v: true }],
  ['v: TRUE', { v: true }],
  ['v: tRue', { v: 'tRue' }],
  ['v: False', { v: false }],
  ['v: off', { v: false }],
  ['v: Off', { v: false }],
  ['v: oN', { v: 'oN' }],
  ['v: 2026-10-30', { v: new Date('2026-10-30T00:00:00.000Z') }],
  ['v: 2026-10-30 12:00:00', { v: new Date('2026-10-30T12:00:00.000Z') }],
  ['v: 2026-10-30T12:00:00Z', { v: new Date('2026-10-30T12:00:00.000Z') }],
  ['v: 2026-10-30t12:00:00.5+09:00', { v: new Date('2026-10-30T03:00:00.500Z') }],
  ['v: 2026-1-2', { v: '2026-1-2' }],
  ['v: 2026-1-2 3:04:05', { v: new Date('2026-01-02T03:04:05.000Z') }],
  ['v: 2026-10-30 12:00:00 -5', { v: new Date('2026-10-30T17:00:00.000Z') }],
  ['v: 010', { v: 8 }],
  ['v: 0o10', { v: '0o10' }],
  ['v: 0x1F', { v: 31 }],
  ['v: 0b101', { v: 5 }],
  ['v: 1_000', { v: 1000 }],
  ['v: 1:30', { v: 90 }],
  ['v: 1e3', { v: '1e3' }],
  ['v: 1.0e3', { v: '1.0e3' }],
  ['v: 1.0e+3', { v: 1000 }],
  ['v: 1e+3', { v: '1e+3' }],
  ['v: .5', { v: 0.5 }],
  ['v: -.5', { v: '-.5' }],
  ['v: +.5', { v: '+.5' }],
  ['v: .inf', { v: Infinity }],
  ['v: -.inf', { v: -Infinity }],
  ['v: .NaN', { v: NaN }],
  ['v: .nan', { v: NaN }],
  ['v: .NAN', { v: NaN }],
  ['v: ~', { v: JSON_NULL }],
  ['v: null', { v: JSON_NULL }],
  ['v: Null', { v: JSON_NULL }],
  ['v: NULL', { v: JSON_NULL }],
  ['v: nULL', { v: 'nULL' }],
  ['v:', { v: JSON_NULL }],
  ['v: \'\'', { v: '' }],
  ['v: ""', { v: '' }],
  ['a: 1\na: 2', { a: 2 }],
  ['base: &b {x: 1}\nm:\n  <<: *b\n  y: 2', { base: { x: 1 }, m: { x: 1, y: 2 } }],
  ['base: &b {x: 1, z: 9}\nm:\n  <<: *b\n  x: 2', { base: { x: 1, z: 9 }, m: { x: 2, z: 9 } }],
  ['v: 08', { v: '08' }],
  ['v: 09', { v: '09' }],
  ['v: 09.5', { v: 9.5 }],
  ['v: +1', { v: 1 }],
  ['v: -0', { v: 0 }],
  ['v: 0', { v: 0 }],
  ['v: 00', { v: 0 }],
  ['v: 0_', { v: 0 }],
  ['v: -1_0', { v: -10 }],
  ['v: 1__0', { v: 10 }],
  ['v: _1', { v: '_1' }],
  ['v: 1.', { v: 1 }],
  ['v: -1.5', { v: -1.5 }],
  ['v: 1.5', { v: 1.5 }],
  ['v: 1_0.5', { v: 10.5 }],
  ['v: 1:30.5', { v: 90.5 }],
  ['v: 190:20:30', { v: 685_230 }],
  ['v: 1:60', { v: '1:60' }],
  ['v: 1:6', { v: 66 }],
  ['v: !!str 1', { v: '1' }],
  ['v: !!int \'3\'', { v: 3 }],
  ['v: !!bool \'yes\'', { v: true }],
  ['v: "\\x41"', { v: 'A' }],
  ['v: \'#x\'', { v: '#x' }],
  ['v: a #c', { v: 'a' }],
  ['v: \'yes\'', { v: 'yes' }],
  ['v: "1"', { v: '1' }],
  ['v: "y"', { v: 'y' }],
  ['- 1\n- y\n- n', [1, 'y', 'n']],
  ['v: [y, n, 1, \'x\']', { v: ['y', 'n', 1, 'x'] }],
  ['v: {a: yes, b: 1e3}', { v: { a: true, b: '1e3' } }],
  ['? y\n: 1', { y: 1 }],
  ['true: 1', { true: 1 }],
  ['1: x', { 1: 'x' }],
  ['y: 1', { y: 1 }],
  ['v: |\n  yes\n', { v: 'yes\n' }],
  ['v: >\n  1\n', { v: '1\n' }],
  ['v: 0.', { v: 0 }],
  ['v: 00.5', { v: 0.5 }],
  ['v: 0b', { v: '0b' }],
  ['v: 0x', { v: '0x' }],
  ['v: 0xg', { v: '0xg' }],
  ['v: +0x1f', { v: 31 }],
  ['v: -0b11', { v: -3 }],
  ['v: 0B1', { v: '0B1' }],
  ['v: 0X1f', { v: '0X1f' }],
  ['v: +', { v: '+' }],
  ['v: .', { v: '.' }],
  ['v: -.', { v: '-.' }],
  ['v: .e1', { v: '.e1' }],
  ['v: 1e', { v: '1e' }],
  ['v: 1.e3', { v: '1.e3' }],
  ['v: 12:30', { v: 750 }],
  ['v: 12:30:45', { v: 45_045 }],
  ['v: 12:3', { v: 723 }],
  ['v: 1:2:3:4', { v: 223_384 }],
  ['v: !!null \'\'', { v: JSON_NULL }],
  ['v: !!str', { v: '' }],
]

const PYTHON_ERRORS: readonly string[] = [
  'v: =',
  'v: [1, 2',
  'title: a: b',
  'v: -',
]

describe('parseYamlDocument', () => {
  it.each(PYTHON_RESULTS)('%j は Python と同じ値になる', async (source, expected) => {
    await explains('YAML の文書を読み取る関数のテストです。真偽値・数値・日付・`null` などのさまざまな書き方が、Python の YAML ライブラリ（`safe_load`）の実際の出力と同じ値になることを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseYamlDocument(source)).toEqual(expected)
    })
  })

  it.each(PYTHON_ERRORS)('%j は、Python と同じく例外が発生する', async (source) => {
    await explains('YAML の文書を読み取る関数のテストです。構文が誤っている文書（`v: =` や閉じていない `[1, 2` など）を渡した場合に、Python と同様に例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseYamlDocument(source)).toThrow(Error)
    })
  })

  it('重複したキーがある場合は、後に書いた値を採用する', async () => {
    await explains('YAML の文書を読み取る関数のテストです。キーが重複している文書を渡した場合に、後に書いた値が採用されることを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseYamlDocument('type: task\ntype: bug\n')).toEqual({ type: 'bug' })
    })
  })

  it('空の文書とコメントだけの文書は、null を表す値を返す', async () => {
    await explains('YAML の文書を読み取る関数のテストです。空の文書とコメントだけの文書を渡した場合に、`null` を表す値を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseYamlDocument('')).toBe(JSON_NULL)
      expect(parseYamlDocument('# コメントだけ\n')).toBe(JSON_NULL)
    })
  })

  it('-0 を渡すと、整数の 0 を返す', async () => {
    await explains('YAML の文書を読み取る関数のテストです。`-0` を渡した場合に、負のゼロでなく、整数の 0 として読み取ることを確認します。')
    stepSync('結果を比べる', () => {
      expect(Object.is(parseYamlDocument('-0'), 0)).toBe(true)
    })
  })

  it.each([
    ['a: !!float 1', { a: 1 }],
    ['a: !!float \'1\'', { a: 1 }],
    ['a: !!float .5', { a: 0.5 }],
    ['a: !!float 1:30', { a: 90 }],
    ['a: !!int 0x10', { a: 16 }],
    ['a: !!int 1_0', { a: 10 }],
    ['a: !!int \'3\'', { a: 3 }],
    ['a: !!str 1', { a: '1' }],
    ['a: !!bool yes', { a: true }],
    ['a: !!bool yEs', { a: true }],
    ['a: !!null x', { a: JSON_NULL }],
    ['a: !!timestamp 2026-10-30', { a: new Date('2026-10-30T00:00:00.000Z') }],
  ])('明示的なタグを付けた場合は、値の形に依らず、タグの型で読み取る（Python の実際の出力）: %j', async (source, expected) => {
    await explains('YAML の明示的なタグのテストです。`!!float` や `!!int` などのタグを付けた場合に、値の形でなくタグの型に従って読み取り、Python の実際の出力と同じ値になることを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseYamlDocument(source)).toEqual(expected)
    })
  })

  it.each([
    'a: !!int 1.5',
    'a: !!int abc',
    'a: !!bool maybe',
    'a: !!bool 1',
    'a: !!float abc',
    'a: !!timestamp x',
    'a: !!foo 1',
    'a: !foo 1',
    'a: <<',
    'a: [<<]',
    '<<: 1',
    '? [a, b]\n: 1',
    '? {a: 1}\n: 1',
  ])('Python が ConstructorError か ValueError で失敗する入力は、例外が発生する: %j', async (source) => {
    await explains('YAML の誤った入力のテストです。タグの型と値が合わない場合や未知のタグなど、Python が `ConstructorError` か `ValueError` で失敗する入力に対して、例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseYamlDocument(source)).toThrow(Error)
    })
  })

  it.each(['a: \'<<\'', 'a: "<<"', 'a: !!str <<'])('引用符で囲んだ << と、str タグを付けた << は、文字列として読み取る: %s', async (source) => {
    await explains('YAML の `<<`（マージキー）のテストです。引用符で囲んだ `<<` と、`!!str` を付けた `<<` を渡した場合に、文字列の `<<` として読み取ることを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseYamlDocument(source)).toEqual({ a: '<<' })
    })
  })

  it('文字列でないキーは文字列にして読む（Python は int・真偽値・None のキー。検証後の結果は同じ）', async () => {
    await explains('YAML のキーのテストです。文字列でないキー（`1`・`yes`・`null` など）を渡した場合に、文字列のキーに変換して読み取ることを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseYamlDocument('1: a\nyes: b\nnull: c')).toEqual({ 1: 'a', true: 'b', null: 'c' })
    })
  })

  it('存在しない日付と時刻を渡すと、例外が発生する', async () => {
    await explains('YAML の日付のテストです。`2026-02-30` のように存在しない日付や、`25:00:00` のように存在しない時刻を渡した場合に、例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseYamlDocument('v: 2026-02-30')).toThrow(Error)
      expect(() => parseYamlDocument('v: 2026-10-30 25:00:00')).toThrow(Error)
    })
  })
})
