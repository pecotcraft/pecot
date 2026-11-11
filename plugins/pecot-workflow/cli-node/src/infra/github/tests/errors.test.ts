import { describe, expect, it } from 'vitest'

import { PecotError } from '../../../domain/errors.js'
import { describeApiError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError, isClosedByAnotherRequest, isMissingReferenceError } from '../errors.js'

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
  it('本文の message と errors[].message を message の後ろに添える', () => {
    const error = new GitHubAPIError('422 Unprocessable', { responseBody: '{"message": " Validation Failed ", "errors": [{"message": "No commits"}, {"message": "  "}, {"code": "x"}, "text"]}' })
    expect(describeApiError(error)).toBe('422 Unprocessable Validation Failed No commits')
  })

  it('errors[].message だけでも添える', () => {
    expect(describeApiError(new GitHubAPIError('m', { responseBody: '{"errors": [{"message": "理由"}]}' }))).toBe('m 理由')
  })

  it.each([
    ['本文なし', undefined],
    ['JSON でない', '<html>'],
    ['オブジェクトでない', '[1]'],
    ['添える文が無い', '{"message": " ", "errors": "x"}'],
    ['message が文字列でない', '{"message": 3}'],
  ])('%s なら message のまま', (_name, responseBody) => {
    expect(describeApiError(new GitHubAPIError('m', { responseBody }))).toBe('m')
  })
})

describe('isMissingReferenceError', () => {
  it.each([
    [404, 'Reference does not exist', true],
    [422, '{"message":"Reference does not exist"}', true],
    [422, 'other', false],
    [500, 'Reference does not exist', false],
    [404, undefined, false],
  ])('状態 %s・本文 %j は %s', (statusCode, responseBody, expected) => {
    expect(isMissingReferenceError(new GitHubAPIError('m', { statusCode, responseBody }))).toBe(expected)
  })
})

describe('isClosedByAnotherRequest', () => {
  it.each([
    [422, 'Issue was closed by another request', true],
    [422, 'other', false],
    [404, 'closed by another request', false],
    [422, undefined, false],
  ])('状態 %s・本文 %j は %s', (statusCode, responseBody, expected) => {
    expect(isClosedByAnotherRequest(new GitHubAPIError('m', { statusCode, responseBody }))).toBe(expected)
  })
})
