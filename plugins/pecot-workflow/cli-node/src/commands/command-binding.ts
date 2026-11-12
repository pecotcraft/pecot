/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
// 定義したコマンドを commander につなぎ、argv から実行する。
// commander の既定（process.exit の直呼び・英語の誤り文）は使わず、click と同じ使い方の誤りに直す。
import { Command, CommanderError, Option } from 'commander'
import { z } from 'zod'

import { closeMatches } from './fuzzy.js'
import type { CommandDefinition, CommandIo, PreparedCommand } from './registry.js'
import {
  invalidValueMessage,
  missingArgumentMessage,
  missingOptionMessage,
  noSuchOptionMessage,
  optionRequiresArgumentMessage,
  optionTakesNoValueMessage,
  UsageError,
} from './usage-error.js'
import type { UsageContext } from './usage-error.js'
import { convertValue, flagKindOf, valueTypeOf } from './value-types.js'
import type { FlagKind, ValueType } from './value-types.js'

function fieldSchemaOf(definition: Readonly<CommandDefinition>, name: string): z.ZodType | undefined {
  const field: unknown = Reflect.get(definition.input.shape, name)
  return field instanceof z.ZodType ? field : undefined
}

function isRequired(schema: z.ZodType): boolean {
  return !schema.safeParse(undefined).success
}

/**
typer の Missing argument と Invalid value に出す名前。引数の名前のまま（小文字）
*/
function argumentLabel(name: string): string {
  return name
}

function flagOf(name: string): string {
  return `--${name.replaceAll('_', '-')}`
}

function discard(): void {
  // commander の出力は使わない。誤りは UsageError にして、呼び出し側が書く
}

function isListField(definition: Readonly<CommandDefinition>, name: string): boolean {
  const schema = fieldSchemaOf(definition, name)
  return schema !== undefined && flagKindOf(schema) === 'list'
}

/**
typer の Usage 行に出す書式。
位置引数は名前のまま並べ、必須なら `{issue_ref}`、任意なら `[version]` にする。複数なら `...` を付ける
*/
export function synopsisOf(definition: Readonly<CommandDefinition>): string {
  const names = definition.positional.map((name) => {
    const schema = fieldSchemaOf(definition, name)
    const label = argumentLabel(name)
    const suffix = isListField(definition, name) ? '...' : ''
    return schema === undefined || isRequired(schema) ? `{${label}}${suffix}` : `[${label}]${suffix}`
  })
  return ['[OPTIONS]', ...names].join(' ')
}

export function usageOf(definition: Readonly<CommandDefinition>): UsageContext {
  return { commandPath: definition.path, synopsis: synopsisOf(definition) }
}

interface BoundOption {
  readonly field: string
  readonly option: Option
  readonly isRequired: boolean
  readonly kind: FlagKind
  readonly valueType: ValueType
  /**
  長い形・短い形・別名の順
  */
  readonly names: readonly string[]
  /**
  否定形（`--no-checkout`）。無ければ undefined
  */
  readonly negation: string | undefined
}

function bindOption(definition: Readonly<CommandDefinition>, field: string): BoundOption | undefined {
  const schema = fieldSchemaOf(definition, field)
  if (schema === undefined) return undefined
  const long = flagOf(field)
  const short = definition.shortFlags.get(field)
  const kind = flagKindOf(schema)
  const valueType = valueTypeOf(schema)
  const alias = definition.aliases.get(field)
  // commander は 2 つ並べた名前の後ろを長い形とみなし、属性名にする。別名を先に書いて、属性名を元の名前にそろえる
  const flags = `${short === undefined ? '' : `${short}, `}${alias === undefined ? '' : `${alias}, `}${long}${kind === 'boolean' ? '' : ' <value>'}`
  const option = new Option(flags)
  // `--no-copy` のような名前の入力そのものを、commander に否定形（既定が真）と読ませない
  option.negate = false
  if (kind === 'list') option.argParser((value: string, previous: readonly string[] | undefined) => [...previous ?? [], value])
  return {
    field,
    option,
    isRequired: isRequired(schema),
    kind,
    valueType,
    names: [long, ...short === undefined ? [] : [short], ...alias === undefined ? [] : [alias]],
    negation: kind === 'boolean' ? definition.negations.get(field) : undefined,
  }
}

function bindOptions(definition: Readonly<CommandDefinition>): readonly BoundOption[] {
  return Object.keys(definition.input.shape)
    .filter(name => (name !== 'repo' || definition.hasOwnRepo) && !definition.positional.includes(name))
    .map(name => bindOption(definition, name))
    .filter(bound => bound !== undefined)
}

