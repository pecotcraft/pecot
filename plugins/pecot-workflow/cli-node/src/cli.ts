/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod のスキーマは深い readonly にできない */
// pecot-workflow の Node CLI のエントリポイント。
// グローバルオプションは Python の CLI（typer）と同じ順で処理する。
//   1. 解析の誤り（未知のオプション・値の欠け）。
//   2. eager な --version・--help。他の引数が不正でも実行する。
//   3. --repo の形式。不正なら使い方の誤りの枠を出して終了コード 2。
//   4. コマンド名の解決。
//   5. PECOT_GITHUB_API_URL の検証。不正なら文言を出して終了コード 1。
//   6. --show-repo。解決して 2 行を出し、終了コード 0。
//   7. コマンドの --help。`--` より前に --help があれば、ほかの引数を検証せずに help を出して終了コード 0。
//   8. コマンドの実行。コマンドが無ければ終了コード 0。
//
// 例外は、使い方の誤りなら枠付きで終了コード 2、独自の例外なら failure.ts の文で終了コード 1 にする。
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { InvalidValueError } from './domain/errors.js'
import { AmbiguousRepositoryError, parseOwnerRepository, resolveRepository } from './domain/repository-resolver.js'
import { readAuthoredNotes } from './infra/authored-notes.js'
import { gitRunnerFor } from './infra/git.js'
import { resolveApiUrlOverride } from './infra/github/client.js'
import { hasErrorCode } from './infra/os-error.js'
import { isHelpRequested, runDefinition } from './commands/command-binding.js'
import { commandHelpText } from './commands/command-help.js'
import { interfaceIdOf } from './commands/command-definition.js'
import { invalidRepositoryMessage, parseGlobalOptions, ROOT_USAGE } from './commands/global-options.js'
import { FAILURE_EXIT_CODE, isReportableFailure, reportFailure } from './commands/failure.js'
import { closeMatches } from './commands/fuzzy.js'
import { helpText } from './commands/help.js'
import { COMMANDS, findCommand } from './commands/registry.js'
import type { CommandDefinition, CommandIo } from './commands/registry.js'
import { AbortedError, createOutput, createProcessIo, reportAborted } from './commands/output.js'
import { formatResolvedRepository } from './commands/repository-display.js'
import { outputWidth } from './commands/rich-panel.js'
import {
  COMMAND_SYNOPSIS,
  formatUsageError,
  MISSING_COMMAND_MESSAGE,
  noSuchCommandMessage,
  noSuchOptionMessage,
  USAGE_EXIT_CODE,
  UsageError,
} from './commands/usage-error.js'
import { readVersion } from './version.js'

export interface CliContext {
  readonly commands: readonly CommandDefinition[]
  readonly io: CommandIo
  readonly cwd: string
  /**
  rich の幅を決める環境変数（TERMINAL_WIDTH・COLUMNS）
  */
  readonly environment: Readonly<Record<string, string | undefined>>
  /**
  端末の幅。端末につながっていなければ undefined
  */
  readonly terminalColumns: number | undefined
}

type Resolution
  = | { readonly kind: 'command', readonly definition: CommandDefinition, readonly argv: readonly string[] }
    | { readonly kind: 'help', readonly path: readonly string[] }

function isUnderGroup(path: readonly string[], group: readonly string[]): boolean {
  return group.every((segment, index) => path.at(index) === segment)
}

/**
コマンド名を、グループをたどって解決する。見つからなければ UsageError
*/
function resolveCommand(group: readonly string[], rest: readonly string[], commands: readonly CommandDefinition[]): Resolution {
  const context = { commandPath: group, synopsis: COMMAND_SYNOPSIS }
  const [name, ...tail] = rest
  if (name === undefined) throw new UsageError(MISSING_COMMAND_MESSAGE, context)
  if (group.length > 0 && name.startsWith('-')) {
    if (name === '--help') return { kind: 'help', path: group }
    throw new UsageError(noSuchOptionMessage(name, name.startsWith('--') ? closeMatches(name, ['--help']) : []), context)
  }
  const path = [...group, name]
  const names = commands
    .filter(command => command.path.length > group.length && isUnderGroup(command.path, group))
    .map(command => command.path.slice(group.length, group.length + 1).join(''))
  if (!names.includes(name)) {
    const possibilities = closeMatches(name, [...new Set(names)])
    throw new UsageError(noSuchCommandMessage(name, possibilities), context)
  }
  const definition = findCommand(path, commands)
  return definition === undefined ? resolveCommand(path, tail, commands) : { kind: 'command', definition, argv: tail }
}

function validateRepository(repository: string | undefined): void {
  if (repository === undefined) return
  try {
    parseOwnerRepository(repository)
  }
  catch (error: unknown) {
    if (!(error instanceof InvalidValueError)) throw error
    throw new UsageError(invalidRepositoryMessage(error.message), ROOT_USAGE)
  }
}

