// 子プロセス起動の Promise wrapper。stdout / stderr を全件 capture し、
// timeout 経過時は SIGTERM を送出する。tech-advisor B2 に従い、capture と
// 任意の親 stream への relay を両立する。

import { spawn } from 'node:child_process'

import type { SpawnResult } from '../../domain/_shared/spawn-result.js'

export interface SpawnPromiseOptions {
  readonly cwd?: string
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly timeoutMs: number
  /**
  capture と並行して親へ relay する stream (任意)。
  */
  readonly stdoutRelay?: NodeJS.WritableStream
  readonly stderrRelay?: NodeJS.WritableStream
  /**
  呼び出し元がキャンセルされたら子プロセスへ SIGTERM を送る (任意)。

  MCP の tools/call は ToolCallContext.signal でキャンセルされる。
  配線しないと、クライアントが諦めたあとも、子プロセスが孤児として動き続ける。
  */
  readonly signal?: AbortSignal | undefined
}

/**
`cmd args` を spawn し、stdout / stderr を全件 capture した結果を返す。

- shell:false で起動するためコマンド名 / 引数は user 入力をそのまま渡せる。
- timeout 到達時は SIGTERM を送出し、`timedOut: true` を立てる。
- 起動 error (ENOENT 等) は reject せず、`exitCode: null` + `stderr` に詰める。
  コマンド層が exit code 監視で一律ハンドリングできるようにする。
*/
export async function spawnPromise(
  command: string,
  arguments_: readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- stream は mutable 型
  options: SpawnPromiseOptions,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let isTimedOut = false
    let isSettled = false

    const spawnOptions: Parameters<typeof spawn>[2] = {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    }
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd
    if (options.env !== undefined) spawnOptions.env = { ...options.env }

    const child = spawn(command, [...arguments_], spawnOptions)

    const timer = setTimeout(() => {
      isTimedOut = true
      child.kill('SIGTERM')
    }, options.timeoutMs)
    timer.unref()

    // 呼び出し元のキャンセル。abort 済みの signal に後からリスナを足しても発火しないため、
    // 現在値を先に見てから購読する。
    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Readonly<Buffer>) => {
      const buffer = Buffer.from(chunk)
      stdoutChunks.push(buffer)
      options.stdoutRelay?.write(buffer)
    })
    child.stderr?.on('data', (chunk: Readonly<Buffer>) => {
      const buffer = Buffer.from(chunk)
      stderrChunks.push(buffer)
      options.stderrRelay?.write(buffer)
    })

    const finalize = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      extraStderr: string,
    ): void => {
      if (isSettled) return
      isSettled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      // 防御 (tech-advisor B1): ENOENT 等で 'error' が先行した直後、'close' も発火する Node 仕様がある。
      // 二重 finalize は settled で抑止しているが、稀に child が生存したまま残るケース (timer 競合など) がある。
      // そのため念のため kill しておく。既に exited なら kill は no-op。
      /* c8 ignore start -- killed が false のパスは既存テストで観測されない */
      if (!child.killed) {
        try {
          child.kill()
        }
        catch {
          // 既に終了済みの場合の防御。SpawnResult には影響しないので握り潰す。
        }
      }
      /* c8 ignore stop */
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const captured = Buffer.concat(stderrChunks).toString('utf8')
      // ENOENT 等の起動 error は extraStderr 経由でのみ流入する。
      const stderr = mergeStderr(captured, extraStderr)
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut: isTimedOut,
      })
    }

    child.on('error', (error: Readonly<Error>) => {
      // eslint-disable-next-line unicorn/no-null -- exitCode / signal は SpawnResult 契約で null
      finalize(null, null, error.message)
    })

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finalize(code, signal, '')
    })
  })
}

export function mergeStderr(captured: string, extra: string): string {
  if (extra === '') return captured
  if (captured === '') return extra
  return `${captured}\n${extra}`
}
