/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
// オプションと位置引数の型。zod のスキーマの形から、click と同じ型変換と誤りの文を決める。
import { z } from 'zod'

import { parsePythonInteger, pythonStringRepr } from '../domain/python-format.js'

/**
CLI の値の形。真偽値は値を取らない旗、list は繰り返して渡す
*/
export type FlagKind = 'boolean' | 'list' | 'value'

export interface IntegerType {
  readonly type: 'integer'
  readonly min: number | undefined
  readonly max: number | undefined
}

export type ValueType = IntegerType | { readonly type: 'float' } | { readonly type: 'string' }

/**
包んでいる側のスキーマ。Optional・Default・Nullable・Readonly・Prefault・Catch・NonOptional は中を見る。
Pipe は、後段が transform なら前段を、そうでなければ後段を見る
*/
function innerSchemaOf(schema: z.core.$ZodType): z.core.$ZodType | undefined {
  if (
    schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable
    || schema instanceof z.ZodReadonly || schema instanceof z.ZodPrefault || schema instanceof z.ZodCatch
    || schema instanceof z.ZodNonOptional
  ) return schema.unwrap()
  if (schema instanceof z.ZodPipe) return schema.out instanceof z.ZodTransform ? schema.in : schema.out
  return undefined
}

function unwrapped(schema: z.core.$ZodType): z.core.$ZodType {
  let current = schema
  for (let inner = innerSchemaOf(current); inner !== undefined; inner = innerSchemaOf(current)) current = inner
  return current
}

export function flagKindOf(schema: z.core.$ZodType): FlagKind {
  const current = unwrapped(schema)
  if (current instanceof z.ZodBoolean) return 'boolean'
  return current instanceof z.ZodArray ? 'list' : 'value'
}

// z.int() は上下を安全な整数の端にする。範囲の指定とは見なさない
function boundOf(bound: number | null): number | undefined {
  return bound === null || Math.abs(bound) >= Number.MAX_SAFE_INTEGER ? undefined : bound
}

/**
値 1 つの型。list は要素の型
*/
export function valueTypeOf(schema: z.core.$ZodType): ValueType {
  const outer = unwrapped(schema)
  const current = outer instanceof z.ZodArray ? unwrapped(outer.element) : outer
  if (current instanceof z.ZodNumber) {
    const isInteger = (current.format ?? '').includes('int')
    return isInteger ? { type: 'integer', min: boundOf(current.minValue), max: boundOf(current.maxValue) } : { type: 'float' }
  }
  return { type: 'string' }
}

const SPECIAL_FLOAT = /^[+-]?(?:inf|infinity|nan)$/iu
const DECIMAL_CHARACTERS = /^[+-]?[\d.][\d.e+-]*$/iu

/**
float(text) と同じ。前後の空白・数字の間の `_`・指数・inf・nan を受ける。不正なら undefined
*/
function parsePythonFloat(text: string): number | undefined {
  const lower = text.trim().toLowerCase().replaceAll(/(?<=\d)_(?=\d)/gu, '')
  if (SPECIAL_FLOAT.test(lower)) {
    if (lower.endsWith('nan')) return NaN
    return lower.startsWith('-') ? -Infinity : Infinity
  }
  if (!DECIMAL_CHARACTERS.test(lower)) return undefined
  const value = Number(lower)
  return Number.isNaN(value) ? undefined : value
}

function describeRange(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${String(min)}<=x<=${String(max)}`
  return min === undefined ? `x<=${String(max)}` : `x>=${String(min)}`
}

export type Conversion
  = | { readonly isValid: true, readonly value: unknown }
    | { readonly isValid: false, readonly message: string }

/**
コマンドラインの文字列を、型に応じて変換する。誤りの文は click と同じ
*/
export function convertValue(text: string, valueType: ValueType): Conversion {
  if (valueType.type === 'string') return { isValid: true, value: text }
  if (valueType.type === 'float') {
    const value = parsePythonFloat(text)
    return value === undefined ? { isValid: false, message: `${pythonStringRepr(text)} is not a valid float.` } : { isValid: true, value }
  }
  const { min, max } = valueType
  const hasRange = min !== undefined || max !== undefined
  const value = parsePythonInteger(text)
  if (value === undefined) {
    return { isValid: false, message: `${pythonStringRepr(text)} is not a valid integer${hasRange ? ' range' : ''}.` }
  }
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    return { isValid: false, message: `${String(value)} is not in the range ${describeRange(min, max)}.` }
  }
  return { isValid: true, value }
}
