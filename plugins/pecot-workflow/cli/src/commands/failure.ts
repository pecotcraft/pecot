// コマンドが捕まえなかった例外を、最上位で `error: <message>` の行と終了コード 1 にする（Python の PecotError の網と同じ）。
// 値の誤り（InvalidValueError）と OS のエラーも同じ行にする。上のどれでもない例外はプログラムの誤りなので、伝える。
import { PecotError, InvalidValueError } from '../domain/errors.js'
import { OsError } from '../infra/os-error.js'
import { AbortedError, createOutput, reportAborted } from './output.js'
import type { CommandIo } from './registry.js'
import { formatUsageError, USAGE_EXIT_CODE, UsageError } from './usage-error.js'

export const FAILURE_EXIT_CODE = 1

/**
最上位で error の行にできる例外か
*/
export function isReportableFailure(error: unknown): error is Error {
  return error instanceof PecotError || error instanceof InvalidValueError || error instanceof OsError
}

export function reportFailure(error: Readonly<Error>, io: CommandIo): void {
  createOutput(false, io).error(error.message)
}

/**
コマンドの実行で捕まえた例外を、終了コードにする。CLI の runCli と MCP のツールの呼び出しが共有する。
使い方の誤りは枠付きで stderr に出して 2。確認の中止は Aborted. で 1。報告できる失敗は error の行で 1。それ以外は伝える
*/
export function exitCodeOfFailure(error: unknown, io: CommandIo, width: number): number {
  if (error instanceof UsageError) {
    io.stderr(formatUsageError(error, width))
    return USAGE_EXIT_CODE
  }
  if (error instanceof AbortedError) return reportAborted(io)
  if (!isReportableFailure(error)) throw error
  reportFailure(error, io)
  return FAILURE_EXIT_CODE
}
