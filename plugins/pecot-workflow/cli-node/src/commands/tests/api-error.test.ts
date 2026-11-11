import { describe, expect, it } from 'vitest'

import { GitHubAPIError } from '../../infra/github/errors.js'
import { TransportFailure } from '../../infra/github/client.js'
import { apiErrorDetail } from '../api-error.js'

describe('apiErrorDetail', () => {
  it('API の失敗は message をそのまま返す', () => {
    expect(apiErrorDetail(new GitHubAPIError('GitHub API error: 422', { statusCode: 422, responseBody: '{"message":"x"}' }))).toBe('GitHub API error: 422')
  })

  it('送信の失敗も message をそのまま返す', () => {
    expect(apiErrorDetail(new TransportFailure('timed out'))).toBe('timed out')
  })
})
