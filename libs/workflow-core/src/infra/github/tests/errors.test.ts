import { describe, expect, it } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'
import { stepSync } from '../../../../tests/_helpers/step.js'

import { PecotError } from '../../../domain/errors.js'
import { asNotFoundError, GitHubAPIError, GitHubAuthError, GitHubNotFoundError, GitHubRateLimitError, isClosedByAnotherRequest } from '../errors.js'

describe('GitHubAPIError', () => {
  it('基本的なエラーは状態コードと本文を持たない', async () => {
    await explains('GitHub API のエラー型のテストです。基本のエラーが、メッセージを持ち、状態コードと本文を持たないことを確認します。')
    const error = stepSync('GitHubAPIError を作る', () => new GitHubAPIError('テストエラー'))
    stepSync('エラーの内容を比べる', () => {
      expect(error.message).toBe('テストエラー')
      expect(error.statusCode).toBeUndefined()
      expect(error.responseBody).toBeUndefined()
      expect(String(error)).toBe('GitHubAPIError: テストエラー')
    })
  })

  it('状態コードと本文を指定すると、それらを保持する', async () => {
    await explains('GitHub API のエラー型のテストです。状態コードと本文を指定した場合に、それらを保持することを確認します。')
    const error = stepSync('状態コードと本文を指定して GitHubAPIError を作る', () => new GitHubAPIError('エラー', { statusCode: 500, responseBody: '{"error": "test"}' }))
    stepSync('状態コードと本文を比べる', () => {
      expect(error.statusCode).toBe(500)
      expect(error.responseBody).toBe('{"error": "test"}')
    })
  })

  it('元の例外を指定すると、cause として保持する', async () => {
    await explains('GitHub API のエラー型のテストです。元の例外を指定した場合に、`cause` として保持することを確認します。')
    const cause = new Error('元')
    const error = stepSync('元の例外を指定して GitHubAPIError を作る', () => new GitHubAPIError('エラー', { cause }))
    stepSync('cause を比べる', () => {
      expect(error.cause).toBe(cause)
    })
  })

  it('PecotError を継承する', async () => {
    await explains('GitHub API のエラー型のテストです。`PecotError` を継承していることを確認します。')
    const error = stepSync('GitHubAPIError を作る', () => new GitHubAPIError('x'))
    stepSync('継承を確かめる', () => {
      expect(error).toBeInstanceOf(PecotError)
    })
  })
})

describe('継承', () => {
  it.each<[string, GitHubAPIError]>([
    ['GitHubAuthError', new GitHubAuthError('認証エラー')],
    ['GitHubNotFoundError', new GitHubNotFoundError('リソースが見つかりません')],
    ['GitHubRateLimitError', new GitHubRateLimitError('レート制限')],
  ])('%s は GitHubAPIError を継承し、クラス名を name に持つ', async (name, error) => {
    await explains('認証・未検出・レート制限のエラー型のテストです。いずれも `GitHubAPIError` を継承し、クラス名を `name` に持つことを確認します。')
    stepSync('継承とクラス名を確かめる', () => {
      expect(error).toBeInstanceOf(GitHubAPIError)
      expect(error.name).toBe(name)
    })
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
    const error = stepSync('状態コードと本文を持つエラーを用意する', () => new GitHubAPIError('m', { statusCode, responseBody }))
    const isMatched = stepSync('isClosedByAnotherRequest を呼ぶ', () => isClosedByAnotherRequest(error))
    stepSync('判定を比べる', () => {
      expect(isMatched).toBe(expected)
    })
  })
})

describe('asNotFoundError', () => {
  it('GraphQL の type が NOT_FOUND の GitHubAPIError は、同じ文の GitHubNotFoundError に変換する', async () => {
    await explains('GraphQL のエラーを変換する関数のテストです。`type` が `NOT_FOUND` の `GitHubAPIError` を、同じメッセージの `GitHubNotFoundError` に変換することを確認します。')
    const converted = stepSync('NOT_FOUND のエラーを変換する', () => asNotFoundError(new GitHubAPIError('GraphQL query error: x', { errorType: 'NOT_FOUND' })))
    stepSync('変換したエラーを比べる', () => {
      expect(converted).toBeInstanceOf(GitHubNotFoundError)
      expect(converted).toMatchObject({ message: 'GraphQL query error: x', errorType: 'NOT_FOUND' })
    })
  })

  it.for([
    { name: 'type が別', error: new GitHubAPIError('e', { errorType: 'FORBIDDEN' }) },
    { name: 'type が無い', error: new GitHubAPIError('e') },
    { name: 'GitHubAPIError でない', error: new PecotError('e') },
  ])('$name の例外は、そのまま返す', async ({ error }) => {
    await explains('GraphQL のエラーを変換する関数のテストです。`type` が別の値の場合や存在しない場合、`GitHubAPIError` でない例外の場合に、変換せずにそのまま返すことを確認します。')
    const converted = stepSync('例外を変換する', () => asNotFoundError(error))
    stepSync('同じ例外が返ることを確かめる', () => {
      expect(converted).toBe(error)
    })
  })
})
