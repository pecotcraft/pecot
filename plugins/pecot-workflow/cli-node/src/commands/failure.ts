// コマンドが捕まえなかった例外を、最上位で `error: <message>` の行と終了コード 1 にする（Python の PecotError の網と同じ）。
// 値の誤り（InvalidValueError）と OS のエラーも同じ行にする。上のどれでもない例外はプログラムの誤りなので、伝える。
import { PecotError, InvalidValueError } from '../domain/errors.js'
import { OsError } from '../infra/os-error.js'
import { createOutput } from './output.js'
import type { CommandIo } from './registry.js'

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
