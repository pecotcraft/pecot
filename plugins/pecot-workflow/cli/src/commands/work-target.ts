// 作業対象（.pecot-active と .pecot-session-title、作業ディレクトリ）を記録して、結果の行を出す。
import { InvalidValueError, ProjectRootNotFoundError } from '../domain/errors.js'
import { FLAG_PECOT_BASE } from '../domain/state.js'
import type { BaseRecord } from '../domain/state.js'
import { OsError, hasErrorCode, toOsError } from '../infra/os-error.js'
import { WORK_DIR } from '../infra/paths.js'
import { ensureWorkDirectory, removeFlag, writeBaseRecord, writeWorkTarget } from '../infra/state-store.js'
import { stopWith } from './command-stop.js'
import type { Output } from './output.js'

export interface RecordWorkTargetOptions {
  /**
  真なら、記録の失敗を warning ではなく error の行で出し、終了コード 1 で止める
  */
  readonly failWithExit?: boolean
  /**
  着手で選んだ base。作業対象を記録できたときに .pecot-base へ書く。省くと .pecot-base は消えたままになる
  */
  readonly base?: Readonly<BaseRecord>
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
.pecot-base を消してから作業対象を書き、`set: work target ...` の行を出す。options.base があれば記録後に .pecot-base も書く。
失敗は warning の行。failWithExit なら error の行と CommandExit(1)。記録できたかを返す
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
  clearBase(out)
  let target: string
  try {
    writeWorkTarget(issueReference, title)
    target = `work target ${issueReference}`
    if (ensureWorkDirectory(issueReference) !== undefined) target += ` (work directory ${WORK_DIR}/${String(issueNumber)}/)`
  }
  catch (error: unknown) {
    if (!isRecordingFailure(error)) throw error
    if (options.failWithExit === true) {
      stopWith(out, `could not record the work target: ${describeFailure(error)}`, 'other')
    }
    out.warning(`could not record the work target: ${describeFailure(error)}`)
    return 'failed'
  }
  out.done({ verb: 'set', target })
  if (options.base !== undefined) recordBase(options.base, out)
  return 'recorded'
}

function warnBase(out: Readonly<Output>, error: unknown): void {
  if (!isRecordingFailure(error)) throw error
  out.warning(`could not record the base: ${describeFailure(error)}`)
}

/**
前の作業対象の .pecot-base を消す。消せなければ warning の行を出して続ける
*/
function clearBase(out: Readonly<Output>): void {
  try {
    removeFlag(FLAG_PECOT_BASE)
  }
  catch (error: unknown) {
    // 状態ディレクトリが無い（ENOTDIR）なら消すものが無い。書くほうの失敗が別に出る
    if (hasErrorCode(error) && error.code === 'ENOTDIR') return
    warnBase(out, error)
  }
}

/**
.pecot-base を書く。書けなければ warning の行を出して続ける
*/
function recordBase(record: Readonly<BaseRecord>, out: Readonly<Output>): void {
  try {
    writeBaseRecord(record)
  }
  catch (error: unknown) {
    warnBase(out, error)
  }
}

/**
予行の行。recordWorkTarget が書く作業対象（.pecot-active・.pecot-session-title・.pecot-base）を書かずに出す
*/
export function planWorkTarget(out: Readonly<Output>, owner: string, repository: string, issueNumber: number): void {
  out.planned({ verb: 'set', target: `work target ${owner}/${repository}/${String(issueNumber)}` })
}
