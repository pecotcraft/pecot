import { describe, expect, it } from 'vitest'

import { PecotError } from '../../../domain/errors.js'
import { describeApiError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError } from '../errors.js'

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

function error(responseBody: string | undefined): GitHubAPIError {
  return new GitHubAPIError('GitHub API error: 422', { statusCode: 422, responseBody })
}

describe('describeApiError', () => {
  it('本文の message と errors[].message を message に添える', () => {
    const body = JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'tag exists' }, { code: 'x' }, { message: '  ' }, { message: 'second' }] })
    expect(describeApiError(error(body))).toBe('GitHub API error: 422 Validation Failed tag exists second')
  })

  it('message だけでも添える', () => {
    expect(describeApiError(error('{"message":"Not allowed"}'))).toBe('GitHub API error: 422 Not allowed')
  })

  it.each([
    ['本文が無い', undefined],
    ['JSON でない', '<html>bad</html>'],
    ['配列', '[1]'],
    ['どちらも無い', '{"documentation_url":"x"}'],
    ['message が空白', '{"message":"  ","errors":"x"}'],
  ])('%s ときは添えない', (_name, body) => {
    expect(describeApiError(error(body))).toBe('GitHub API error: 422')
  })
})
