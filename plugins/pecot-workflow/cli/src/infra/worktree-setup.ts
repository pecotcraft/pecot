// ワークツリー作成後の setup_command の実行。Python の subprocess.run（shell=True）と同じ結果にする。

import os from 'node:os'

import { runProcess } from '@pecot/workflow-core/infra/process-run.js'

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
setup_command を shell 経由で実行して、結果を構造化して返す。stdin は閉じて、対話プロンプトで止まらないようにする。
timeoutSeconds を超えたら止めて exitCode -1 を返す（0 ならすぐ時間切れ）。signal で取り消されたら、シェルの下のコマンドごと止めて CancelledError を投げる
*/
export async function runSetupCommand(command: string, cwd: string, timeoutSeconds?: number, signal?: Readonly<AbortSignal>): Promise<SetupResult> {
  const result = await runProcess(command, [], { cwd, shell: true, stdin: 'ignore', timeoutMilliseconds: timeoutMilliseconds(timeoutSeconds), signal })
  const { stdout, stderr } = result
  return result.isTimedOut
    ? { command, exitCode: -1, stdout, stderr: `${stderr}timeout after ${String(timeoutSeconds)} seconds`.trimStart() }
    : { command, exitCode: result.exitCode ?? signalNumber(result.signal), stdout, stderr }
}
