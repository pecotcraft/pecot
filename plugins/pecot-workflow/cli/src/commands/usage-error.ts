// 使い方の誤りの表示。Python の CLI が出していた click の Usage 行・Try 行と、枠付きの Error を写す。
// 全コマンドの共通部。コマンドの path と引数の書式は、呼び出す側が渡す。
import { BaseError } from '../domain/errors.js'
import { compareCodePoints } from './fuzzy.js'
import { renderPanel, wrapText } from './rich-panel.js'

const PROGRAM = 'pecot'
const DEFAULT_OUTPUT_WIDTH = 80

/**
誤りが起きたコマンド。
synopsis は Usage 行の `pecot <path>` の後ろに続く書式。
例は `[OPTIONS] {issue_ref}`。グループなら `[OPTIONS] COMMAND [ARGS]...` にする
*/
export interface UsageContext {
  readonly commandPath: readonly string[]
  readonly synopsis: string
}

/**
使い方の誤り。終了コードは 2。context が無いときは枠だけを出す
*/
export class UsageError extends BaseError {
  readonly context: UsageContext | undefined

  constructor(message: string, context?: Readonly<UsageContext>) {
    super(message)
    this.context = context
  }
}

/**
コマンドとグループの Usage 行に出す書式
*/
export const COMMAND_SYNOPSIS = '[OPTIONS] COMMAND [ARGS]...'

export const USAGE_EXIT_CODE = 2

export function missingArgumentMessage(name: string): string {
  return `Missing argument '${name}'.`
}

/**
names は長い形・短い形の順（例: `['--directory', '-D']`）
*/
export function missingOptionMessage(names: readonly string[]): string {
  return `Missing option ${names.map(name => `'${name}'`).join(' / ')}.`
}

/**
possibilities は近い長いオプション。あれば、辞書順に並べて案内を付ける（1 件でも同じ形）
*/
export function noSuchOptionMessage(name: string, possibilities: readonly string[] = []): string {
  const hint = possibilities.length === 0 ? '' : ` (Possible options: ${possibilities.toSorted(compareCodePoints).join(', ')})`
  return `No such option: ${name}${hint}`
}

/**
possibilities は近いコマンド名。近い順のまま案内する
*/
export function noSuchCommandMessage(name: string, possibilities: readonly string[] = []): string {
  const hint = possibilities.length === 0 ? '' : ` Did you mean ${possibilities.map(candidate => `'${candidate}'`).join(', ')}?`
  return `No such command '${name}'.${hint}`
}

export function optionRequiresArgumentMessage(name: string): string {
  return `Option '${name}' requires an argument.`
}

export function optionTakesNoValueMessage(name: string): string {
  return `Option '${name}' does not take a value.`
}

/**
names はオプションなら長い形・短い形の順、位置引数なら入力の名前
*/
export function invalidValueMessage(names: string | readonly string[], detail: string): string {
  const quoted = (typeof names === 'string' ? [names] : names).map(name => `'${name}'`).join(' / ')
  return `Invalid value for ${quoted}: ${detail}`
}

export const MISSING_COMMAND_MESSAGE = 'Missing command.'

function headerLines(context: Readonly<UsageContext>, width: number): string {
  const program = [PROGRAM, ...context.commandPath].join(' ')
  const usage = wrapText(`Usage: ${program} ${context.synopsis}`, width).map(line => line.trimEnd())
  return `${[...usage, `Try '${program} --help' for help.`].join('\n')}\n`
}

/**
stderr に書く文字列を作る。Usage 行、Try 行、枠付きの Error の順。width は枠の幅（既定は 80）
*/
export function formatUsageError(error: Readonly<UsageError>, width = DEFAULT_OUTPUT_WIDTH): string {
  const header = error.context === undefined ? '' : headerLines(error.context, width)
  return `${header}${renderPanel('Error', error.message, width)}`
}
