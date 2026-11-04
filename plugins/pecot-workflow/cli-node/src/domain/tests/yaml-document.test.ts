import { describe, expect, it } from 'vitest'

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
  it.each(PYTHON_RESULTS)('%j は Python と同じ値になる', (source, expected) => {
    expect(parseYamlDocument(source)).toEqual(expected)
  })

  it.each(PYTHON_ERRORS)('%j は Python と同じくエラーになる', (source) => {
    expect(() => parseYamlDocument(source)).toThrow(Error)
  })

  it('重複キーは後のものが勝つ', () => {
    expect(parseYamlDocument('type: task\ntype: bug\n')).toEqual({ type: 'bug' })
  })

  it('空の文書は null', () => {
    expect(parseYamlDocument('')).toBe(JSON_NULL)
    expect(parseYamlDocument('# コメントだけ\n')).toBe(JSON_NULL)
  })

  it('-0 の整数は 0 になる', () => {
    expect(Object.is(parseYamlDocument('-0'), 0)).toBe(true)
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
  ])('明示タグは値の形に依らず、タグの型で読む（Python の実出力）: %j', (source, expected) => {
    expect(parseYamlDocument(source)).toEqual(expected)
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
  ])('Python が ConstructorError か ValueError で失敗する入力はエラーにする: %j', (source) => {
    expect(() => parseYamlDocument(source)).toThrow(Error)
  })

  it.each(['a: \'<<\'', 'a: "<<"', 'a: !!str <<'])('引用符付きの << と、str タグ付きの << は文字列: %s', (source) => {
    expect(parseYamlDocument(source)).toEqual({ a: '<<' })
  })

  it('文字列でないキーは文字列にして読む（Python は int・真偽値・None のキー。検証後の結果は同じ）', () => {
    expect(parseYamlDocument('1: a\nyes: b\nnull: c')).toEqual({ 1: 'a', true: 'b', null: 'c' })
  })

  it('存在しない日付はエラーにする', () => {
    expect(() => parseYamlDocument('v: 2026-02-30')).toThrow(Error)
    expect(() => parseYamlDocument('v: 2026-10-30 25:00:00')).toThrow(Error)
  })
})