function showRepository(repository: string | undefined, context: Readonly<CliContext>): number {
  try {
    // Python の resolve_repo も GIT_* を外さずに git を呼ぶ（git の hook の下では GIT_DIR が cwd より優先される）。同じ動作にそろえる
    const resolved = resolveRepository(repository, gitRunnerFor(context.cwd))
    context.io.stdout(formatResolvedRepository(resolved))
    return 0
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) context.io.stderr(`error: --repo: ${error.message}\n`)
    else if (error instanceof AmbiguousRepositoryError) context.io.stderr(`error: ${error.message}\n`)
    else throw error
    return USAGE_EXIT_CODE
  }
}

/**
コマンドの help を stdout に出して 0 を返す。details・constraints・examples は定義書の手書きの側から読む。
読めなければその 3 つの節を出さず、stderr に warning の行を 1 行出す（help を誤りで止めない）
*/
function showCommandHelp(definition: CommandDefinition, context: Readonly<CliContext>, width: number): number {
  const notes = readAuthoredNotes(interfaceIdOf(definition.path))
  if (notes === undefined) createOutput(false, context.io).warning(`could not read the details of '${definition.path.join(' ')}' from interface/authored.yaml; they are left out of this help`)
  context.io.stdout(commandHelpText(definition, notes, width))
  return 0
}

async function execute(argv: readonly string[], context: Readonly<CliContext>, width: number): Promise<number> {
  const options = parseGlobalOptions(argv)
  if (argv.length === 0) {
    context.io.stdout(helpText([], context.commands, width))
    return USAGE_EXIT_CODE
  }
  if (options.eager === 'version') {
    context.io.stdout(`pecot version ${readVersion()}\n`)
    return 0
  }
  if (options.eager === 'help') {
    context.io.stdout(helpText([], context.commands, width))
    return 0
  }
  validateRepository(options.repo)
  const resolution = options.rest.length === 0 ? undefined : resolveCommand([], options.rest, context.commands)

  try {
    resolveApiUrlOverride()
  }
  catch (error: unknown) {
    if (!(error instanceof InvalidValueError)) throw error
    context.io.stderr(`error: ${error.message}\n`)
    return 1
  }
  if (options.showRepo) return showRepository(options.repo, context)
  if (resolution === undefined) return 0
  if (resolution.kind === 'help') {
    context.io.stdout(helpText(resolution.path, context.commands, width))
    return 0
  }
  return isHelpRequested(resolution.argv)
    ? showCommandHelp(resolution.definition, context, width)
    : await runDefinition(resolution.definition, resolution.argv, context.io, options.repo)
}

/**
argv（node とスクリプトを除く）を実行して終了コードを返す。
使い方の誤りは枠付きで stderr に出して 2。確認の中止は Aborted. で 1。独自の例外は error の行で 1。それ以外の例外は伝える
*/
export async function runCli(argv: readonly string[], context: Readonly<CliContext>): Promise<number> {
  const width = outputWidth(context.environment, context.terminalColumns)
  try {
    return await execute(argv, context, width)
  }
  catch (error: unknown) {
    if (error instanceof UsageError) {
      context.io.stderr(formatUsageError(error, width))
      return USAGE_EXIT_CODE
    }
    if (error instanceof AbortedError) return reportAborted(context.io)
    if (!isReportableFailure(error)) throw error
    reportFailure(error, context.io)
    return FAILURE_EXIT_CODE
  }
}

/**
出力先のパイプが閉じられたとき（`pecot ... | head`）に、エラーを出さず静かに終わる。
Python の __main__.py は SIGPIPE を既定の動作に戻し、BrokenPipeError も握って終了コード 0 で終わる。Node は EPIPE を error イベントで受ける
*/
export function exitQuietlyOnBrokenPipe(stream: Readonly<Pick<NodeJS.WritableStream, 'on'>>, finish: () => void): void {
  stream.on('error', (error: Error) => {
    if (hasErrorCode(error) && error.code === 'EPIPE') finish()
    else throw error
  })
}

/**
端末の幅。rich は標準入力・標準出力・標準エラーの順に、端末につながったものの幅を使う。Node では出力側の 2 つを見る
*/
function terminalColumns(): number | undefined {
  if (process.stderr.isTTY) return process.stderr.columns
  return process.stdout.isTTY ? process.stdout.columns : undefined
}

export async function main(): Promise<void> {
  const io = createProcessIo()
  const pipe = { isClosed: false }
  const finish = (): void => {
    pipe.isClosed = true
    process.exitCode = 0
    process.stdout.destroy()
  }
  exitQuietlyOnBrokenPipe(process.stdout, finish)
  exitQuietlyOnBrokenPipe(process.stderr, finish)
  const code = await runCli(process.argv.slice(2), {
    commands: COMMANDS,
    io,
    cwd: process.cwd(),
    // interface-env: TERMINAL_WIDTH COLUMNS
    environment: process.env,
    terminalColumns: terminalColumns(),
  })
  if (!pipe.isClosed) process.exitCode = code
}

/* v8 ignore start -- 直接起動時にだけ通る */
if (process.argv[1] !== undefined) {
  // import.meta.url は symlink を解決した実体パスを指すため、argv[1] 側も realpath に揃える。
  // 揃えないと symlink 経由起動で一致せず、何もせず exit 0 で終わる。
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 起動された自分自身のパス
  const selfUrl = pathToFileURL(realpathSync(process.argv[1])).href
  if (import.meta.url === selfUrl) {
    await main()
  }
}
/* v8 ignore stop */
