// 待つ時間の長い子プロセスを、イベントループを止めずに動かす。時間切れと MCP の要求の取り消しで、子をプロセスグループごと止める。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- Node の型が mutable */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import { CancelledError } from '../domain/errors.js'
import { normalizeNewlines } from '../domain/python-format.js'
import { childStdin } from './child-stdin.js'
import type { ChildStdin } from './child-stdin.js'
import { toOsError } from './os-error.js'

/**
子の標準出力・標準エラーを溜める上限。出力が大きい git（log・diff 等）でも切れない大きさにし、超えた分は捨てる
*/
export const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024

/**
止めるときに SIGTERM を送ってから SIGKILL を送るまでの猶予。git が lock ファイルを片付ける時間
*/
export const KILL_GRACE_MILLISECONDS = 1000

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

// 別のセッションの子には端末のシグナルが届かないので、受けたらグループへ送ってから既定の動きに戻す
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

interface Capture {
  push: (chunk: Buffer) => void
  text: () => string
}

function createCapture(): Capture {
  const chunks: Buffer[] = []
  let captured = 0
  return {
    push: (chunk) => {
      const room = MAX_OUTPUT_BYTES - captured
      if (room <= 0) return
      const kept = chunk.subarray(0, Math.min(room, chunk.length))
      captured += kept.length
      chunks.push(kept)
    },
    text: () => normalizeNewlines(Buffer.concat(chunks).toString('utf8')),
  }
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

// 子はグループの頭なので、負の pid で孫（git-remote-https・フック・シェルの下のコマンド）にも送る
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  }
  catch {
    // 既に終わっている
  }
}

// SIGTERM で片付けの機会を渡し、猶予の後も残っていれば SIGKILL で止める
function terminateGroup(child: ChildProcess): void {
  signalGroup(child, 'SIGTERM')
  setTimeout(() => {
    signalGroup(child, 'SIGKILL')
  }, KILL_GRACE_MILLISECONDS).unref()
}

/**
生きている子のグループに SIGTERM を送る。サーバの終了のときに呼ぶ
*/
export function killRunningProcesses(): void {
  for (const child of running) signalGroup(child, 'SIGTERM')
}

/**
子プロセスを動かし、終わるのを待つ。起動に失敗（ENOENT など）したら OsError を投げる。
子が 0 で終わっていれば、取り消しと重なっても成功の結果を返す
*/
export async function runProcess(command: string, arguments_: readonly string[], options: Readonly<ProcessOptions> = {}): Promise<ProcessResult> {
  const { signal } = options
  if (signal?.aborted === true) throw cancelledBy(signal)
  const timeout = options.timeoutMilliseconds === undefined ? undefined : AbortSignal.timeout(options.timeoutMilliseconds)
  // 時間切れのとき、フックなどの孫までまとめて止めるため、子を自分のグループの頭にする
  const child = spawn(command, [...arguments_], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    stdio: [options.stdin ?? childStdin(), 'pipe', 'pipe'],
    detached: true,
  })
  running.add(child)
  const stdout = createCapture()
  const stderr = createCapture()
  child.stdout.on('data', stdout.push)
  child.stderr.on('data', stderr.push)

  return await new Promise<ProcessResult>((resolve, reject) => {
    let stopped: 'timed-out' | 'cancelled' | undefined
    let isSettled = false
    const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null
    const onTimeout = (): void => {
      stop('timed-out')
    }
    const onAbort = (): void => {
      stop('cancelled')
    }
    const forward = (received: NodeJS.Signals): void => {
      signalGroup(child, received)
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
      if (stopped === 'cancelled' && signal !== undefined) {
        reject(cancelledBy(signal))
        return
      }
      resolve({ exitCode, signal: exitSignal, stdout: stdout.text(), stderr: stderr.text(), isTimedOut: stopped === 'timed-out' })
    }
    // 止めた後は close を待たない。パイプを握った孫が残ると、close は孫が終わるまで来ない
    const settleOnExit = (): void => {
      child.stdout.destroy()
      child.stderr.destroy()
      settle(child.exitCode, child.signalCode)
    }
    const stop = (reason: 'timed-out' | 'cancelled'): void => {
      if (isSettled || stopped !== undefined) return
      terminateGroup(child)
      // 子が先に終わっていれば、その結果を返す。0 で終わっていない取り消しだけは、続きを動かさないために投げる
      if (hasExited()) {
        if (reason === 'cancelled' && child.exitCode !== 0) stopped = reason
        settleOnExit()
        return
      }
      stopped = reason
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
    child.once('exit', (exitCode: number | null) => {
      if (stopped === undefined) return
      // 止める前に 0 で終わっていた（止めるのと終わるのが重なった）なら成功とする
      if (exitCode === 0) stopped = undefined
      settleOnExit()
    })
    child.once('close', (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      settle(exitCode, exitSignal)
    })
  })
}
