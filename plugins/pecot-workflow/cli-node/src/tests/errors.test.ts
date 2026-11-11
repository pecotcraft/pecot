// 独自例外の階層（Python の test_errors.py）。段 1 の範囲の例外だけを並べる。
// 他の塊の例外（changelog・release・worktree・frontmatter・github など）は、その塊のテストが同じ形で固定する。
import { describe, expect, it } from 'vitest'

import { ConfigError, MultipleConfigsError } from '../domain/config.js'
import { PecotError, BaseError, InvalidValueError, ProjectRootNotFoundError } from '../domain/errors.js'
import { ReferenceParseError } from '../domain/reference-parser.js'
import { AmbiguousRepositoryError } from '../domain/repository-resolver.js'
import { GitCommandError } from '../infra/git.js'
import { OsError } from '../infra/os-error.js'
import { OutputPathReservationError } from '../infra/paths.js'

describe('PecotError', () => {
  it('Error であり、メッセージを持つ', () => {
    expect(new PecotError('boom')).toBeInstanceOf(Error)
    expect(() => {
      throw new PecotError('boom')
    }).toThrow('boom')
  })

  it('name はクラス名', () => {
    expect(new ProjectRootNotFoundError('x').name).toBe('ProjectRootNotFoundError')
  })

  it('cause を渡せる', () => {
    const cause = new Error('原因')
    expect(new PecotError('boom', { cause }).cause).toBe(cause)
  })
})

describe('独自例外は PecotError を継承する', () => {
  it.each([
    ['ProjectRootNotFoundError', ProjectRootNotFoundError],
    ['OutputPathReservationError', OutputPathReservationError],
    ['ConfigError', ConfigError],
    ['MultipleConfigsError', MultipleConfigsError],
    ['ReferenceParseError', ReferenceParseError],
    ['AmbiguousRepositoryError', AmbiguousRepositoryError],
  ])('%s は PecotError を継承する', (_name, errorClass) => {
    expect(errorClass.prototype).toBeInstanceOf(PecotError)
  })

  it('MultipleConfigsError は ConfigError の下', () => {
    expect(MultipleConfigsError.prototype).toBeInstanceOf(ConfigError)
  })

  it('値の不正（Python の ValueError）は PecotError ではない', () => {
    expect(InvalidValueError.prototype).toBeInstanceOf(Error)
    expect(InvalidValueError.prototype).not.toBeInstanceOf(PecotError)
  })
})

describe('BaseError', () => {
  it('name をクラス名にし、cause を渡せる', () => {
    class SampleError extends BaseError {}
    const cause = new Error('原因')
    const error = new SampleError('message', { cause })
    expect(error.name).toBe('SampleError')
    expect(error.cause).toBe(cause)
  })

  it.each([
    ['PecotError', PecotError],
    ['InvalidValueError', InvalidValueError],
    ['OsError', OsError],
    ['GitCommandError', GitCommandError],
  ])('%s は BaseError を継承する', (_name, errorClass) => {
    expect(errorClass.prototype).toBeInstanceOf(BaseError)
  })

  it('Python の組み込み例外に当たる系は PecotError を継承しない', () => {
    expect(OsError.prototype).not.toBeInstanceOf(PecotError)
    expect(GitCommandError.prototype).not.toBeInstanceOf(PecotError)
  })
})
