// 作業対象（.pecot-active と .pecot-session-title、作業ディレクトリ）を記録して、結果の行を出す。
import { InvalidValueError, ProjectRootNotFoundError } from '../domain/errors.js'
import type { BaseRecord } from '../domain/state.js'
import { OsError, hasErrorCode, toOsError } from '../infra/os-error.js'
import { WORK_DIR } from '../infra/paths.js'
import { ensureWorkDirectory, writeBaseRecord, writeWorkTarget } from '../infra/state-store.js'
import { stopWith } from './command-stop.js'
import type { Output } from './output.js'

export interface RecordWorkTargetOptions {
  /**
  真なら、記録の失敗を warning ではなく error の行で出し、終了コード 1 で止める
  */
  readonly failWithExit?: boolean
}

/**
記録の失敗として扱う例外か。OS の失敗・値の誤り・プロジェクトルート不明。プログラムの誤りは伝える
*/
function isRecordingFailure(error: unknown): error is Error {
  return error instanceof OsError || error instanceof InvalidValueError || error instanceof ProjectRootNotFoundError || hasErrorCode(error)
}

function describeFailure(error: Readonly<Error>): string {
  const converted = toOsError(error)
  return converted instanceof Error ? converted.message : error.message
}

/**
.pecot-active と .pecot-session-title を書き、`set: work target ...` の行を出す。
失敗は warning の行にする。failWithExit なら error の行を出して CommandExit(1) を投げる。記録できたかを返す
*/
export function recordWorkTarget(
  out: Readonly<Output>,
  owner: string,
  repository: string,
  issueNumber: number,
  title: string,
  options: Readonly<RecordWorkTargetOptions> = {},
): 'recorded' | 'failed' {
  const issueReference = `${owner}/${repository}/${String(issueNumber)}`
  let target: string
  try {
    writeWorkTarget(issueReference, title)
    target = `work target ${issueReference}`
    if (ensureWorkDirectory(issueReference) !== undefined) target += ` (work directory ${WORK_DIR}/${String(issueNumber)}/)`
  }
  catch (error: unknown) {
    if (!isRecordingFailure(error)) throw error
    if (options.failWithExit === true) {
      stopWith(out, `could not record the work target: ${describeFailure(error)}`)
    }
    out.warning(`could not record the work target: ${describeFailure(error)}`)
    return 'failed'
  }
  out.done({ verb: 'set', target })
  return 'recorded'
}

/**
.pecot-base を書く。記録の失敗は、出力の行を増やさず、前の記録も残さないために、何も出さずに捨てる
*/
export function recordBase(record: Readonly<BaseRecord>): void {
  try {
    writeBaseRecord(record)
  }
  catch (error: unknown) {
    if (!isRecordingFailure(error)) throw error
  }
}
