/* eslint-disable security/detect-non-literal-fs-filename -- 引数のパスを調べるだけ */
import { statSync } from 'node:fs'

export function isFile(target: string): boolean {
  return statSync(target, { throwIfNoEntry: false })?.isFile() === true
}
