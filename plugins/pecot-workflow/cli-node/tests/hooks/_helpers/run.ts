// shell の起動。同期は spawnSync、並行に起動するケースは runAsync を使う。タイムアウトは 25 秒で、超えたら throw する。
// stdout・stderr は Node の復号のまま返し、改行（\r\n）は直さない。
import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:os'
import path from 'node:path'

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

function ignoreBrokenPipe(): void {
  // 読まずに終わる子への書き込みは EPIPE になる。結果は終了コードで見る
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

export function runAsync(hookCase: HookCase, command: string, argv: readonly string[] = [], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: options.cwd ?? hookCase.temporaryPath, env: hookCase.composeEnv(options.env) })
    const out: string[] = []
    const errors: string[] = []
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${String(TIMEOUT_MS)} ms でタイムアウトしました（${description(command, argv)}）`))
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk: string) => {
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      errors.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode: exitCodeOf(code, signal),
        stdout: out.join(''),
        stderr: errors.join(''),
      })
    })
    child.stdin.on('error', ignoreBrokenPipe)
    child.stdin.end(options.stdin)
  })
}

// bash <script> [args...]
export function runScript(hookCase: HookCase, script: string, argv: readonly string[] = [], options: RunOptions = {}): RunResult {
  return run(hookCase, 'bash', [script, ...argv], options)
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
  return run(hookCase, 'bash', ['-c', SOURCE_HOOK_INPUT_THEN_EXEC, '_', script, json], options)
}

// PostToolUse(Bash) のサブスクリプトを、エントリと同じ前段で起動する。JSON は argv で渡す。
export function runPostScript(hookCase: HookCase, script: string, json: string, options: Omit<RunOptions, 'stdin'> = {}): RunResult {
  return run(hookCase, 'bash', ['-c', SOURCE_POST_MATCH_THEN_EXEC, '_', script, json], options)
}
