// ツールの outputSchema。pecot-workflow の mcp/result.ts と同じ作りで、閉じた object の anyOf で成功の必須項目か kind と detail を求める。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */

import { fromJsonSchema } from '@modelcontextprotocol/server'
import type { JsonSchemaType, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

const FAILURE_REQUIRED: readonly string[] = ['kind', 'detail']

/**
成功の形ごとに、必ず返る項目の組。空なら anyOf を置かない。
*/
export type SuccessRequired = readonly (readonly string[])[]

/**
zod の object を JSON Schema にし、成功の必須項目があれば anyOf の枝で「成功の形のどれか」か「kind と detail」を求める。
*/
export function toolOutputSchema(output: z.ZodObject, success: SuccessRequired): Record<string, unknown> {
  const generated = Object.entries(z.toJSONSchema(output, { io: 'output' })).filter(([key]) => key !== '$schema')
  return {
    ...Object.fromEntries(generated),
    ...success.length > 0 && {
      anyOf: [...success.map(required => ({ required: [...required] })), { required: [...FAILURE_REQUIRED] }],
    },
  }
}

/**
手組みの JSON Schema を、SDK が受ける形にする。検証は SDK の ajv（2020-12）で、値を変えない。
*/
export function standardOutputSchema(schema: Readonly<Record<string, unknown>>): StandardSchemaWithJSON {
  // eslint-disable-next-line no-restricted-syntax -- JsonSchemaType は全キーワードの型で、組み立てた object を当てられない
  return fromJsonSchema(schema as JsonSchemaType)
}