/**
click は `-1` のような負数に見える語を位置引数にせず、未定義の短いオプションとして断る（`-12` も `-1`）。
その語の位置を返す。`--` より後ろと、値を取るオプションの値の位置にある語は対象にしない
*/
function negativeNumberIndex(argv: readonly string[], bound: readonly BoundOption[]): number | undefined {
  const valueTaking = new Set(bound.filter(entry => entry.kind !== 'boolean').flatMap(entry => entry.names))
  let isValueNext = false
  for (const [index, argument] of argv.entries()) {
    if (isValueNext) {
      isValueNext = false
      continue
    }
    if (argument === '--') return undefined
    if (/^-\d/u.test(argument)) return index
    isValueNext = valueTaking.has(argument)
  }
  return undefined
}

function toUsageError(
  error: Readonly<CommanderError>,
  argv: readonly string[],
  bound: readonly BoundOption[],
  usage: UsageContext,
): UsageError {
  // commander の文は `error: unknown option '--x'` の形で、引用符の中に名前が入る
  const quoted = error.message.replace(/^[^']*'([^']*)'.*$/su, '$1')
  switch (error.code) {
    case 'commander.unknownOption': {
      // click は `--name=値` の値を落として名前だけで案内する。真偽のオプションなら、値は取らない旨にして Usage 行を付けない
      const typedName = quoted.startsWith('--') ? quoted.replace(/=.*$/su, '') : quoted
      const booleanNames = bound.flatMap(entry => entry.kind === 'boolean' ? [entry.names[0], entry.negation] : [])
      if (typedName !== quoted && booleanNames.includes(typedName)) return new UsageError(optionTakesNoValueMessage(typedName))
      const longNames = ['--help', ...bound.flatMap(entry => [...entry.names.filter(name => name.startsWith('--')), ...entry.negation === undefined ? [] : [entry.negation]])]
      const possibilities = typedName.startsWith('--') ? closeMatches(typedName, longNames) : []
      return new UsageError(noSuchOptionMessage(typedName, possibilities), usage)
    }
    case 'commander.optionMissingArgument': {
      // `-c, --comment-limit <value>` のうち、利用者が打った方の名前を出す
      const names = quoted.split(/[ ,]+/u).filter(part => part.startsWith('-'))
      const typed = argv.findLast(argument => names.includes(argument)) ?? names.at(-1) ?? quoted
      // click はこの誤りに Usage 行・Try 行を付けない
      return new UsageError(optionRequiresArgumentMessage(typed))
    }
    // 上の 2 つ以外の commander の誤りは、このバインドでは起きない（引数は任意、argParser は使わない）。
    // makeOptionMandatory・choices・InvalidArgumentError などを使い始めたら、この行を外して誤りごとに文とテストを足す
    /* v8 ignore next */
    default: { return new UsageError(error.message.replace(/^error: /u, ''), usage) }
  }
}

function extraArgumentsMessage(extras: readonly string[]): string {
  // click は個数によらず `argument(s)` と書く
  return `Got unexpected extra argument(s) (${extras.join(' ')})`
}

function convertOrFail(text: string, valueType: ValueType, names: string | readonly string[], usage: UsageContext): unknown {
  const conversion = convertValue(text, valueType)
  if (!conversion.isValid) throw new UsageError(invalidValueMessage(names, conversion.message), usage)
  return conversion.value
}

function convertField(value: unknown, kind: FlagKind, valueType: ValueType, names: string | readonly string[], usage: UsageContext): unknown {
  if (typeof value === 'string') return convertOrFail(value, valueType, names, usage)
  if (kind === 'list' && Array.isArray(value)) {
    return value.map((item: unknown) => typeof item === 'string' ? convertOrFail(item, valueType, names, usage) : item)
  }
  return value
}

function positionalInput(definition: Readonly<CommandDefinition>, command: Command, usage: UsageContext): readonly (readonly [string, unknown])[] {
  const processed: unknown[] = command.processedArgs
  const entries = definition.positional.flatMap((name, index): (readonly [string, unknown])[] => {
    const value = processed.at(index)
    const schema = fieldSchemaOf(definition, name)
    if (Array.isArray(value) ? value.length > 0 : value !== undefined) {
      const kind = schema === undefined ? 'value' : flagKindOf(schema)
      const valueType: ValueType = schema === undefined ? { type: 'string' } : valueTypeOf(schema)
      return [[name, convertField(value, kind, valueType, argumentLabel(name), usage)]]
    }
    if (schema !== undefined && isRequired(schema)) throw new UsageError(missingArgumentMessage(argumentLabel(name)), usage)
    return []
  })
  const lastName = definition.positional.at(-1)
  const extras = lastName !== undefined && isListField(definition, lastName) ? [] : command.args.slice(definition.positional.length)
  if (extras.length > 0) throw new UsageError(extraArgumentsMessage(extras), usage)
  return entries
}

function optionInput(command: Command, bound: readonly BoundOption[], usage: UsageContext): readonly (readonly [string, unknown])[] {
  return bound.flatMap(({ field, option, isRequired: required, kind, valueType, names }): (readonly [string, unknown])[] => {
    const value: unknown = command.getOptionValue(option.attributeName())
    if (value !== undefined) return [[field, convertField(value, kind, valueType, names, usage)]]
    if (required && kind === 'boolean') return [[field, false]]
    if (required) throw new UsageError(missingOptionMessage(names), usage)
    return []
  })
}

/**
検証の誤り（ZodError）を使い方の誤りにする。入力名に当たるオプションか位置引数の名前で示す
*/
function issueToUsageError(definition: Readonly<CommandDefinition>, error: Readonly<z.ZodError>, bound: readonly BoundOption[], usage: UsageContext): UsageError {
  const [issue] = error.issues
  const field = issue?.path.at(0)
  const names = definition.positional.includes(String(field))
    ? argumentLabel(String(field))
    : bound.find(entry => entry.field === field)?.names ?? 'input'
  return new UsageError(invalidValueMessage(names, issue?.message ?? error.message), usage)
}

/**
run が投げた context 無しの UsageError（BadParameter）に、このコマンドの使い方を付ける。ほかの例外はそのまま返す
*/
function withUsage(error: unknown, usage: UsageContext): unknown {
  return error instanceof UsageError && error.context === undefined ? new UsageError(error.message, usage) : error
}

/**
グローバルの --repo を入力 repo にする。自分の `--repo` を持つコマンドは、サブコマンドの値を先に使い、無ければグローバルの値を使う。
ignoresGlobalRepo のコマンドには、グローバルの値を渡さない
*/
function withRepository(definition: Readonly<CommandDefinition>, input: Readonly<Record<string, unknown>>, repository: string | undefined): Readonly<Record<string, unknown>> {
  if (repository === undefined || definition.ignoresGlobalRepo) return input
  return definition.hasOwnRepo ? { repo: repository, ...input } : { ...input, repo: repository }
}

/**
定義したコマンドを argv（コマンド名より後ろ）で実行して、終了コードを返す。
グローバルの --repo は repo で渡し、入力 repo にする。
使い方の誤りは UsageError を投げる。--help は説明を stdout に出して 0 を返す。
UsageError にするのは解析と入力の検証（parse）の誤りだけで、本体（run）の例外はそのまま伝える
*/
export async function runDefinition(
  definition: Readonly<CommandDefinition>,
  argv: readonly string[],
  io: Readonly<CommandIo>,
  repository?: string,
): Promise<number> {
  const usage = usageOf(definition)
  const bound = bindOptions(definition)
  const command = new Command(definition.path.join(' '))
  command
    .description(definition.description)
    .helpOption('--help', 'Show this message and exit.')
    .allowExcessArguments(true)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: discard, outputError: discard })
  for (const name of definition.positional) {
    command.argument(isListField(definition, name) ? `[${argumentLabel(name)}...]` : `[${argumentLabel(name)}]`)
  }
  for (const { option, negation } of bound) {
    command.addOption(option)
    if (negation !== undefined) command.addOption(new Option(negation))
  }

  // 負数に見える語があれば、その手前までを解析する。手前の誤りを先に出し、--help も出さずに、その語を断る
  const negativeIndex = negativeNumberIndex(argv, bound)
  if (negativeIndex !== undefined) command.configureOutput({ writeOut: discard, writeErr: discard, outputError: discard })
  try {
    await command.parseAsync(negativeIndex === undefined ? [...argv] : argv.slice(0, negativeIndex), { from: 'user' })
  }
  catch (error: unknown) {
    if (!(error instanceof CommanderError)) throw error
    const isHelp = error.code === 'commander.helpDisplayed' || error.code === 'commander.help'
    if (!isHelp) throw toUsageError(error, argv, bound, usage)
    if (negativeIndex === undefined) return 0
  }
  const negativeWord = negativeIndex === undefined ? undefined : argv.at(negativeIndex)
  if (negativeWord !== undefined) throw new UsageError(noSuchOptionMessage(negativeWord.slice(0, 2)), usage)
  const entries = [...positionalInput(definition, command, usage), ...optionInput(command, bound, usage)]
  const input = Object.fromEntries(entries)
  let prepared: PreparedCommand
  try {
    prepared = definition.parse(withRepository(definition, input, repository))
  }
  catch (error: unknown) {
    if (error instanceof z.ZodError) throw issueToUsageError(definition, error, bound, usage)
    throw error
  }
  try {
    return await prepared.run(io)
  }
  catch (error: unknown) {
    throw withUsage(error, usage)
  }
}
