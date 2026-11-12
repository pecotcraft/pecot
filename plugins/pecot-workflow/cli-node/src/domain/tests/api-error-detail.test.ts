import { describe, expect, it } from 'vitest'

import { describeApiError } from '../api-error-detail.js'

describe('describeApiError', () => {
  it('本文が無ければ message のまま', () => {
    expect(describeApiError({ message: 'GitHub API error: 500' })).toBe('GitHub API error: 500')
  })

  it('本文が undefined でも message のまま', () => {
    expect(describeApiError({ message: 'GitHub API error: 500', responseBody: undefined })).toBe('GitHub API error: 500')
  })

  it('本文が JSON でなければ message のまま', () => {
    expect(describeApiError({ message: 'GitHub API error: 502', responseBody: '<html>bad gateway</html>' })).toBe('GitHub API error: 502')
  })

  it('本文の message を後ろに足す', () => {
    expect(describeApiError({ message: 'access denied', responseBody: '{"message":"Forbidden"}' })).toBe('access denied Forbidden')
  })

  it('errors[].message も足し、前後の空白は落とす', () => {
    const body = '{"message":" Validation Failed ","errors":[{"message":"first"},{"code":"x"},{"message":"second "}]}'
    expect(describeApiError({ message: 'GitHub API error: 422', responseBody: body })).toBe('GitHub API error: 422 Validation Failed first second')
  })

  it('message が空の本文は足さない', () => {
    expect(describeApiError({ message: 'x', responseBody: '{"message":"  "}' })).toBe('x')
  })
})
