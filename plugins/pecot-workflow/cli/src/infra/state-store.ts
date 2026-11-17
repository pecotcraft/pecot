/* eslint-disable security/detect-non-literal-fs-filename -- パスはプロジェクトルート配下の固定の相対パスと、呼び出し側のフラグ名 */
// フック状態（`.pecot/state/` のフラグファイル）と作業ディレクトリ（`.pecot/work/<Issue番号>/`）の読み書き。規則は domain/state.ts にある。

import { closeSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { ProjectRootNotFoundError } from '../domain/errors.js'
import { pythonStrip } from '../domain/python-format.js'
import { FLAG_PECOT_BASE, FLAG_PECOT_SESSION_TITLE, formatBaseRecord, interpretBaseRecord, planWorkTarget, workDirectoryName } from '../domain/state.js'
import type { BaseReading, BaseRecord } from '../domain/state.js'
import { OsError, hasErrorCode, isFileNotFound } from './os-error.js'
import { projectRoot, STATE_DIR, WORK_DIR } from './paths.js'
import { readTextFile } from './text-file.js'

export interface StateDirectoryOptions {
  /**
  true なら、無ければ作る
  */
  readonly create?: boolean | undefined
}

/**
状態ディレクトリ（`{プロジェクトルート}/.pecot/state`）
*/
export function getStateDirectory(options: Readonly<StateDirectoryOptions> = {}): string {
  const stateDirectory = path.join(projectRoot(), STATE_DIR)
  if (options.create === true) mkdirSync(stateDirectory, { recursive: true })
  return stateDirectory
}

/**
作業ディレクトリ `.pecot/work/<Issue番号>/` を作って返す。
ブランチを作るとき（session start）に呼ぶ。
作れないとき（プロジェクトルート不明・OS のエラー）は undefined。作業フロー自体は止めない
*/
export function ensureWorkDirectory(issueReference: string): string | undefined {
  const number = workDirectoryName(issueReference)
  if (number === undefined) return undefined
  try {
    const workDirectory = path.join(projectRoot(), WORK_DIR, number)
    mkdirSync(workDirectory, { recursive: true })
    return workDirectory
  }
  catch (error: unknown) {
    if (error instanceof ProjectRootNotFoundError || hasErrorCode(error)) return undefined
    throw error
  }
}

/**
フラグファイルを作る（あれば更新時刻を更新する）
*/
export function touchFlag(flagName: string): void {
  const flagFile = path.join(getStateDirectory({ create: true }), flagName)
  closeSync(openSync(flagFile, 'a'))
  const now = new Date()
  utimesSync(flagFile, now, now)
}

/**
フラグファイルを消す。無くてもエラーにならない
*/
export function removeFlag(flagName: string): void {
  try {
    unlinkSync(path.join(getStateDirectory(), flagName))
  }
  catch (error: unknown) {
    if (!isFileNotFound(error)) throw error
  }
}

/**
通常のファイルとして存在するか
*/
export function hasFlag(flagName: string): boolean {
  try {
    return statSync(path.join(getStateDirectory(), flagName)).isFile()
  }
  catch (error: unknown) {
    if (hasErrorCode(error)) return false
    throw error
  }
}

export function writeFlag(flagName: string, content: string): void {
  writeFileSync(path.join(getStateDirectory({ create: true }), flagName), content)
}

/**
フラグファイルの内容（前後の空白を除く）。通常のファイルでなければ undefined。
存在の確認と読み取りの間に hooks が消しても、読んだ結果が無ければ undefined になる
*/
export function readFlag(flagName: string): string | undefined {
  return readFlagFile(path.join(getStateDirectory(), flagName))
}

function readFlagFile(flagFile: string): string | undefined {
  try {
    return pythonStrip(readTextFile(flagFile))
  }
  catch (error: unknown) {
    // 無い・ディレクトリは、通常のファイルではないので undefined
    if (error instanceof OsError && (error.code === 'ENOENT' || error.code === 'EISDIR')) return undefined
    throw error
  }
}

/**
着手のときに選んだ base を .pecot-base に 1 行で書く
*/
export function writeBaseRecord(record: Readonly<BaseRecord>): void {
  writeFlag(FLAG_PECOT_BASE, formatBaseRecord(record))
}

/**
.pecot-base を読む。無ければ開発ブランチから着手したものとして返す
*/
export function readBaseRecord(): BaseReading {
  return interpretBaseRecord(readFlag(FLAG_PECOT_BASE))
}

/**
toplevel の worktree の .pecot-base を読む。無ければ開発ブランチから着手したものとして返す
*/
export function readBaseRecordAt(toplevel: string): BaseReading {
  return interpretBaseRecord(readFlagFile(path.join(toplevel, STATE_DIR, FLAG_PECOT_BASE)))
}

/**
セッション名のキャッシュ（.pecot-session-title）を書く。
issueReference の末尾が整数でなければ InvalidValueError で、何も書かない
*/
export function writeSessionTitle(issueReference: string, title: string): void {
  writeFlag(FLAG_PECOT_SESSION_TITLE, planWorkTarget(issueReference, title))
}
