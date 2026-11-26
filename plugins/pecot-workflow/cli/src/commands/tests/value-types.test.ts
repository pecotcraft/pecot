import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { convertValue, flagKindOf, valueTypeOf } from '../value-types.js'
import type { ValueType } from '../value-types.js'

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
  it.for(KIND_CASES.map(([label, schema, expected]) => ({ label, schema, expected })))('$label のスキーマの場合は、種類 $expected を返す', async ({ schema, expected }) => {
    await explains('入力のスキーマからオプションの種類を求める `flagKindOf` のテストです。真偽値・配列・文字列と、`Optional` や `Default` などで包んだスキーマに対して、`boolean`・`list`・`value` のいずれかを返すことを確認します。')
    expect(flagKindOf(schema)).toBe(expected)
  })
})

const unbounded = { type: 'integer', min: undefined, max: undefined }

const TYPE_CASES: readonly (readonly [string, z.ZodType, unknown])[] = [
  ['範囲つきの整数', z.number().int().min(0).max(20), { type: 'integer', min: 0, max: 20 }],
  ['z.int() の端は範囲にしない', z.int(), unbounded],
  ['実数', z.number(), { type: 'float', min: undefined, max: undefined }],
  ['範囲つきの実数', z.number().min(0).max(5), { type: 'float', min: 0, max: 5 }],
  ['選択肢', z.enum(['a', 'b']).optional(), { type: 'choice', choices: ['a', 'b'] }],
  ['配列の選択肢', z.array(z.enum(['a', 'b'])).default([]), { type: 'choice', choices: ['a', 'b'] }],
  ['文字列', z.string(), { type: 'string' }],
  ['配列は要素の型', z.array(z.int()).readonly(), unbounded],
  ['オブジェクトの配列', z.array(z.strictObject({ name: z.string() })).optional(), { type: 'json' }],
  ['オブジェクト', z.object({ name: z.string() }), { type: 'json' }],
]

describe('valueTypeOf', () => {
  it.for(TYPE_CASES.map(([label, schema, expected]) => ({ label, schema, expected })))('$label のスキーマの場合は、値の型 $expected を返す', async ({ schema, expected }) => {
    await explains('入力のスキーマから値の型を求める `valueTypeOf` のテストです。範囲つきの整数・実数・選択肢・文字列・オブジェクトなどに対して、`integer`・`float`・`choice`・`string`・`json` の型と範囲を返すことを確認します。')
    expect(valueTypeOf(schema)).toEqual(expected)
  })
})

