import { describe, expect, it } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'

import { PecotError } from '../../../domain/errors.js'
import { asNotFoundError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError, isClosedByAnotherRequest, isMissingReferenceError } from '../errors.js'

describe('GitHubAPIError', () => {
  it('基本的なエラーは状態コードと本文を持たない', async () => {
    await explains('GitHub API のエラー型のテストです。基本のエラーが、メッセージを持ち、状態コードと本文を持たないことを確認します。')
    const error = new GitHubAPIError('テストエラー')
    expect(error.message).toBe('テストエラー')
    expect(error.statusCode).toBeUndefined()
    expect(error.responseBody).toBeUndefined()
    expect(String(error)).toBe('GitHubAPIError: テストエラー')
  })

  it('状態コードと本文を指定すると、それらを保持する', async () => {
    await explains('GitHub API のエラー型のテストです。状態コードと本文を指定した場合に、それらを保持することを確認します。')
    const error = new GitHubAPIError('エラー', { statusCode: 500, responseBody: '{"error": "test"}' })
    expect(error.statusCode).toBe(500)
    expect(error.responseBody).toBe('{"error": "test"}')
  })

  it('元の例外を指定すると、cause として保持する', async () => {
    await explains('GitHub API のエラー型のテストです。元の例外を指定した場合に、`cause` として保持することを確認します。')
    const cause = new Error('元')
    expect(new GitHubAPIError('エラー', { cause }).cause).toBe(cause)
  })

  it('PecotError を継承する', async () => {
    await explains('GitHub API のエラー型のテストです。`PecotError` を継承していることを確認します。')
    expect(new GitHubAPIError('x')).toBeInstanceOf(PecotError)
  })
})

describe('継承', () => {
  it.each([
    ['GitHubAuthError', new GitHubAuthError('認証エラー')],
    ['GitHubNotFoundError', new GitHubNotFoundError('リソースが見つかりません')],
    ['GitHubRateLimitError', new GitHubRateLimitError('レート制限')],
  ])('%s は GitHubAPIError を継承し、クラス名を name に持つ', async (name, error) => {
    await explains('認証・未検出・レート制限のエラー型のテストです。いずれも `GitHubAPIError` を継承し、クラス名を `name` に持つことを確認します。')
    expect(error).toBeInstanceOf(GitHubAPIError)
    expect(error.name).toBe(name)
  })
})

describe('isMissingReferenceError', () => {
  it.for([
    { status: 404, expected: true },
    { status: 422, expected: true },
    { status: 403, expected: false },
    { status: 500, expected: false },
  ])('状態コード $status で本文に Reference does not exist があると $expected', async ({ status, expected }) => {
    await explains('参照が存在しないエラーを判定する関数のテストです。状態コードが 404 か 422 で、本文に `Reference does not exist` を含む場合は `true`、403 や 500 の場合は `false` を返すことを確認します。')
    expect(isMissingReferenceError(new GitHubAPIError('x', { statusCode: status, responseBody: '{"message":"Reference does not exist"}' }))).toBe(expected)
  })

  it('本文が別の理由なら、404 でも false', async () => {
    await explains('参照が存在しないエラーを判定する関数のテストです。本文が別の理由（`Not Found`）の場合に、状態コードが 404 でも `false` を返すことを確認します。')
    expect(isMissingReferenceError(new GitHubAPIError('x', { statusCode: 404, responseBody: '{"message":"Not Found"}' }))).toBe(false)
  })

  it('本文が存在しない場合は、false を返す', async () => {
    await explains('参照が存在しないエラーを判定する関数のテストです。本文が存在しない場合に、`false` を返すことを確認します。')
    expect(isMissingReferenceError(new GitHubAPIError('x', { statusCode: 422 }))).toBe(false)
  })
})

describe('isClosedByAnotherRequest', () => {
  it.each([
    [422, 'Issue was closed by another request', true],
    [422, 'other', false],
    [404, 'closed by another request', false],
    [422, undefined, false],
  ])('状態 %s・本文 %j の場合は、%s を返す', async (statusCode, responseBody, expected) => {
    await explains('別の要求で閉じられたエラーを判定する関数のテストです。状態コードが 422 で本文に `closed by another request` を含む場合だけ `true` を返し、それ以外は `false` を返すことを確認します。')
    expect(isClosedByAnotherRequest(new GitHubAPIError('m', { statusCode, responseBody }))).toBe(expected)
  })
})

describe('asNotFoundError', () => {
  it('GraphQL の type が NOT_FOUND の GitHubAPIError は、同じ文の GitHubNotFoundError に変換する', async () => {
    await explains('GraphQL のエラーを変換する関数のテストです。`type` が `NOT_FOUND` の `GitHubAPIError` を、同じメッセージの `GitHubNotFoundError` に変換することを確認します。')
    const converted = asNotFoundError(new GitHubAPIError('GraphQL query error: x', { errorType: 'NOT_FOUND' }))
    expect(converted).toBeInstanceOf(GitHubNotFoundError)
    expect(converted).toMatchObject({ message: 'GraphQL query error: x', errorType: 'NOT_FOUND' })
  })

  it.for([
    { name: 'type が別', error: new GitHubAPIError('e', { errorType: 'FORBIDDEN' }) },
    { name: 'type が無い', error: new GitHubAPIError('e') },
    { name: 'GitHubAPIError でない', error: new PecotError('e') },
  ])('$name の例外は、そのまま返す', async ({ error }) => {
    await explains('GraphQL のエラーを変換する関数のテストです。`type` が別の値の場合や存在しない場合、`GitHubAPIError` でない例外の場合に、変換せずにそのまま返すことを確認します。')
    expect(asNotFoundError(error)).toBe(error)
  })
})
