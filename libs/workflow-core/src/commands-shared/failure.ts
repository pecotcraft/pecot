// コマンドが捕まえなかった例外を、最上位で `error: <message>` の行と終了コード 1 にする（Python の PecotError の網と同じ）。
// 値の誤り（InvalidValueError）と OS のエラーも同じ行にする。上のどれでもない例外はプログラムの誤りなので、伝える。
import { ConfigError } from '../domain/config.js'
import { PecotError, InvalidValueError, ProjectRootNotFoundError } from '../domain/errors.js'
import { GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from '../infra/github/errors.js'
import { OsError } from '../infra/os-error.js'
import { logOf } from '../domain/git-output.js'
import { hintedTextOf } from './command-hint.js'
import type { FailureKind } from './failure-kind.js'
import { AbortedError, createOutput, reportAborted } from './output.js'
import type { CommandIo } from './command-definition.js'
import { USAGE_EXIT_CODE, UsageError } from './usage-error.js'

export const FAILURE_EXIT_CODE = 1

/**
最上位で error の行にできる例外か
*/
export function isReportableFailure(error: unknown): error is Error {
  return error instanceof PecotError || error instanceof InvalidValueError || error instanceof OsError
}

export function reportFailure(error: Readonly<Error>, io: CommandIo): void {
  const out = createOutput(false, io)
  const log = logOf(error)
  if (log !== undefined) out.log(log)
  out.error(hintedTextOf(error) ?? error.message)
}

// 子クラスを親より先に並べる
export const KIND_BY_CLASS: readonly (readonly [abstract new (...arguments_: never[]) => unknown, FailureKind])[] = [
  [UsageError, 'invalid-input'],
  [InvalidValueError, 'invalid-input'],
  [AbortedError, 'aborted'],
  [GitHubAuthError, 'github-auth'],
  [GitHubNotFoundError, 'github-not-found'],
  [GitHubRateLimitError, 'github-rate-limit'],
  [GitHubAPIError, 'github-api'],
  [ConfigError, 'config-invalid'],
  [ProjectRootNotFoundError, 'project-root-not-found'],
]

/**
例外のクラスから失敗の原因の名前を決める。表に無いものは other
*/
export function kindOfFailure(error: unknown): FailureKind {
  return KIND_BY_CLASS.find(([type]) => error instanceof type)?.[1] ?? 'other'
}

/**
ツールの実行で捕まえた例外を、終了コードにする。MCP のツールの呼び出しが使う。
入力の誤りは文を stderr に出して 2。確認の中止は Aborted. で 1。報告できる失敗は error の行で 1。それ以外は伝える
*/
export function exitCodeOfFailure(error: unknown, io: CommandIo): number {
  if (error instanceof UsageError) {
    io.failureKind?.(kindOfFailure(error))
    io.stderr(`${error.message}\n`)
    return USAGE_EXIT_CODE
  }
  if (error instanceof AbortedError) {
    io.failureKind?.(kindOfFailure(error))
    return reportAborted(io)
  }
  if (!isReportableFailure(error)) throw error
  io.failureKind?.(kindOfFailure(error))
  reportFailure(error, io)
  return FAILURE_EXIT_CODE
}
