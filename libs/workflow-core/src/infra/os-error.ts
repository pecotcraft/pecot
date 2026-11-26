// OS のエラー（Python の OSError に当たる）。文言は Python の `[Errno 2] No such file or directory: 'x'` に揃える。

import { BaseError } from '../domain/errors.js'
import { formatOsError } from '../domain/python-format.js'

export class OsError extends BaseError {
  readonly code: string
  readonly path: string | undefined

  constructor(message: string, code: string, path: string | undefined, options?: Readonly<ErrorOptions>) {
    super(message, options)
    this.code = code
    this.path = path
  }
}

/**
Node のシステムエラー（code が `E` で始まる文字列）か
*/
export function hasErrorCode(error: unknown): error is Error & { readonly code: string, readonly path?: string, readonly dest?: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('E')
}

/**
システムコールの失敗（Node の fs 等が投げる、syscall を持つエラー）か
*/
export function isSystemCallError(error: unknown): boolean {
  return hasErrorCode(error) && 'syscall' in error
}

export function isFileNotFound(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 'ENOENT'
}

/**
Node のシステムエラーを OsError にする。errno の表に無い code は元の message を使う。EISDIR のように path を持たないエラーには fallbackPath を付ける。システムエラーでなければそのまま返す
*/
export function toOsError(error: unknown, fallbackPath?: string): unknown {
  if (!hasErrorCode(error)) return error
  const errorPath = error.path ?? fallbackPath
  const message = formatOsError({ code: error.code, path: errorPath, dest: error.dest }) ?? error.message
  return new OsError(message, error.code, errorPath, { cause: error })
}