describe('convertValue', () => {
  it('文字列は、変換せずにそのまま返す', async () => {
    await explains('文字列型の `convertValue` のテストです。`x` を渡した場合に、変換せずに同じ `x` を返すことを確認します。')
    expect(convertValue('x', { type: 'string' })).toEqual({ isValid: true, value: 'x' })
  })

  it('整数は、前後の空白と数字の間の _ を受け付ける', async () => {
    await explains('整数型の `convertValue` のテストです。` 1_000 ` のように前後に空白があり、数字の間に `_` を含む値を、`1000` に変換することを確認します。')
    expect(convertValue(' 1_000 ', { type: 'integer', min: undefined, max: undefined })).toEqual({ isValid: true, value: 1000 })
  })

  it('範囲外の値のメッセージは、両端・下限だけ・上限だけで文が変わる', async () => {
    await explains('範囲を持つ整数型の `convertValue` のテストです。範囲外の値を渡した場合に、`0<=x<=5`・`x>=0`・`x<=5` のように、範囲の指定に応じたメッセージを返すことを確認します。')
    const both = convertValue('9', { type: 'integer', min: 0, max: 5 })
    const lower = convertValue('-1', { type: 'integer', min: 0, max: undefined })
    const upper = convertValue('9', { type: 'integer', min: undefined, max: 5 })
    expect(both).toEqual({ isValid: false, message: '9 is not in the range 0<=x<=5.' })
    expect(lower).toEqual({ isValid: false, message: '-1 is not in the range x>=0.' })
    expect(upper).toEqual({ isValid: false, message: '9 is not in the range x<=5.' })
  })

  it('整数でない値のメッセージは、範囲を持つかどうかで文が変わる', async () => {
    await explains('整数でない値 `a` を渡した場合の `convertValue` のテストです。範囲を持たない場合は `is not a valid int.`、範囲を持つ場合は `is not a valid int range.` のメッセージになることを確認します。')
    expect(convertValue('a', { type: 'integer', min: undefined, max: undefined })).toEqual({ isValid: false, message: '\'a\' is not a valid int.' })
    expect(convertValue('a', { type: 'integer', min: 0, max: undefined })).toEqual({ isValid: false, message: '\'a\' is not a valid int range.' })
  })

  it('実数は、指数表記・inf・nan を受け付け、不正な形は拒否する', async () => {
    await explains('実数型の `convertValue` のテストです。`1e3`・`inf`・`NaN` などは変換し、`1.2.3`・`0x10`・空文字は `is not a valid float.` のメッセージで拒否することを確認します。')
    expect(convertValue('1e3', { type: 'float', min: undefined, max: undefined })).toEqual({ isValid: true, value: 1000 })
    expect(convertValue('-Infinity', { type: 'float', min: undefined, max: undefined })).toEqual({ isValid: true, value: -Infinity })
    expect(convertValue('inf', { type: 'float', min: undefined, max: undefined })).toEqual({ isValid: true, value: Infinity })
    expect(convertValue('NaN', { type: 'float', min: undefined, max: undefined })).toEqual({ isValid: true, value: NaN })
    expect(convertValue('1.2.3', { type: 'float', min: undefined, max: undefined })).toEqual({ isValid: false, message: '\'1.2.3\' is not a valid float.' })
    expect(convertValue('0x10', { type: 'float', min: undefined, max: undefined })).toEqual({ isValid: false, message: '\'0x10\' is not a valid float.' })
    expect(convertValue('', { type: 'float', min: undefined, max: undefined })).toEqual({ isValid: false, message: '\'\' is not a valid float.' })
  })

  it('範囲を持つ実数は float range として扱い、範囲外の値は Python の float の表記で表示する', async () => {
    await explains('範囲を持つ実数型の `convertValue` のテストです。実数でない値は `is not a valid float range.`、範囲外の `9` は範囲を示すメッセージになり、範囲内の `3` は受け付けることを確認します。')
    const range: ValueType = { type: 'float', min: 0, max: 5 }
    expect(convertValue('a', range)).toEqual({ isValid: false, message: '\'a\' is not a valid float range.' })
    expect(convertValue('9', range)).toEqual({ isValid: false, message: '9.0 is not in the range 0<=x<=5.' })
    expect(convertValue('3', range)).toEqual({ isValid: true, value: 3 })
  })

  it('JSON のオブジェクトは、読み込んだ値をそのまま返し、中身の形は検証しない', async () => {
    await explains('JSON 型の `convertValue` のテストです。JSON のオブジェクトを渡した場合に、読み込んだ値をそのまま返し、キーの種類や数を検証しないことを確認します。')
    expect(convertValue('{"name":"Estimate","value":3,"extra":true}', { type: 'json' })).toEqual({ isValid: true, value: { name: 'Estimate', value: 3, extra: true } })
  })

  it.for([
    { text: '{name:1}', message: '\'{name:1}\' is not a valid JSON object.' },
    { text: '[1]', message: '\'[1]\' is not a valid JSON object.' },
    { text: '"x"', message: '\'"x"\' is not a valid JSON object.' },
    { text: '3', message: '\'3\' is not a valid JSON object.' },
    { text: 'null', message: '\'null\' is not a valid JSON object.' },
  ])('JSON のオブジェクトの型に $text を渡すと、拒否する', async ({ text, message }) => {
    await explains('JSON 型の `convertValue` のテストです。読めない JSON・配列・文字列・数・`null` のようにオブジェクトでない値を渡した場合に、`is not a valid JSON object.` のメッセージで拒否することを確認します。')
    expect(convertValue(text, { type: 'json' })).toEqual({ isValid: false, message })
  })

  it('選択肢に含まれない値は、すべての選択肢を並べて拒否する', async () => {
    await explains('選択肢型の `convertValue` のテストです。選択肢の値はそのまま受け付け、選択肢にない値は `is not one of \'plan\', \'merge-diff\'.` のように、すべての選択肢を並べて拒否することを確認します。')
    const choice: ValueType = { type: 'choice', choices: ['plan', 'merge-diff'] }
    expect(convertValue('plan', choice)).toEqual({ isValid: true, value: 'plan' })
    expect(convertValue('bogus', choice)).toEqual({ isValid: false, message: '\'bogus\' is not one of \'plan\', \'merge-diff\'.' })
  })
})
