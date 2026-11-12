/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が決める。ここは種類を調べるだけ */
// パスの種類の判定。Python の Path.is_dir() / is_file() と同じく、シンボリックリンクを辿り、読めないパスは偽にする。

import { statSync } from 'node:fs'

/**
ディレクトリか。無い・読めないときは false
*/
export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  }
  catch {
    return false
  }
}

/**
通常のファイルか。無い・読めないときは false
*/
export function isFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  }
  catch {
    return false
  }
}
