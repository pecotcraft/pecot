import { describe, expect, it } from 'vitest'

import { hasErrorCode, isFileNotFound, isSystemCallError, OsError, toOsError } from '../os-error.js'

function systemError(code: string, message: string, extra: Readonly<Record<string, string>> = {}): Error {
  return Object.assign(new Error(message), { code }, extra)
}

describe('hasErrorCode', () => {
  it('code が E で始まる文字列の Error だけ', () => {
    expect(hasErrorCode(systemError('ENOENT', 'x'))).toBe(true)
    expect(hasErrorCode(systemError('ERR_FS_EISDIR', 'x'))).toBe(true)
    expect(hasErrorCode(systemError('MODULE_NOT_FOUND', 'x'))).toBe(false)
    expect(hasErrorCode(new Error('x'))).toBe(false)
    expect(hasErrorCode('ENOENT')).toBe(false)
    expect(hasErrorCode({ code: 'ENOENT' })).toBe(false)
  })
})

describe('isSystemCallError', () => {
  it('syscall を持つシステムエラーだけ', () => {
    expect(isSystemCallError(systemError('ENOENT', 'x', { syscall: 'open' }))).toBe(true)
    expect(isSystemCallError(systemError('ERR_INVALID_ARG_TYPE', 'x'))).toBe(false)
    expect(isSystemCallError(new TypeError('x'))).toBe(false)
  })
})

describe('isFileNotFound', () => {
  it('ENOENT だけ', () => {
    expect(isFileNotFound(systemError('ENOENT', 'x'))).toBe(true)
    expect(isFileNotFound(systemError('EACCES', 'x'))).toBe(false)
    expect(isFileNotFound(undefined)).toBe(false)
  })
})

describe('toOsError', () => {
  it('Python の OSError と同じ文にし、元の例外を cause に持つ', () => {
    const source = systemError('ENOENT', 'ENOENT: no such file or directory, open \'/x\'', { path: '/x' })
    const converted = toOsError(source)
    expect(converted).toBeInstanceOf(OsError)
    expect(converted).toMatchObject({ message: '[Errno 2] No such file or directory: \'/x\'', code: 'ENOENT', path: '/x', cause: source })
  })

  it('2 つのパスは -> でつなぐ', () => {
    expect(toOsError(systemError('EEXIST', 'x', { path: 'a', dest: 'b' }))).toMatchObject({ message: '[Errno 17] File exists: \'a\' -> \'b\'' })
  })

  it('errno の表に無い code は元の message を使う', () => {
    expect(toOsError(systemError('ECONNRESET', 'socket hang up'))).toMatchObject({ message: 'socket hang up', code: 'ECONNRESET' })
  })

  it('システムエラーでなければそのまま返す', () => {
    const error = new Error('x')
    expect(toOsError(error)).toBe(error)
    expect(toOsError('text')).toBe('text')
  })
})
