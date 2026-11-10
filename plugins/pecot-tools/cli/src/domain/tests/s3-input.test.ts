import { describe, expect, it } from 'vitest'

import { validateLocalPath, validateS3ListUri, validateS3Uri } from '../s3-input.js'

describe('validateS3Uri', () => {
  it('バケットとキーが揃った URI を受ける', () => {
    expect(validateS3Uri('s3://example-bucket/report.json')).toBeUndefined()
    expect(validateS3Uri('s3://example-bucket/logs/2026/09/01/app.log')).toBeUndefined()
  })

  it('キーに空白を含む URI も受ける', () => {
    // shell を介さず 1 要素 1 値で渡すため、空白入りの値は「そういう名前のキー」にしかならない。
    // ここで弾くと空白を含む実在のキーを取得できなくなる。
    expect(validateS3Uri('s3://example-bucket/report 2026.json')).toBeUndefined()
    expect(validateS3Uri('s3://example-bucket/key --recursive')).toBeUndefined()
  })

  it('キーの無い URI とローカルパスを拒否する', () => {
    expect(validateS3Uri('s3://example-bucket')).toContain('s3://')
    expect(validateS3Uri('s3://example-bucket/')).toContain('s3://')
    expect(validateS3Uri('/var/data/report.json')).toContain('s3://')
    expect(validateS3Uri('https://example.com/report.json')).toContain('s3://')
  })
})

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

describe('validateLocalPath', () => {
  it('絶対パスを受ける', () => {
    expect(validateLocalPath('/var/data/report.json')).toBeUndefined()
    expect(validateLocalPath('/var/data/report 2026.json')).toBeUndefined()
  })

  it('相対パスを拒否する', () => {
    expect(validateLocalPath('data/report.json')).toContain('must be an absolute path')
    expect(validateLocalPath('./report.json')).toContain('must be an absolute path')
  })

  it('S3 URI を書き出し先にできない（大小文字を問わない）', () => {
    expect(validateLocalPath('s3://example-bucket/report.json')).toContain('s3://')
    expect(validateLocalPath('S3://example-bucket/report.json')).toContain('s3://')
  })
})
