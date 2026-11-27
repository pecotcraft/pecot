import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { describeApiError } from '../api-error-detail.js'

describe('describeApiError', () => {
  it('レスポンスの本文が存在しない場合は、message をそのまま返す', async () => {
    await explains('API のエラーの説明を作成する関数（`describeApiError`）のテストです。レスポンスの本文が存在しない場合や `undefined` の場合に、`message` をそのまま返すことを確認します。')
    expect(describeApiError({ message: 'GitHub API error: 500' })).toBe('GitHub API error: 500')
    expect(describeApiError({ message: 'GitHub API error: 500', responseBody: undefined })).toBe('GitHub API error: 500')
  })

  it('レスポンスの本文が JSON でない場合は、message をそのまま返す', async () => {
    await explains('レスポンスの本文が HTML など JSON ではない場合のテストです。本文を使わず、`message` をそのまま返すことを確認します。')
    expect(describeApiError({ message: 'GitHub API error: 502', responseBody: '<html>bad gateway</html>' })).toBe('GitHub API error: 502')
  })

  it('レスポンスの本文に message がある場合は、エラーの message の後ろに追加する', async () => {
    await explains('レスポンスの本文が JSON で `message` を持つ場合のテストです。エラーの `message` の後ろに、本文の `message` を空白で区切って追加することを確認します。')
    expect(describeApiError({ message: 'access denied', responseBody: '{"message":"Forbidden"}' })).toBe('access denied Forbidden')
  })

  it('errors[].message も追加し、前後の空白を取り除く', async () => {
    await explains('レスポンスの本文が `message` と `errors` の配列を持つ場合のテストです。それぞれの `message` を前後の空白を取り除いて順に追加し、`message` を持たない要素は無視することを確認します。')
    const body = '{"message":" Validation Failed ","errors":[{"message":"first"},{"code":"x"},{"message":"second "}]}'
    expect(describeApiError({ message: 'GitHub API error: 422', responseBody: body })).toBe('GitHub API error: 422 Validation Failed first second')
  })

  it('本文の message が空白だけの場合は、何も追加しない', async () => {
    await explains('本文の `message` が空白だけの場合のテストです。何も追加せず、エラーの `message` をそのまま返すことを確認します。')
    expect(describeApiError({ message: 'x', responseBody: '{"message":"  "}' })).toBe('x')
  })
})
