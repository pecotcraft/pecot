/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が決める。この関数は読むだけ */
// テキストファイルの読み書き。Python の `read_text()`（UTF-8・universal newlines）と同じ挙動にする。

import { readFileSync } from 'node:fs'

import { normalizeNewlines } from '../domain/python-format.js'
import { toOsError } from './os-error.js'

/**
UTF-8 で読み、改行（\r\n・\r）は \n に揃える。読めなければ Python の OSError と同じ文の OsError
*/
export function readTextFile(file: string): string {
  try {
    return normalizeNewlines(readFileSync(file, 'utf8'))
  }
  catch (error: unknown) {
    throw toOsError(error, file)
  }
}
