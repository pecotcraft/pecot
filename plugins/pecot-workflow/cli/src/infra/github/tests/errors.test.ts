import { describe, expect, it } from 'vitest'

import { PecotError } from '../../../domain/errors.js'
import { asNotFoundError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError, isClosedByAnotherRequest, isMissingReferenceError } from '../errors.js'

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

describe('asNotFoundError', () => {
  it('GraphQL の type が NOT_FOUND の GitHubAPIError は、同じ文の GitHubNotFoundError にする', () => {
    const converted = asNotFoundError(new GitHubAPIError('GraphQL query error: x', { errorType: 'NOT_FOUND' }))
    expect(converted).toBeInstanceOf(GitHubNotFoundError)
    expect(converted).toMatchObject({ message: 'GraphQL query error: x', errorType: 'NOT_FOUND' })
  })

  it.for([
    { name: 'type が別', error: new GitHubAPIError('e', { errorType: 'FORBIDDEN' }) },
    { name: 'type が無い', error: new GitHubAPIError('e') },
    { name: 'GitHubAPIError でない', error: new PecotError('e') },
  ])('$name の例外は、そのまま返す', ({ error }) => {
    expect(asNotFoundError(error)).toBe(error)
  })
})
