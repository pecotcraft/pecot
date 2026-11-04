// コマンドが捕まえなかった例外の、最上位での扱い。
//
// Python の CLI には最上位の共通処理が無く、各コマンドが例外ごとに文を出して終了コード 1 にしていた。
// 共通の形は次の 2 つ。
//   - GitHub の API の失敗は `GitHub APIエラー: <message>`。
//   - それ以外の独自の例外・値の誤り・OS のエラーは `エラー: <message>`。
// コマンドごとに文が違うものは、移すときにコマンドの側で捕まえる。ここは取りこぼしの受け皿にする。
// 上のどれでもない例外はプログラムの誤りなので、握りつぶさずに伝える。
import { PecotError, InvalidValueError } from '../domain/errors.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { OsError } from '../infra/os-error.js'

export const FAILURE_EXIT_CODE = 1

/**
例外から、stderr に書く文を作る。扱えない例外は undefined
*/
export function failureMessage(error: unknown): string | undefined {
  if (error instanceof GitHubAPIError) return `GitHub APIエラー: ${error.message}\n`
  if (error instanceof PecotError || error instanceof InvalidValueError || error instanceof OsError) return `エラー: ${error.message}\n`
  return undefined
}
