// ワークツリー作成後の setup_command の実行。Python の subprocess.run（shell=True）と同じ結果にする。

import { spawnSync } from 'node:child_process'
import os from 'node:os'

import { normalizeNewlines } from '../domain/python-format.js'
import { MAX_OUTPUT_BYTES } from './git.js'
import { hasErrorCode, toOsError } from './os-error.js'

export interface SetupResult {
  /**
  実行したコマンド文字列
  */
  readonly command: string
  /**
  終了コード。timeout なら -1、シグナルで終わったなら -(シグナル番号)
  */
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const SIGNAL_NUMBERS: ReadonlyMap<string, number> = new Map(Object.entries(os.constants.signals))

function signalNumber(signal: NodeJS.Signals | null): number {
  return signal === null ? -1 : -(SIGNAL_NUMBERS.get(signal) ?? 1)
}

// Node の timeout は 0 が無期限。Python の timeout=0 はすぐ時間切れになるので、最短の 1 ミリ秒にする
function timeoutMilliseconds(timeoutSeconds: number | undefined): number | undefined {
  return timeoutSeconds === undefined ? undefined : Math.max(1, timeoutSeconds * 1000)
}

/**
setup_command を shell 経由で実行して、結果を構造化して返す。

stdin は常に閉じて、対話プロンプトで stall しないようにする。
timeoutSeconds を超えた場合は子プロセスを kill し、exitCode -1 の SetupResult を返す（例外は投げない）。-1 は timeout 起因の目印。
timeoutSeconds が 0 なら、Python と同じくすぐ時間切れになる
*/
export function runSetupCommand(command: string, cwd: string, timeoutSeconds?: number): SetupResult {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMilliseconds(timeoutSeconds),
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT_BYTES,
  })
  const isTimedOut = hasErrorCode(result.error) && result.error.code === 'ETIMEDOUT'
  if (!isTimedOut && result.error !== undefined) throw toOsError(result.error)
  const stdout = normalizeNewlines(result.stdout)
  const stderr = normalizeNewlines(result.stderr)
  return isTimedOut
    ? { command, exitCode: -1, stdout, stderr: `${stderr}timeout after ${String(timeoutSeconds)} seconds`.trimStart() }
    : { command, exitCode: result.status ?? signalNumber(result.signal), stdout, stderr }
}
