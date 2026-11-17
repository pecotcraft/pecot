// 待つ時間の長い子プロセスを、イベントループを止めずに動かす。時間切れと MCP の要求の取り消しで、子をプロセスグループごと止める。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- Node の型が mutable */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import { CancelledError } from '../domain/errors.js'
import { normalizeNewlines } from '../domain/python-format.js'
import { childStdin } from './child-stdin.js'
import type { ChildStdin } from './child-stdin.js'
import { toOsError } from './os-error.js'

export interface ProcessOptions {
  readonly cwd?: string | undefined
  /**
  子の環境変数の全体。省略すると今の環境を継承する
  */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /**
  true なら command をシェルで解釈する
  */
  readonly shell?: boolean | undefined
  /**
  省略すると childStdin() に従う
  */
  readonly stdin?: ChildStdin | undefined
  /**
  過ぎたら止めて、isTimedOut が true の結果を返す
  */
  readonly timeoutMilliseconds?: number | undefined
  /**
  MCP の要求の取り消し。取り消されたら子を止めて CancelledError を投げる
  */
  readonly signal?: Readonly<AbortSignal> | undefined
}

export interface ProcessResult {
  /**
  シグナルで終わったときは null
  */
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly isTimedOut: boolean
}

const running = new Set<ChildProcess>()

// 別のグループの子は端末の Ctrl-C を受けないので、受けたらグループごと止めてから既定の動きに戻す
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

function text(chunks: readonly Buffer[]): string {
  return normalizeNewlines(Buffer.concat(chunks).toString('utf8'))
}

function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason
  return reason instanceof Error ? reason.message : String(reason)
}

/**
signal の取り消しの理由を持つ CancelledError
*/
export function cancelledBy(signal: Readonly<AbortSignal>): CancelledError {
  return new CancelledError(reasonText(signal.reason))
}

// 子はグループの頭なので、負の pid で孫（git-remote-https・フック・シェルの下のコマンド）まで止める
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  }
  catch {
    // 既に終わっている
  }
}

/**
生きている子をすべて止める。サーバの終了のときに呼ぶ
*/
export function killRunningProcesses(): void {
  for (const child of running) killGroup(child)
}

/**
子プロセスを動かし、終わるのを待つ。起動に失敗（ENOENT など）したら OsError を投げる。
子が 0 で終わっていれば、時間切れや取り消しと重なっても成功の結果を返す
*/
export async function runProcess(command: string, arguments_: readonly string[], options: Readonly<ProcessOptions> = {}): Promise<ProcessResult> {
  const { signal } = options
  if (signal?.aborted === true) throw cancelledBy(signal)
  const timeout = options.timeoutMilliseconds === undefined ? undefined : AbortSignal.timeout(options.timeoutMilliseconds)
  const child = spawn(command, [...arguments_], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    stdio: [options.stdin ?? childStdin(), 'pipe', 'pipe'],
    detached: true,
  })
  running.add(child)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk)
  })

  return await new Promise<ProcessResult>((resolve, reject) => {
    let stopped: 'timed-out' | 'cancelled' | undefined
    let isSettled = false
    const onTimeout = (): void => {
      stop('timed-out')
    }
    const onAbort = (): void => {
      stop('cancelled')
    }
    const forward = (received: NodeJS.Signals): void => {
      killGroup(child)
      finish()
      process.kill(process.pid, received)
    }
    const finish = (): void => {
      isSettled = true
      running.delete(child)
      timeout?.removeEventListener('abort', onTimeout)
      signal?.removeEventListener('abort', onAbort)
      for (const name of FORWARDED_SIGNALS) process.removeListener(name, forward)
    }
    const settle = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
      if (isSettled) return
      finish()
      const isStopped = stopped !== undefined && exitCode !== 0
      if (isStopped && stopped === 'cancelled' && signal !== undefined) {
        reject(cancelledBy(signal))
        return
      }
      resolve({ exitCode, signal: exitSignal, stdout: text(stdout), stderr: text(stderr), isTimedOut: isStopped && stopped === 'timed-out' })
    }
    // 止めた後は close を待たない。パイプを握った孫が残ると、close は孫が終わるまで来ない
    const settleStopped = (): void => {
      child.stdout.destroy()
      child.stderr.destroy()
      settle(child.exitCode, child.signalCode)
    }
    const stop = (reason: 'timed-out' | 'cancelled'): void => {
      if (isSettled || stopped !== undefined) return
      stopped = reason
      killGroup(child)
      if (child.exitCode !== null || child.signalCode !== null) settleStopped()
    }
    timeout?.addEventListener('abort', onTimeout, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    for (const name of FORWARDED_SIGNALS) process.on(name, forward)

    child.once('error', (error) => {
      if (isSettled) return
      finish()
      const converted = toOsError(error)
      reject(converted instanceof Error ? converted : error)
    })
    child.once('exit', () => {
      if (stopped !== undefined) settleStopped()
    })
    child.once('close', (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      settle(exitCode, exitSignal)
    })
  })
}
