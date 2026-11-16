// 作業対象のセッション名のキャッシュ（.pecot-session-title）と作業ディレクトリを作って、結果の行を出す。
import { InvalidValueError, ProjectRootNotFoundError } from '../domain/errors.js'
import { FLAG_PECOT_BASE } from '../domain/state.js'
import type { BaseRecord } from '../domain/state.js'
import { OsError, hasErrorCode, toOsError } from '../infra/os-error.js'
import { WORK_DIR } from '../infra/paths.js'
import { ensureWorkDirectory, removeFlag, writeBaseRecord, writeSessionTitle } from '../infra/state-store.js'
import type { Output } from './output.js'

export interface RecordWorkTargetOptions {
  /**
  着手で選んだ base。作業対象を記録できたときに .pecot-base へ書く。省くと .pecot-base は消えたままになる
  */
  readonly base?: Readonly<BaseRecord>
}

/**
recordWorkTarget の結果。workDirectory は作れた作業ディレクトリの絶対パス
*/
export interface RecordedWorkTarget {
  readonly status: 'recorded' | 'failed'
  readonly issue: string
  readonly workDirectory?: string | undefined
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
.pecot-base を消してからセッション名のキャッシュを書き、作業ディレクトリを作って `create: work directory ...` の行を出す。
作業ディレクトリがすでにあっても同じ行を出す。options.base があれば記録後に .pecot-base も書く。
失敗は warning の行。記録できたかと、参照・作業ディレクトリを返す
*/
export function recordWorkTarget(
  out: Readonly<Output>,
  owner: string,
  repository: string,
  issueNumber: number,
  title: string,
  options: Readonly<RecordWorkTargetOptions> = {},
): RecordedWorkTarget {
  const issueReference = `${owner}/${repository}/${String(issueNumber)}`
  clearBase(out)
  try {
    writeSessionTitle(issueReference, title)
  }
  catch (error: unknown) {
    if (!isRecordingFailure(error)) throw error
    out.warning(`could not record the work target: ${describeFailure(error)}`)
    return { status: 'failed', issue: issueReference }
  }
  const workDirectory = ensureWorkDirectory(issueReference)
  if (workDirectory === undefined) out.warning(`could not create ${workDirectoryTarget(issueNumber)}`)
  else out.done({ verb: 'create', target: workDirectoryTarget(issueNumber) })
  if (options.base !== undefined) recordBase(options.base, out)
  return { status: 'recorded', issue: issueReference, workDirectory }
}

function workDirectoryTarget(issueNumber: number): string {
  return `work directory ${WORK_DIR}/${String(issueNumber)}/`
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
予行の行。recordWorkTarget が作る作業ディレクトリ（と書く .pecot-session-title・.pecot-base）を作らずに出す
*/
export function planWorkTarget(out: Readonly<Output>, issueNumber: number): void {
  out.planned({ verb: 'create', target: workDirectoryTarget(issueNumber) })
}
