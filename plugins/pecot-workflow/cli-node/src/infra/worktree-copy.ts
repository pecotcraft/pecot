/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が渡すリポジトリ・ワークツリー配下 */
// 未追跡ファイルのワークツリーへのコピー。Python の shutil.copy2・copytree と同じ挙動にする。
//
// 更新時刻は、ナノ秒の stat から秒の小数に直して写す。
// 秒の小数は 1.6e9 前後で 0.24 マイクロ秒の刻みになるので、Python の copy2 とは最大でこの刻みの差が出る。
// ディレクトリは、リンク先の中身を写す。
// 写せないエントリがあっても残りを写し終えてから、まとめてエラーにする（copytree と同じ）。

import { BaseError } from '../domain/errors.js'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'

import { pythonStringRepr } from '../domain/python-format.js'
import { toOsError } from './os-error.js'

export interface CopyResult {
  readonly source: string
  readonly dest: string
  readonly action: 'copied' | 'skipped' | 'error'
  /**
  追加メッセージ（エラー詳細など）。無ければ空
  */
  readonly message: string
}

/**
ディレクトリの中身を写せないエントリがあった（Python の shutil.Error に当たる）。
メッセージは、(コピー元, コピー先, 理由) の一覧の repr
*/
export class TreeCopyError extends BaseError {
  constructor(failures: readonly Failure[]) {
    super(`[${failures.map(([source, destination, reason]) => `(${pythonStringRepr(source)}, ${pythonStringRepr(destination)}, ${pythonStringRepr(reason)})`).join(', ')}]`)
  }
}

function messageOf(error: unknown): string {
  const converted = toOsError(error)
  return converted instanceof Error ? converted.message : String(converted)
}

// 権限と更新時刻を写す（shutil.copystat）
function copyStatus(source: string, destination: string): void {
  const stat = statSync(source, { bigint: true })
  chmodSync(destination, Number(stat.mode & 0o7777n))
  utimesSync(destination, Number(stat.atimeNs) / 1e9, Number(stat.mtimeNs) / 1e9)
}

// リンク先の中身を写す（shutil.copy2 の follow_symlinks=True）。ソースを先に調べるのは、エラーの文を Python に合わせるため
function copyFileWithStatus(source: string, destination: string): void {
  statSync(source)
  copyFileSync(source, destination)
  copyStatus(source, destination)
}

type Failure = readonly [string, string, string]

// 写せなかったエントリの一覧を返す。ディレクトリ自体を作れなければ例外
function copyTree(source: string, destination: string): readonly Failure[] {
  mkdirSync(destination, { recursive: true })
  const failures: Failure[] = []
  for (const name of readdirSync(source)) {
    const sourceEntry = path.join(source, name)
    const destinationEntry = path.join(destination, name)
    try {
      if (statSyncOrUndefined(sourceEntry)?.isDirectory() === true) failures.push(...copyTree(sourceEntry, destinationEntry))
      else copyFileWithStatus(sourceEntry, destinationEntry)
    }
    catch (error: unknown) {
      failures.push([sourceEntry, destinationEntry, messageOf(error)])
    }
  }
  copyStatus(source, destination)
  return failures
}

function statSyncOrUndefined(target: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(target)
  }
  catch {
    return undefined
  }
}

function copyOne(source: string, destination: string): void {
  mkdirSync(path.dirname(destination), { recursive: true })
  if (statSync(source).isDirectory()) {
    const failures = copyTree(source, destination)
    if (failures.length > 0) throw new TreeCopyError(failures)
    return
  }
  copyFileWithStatus(source, destination)
}

/**
ファイルをコピーする。files はコピーする相対パス。ソースが無ければ skipped、OS のエラーなら error として結果に載せる
*/
export function copyFiles(sourceRoot: string, destinationRoot: string, files: readonly string[]): readonly CopyResult[] {
  return files.map((file): CopyResult => {
    const source = path.join(sourceRoot, file)
    const destination = path.join(destinationRoot, file)
    if (!existsSync(source)) return { source, dest: destination, action: 'skipped', message: 'ソースファイルが存在しません' }
    try {
      copyOne(source, destination)
      return { source, dest: destination, action: 'copied', message: '' }
    }
    catch (error: unknown) {
      // copy が投げるのはシステムエラーと TreeCopyError だけ。Python の `except OSError` と同じく、結果に載せて続ける
      return { source, dest: destination, action: 'error', message: messageOf(error) }
    }
  })
}
