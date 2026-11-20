import { describe, expect, it } from 'vitest'

import { validateS3ListUri } from '../s3-input.js'

describe('validateS3ListUri', () => {
  it('バケットと prefix の双方を受ける', () => {
    expect(validateS3ListUri('s3://example-bucket')).toBeUndefined()
    expect(validateS3ListUri('s3://example-bucket/prefix/')).toBeUndefined()
    expect(validateS3ListUri('s3://example-bucket/prefix/report.json')).toBeUndefined()
  })

  it('バケット名の無い s3:// も受ける（バケット一覧の指定）', () => {
    expect(validateS3ListUri('s3://')).toBeUndefined()
  })

  it('s3 以外のスキームとローカルパスを拒否する', () => {
    expect(validateS3ListUri('/var/data')).toContain('s3://')
    expect(validateS3ListUri('https://example.com/')).toContain('s3://')
    expect(validateS3ListUri('example-bucket')).toContain('s3://')
  })
})
