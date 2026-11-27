// 独自例外の階層（Python の test_errors.py）。段 1 の範囲の例外だけを並べる。
// 他の塊の例外（changelog・release・worktree・frontmatter・github など）は、その塊のテストが同じ形で固定する。
import { describe, expect, it } from 'vitest'

import { ConfigError } from '../src/domain/config.js'
import { PecotError, BaseError, InvalidValueError, ProjectRootNotFoundError } from '../src/domain/errors.js'
import { ReferenceParseError } from '../src/domain/reference-parser.js'
import { AmbiguousRepositoryError } from '../src/domain/repository-resolver.js'
import { GitCommandError } from '../src/infra/git.js'
import { OsError } from '../src/infra/os-error.js'
import { explains } from './_helpers/explains.js'

describe('PecotError', () => {
  it('PecotError は Error を継承し、指定したメッセージを持つ', async () => {
    await explains('`PecotError` のテストです。インスタンスが `Error` であり、例外として発生させたときに指定したメッセージが含まれることを確認します。')
    expect(new PecotError('boom')).toBeInstanceOf(Error)
    expect(() => {
      throw new PecotError('boom')
    }).toThrow('boom')
  })

  it('例外の name には、クラス名が設定される', async () => {
    await explains('`ProjectRootNotFoundError` のテストです。`name` にクラス名の `ProjectRootNotFoundError` が設定されることを確認します。')
    expect(new ProjectRootNotFoundError('x').name).toBe('ProjectRootNotFoundError')
  })

  it('cause を指定すると、その値が cause に保持される', async () => {
    await explains('`PecotError` のテストです。コンストラクタに `cause` を指定した場合に、同じ値が `cause` に保持されることを確認します。')
    const cause = new Error('原因')
    expect(new PecotError('boom', { cause }).cause).toBe(cause)
  })
})

describe('独自例外は PecotError を継承する', () => {
  it.each([
    ['ProjectRootNotFoundError', ProjectRootNotFoundError],
    ['ConfigError', ConfigError],
    ['ReferenceParseError', ReferenceParseError],
    ['AmbiguousRepositoryError', AmbiguousRepositoryError],
  ])('%s は PecotError を継承する', async (_name, errorClass) => {
    await explains('独自例外の継承関係のテストです。`ProjectRootNotFoundError` や `ConfigError` などが `PecotError` を継承していることを確認します。')
    expect(errorClass.prototype).toBeInstanceOf(PecotError)
  })

  it('値の不正を表す InvalidValueError は、PecotError を継承しない', async () => {
    await explains('`InvalidValueError` のテストです。`Error` を継承する一方で、`PecotError` は継承していないことを確認します。')
    expect(InvalidValueError.prototype).toBeInstanceOf(Error)
    expect(InvalidValueError.prototype).not.toBeInstanceOf(PecotError)
  })
})

describe('BaseError', () => {
  it('BaseError を継承したクラスは、name にクラス名を設定し、cause を保持する', async () => {
    await explains('`BaseError` のテストです。継承したクラス `SampleError` の `name` がクラス名になり、指定した `cause` が保持されることを確認します。')
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
  ])('%s は BaseError を継承する', async (_name, errorClass) => {
    await explains('`BaseError` のテストです。`PecotError` や `OsError` などが `BaseError` を継承していることを確認します。')
    expect(errorClass.prototype).toBeInstanceOf(BaseError)
  })

  it('OsError と GitCommandError は、PecotError を継承しない', async () => {
    await explains('`OsError` と `GitCommandError` のテストです。どちらも `PecotError` を継承していないことを確認します。')
    expect(OsError.prototype).not.toBeInstanceOf(PecotError)
    expect(GitCommandError.prototype).not.toBeInstanceOf(PecotError)
  })
})
