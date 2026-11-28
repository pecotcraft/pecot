import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { z } from 'zod'

import { normalizeInput } from '../input-schema.js'
import { ATTRIBUTES_INPUT } from './support.js'

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function normalized(shape: Readonly<Record<string, z.ZodType>>): ReturnType<typeof normalizeInput> {
  return normalizeInput(z.toJSONSchema(z.strictObject(shape), { io: 'input' }), 'issue edit', false)
}

describe('normalizeInput', () => {
  it('オブジェクトの配列は、items の中の properties・anyOf の枝まで、キーと名前の順をそろえる', async () => {
    await explains('入力の JSON Schema を正規化する `normalizeInput` のテストです。オブジェクトの配列を持つ入力の場合に、`items` の中の `properties` や `anyOf` の枝まで、キーと名前の順が決まった順に並ぶことを確認します。')
    const properties = stepSync('入力のスキーマを正規化する', () => normalized({ attributes: ATTRIBUTES_INPUT }).properties)
    stepSync('properties を比べる', () => {
      expect(JSON.stringify(properties)).toBe(JSON.stringify({
        attributes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Attribute name' },
              source: { type: 'string', enum: ['project', 'issue_field', 'issue'], description: 'Where the attribute lives' },
              value: {
                anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'array', items: { type: 'string' } }, { type: 'null' }],
                description: 'Value to write',
              },
            },
            required: ['name', 'value'],
            additionalProperties: false,
          },
          description: 'Attributes to write',
        },
      }))
    })
  })

  it.for([
    { name: 'properties の中', schema: z.strictObject({ m: z.string().max(1) }), message: 'issue edit: n: unsupported JSON Schema key maxLength' },
    { name: 'anyOf の枝の中', schema: z.union([z.string().max(1), z.int()]), message: 'issue edit: n: unsupported JSON Schema key maxLength' },
    { name: 'additionalProperties の中', schema: z.object({}).catchall(z.string().max(1)), message: 'issue edit: n: unsupported JSON Schema key maxLength' },
  ])('$name で未対応のキーを使うと、コマンドと引数の名前を付けたエラーを送出する', async ({ schema, message }) => {
    await explains('未対応の JSON Schema のキーを検出する `normalizeInput` のテストです。`properties` や `anyOf` の中に `maxLength` がある場合に、コマンド名と引数名を含む `unsupported JSON Schema key` の例外が発生することを確認します。')
    stepSync('未対応のキーを含むスキーマを正規化して例外を比べる', () => {
      expect(() => normalized({ n: schema })).toThrow(message)
    })
  })

  it('type が文字列でない場合は、コマンドと引数の名前を付けたエラーを送出する', async () => {
    await explains('未対応の `type` を検出する `normalizeInput` のテストです。`type` が `[\'string\', \'null\']` のように配列の場合に、コマンド名と引数名を含む `unsupported type` の例外が発生することを確認します。')
    const schema = { type: 'object', properties: { n: { type: ['string', 'null'] } }, required: [] }
    stepSync('type が配列のスキーマを正規化して例外を比べる', () => {
      expect(() => normalizeInput(schema, 'issue edit', false)).toThrow('issue edit: n: unsupported type ["string","null"]')
    })
  })

  it('スキーマの形が想定と違う部分は、空のオブジェクトか元の値のまま扱い、例外を送出しない', async () => {
    await explains('入力の JSON Schema を正規化する `normalizeInput` のテストです。オブジェクトでない引数・枝・`properties` や、文字列だけでない `required` を渡した場合に、空のオブジェクトに直すか元の値のまま残し、例外を送出しないことを確認します。')
    const schema = {
      type: 'object',
      properties: { z: { type: 'object', properties: { b: 1 }, anyOf: [1], required: [1, 'x'] }, a: 5 },
      required: 'bad',
    }
    const result = stepSync('形が想定と違うスキーマを正規化する', () => normalizeInput(schema, 'issue edit', false))
    stepSync('正規化の結果を比べる', () => {
      expect(result).toEqual({
        type: 'object',
        properties: { a: {}, z: { type: 'object', anyOf: [{}], properties: { b: {} }, required: [1, 'x'] } },
        required: [],
        additionalProperties: false,
      })
    })
  })

  it('properties が無いスキーマは、引数の無い入力として扱う', async () => {
    await explains('入力の JSON Schema を正規化する `normalizeInput` のテストです。`properties` を持たないスキーマの場合に、引数も必須の名前も空の入力にすることを確認します。')
    const result = stepSync('properties が無いスキーマを正規化する', () => normalizeInput({ type: 'object' }, 'issue edit', false))
    stepSync('正規化の結果を比べる', () => {
      expect(result).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false })
    })
  })
})
