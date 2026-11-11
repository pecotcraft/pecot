// 「何も変えない」「何も作らない」を、呼ぶ前後のディレクトリの比較で確かめるための helper。
/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは呼び出し側が渡した一時ディレクトリ配下だけ */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'

import { compareStrings } from '../../../domain/_shared/compare-strings.js'

/**
ディレクトリの下の全エントリを、相対パスから中身の写しへの対応で返す。
ディレクトリは `<dir>`、symlink は `-> 先` とし、辿らない。存在しなければ `undefined`。
*/
export function snapshotTree(root: string): ReadonlyMap<string, string> | undefined {
  let rootStat
  try {
    rootStat = lstatSync(root)
  }
  catch {
    return undefined
  }
  const entries = new Map<string, string>()
  if (!rootStat.isDirectory()) return entries
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).toSorted(compareStrings)) {
      const full = path.join(directory, name)
      const relative = path.relative(root, full)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) entries.set(relative, `-> ${readlinkSync(full)}`)
      else if (stat.isDirectory()) {
        entries.set(relative, '<dir>')
        walk(full)
      }
      else entries.set(relative, readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return entries
}
