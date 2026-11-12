import { describe, expect, it } from 'vitest'

import { PecotError } from '../../../domain/errors.js'
import { describeApiError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError, isMissingReferenceError } from '../errors.js'

describe('GitHubAPIError', () => {
  it('基本的なエラーは状態コードと本文を持たない', () => {
    const error = new GitHubAPIError('テストエラー')
    expect(error.message).toBe('テストエラー')
    expect(error.statusCode).toBeUndefined()
    expect(error.responseBody).toBeUndefined()
    expect(String(error)).toBe('GitHubAPIError: テストエラー')
  })

  it('状態コードと本文を持てる', () => {
    const error = new GitHubAPIError('エラー', { statusCode: 500, responseBody: '{"error": "test"}' })
    expect(error.statusCode).toBe(500)
    expect(error.responseBody).toBe('{"error": "test"}')
  })

  it('元の例外を cause に持てる', () => {
    const cause = new Error('元')
    expect(new GitHubAPIError('エラー', { cause }).cause).toBe(cause)
  })

  it('PecotError を継承する', () => {
    expect(new GitHubAPIError('x')).toBeInstanceOf(PecotError)
  })
})

describe('継承', () => {
  it.each([
    ['GitHubAuthError', new GitHubAuthError('認証エラー')],
    ['GitHubNotFoundError', new GitHubNotFoundError('リソースが見つかりません')],
    ['GitHubRateLimitError', new GitHubRateLimitError('レート制限')],
  ])('%s は GitHubAPIError を継承し、クラス名を name に持つ', (name, error) => {
    expect(error).toBeInstanceOf(GitHubAPIError)
    expect(error.name).toBe(name)
  })
})

describe('describeApiError', () => {
  it('本文が無ければ message のまま', () => {
    expect(describeApiError(new GitHubAPIError('GitHub API error: 500', { statusCode: 500 }))).toBe('GitHub API error: 500')
  })

  it('本文が JSON でなければ message のまま', () => {
    expect(describeApiError(new GitHubAPIError('GitHub API error: 502', { statusCode: 502, responseBody: '<html>bad gateway</html>' }))).toBe('GitHub API error: 502')
  })

  it('本文の message を後ろに足す', () => {
    expect(describeApiError(new GitHubAPIError('access denied', { statusCode: 403, responseBody: '{"message":"Forbidden"}' }))).toBe('access denied Forbidden')
  })

  it('errors[].message も足し、前後の空白は落とす', () => {
    const body = '{"message":" Validation Failed ","errors":[{"message":"first"},{"code":"x"},{"message":"second "}]}'
    expect(describeApiError(new GitHubAPIError('GitHub API error: 422', { statusCode: 422, responseBody: body }))).toBe('GitHub API error: 422 Validation Failed first second')
  })

  it('message が空の本文は足さない', () => {
    expect(describeApiError(new GitHubAPIError('x', { responseBody: '{"message":"  "}' }))).toBe('x')
  })
})

describe('isMissingReferenceError', () => {
  it.for([
    { status: 404, expected: true },
    { status: 422, expected: true },
    { status: 403, expected: false },
    { status: 500, expected: false },
  ])('状態コード $status で本文に Reference does not exist があると $expected', ({ status, expected }) => {
    expect(isMissingReferenceError(new GitHubAPIError('x', { statusCode: status, responseBody: '{"message":"Reference does not exist"}' }))).toBe(expected)
  })

  it('本文が別の理由なら、404 でも false', () => {
    expect(isMissingReferenceError(new GitHubAPIError('x', { statusCode: 404, responseBody: '{"message":"Not Found"}' }))).toBe(false)
  })

  it('本文が無ければ false', () => {
    expect(isMissingReferenceError(new GitHubAPIError('x', { statusCode: 422 }))).toBe(false)
  })
})
