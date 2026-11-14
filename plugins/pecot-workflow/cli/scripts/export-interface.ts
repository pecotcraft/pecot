// cli のコマンド一覧（COMMANDS）から、interface/generated.json の項目を作る。
// 形と決定性の決めは specs/022-interface-definitions/contracts/definition-format.md にある。
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { z } from 'zod'

import { diffGenerated, formatStale } from '../../../../libs/interface-spec/src/domain/diff.js'
import { generatedFileSchema, type GeneratedFile, type Names } from '../../../../libs/interface-spec/src/domain/schema.js'
import { interfaceIdOf } from '../src/commands/command-definition.js'
import { normalizeInput } from '../src/commands/input-schema.js'
import { byName, COMMAND_GROUPS, COMMAND_VERBS, flagOf } from '../src/commands/names.js'
import type { CommandWord } from '../src/commands/names.js'
import type { InputSchema } from '../src/commands/input-schema.js'
import { createOutput } from '../src/commands/output.js'
import { COMMANDS } from '../src/commands/registry.js'
import type { CommandDefinition, CommandIo } from '../src/commands/registry.js'

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

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない
function flagsOf(command: CommandDefinition, names: readonly string[]): Record<string, readonly string[]> {
  const positional = new Set(command.positional)
  const flags: [string, readonly string[]][] = []
  for (const name of names) {
    if (positional.has(name)) continue
    const flag = [flagOf(name)]
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
  const input = normalizeInput(z.toJSONSchema(command.input, { io: 'input' }), name, command.hasOwnRepo)
  return {
    id: interfaceIdOf(command.path),
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

function wordsOf(words: readonly CommandWord[]): Names['positions'][number] {
  return words.map(word => word.readOnly === true
    ? { word: word.name, meaning: word.meaning, read_only: true }
    : { word: word.name, meaning: word.meaning })
}

/**
コマンド名の語彙（グループと動詞の 2 語、区切りは空白）を、generated.json の names の形にする
*/
export function exportNames(groups: readonly CommandWord[] = COMMAND_GROUPS, verbs: readonly CommandWord[] = COMMAND_VERBS): Names {
  return { separator: ' ', positions: [wordsOf(groups), wordsOf(verbs)], rest: false }
}

export interface MainOptions {
  // 比べる・書く定義書。既定は plugins/pecot-workflow/interface/generated.json
  readonly target?: string
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..')
const DEFAULT_TARGET = path.resolve(import.meta.dirname, '../../interface/generated.json')
const WRITE_COMMAND = 'pnpm --dir plugins/pecot-workflow/cli exec tsx scripts/export-interface.ts --write'

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

function shownOf(target: string): string {
  const relative = path.relative(REPOSITORY_ROOT, target)
  return relative.startsWith('..') ? target : relative.split(path.sep).join('/')
}

/**
コマンドの項目を、generated.json の書式（挿入順・字下げ 2・末尾に改行 1 つ）の文字列にする
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない
function serialize(file: Readonly<GeneratedFile>): string {
  return `${JSON.stringify(file, undefined, 2)}\n`
}

function build(entries: readonly InterfaceEntry[]): GeneratedFile {
  return generatedFileSchema.parse({ format: 1, plugin: 'pecot-workflow', prefix: 'PW', names: exportNames(), entries })
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない
function write(file: Readonly<GeneratedFile>, target: string, io: CommandIo): number {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 既定は固定パス、テストは一時ファイルを渡す
    writeFileSync(target, serialize(file))
  }
  catch (error) {
    io.stderr(`error: cannot write ${shownOf(target)}: ${reasonOf(error)}\n`)
    return 1
  }
  io.stdout(`wrote: ${shownOf(target)}\n`)
  return 0
}

/**
定義書の全項目を、Node の COMMANDS から作った項目と比べる。絞り込みはしない
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の推論型は変えられない
function check(file: Readonly<GeneratedFile>, target: string, io: CommandIo): number {
  let lines: string[]
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 既定は固定パス、テストは一時ファイルを渡す
    const current = readFileSync(target, 'utf8')
    if (current === serialize(file)) return 0
    lines = diffGenerated(generatedFileSchema.parse(JSON.parse(current)), file)
  }
  catch (error) {
    io.stderr(`error: cannot read ${shownOf(target)}: ${reasonOf(error)}\n  run: ${WRITE_COMMAND}\n`)
    return 1
  }
  const stale = formatStale(shownOf(target), lines, WRITE_COMMAND)
  for (const line of stale) io.stderr(`${line}\n`)
  return 1
}

/**
`--check` か `--write` を受ける
*/
export function main(argv: readonly string[], io: CommandIo, commands: readonly CommandDefinition[] = COMMANDS, options: Readonly<MainOptions> = {}): number {
  const output = createOutput(false, io)
  if (!(argv.length === 1 && (argv[0] === '--check' || argv[0] === '--write'))) {
    output.error('usage: export-interface.ts --check | --write')
    return 2
  }
  const entries = exportEntries(commands)
  const duplicated = duplicatesOf(entries.map(entry => entry.id))
  if (duplicated.length > 0) {
    output.error(`duplicate ids: ${duplicated.join(', ')}`)
    return 1
  }
  let file: GeneratedFile
  try {
    file = build(entries)
  }
  catch (error) {
    output.error(`invalid entries: ${reasonOf(error)}`)
    return 1
  }
  const target = options.target ?? DEFAULT_TARGET
  return argv[0] === '--write' ? write(file, target, io) : check(file, target, io)
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
