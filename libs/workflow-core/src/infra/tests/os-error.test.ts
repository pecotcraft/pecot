import { describe, expect, it } from 'vitest'

import { hasErrorCode, isFileNotFound, isSystemCallError, OsError, toOsError } from '../os-error.js'
import { explains } from '../../../tests/_helpers/explains.js'

function systemError(code: string, message: string, extra: Readonly<Record<string, string>> = {}): Error {
  return Object.assign(new Error(message), { code }, extra)
}

describe('hasErrorCode', () => {
  it('code が E で始まる文字列の Error のとき true、それ以外は false を返す', async () => {
    await explains('システムエラーの判定（`hasErrorCode`）のテストです。`code` が `E` で始まる文字列を持つ `Error` の場合に `true` を返し、`MODULE_NOT_FOUND` や通常の `Error` などの場合に `false` を返すことを確認します。')
    expect(hasErrorCode(systemError('ENOENT', 'x'))).toBe(true)
    expect(hasErrorCode(systemError('ERR_FS_EISDIR', 'x'))).toBe(true)
    expect(hasErrorCode(systemError('MODULE_NOT_FOUND', 'x'))).toBe(false)
    expect(hasErrorCode(new Error('x'))).toBe(false)
    expect(hasErrorCode('ENOENT')).toBe(false)
    expect(hasErrorCode({ code: 'ENOENT' })).toBe(false)
  })
})

describe('isSystemCallError', () => {
  it('syscall を持つシステムエラーのとき true、それ以外は false を返す', async () => {
    await explains('`isSystemCallError` のテストです。`syscall` を持つシステムエラーの場合に `true` を返し、`syscall` を持たないエラーや `TypeError` の場合に `false` を返すことを確認します。')
    expect(isSystemCallError(systemError('ENOENT', 'x', { syscall: 'open' }))).toBe(true)
    expect(isSystemCallError(systemError('ERR_INVALID_ARG_TYPE', 'x'))).toBe(false)
    expect(isSystemCallError(new TypeError('x'))).toBe(false)
  })
})

describe('isFileNotFound', () => {
  it('ENOENT のとき true、それ以外は false を返す', async () => {
    await explains('`isFileNotFound` のテストです。`code` が `ENOENT` の場合に `true` を返し、`EACCES` や `undefined` などの場合に `false` を返すことを確認します。')
    expect(isFileNotFound(systemError('ENOENT', 'x'))).toBe(true)
    expect(isFileNotFound(systemError('EACCES', 'x'))).toBe(false)
    expect(isFileNotFound(undefined)).toBe(false)
  })
})

describe('toOsError', () => {
  it('システムエラーを、Python の OSError と同じ文の OsError に変換し、元の例外を cause に保持する', async () => {
    await explains('システムエラーを変換する `toOsError` のテストです。メッセージが Python の `OSError` と同じ形式になり、元の例外が `cause` に保持されることを確認します。')
    const source = systemError('ENOENT', 'ENOENT: no such file or directory, open \'/x\'', { path: '/x' })
    const converted = toOsError(source)
    expect(converted).toBeInstanceOf(OsError)
    expect(converted).toMatchObject({ message: '[Errno 2] No such file or directory: \'/x\'', code: 'ENOENT', path: '/x', cause: source })
  })

  it('パスを 2 つ持つシステムエラーは、2 つのパスを -> でつないだ文にする', async () => {
    await explains('`toOsError` のテストです。`path` と `dest` を持つ `EEXIST` のエラーの場合に、メッセージが 2 つのパスを `->` でつないだ形式になることを確認します。')
    expect(toOsError(systemError('EEXIST', 'x', { path: 'a', dest: 'b' }))).toMatchObject({ message: '[Errno 17] File exists: \'a\' -> \'b\'' })
  })

  it('errno の対応表に存在しない code の場合は、元の message をそのまま使う', async () => {
    await explains('`toOsError` のテストです。対応表に存在しない `ECONNRESET` のエラーの場合に、元の `message` がそのまま使われることを確認します。')
    expect(toOsError(systemError('ECONNRESET', 'socket hang up'))).toMatchObject({ message: 'socket hang up', code: 'ECONNRESET' })
  })

  it('システムエラーでなければそのまま返す', async () => {
    await explains('`toOsError` のテストです。システムエラーではない `Error` や文字列の場合に、変換せずに入力をそのまま返すことを確認します。')
    const error = new Error('x')
    expect(toOsError(error)).toBe(error)
    expect(toOsError('text')).toBe('text')
  })
})
