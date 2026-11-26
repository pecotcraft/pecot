/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が決める。この関数は読むだけ */
// テキストファイルの読み書き。Python の `read_text()`（UTF-8・universal newlines）と同じ挙動にする。

import { readFileSync } from 'node:fs'

import { BaseError } from '../domain/errors.js'
import { normalizeNewlines } from '../domain/python-format.js'
import { toOsError } from './os-error.js'

// BOM は Python の utf-8 と同じく残す。不正なバイトは置き換えず例外にする
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
UTF-8 として読めないファイル。Python の UnicodeDecodeError に当たり、OsError ではない
*/
export class TextDecodeError extends BaseError {}

/**
UTF-8 で読み、改行（\r\n・\r）は \n に揃える。読めなければ Python の OSError と同じ文の OsError。
不正な UTF-8 は TextDecodeError
*/
export function readTextFile(file: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  }
  catch (error: unknown) {
    throw toOsError(error, file)
  }
  try {
    return normalizeNewlines(UTF8_DECODER.decode(bytes))
  }
  catch (error: unknown) {
    throw new TextDecodeError(`'utf-8' codec can't decode file: ${file}`, { cause: error })
  }
}
