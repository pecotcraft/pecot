// cli-node のコマンド一覧（COMMANDS）から、interface/generated.json の項目を作る。
// 形と決定性の決めは specs/022-interface-definitions/contracts/definition-format.md にある。
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { z } from 'zod'

import { diffGenerated } from '../../../../libs/interface-spec/src/domain/diff.js'
import { generatedEntrySchema, generatedFileSchema, type GeneratedFile } from '../../../../libs/interface-spec/src/domain/schema.js'
import { createOutput } from '../src/commands/output.js'
import { COMMANDS } from '../src/commands/index.js'
import type { CommandDefinition, CommandIo } from '../src/commands/registry.js'

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
contracts の表に載せる type
*/
const TYPES = new Set(['string', 'integer', 'boolean', 'array'])

/**
引数 1 つの JSON Schema を、キーの順をそろえ、z.int() の端を外した形にする。
表に無いキーと type は、where を付けて例外で止める
*/
function normalizeProperty(schema: JsonObject, where: string): JsonObject {
  const entries = Object.entries(schema)
    .filter(([key, value]) => !(typeof value === 'number' && (key === 'minimum' || key === 'maximum') && SAFE_INTEGER_EDGES.has(value)))
    .map(([key, value]): [string, unknown] => {
      if (!SCHEMA_KEY_ORDER.includes(key)) throw new TypeError(`${where}: unsupported JSON Schema key ${key}`)
      if (key === 'type' && !(typeof value === 'string' && TYPES.has(value))) throw new TypeError(`${where}: unsupported type ${JSON.stringify(value)}`)
      return [key, key === 'items' && isRecord(value) ? normalizeProperty(value, where) : value]
    })
    .toSorted(([left], [right]) => keyRank(left) - keyRank(right))
  return Object.fromEntries(entries)
}

/**
グローバルの repo を除いて、input を正規化する。repo は defineCommand が足したもので、コマンド自身の引数ではない
*/
function normalizeInput(schema: JsonObject, command: string): InputSchema {
  const { properties, required } = schema
  const own = (isRecord(properties) ? Object.entries(properties) : []).filter(([name]) => name !== 'repo')
  const names = (Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []).filter(name => name !== 'repo')
  return {
    type: 'object',
    properties: Object.fromEntries(own.toSorted(([left], [right]) => byName(left, right)).map(([name, property]) => [name, normalizeProperty(isRecord(property) ? property : {}, `${command}: ${name}`)])),
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
    const alias = command.aliases.get(name)
    if (alias !== undefined) flag.push(alias)
    const negation = command.negations.get(name)
    if (negation !== undefined) flag.push(negation)
    flags.push([name, flag])
  }
  return Object.fromEntries(flags)
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function entryOf(command: CommandDefinition): InterfaceEntry {
  const name = command.path.join(' ')
  const input = normalizeInput(z.toJSONSchema(command.input, { io: 'input' }), name)
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

export interface MainOptions {
  // 比べる定義書。既定は plugins/pecot-workflow/interface/generated.json
  readonly target?: string
}

const DEFAULT_TARGET = path.resolve(import.meta.dirname, '../../interface/generated.json')

function reasonOf(error: unknown): string {
  if (error instanceof z.ZodError) return issuesOf(error)
  return error instanceof Error ? (error.message.split('\n', 1)[0] ?? 'unknown') : 'unknown'
}

/**
zod のエラーを「欄のパス: 文」に直す。複数あるときは先頭の 3 件を "; " でつなぐ
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function issuesOf(error: z.ZodError): string {
  const shown = error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  return shown.join('; ') + (error.issues.length > shown.length ? `; and ${String(error.issues.length - shown.length)} more` : '')
}

function duplicatesOf(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id)
    seen.add(id)
  }
  return [...duplicated].toSorted(byName)
}

/**
登録したコマンドの項目だけを、定義書の同じ ID の項目と、surfaces.mcp を除いて比べる
*/
function check(entries: readonly InterfaceEntry[], target: string, output: Readonly<ReturnType<typeof createOutput>>): number {
  let authored: GeneratedFile
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 既定は固定パス、テストは一時ファイルを渡す
    authored = generatedFileSchema.parse(JSON.parse(readFileSync(target, 'utf8')))
  }
  catch (error) {
    output.error(`cannot read ${target}: ${reasonOf(error)}`)
    return 1
  }
  const duplicated = duplicatesOf(entries.map(entry => entry.id))
  if (duplicated.length > 0) {
    output.error(`duplicate ids: ${duplicated.join(', ')}`)
    return 1
  }
  const ids = new Set(entries.map(entry => entry.id))
  const nodeEntries: GeneratedFile['entries'] = []
  for (const { surfaces, ...rest } of entries) {
    const parsed = generatedEntrySchema.safeParse({ ...rest, surfaces: { cli: surfaces.cli } })
    if (!parsed.success) {
      output.error(`${rest.id}: invalid entry: ${issuesOf(parsed.error)}`)
      return 1
    }
    nodeEntries.push(parsed.data)
  }
  const node: GeneratedFile = { format: authored.format, plugin: authored.plugin, prefix: authored.prefix, entries: nodeEntries }
  const picked = authored.entries
    .filter(entry => ids.has(entry.id))
    .map(({ surfaces, ...rest }) => ({ ...rest, surfaces: { ...(surfaces.cli !== undefined && { cli: surfaces.cli }) } }))
  const lines = diffGenerated({ ...authored, entries: picked }, node)
  for (const line of lines) output.error(line)
  return lines.length === 0 ? 0 : 1
}

/**
`--check` か `--write` を受ける。登録が 0 件の間は定義書に触れない
*/
export function main(argv: readonly string[], io: CommandIo, commands: readonly CommandDefinition[] = COMMANDS, options: Readonly<MainOptions> = {}): number {
  const output = createOutput(false, io)
  if (!(argv.length === 1 && (argv[0] === '--check' || argv[0] === '--write'))) {
    output.error('usage: export-interface.ts --check | --write')
    return 2
  }
  if (commands.length === 0) {
    output.warning('no commands are registered in cli-node; generated.json is left as is')
    return 0
  }
  if (argv[0] === '--write') {
    output.error('usage: --write is not supported until the switch; use --check')
    return 2
  }
  return check(exportEntries(commands), options.target ?? DEFAULT_TARGET, output)
}

// Node の import.meta.main は engines の範囲で実験的な扱いなので、起動したファイルかどうかを realpath で比べて判定する
const entryPoint = process.argv[1]
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者の入力ではないパス
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text) },
    stderr: (text) => { process.stderr.write(text) },
  })
}
