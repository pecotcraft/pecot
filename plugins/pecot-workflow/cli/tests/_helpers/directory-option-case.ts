// session show・session restore の --directory の検証のテストが共有する表と準備。
/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface InvalidDirectoryCase {
  readonly name: string
  readonly reason: string
  /**
  権限を落とすケースか（root では実行できず、後で戻す）
  */
  readonly locked: boolean
  readonly prepare: (root: string) => string
}

export const INVALID_DIRECTORY_CASES: readonly InvalidDirectoryCase[] = [
  { name: '無いパス', reason: 'does not exist', locked: false, prepare: (root: string): string => path.join(root, 'x') },
  { name: 'ファイル', reason: 'is a file', locked: false, prepare: (root: string): string => {
    const file = path.join(root, 'plain.txt')
    writeFileSync(file, '')
    return file
  } },
  { name: '読めないディレクトリ', reason: 'is not readable', locked: true, prepare: (root: string): string => {
    const locked = path.join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    return locked
  } },
]

/**
権限を落としたディレクトリを、後片付けできるように戻す
*/
export function unlock(target: string): void {
  chmodSync(target, 0o700)
}

/**
権限を落とせない root かどうか
*/
export function isRoot(): boolean {
  return process.getuid?.() === 0
}
