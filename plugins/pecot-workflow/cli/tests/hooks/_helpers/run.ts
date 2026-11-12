// shell の起動。spawnSync を使う。タイムアウトは 25 秒で、超えたら throw する。
// stdout・stderr は Node の復号のまま返し、改行（\r\n）は直さない。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'

import { scratchDirectory } from './environment.js'
import type { EnvironmentOverrides, HookCase } from './environment.js'
import { adapterDirectory, hooksDirectory } from './paths.js'
import { jsonDumps } from './text.js'

const TIMEOUT_MS = 25_000
// 既定の 1 MiB を超えると子が止まるので広げる。
const MAX_BUFFER = 64 * 1024 * 1024

export interface RunOptions {
  readonly stdin?: string
  readonly cwd?: string
  readonly env?: EnvironmentOverrides
}

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function description(command: string, argv: readonly string[]): string {
  return [command, ...argv].join(' ').slice(0, 200)
}

// シグナルで終わった子は、負の値にする。
function exitCodeOf(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status
  if (signal === null) return -1
  const entry = Object.entries(constants.signals).find(([name]) => name === signal)
  return -(entry?.[1] ?? 0)
}

export function run(hookCase: HookCase, command: string, argv: readonly string[] = [], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, argv, {
    input: options.stdin,
    cwd: options.cwd ?? hookCase.temporaryPath,
    env: hookCase.composeEnv(options.env),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
  })
  if (result.error) throw new Error(`起動に失敗しました（${description(command, argv)}）: ${result.error.message}`, { cause: result.error })
  return { exitCode: exitCodeOf(result.status, result.signal), stdout: result.stdout, stderr: result.stderr }
}

// bash <script> [args...]
export function runScript(hookCase: HookCase, script: string, argv: readonly string[] = [], options: RunOptions = {}): RunResult {
  return run(hookCase, 'bash', [script, ...argv], options)
}

// 手順を一時ファイルに書き、そのパスを返す。bash -c に値を渡す形を避けるために使う。
export function shellFile(hookCase: HookCase, snippet: string): string {
  const name = createHash('sha256').update(snippet).digest('hex').slice(0, 16)
  const file = path.join(scratchDirectory(hookCase), `${name}.sh`)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ケースの一時ディレクトリ配下
  writeFileSync(file, `${snippet}\n`)
  return file
}

// 手順を bash で起動する。argv は $1 から並ぶ。
export function runShell(hookCase: HookCase, snippet: string, argv: readonly string[] = [], options: RunOptions = {}): RunResult {
  return runScript(hookCase, shellFile(hookCase, snippet), argv, options)
}

// hooks/ 直下のエントリを JSON 入力で起動する。
export function runHookEntry(hookCase: HookCase, entry: string, payload: unknown, options: Omit<RunOptions, 'stdin'> = {}): RunResult {
  return runScript(hookCase, path.join(hooksDirectory, entry), [], { ...options, stdin: jsonDumps(payload) })
}

// claude-adapter.sh 経由でコアスクリプトを起動する。
export function runClaudeAdapter(hookCase: HookCase, command: string, coreScript: string, options: Omit<RunOptions, 'stdin'> = {}): RunResult {
  const stdin = jsonDumps({ tool_input: { command } })
  return runScript(hookCase, path.join(adapterDirectory, 'claude-adapter.sh'), [coreScript], { ...options, stdin })
}

const SOURCE_HOOK_INPUT_THEN_EXEC = 'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'

// pecot_export_project_root を無効にして起動する。CLAUDE_PROJECT_DIR はテストが用意した値のままにするため。
const SOURCE_POST_MATCH_THEN_EXEC = [
  'PECOT_PROJECT_ROOT_LAZY=1; ',
  'source "$(dirname "$1")/../core/project-root.sh" "$2" && ',
  'pecot_export_project_root() { :; } && ',
  'source "$(dirname "$1")/bash-post-match.sh" "$2" && exec bash "$1"',
].join('')

// サブスクリプトを hook-input.sh を source してから起動する。JSON は argv で渡す。
export function runHookScript(hookCase: HookCase, script: string, json: string, options: Omit<RunOptions, 'stdin'> = {}): RunResult {
  return runShell(hookCase, SOURCE_HOOK_INPUT_THEN_EXEC, [script, json], options)
}

// PostToolUse(Bash) のサブスクリプトを、エントリと同じ前段で起動する。JSON は argv で渡す。
export function runPostScript(hookCase: HookCase, script: string, json: string, options: Omit<RunOptions, 'stdin'> = {}): RunResult {
  return runShell(hookCase, SOURCE_POST_MATCH_THEN_EXEC, [script, json], options)
}
