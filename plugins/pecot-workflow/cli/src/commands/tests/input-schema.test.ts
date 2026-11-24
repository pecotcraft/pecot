import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { normalizeInput } from '../input-schema.js'
import { ATTRIBUTES_INPUT } from './support.js'

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function normalized(shape: Readonly<Record<string, z.ZodType>>): ReturnType<typeof normalizeInput> {
  return normalizeInput(z.toJSONSchema(z.strictObject(shape), { io: 'input' }), 'issue edit', false)
}

describe('normalizeInput', () => {
  it('オブジェクトの配列は、items の中の properties・anyOf の枝まで、キーと名前の順をそろえる', () => {
    expect(JSON.stringify(normalized({ attributes: ATTRIBUTES_INPUT }).properties)).toBe(JSON.stringify({
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

  it.for([
    { name: 'properties の中', schema: z.strictObject({ m: z.string().min(1) }), message: 'issue edit: n: unsupported JSON Schema key minLength' },
    { name: 'anyOf の枝の中', schema: z.union([z.string().min(1), z.int()]), message: 'issue edit: n: unsupported JSON Schema key minLength' },
    { name: 'additionalProperties の中', schema: z.object({}).catchall(z.string().min(1)), message: 'issue edit: n: unsupported JSON Schema key minLength' },
  ])('$name で表に無いキーを使うと、コマンドと引数の名前を付けて止める', ({ schema, message }) => {
    expect(() => normalized({ n: schema })).toThrow(message)
  })

  it('type が文字列でなければ、コマンドと引数の名前を付けて止める', () => {
    const schema = { type: 'object', properties: { n: { type: ['string', 'null'] } }, required: [] }
    expect(() => normalizeInput(schema, 'issue edit', false)).toThrow('issue edit: n: unsupported type ["string","null"]')
  })
})
