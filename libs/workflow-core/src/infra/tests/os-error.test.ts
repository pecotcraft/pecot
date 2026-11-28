import { describe, expect, it } from 'vitest'

import { hasErrorCode, isFileNotFound, isSystemCallError, OsError, toOsError } from '../os-error.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

function systemError(code: string, message: string, extra: Readonly<Record<string, string>> = {}): Error {
  return Object.assign(new Error(message), { code }, extra)
}

describe('hasErrorCode', () => {
  it('code が E で始まる文字列の Error のとき true、それ以外は false を返す', async () => {
    await explains('システムエラーの判定（`hasErrorCode`）のテストです。`code` が `E` で始まる文字列を持つ `Error` の場合に `true` を返し、`MODULE_NOT_FOUND` や通常の `Error` などの場合に `false` を返すことを確認します。')
    const results = stepSync('いくつかの値を判定する', () => [
      hasErrorCode(systemError('ENOENT', 'x')),
      hasErrorCode(systemError('ERR_FS_EISDIR', 'x')),
      hasErrorCode(systemError('MODULE_NOT_FOUND', 'x')),
      hasErrorCode(new Error('x')),
      hasErrorCode('ENOENT'),
      hasErrorCode({ code: 'ENOENT' }),
    ])
    stepSync('判定の結果を比べる', () => {
      expect(results).toEqual([true, true, false, false, false, false])
    })
  })
})

describe('isSystemCallError', () => {
  it('syscall を持つシステムエラーのとき true、それ以外は false を返す', async () => {
    await explains('`isSystemCallError` のテストです。`syscall` を持つシステムエラーの場合に `true` を返し、`syscall` を持たないエラーや `TypeError` の場合に `false` を返すことを確認します。')
    const results = stepSync('いくつかのエラーを判定する', () => [
      isSystemCallError(systemError('ENOENT', 'x', { syscall: 'open' })),
      isSystemCallError(systemError('ERR_INVALID_ARG_TYPE', 'x')),
      isSystemCallError(new TypeError('x')),
    ])
    stepSync('判定の結果を比べる', () => {
      expect(results).toEqual([true, false, false])
    })
  })
})

describe('isFileNotFound', () => {
  it('ENOENT のとき true、それ以外は false を返す', async () => {
    await explains('`isFileNotFound` のテストです。`code` が `ENOENT` の場合に `true` を返し、`EACCES` や `undefined` などの場合に `false` を返すことを確認します。')
    const results = stepSync('いくつかの値を判定する', () => [
      isFileNotFound(systemError('ENOENT', 'x')),
      isFileNotFound(systemError('EACCES', 'x')),
      isFileNotFound(undefined),
    ])
    stepSync('判定の結果を比べる', () => {
      expect(results).toEqual([true, false, false])
    })
  })
})

describe('toOsError', () => {
  it('システムエラーを、Python の OSError と同じ文の OsError に変換し、元の例外を cause に保持する', async () => {
    await explains('システムエラーを変換する `toOsError` のテストです。メッセージが Python の `OSError` と同じ形式になり、元の例外が `cause` に保持されることを確認します。')
    const source = systemError('ENOENT', 'ENOENT: no such file or directory, open \'/x\'', { path: '/x' })
    const converted = stepSync('システムエラーを変換する', () => toOsError(source))
    stepSync('変換の結果を比べる', () => {
      expect(converted).toBeInstanceOf(OsError)
      expect(converted).toMatchObject({ message: '[Errno 2] No such file or directory: \'/x\'', code: 'ENOENT', path: '/x', cause: source })
    })
  })

  it('パスを 2 つ持つシステムエラーは、2 つのパスを -> でつないだ文にする', async () => {
    await explains('`toOsError` のテストです。`path` と `dest` を持つ `EEXIST` のエラーの場合に、メッセージが 2 つのパスを `->` でつないだ形式になることを確認します。')
    const converted = stepSync('パスを 2 つ持つエラーを変換する', () => toOsError(systemError('EEXIST', 'x', { path: 'a', dest: 'b' })))
    stepSync('メッセージを比べる', () => {
      expect(converted).toMatchObject({ message: '[Errno 17] File exists: \'a\' -> \'b\'' })
    })
  })

  it('errno の対応表に存在しない code の場合は、元の message をそのまま使う', async () => {
    await explains('`toOsError` のテストです。対応表に存在しない `ECONNRESET` のエラーの場合に、元の `message` がそのまま使われることを確認します。')
    const converted = stepSync('対応表に無い code のエラーを変換する', () => toOsError(systemError('ECONNRESET', 'socket hang up')))
    stepSync('メッセージを比べる', () => {
      expect(converted).toMatchObject({ message: 'socket hang up', code: 'ECONNRESET' })
    })
  })

  it('システムエラーでなければそのまま返す', async () => {
    await explains('`toOsError` のテストです。システムエラーではない `Error` や文字列の場合に、変換せずに入力をそのまま返すことを確認します。')
    const error = new Error('x')
    const results = stepSync('システムエラーでない値を変換する', () => [toOsError(error), toOsError('text')])
    stepSync('入力と同じ値が返ることを確かめる', () => {
      expect(results[0]).toBe(error)
      expect(results[1]).toBe('text')
    })
  })
})
