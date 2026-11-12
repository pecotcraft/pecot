// シナリオの argv を、MCP のツールの入力にする。写し方は定義書（interface/generated.json）の cli.positional・cli.flags と input の型に従う。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { parseJson } from '../../src/tests/_helpers/json.js'
import { pluginRoot } from './setup.js'

const Names = z.array(z.string())
const PropertySchema = z.looseObject({ type: z.string() })
const SurfacesSchema = z.object({ cli: z.object({ path: Names }) })
const InputSchema = z.object({ properties: z.record(z.string(), PropertySchema) })
const CliSchema = z.object({ positional: Names, flags: z.record(z.string(), Names) })
const EntrySchema = z.object({ surfaces: SurfacesSchema, input: InputSchema, cli: CliSchema })
const GeneratedSchema = z.object({ entries: z.array(EntrySchema) })

export type ToolShape = z.output<typeof EntrySchema>

type ToolInput = Record<string, unknown>

export function readToolShape(commandPath: readonly string[]): ToolShape {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- plugin の interface/ の下の固定のファイル
  const text = readFileSync(path.join(pluginRoot, 'interface', 'generated.json'), 'utf8')
  const generated = GeneratedSchema.parse(parseJson(text))
  const entry = generated.entries.find(item => item.surfaces.cli.path.join(' ') === commandPath.join(' '))
  if (entry === undefined) throw new Error(`定義書に ${commandPath.join(' ')} がありません`)
  return entry
}

interface FlagTarget {
  readonly field: string
  readonly isNegation: boolean
}

// `--no-x` は、同じ入力が `--x` も持つときだけ否定形。入力 no_x の `--no-x` は、ふつうの真偽値
function isNegationOf(flag: string, flags: readonly string[]): boolean {
  return flag.startsWith('--no-') && flags.includes(`--${flag.slice(5)}`)
}

function flagTargets(shape: Readonly<ToolShape>): ReadonlyMap<string, FlagTarget> {
  const entries = Object.entries(shape.cli.flags).flatMap(([field, flags]) => flags.map((flag): [string, FlagTarget] => [flag, { field, isNegation: isNegationOf(flag, flags) }]))
  return new Map(entries)
}

function typeOf(shape: Readonly<ToolShape>, field: string): string {
  const property = Object.entries(shape.input.properties).find(([name]) => name === field)?.[1]
  if (property === undefined) throw new Error(`${field} は入力に無い名前です`)
  return property.type
}

function convert(type: string, field: string, text: string): unknown {
  if (type !== 'integer') return text
  if (!/^-?\d+$/u.test(text)) throw new TypeError(`${field}: 整数ではありません: ${text}`)
  const value = Number(text)
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field}: 整数ではありません: ${text}`)
  return value
}

function assign(input: ToolInput, shape: Readonly<ToolShape>, field: string, text: string): void {
  const type = typeOf(shape, field)
  const current = Reflect.get(input, field)
  const previous: unknown[] = Array.isArray(current) ? current : []
  Reflect.set(input, field, type === 'array' ? [...previous, text] : convert(type, field, text))
}

interface Parsed {
  readonly input: ToolInput
  readonly positional: readonly string[]
}

const GLOBAL_REPOSITORY_FLAGS: ReadonlySet<string> = new Set(['--repo'])
const REPOSITORY_TARGET: FlagTarget = { field: 'repo', isNegation: false }

function targetOf(targets: ReadonlyMap<string, FlagTarget>, flag: string): FlagTarget {
  const target = targets.get(flag) ?? (GLOBAL_REPOSITORY_FLAGS.has(flag) ? REPOSITORY_TARGET : undefined)
  if (target === undefined) throw new Error(`定義書に無いフラグです: ${flag}`)
  return target
}

// CLI（click）は `-1` のような負数に見える語を未定義の短いオプションとして断る。MCP の入力には写せない
const NEGATIVE_NUMBER = /^-\d/u

function parseFlags(shape: Readonly<ToolShape>, argv: readonly string[]): Parsed {
  const targets = flagTargets(shape)
  const input: ToolInput = {}
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv.at(index) ?? ''
    // 区切りは、値に使われなかった `--` だけ。値の位置の `--` は下で値にする
    // eslint-disable-next-line security/detect-possible-timing-attacks -- 秘密ではない argv の比較
    if (token === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    if (NEGATIVE_NUMBER.test(token)) throw new Error(`負数に見える語は、CLI が未定義のオプションとして断るので写せません: ${token}`)
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    const flag = equals === -1 ? token : token.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1)
    const target = targetOf(targets, flag)
    if (target.field !== 'repo' && typeOf(shape, target.field) === 'boolean') {
      if (inlineValue !== undefined) throw new Error(`${flag} は値を取らないフラグです: ${token}`)
      Reflect.set(input, target.field, !target.isNegation)
      continue
    }
    const value = inlineValue ?? argv.at(index + 1)
    if (value === undefined) throw new Error(`${flag} に値がありません`)
    if (inlineValue === undefined) index += 1
    if (target.field === 'repo') Reflect.set(input, 'repo', value)
    else assign(input, shape, target.field, value)
  }
  return { input, positional }
}

/**
argv（コマンド名より後ろ）を、ツールの入力にする。位置引数は cli.positional の順に入れ、最後が配列ならその先を全部集める。
フラグは cli.flags で入力の名前に引き、値を取らない真偽値は true（否定形は false）。グローバルの --repo は repo。
写せない argv（未知のフラグ・負数に見える語・余った位置引数・真偽値への値など）は例外にする
*/
export function toolInputOf(shape: Readonly<ToolShape>, argv: readonly string[]): Readonly<ToolInput> {
  const { input, positional } = parseFlags(shape, argv)
  const last = shape.cli.positional.at(-1)
  const isVariadic = last !== undefined && typeOf(shape, last) === 'array'
  if (!isVariadic && positional.length > shape.cli.positional.length) {
    throw new Error(`位置引数が多すぎます: ${positional.slice(shape.cli.positional.length).join(' ')}`)
  }
  for (const [position, field] of shape.cli.positional.entries()) {
    const isLast = position === shape.cli.positional.length - 1
    const rest = positional.slice(position)
    const texts = isLast && typeOf(shape, field) === 'array' ? rest : rest.slice(0, 1)
    for (const text of texts) assign(input, shape, field, text)
  }
  return input
}
