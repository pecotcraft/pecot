import { describe, expect, it } from 'vitest'

import { validateS3ListUri } from '../s3-input.js'
import { explains } from '../../../tests/_helpers/explains.js'

describe('validateS3ListUri', () => {
  it('S3 の URI にバケット名だけの場合も prefix を含む場合も、受け付ける', async () => {
    await explains('S3 の一覧の対象を検証する `validateS3ListUri` のテストです。`s3://example-bucket` のようにバケット名だけの URI と、prefix やオブジェクトのキーを含む URI の両方で、エラーを返さないことを確認します。')
    expect(validateS3ListUri('s3://example-bucket')).toBeUndefined()
    expect(validateS3ListUri('s3://example-bucket/prefix/')).toBeUndefined()
    expect(validateS3ListUri('s3://example-bucket/prefix/report.json')).toBeUndefined()
  })

  it('バケット名のない s3:// も、バケット一覧の指定として受け付ける', async () => {
    await explains('S3 の一覧の対象を検証する `validateS3ListUri` のテストです。バケット名を含まない `s3://` を渡した場合に、バケット一覧の指定として扱い、エラーを返さないことを確認します。')
    expect(validateS3ListUri('s3://')).toBeUndefined()
  })

  it('s3 以外のスキームの URI とローカルパスは、s3:// の形式を示すエラーで拒否する', async () => {
    await explains('S3 の一覧の対象を検証する `validateS3ListUri` のテストです。`/var/data` や `https://example.com/` のように `s3://` で始まらない値を渡した場合に、`s3://` を含むエラーメッセージを返すことを確認します。')
    expect(validateS3ListUri('/var/data')).toContain('s3://')
    expect(validateS3ListUri('https://example.com/')).toContain('s3://')
    expect(validateS3ListUri('example-bucket')).toContain('s3://')
  })
})
