import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { convertValue, flagKindOf, valueTypeOf } from '../value-types.js'

const strings = z.array(z.string())
const flag = z.boolean()

const KIND_CASES: readonly (readonly [string, z.ZodType, string])[] = [
  ['真偽値', flag, 'boolean'],
  ['配列', strings, 'list'],
  ['文字列', z.string(), 'value'],
  ['Optional', flag.optional(), 'boolean'],
  ['Default', flag.default(true), 'boolean'],
  ['Nullable', flag.nullable(), 'boolean'],
  ['Readonly', strings.readonly(), 'list'],
  ['Prefault', strings.prefault([]), 'list'],
  ['Catch', flag.catch(false), 'boolean'],
  ['NonOptional', flag.optional().nonoptional(), 'boolean'],
  ['後段が transform の Pipe は前段を見る', flag.transform(value => !value), 'boolean'],
  ['preprocess は後段を見る', z.preprocess(value => value, strings), 'list'],
  ['後段が transform でない Pipe は後段を見る', z.string().pipe(z.string().min(1)), 'value'],
]

describe('flagKindOf', () => {
  it.for(KIND_CASES.map(([label, schema, expected]) => ({ label, schema, expected })))('$label のとき、$expected を返す', ({ schema, expected }) => {
    expect(flagKindOf(schema)).toBe(expected)
  })
})

const unbounded = { type: 'integer', min: undefined, max: undefined }

const TYPE_CASES: readonly (readonly [string, z.ZodType, unknown])[] = [
  ['範囲つきの整数', z.number().int().min(0).max(20), { type: 'integer', min: 0, max: 20 }],
  ['z.int() の端は範囲にしない', z.int(), unbounded],
  ['実数', z.number(), { type: 'float' }],
  ['文字列', z.string(), { type: 'string' }],
  ['配列は要素の型', z.array(z.int()).readonly(), unbounded],
]

describe('valueTypeOf', () => {
  it.for(TYPE_CASES.map(([label, schema, expected]) => ({ label, schema, expected })))('$label のとき、$expected を返す', ({ schema, expected }) => {
    expect(valueTypeOf(schema)).toEqual(expected)
  })
})

describe('convertValue', () => {
  it('文字列はそのまま', () => {
    expect(convertValue('x', { type: 'string' })).toEqual({ isValid: true, value: 'x' })
  })

  it('整数は前後の空白と数字の間の _ を受ける', () => {
    expect(convertValue(' 1_000 ', { type: 'integer', min: undefined, max: undefined })).toEqual({ isValid: true, value: 1000 })
  })

  it('範囲の説明は、両端・下だけ・上だけで変わる', () => {
    const both = convertValue('9', { type: 'integer', min: 0, max: 5 })
    const lower = convertValue('-1', { type: 'integer', min: 0, max: undefined })
    const upper = convertValue('9', { type: 'integer', min: undefined, max: 5 })
    expect(both).toEqual({ isValid: false, message: '9 is not in the range 0<=x<=5.' })
    expect(lower).toEqual({ isValid: false, message: '-1 is not in the range x>=0.' })
    expect(upper).toEqual({ isValid: false, message: '9 is not in the range x<=5.' })
  })

  it('整数でなければ、範囲があるかで文が変わる', () => {
    expect(convertValue('a', { type: 'integer', min: undefined, max: undefined })).toEqual({ isValid: false, message: '\'a\' is not a valid integer.' })
    expect(convertValue('a', { type: 'integer', min: 0, max: undefined })).toEqual({ isValid: false, message: '\'a\' is not a valid integer range.' })
  })

  it('実数は指数・inf・nan を受け、不正な形は断る', () => {
    expect(convertValue('1e3', { type: 'float' })).toEqual({ isValid: true, value: 1000 })
    expect(convertValue('-Infinity', { type: 'float' })).toEqual({ isValid: true, value: -Infinity })
    expect(convertValue('inf', { type: 'float' })).toEqual({ isValid: true, value: Infinity })
    expect(convertValue('NaN', { type: 'float' })).toEqual({ isValid: true, value: NaN })
    expect(convertValue('1.2.3', { type: 'float' })).toEqual({ isValid: false, message: '\'1.2.3\' is not a valid float.' })
    expect(convertValue('0x10', { type: 'float' })).toEqual({ isValid: false, message: '\'0x10\' is not a valid float.' })
    expect(convertValue('', { type: 'float' })).toEqual({ isValid: false, message: '\'\' is not a valid float.' })
  })
})
