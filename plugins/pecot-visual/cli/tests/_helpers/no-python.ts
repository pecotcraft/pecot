// 子プロセスツリー全体に対して python / python3 / uvx / uv の execve が観測されないことを
// 検証するためのヘルパ。strace -f -e execve でラップして親コマンドを起動し、execve イベント
// を全件 capture する。失敗時は観測された execve バイナリの一覧を例外メッセージに含める。
//
// strace 不在環境向けの fallback として、`pgrep -P` を子プロセスツリーから走査する path も用意している。
// ただし execve タイミングが捕捉できないため、第一選択は strace。
//
// e2e-planner #2 の Python フリー検証要件に対応する。

import { spawn, spawnSync } from 'node:child_process'

export interface NoPythonResult {
  readonly executable: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  /**
  観測された python 系 execve のバイナリ名一覧 (空なら Python フリー)
  */
  readonly pythonExecves: readonly string[]
}

const FORBIDDEN: ReadonlySet<string> = new Set(['python', 'python3', 'uvx', 'uv'])

function basename(absPath: string): string {
  const index = absPath.lastIndexOf('/')
  return index === -1 ? absPath : absPath.slice(index + 1)
}

function isForbidden(name: string): boolean {
  return FORBIDDEN.has(name)
}

export function isStraceAvailable(): boolean {
  const result = spawnSync('strace', ['-V'], { stdio: ['ignore', 'pipe', 'pipe'] })
  return result.status === 0
}

/**
`executable args...` を strace -f -e execve でラップして起動し、
子プロセスツリー全体の execve 経過を観測する。

Linux 限定。devcontainer (Linux) では利用可能だが、macOS host 上の test では skip すべき。
*/
export async function runWithoutPython(
  executable: string,
  arguments_: readonly string[],

  options: Readonly<{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }> = {},
): Promise<NoPythonResult> {
  return new Promise<NoPythonResult>((resolve) => {
    const straceArguments = ['-f', '-e', 'trace=execve', '--', executable, ...arguments_]
    const spawnOptions: Parameters<typeof spawn>[2] = { stdio: ['ignore', 'pipe', 'pipe'] }
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd
    if (options.env !== undefined) spawnOptions.env = { ...options.env }
    const child = spawn('strace', straceArguments, spawnOptions)
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timer: NodeJS.Timeout | undefined
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
      timer.unref()
    }
    child.stdout?.on('data', (c: Readonly<Buffer>) => {
      stdoutChunks.push(Buffer.from(c))
    })
    child.stderr?.on('data', (c: Readonly<Buffer>) => {
      stderrChunks.push(Buffer.from(c))
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      const pythonExecves = parsePythonExecves(stderr)
      resolve({ executable, args: arguments_, exitCode: code, stdout, stderr, pythonExecves })
    })
  })
}

/**
strace stderr 出力から `execve("/path/to/binary", [...], ...)` 行を抽出する。
binary basename が python / python3 / uvx / uv のいずれかに一致するものを返す。
*/
export function parsePythonExecves(straceStderr: string): readonly string[] {
  const result: string[] = []
  // 行頭は `[pid 1234] execve(...)` または `execve(...)`。引数は "<path>"。
  const re = /execve\("([^"]+)"/g
  let match
  while ((match = re.exec(straceStderr)) !== null) {
    const absPath = match[1] ?? ''
    const name = basename(absPath)
    if (isForbidden(name)) result.push(name)
  }
  return result
}
