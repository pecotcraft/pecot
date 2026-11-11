// cli-node のコマンド一覧（COMMANDS）から、interface/generated.json の項目を作る。
// 形と決定性の決めは specs/022-interface-definitions/contracts/definition-format.md にある。
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { z } from 'zod'

import { createOutput } from '../src/commands/output.js'
import { COMMANDS, type CommandDefinition, type CommandIo } from '../src/commands/registry.js'

const PREFIX = 'PW'

/**
引数の中のキーの順。ここに無いキーは後ろに、名前の順で付ける
*/
const SCHEMA_KEY_ORDER = ['type', 'items', 'enum', 'minimum', 'maximum', 'default', 'description']

/**
z.int() が付ける安全な整数の端
*/
const SAFE_INTEGER_EDGES = new Set([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])

export type JsonObject = Readonly<Record<string, unknown>>

export interface InputSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, JsonObject>>
  readonly required: readonly string[]
  readonly additionalProperties: false
}

export interface InterfaceEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly surfaces: { readonly cli: { readonly path: readonly string[] }, readonly mcp: { readonly tool: string } }
  readonly hidden: false
  readonly deprecated: false
  readonly input: InputSchema
  readonly cli: { readonly positional: readonly string[], readonly flags: Readonly<Record<string, readonly string[]>> }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byName(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

function keyRank(key: string): number {
  const index = SCHEMA_KEY_ORDER.indexOf(key)
  return index === -1 ? SCHEMA_KEY_ORDER.length : index
}

/**
引数 1 つの JSON Schema を、キーの順をそろえ、z.int() の端を外した形にする
*/
function normalizeProperty(schema: JsonObject): JsonObject {
  const entries = Object.entries(schema)
    .filter(([key, value]) => !(typeof value === 'number' && (key === 'minimum' || key === 'maximum') && SAFE_INTEGER_EDGES.has(value)))
    .toSorted(([left], [right]) => keyRank(left) - keyRank(right) || byName(left, right))
    .map(([key, value]): [string, unknown] => [key, key === 'items' && isRecord(value) ? normalizeProperty(value) : value])
  return Object.fromEntries(entries)
}

function normalizeInput(schema: JsonObject): InputSchema {
  const { properties, required } = schema
  const own = isRecord(properties) ? Object.entries(properties) : []
  const names = Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []
  return {
    type: 'object',
    properties: Object.fromEntries(own.toSorted(([left], [right]) => byName(left, right)).map(([name, schema_]) => [name, normalizeProperty(isRecord(schema_) ? schema_ : {})])),
    required: names.toSorted(byName),
    additionalProperties: false,
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function flagsOf(command: CommandDefinition, names: readonly string[]): Record<string, readonly string[]> {
  const positional = new Set(command.positional)
  const flags: [string, readonly string[]][] = []
  for (const name of names) {
    if (positional.has(name)) continue
    const flag = [`--${name.replaceAll('_', '-')}`]
    const short = command.shortFlags.get(name)
    if (short !== undefined) flag.push(short)
    const negation = command.negations.get(name)
    if (negation !== undefined) flag.push(negation)
    flags.push([name, flag])
  }
  return Object.fromEntries(flags)
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function entryOf(command: CommandDefinition): InterfaceEntry {
  const name = command.path.join(' ')
  // defineCommand が足したグローバルの repo は、コマンド自身の引数ではないので外す
  const own = command.input.omit({ repo: true })
  const input = normalizeInput(z.toJSONSchema(own, { io: 'input' }))
  return {
    id: `${PREFIX}-${name.toUpperCase().replaceAll(/[ _]/g, '-')}`,
    name,
    description: command.description,
    surfaces: { cli: { path: command.path }, mcp: { tool: command.toolName } },
    hidden: false,
    deprecated: false,
    input,
    cli: { positional: command.positional, flags: flagsOf(command, Object.keys(input.properties)) },
  }
}

/**
コマンドの一覧から、generated.json の項目を id の順に作る
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
export function exportEntries(commands: readonly CommandDefinition[]): InterfaceEntry[] {
  return commands.map(command => entryOf(command)).toSorted((left, right) => byName(left.id, right.id))
}

/**
`--check` か `--write` を受ける。登録が 0 件の間は generated.json に触れない
*/
export function main(argv: readonly string[], io: CommandIo, commands: readonly CommandDefinition[] = COMMANDS): number {
  const output = createOutput(false, io)
  const modes = argv.filter(argument => argument === '--check' || argument === '--write')
  if (modes.length !== 1 || argv.length !== 1) {
    output.error('usage: export-interface.ts --check | --write')
    return 2
  }
  if (commands.length === 0) {
    output.warning('no commands are registered in cli-node; generated.json is left as is')
    return 0
  }
  output.error('exporting registered commands is not supported yet')
  return 2
}

// Node の import.meta.main は engines の範囲で実験的な扱いなので、起動したファイルかどうかを argv で判定する
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text) },
    stderr: (text) => { process.stderr.write(text) },
  })
}
