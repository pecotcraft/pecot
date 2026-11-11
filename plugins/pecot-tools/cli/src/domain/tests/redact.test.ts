import { describe, expect, it } from 'vitest'

import { verifies } from '../../../tests/_helpers/verifies.js'
import { redactSecrets } from '../redact.js'

describe('redactSecrets', () => {
  it('アクセスキー ID を伏せる（長期・一時の両方）', async (context) => {
    await verifies(context, 'PT-COMMON-15')
    expect(redactSecrets('key=AKIAIOSFODNN7EXAMPLE')).toBe('key=[redacted]')
    expect(redactSecrets('key=ASIAIOSFODNN7EXAMPLE')).toBe('key=[redacted]')
  })

  it('aws_secret_access_key の値部だけを伏せる', async (context) => {
    await verifies(context, 'PT-COMMON-12')
    expect(redactSecrets('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('aws_secret_access_key = [redacted]')
  })

  it('aws_session_token の値部だけを伏せる', async (context) => {
    await verifies(context, 'PT-COMMON-12')
    expect(redactSecrets('aws_session_token=IQoJb3JpZ2luX2VjEXAMPLE')).toBe('aws_session_token=[redacted]')
  })

  it('x-amz-security-token ヘッダの値部だけを伏せる', async (context) => {
    await verifies(context, 'PT-COMMON-12')
    expect(redactSecrets('x-amz-security-token: IQoJb3JpZ2luX2VjEXAMPLE'))
      .toBe('x-amz-security-token: [redacted]')
  })

  it('環境変数形の大文字キーも伏せる', () => {
    // 混入元の本命は、`env` や `--debug` 相当の出力に混入する環境変数の大文字形。
    expect(redactSecrets('AWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEXAMPLE'))
      .toBe('AWS_SESSION_TOKEN=[redacted]')
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('AWS_SECRET_ACCESS_KEY=[redacted]')
  })

  it('ヘッダ名の大文字形も伏せる', () => {
    expect(redactSecrets('X-Amz-Security-Token: IQoJb3JpZ2luX2VjEXAMPLE'))
      .toBe('X-Amz-Security-Token: [redacted]')
  })

  it('JSON 文字列の中で置換しても JSON.parse が通る', () => {
    // 値部が閉じ引用符まで飲み込むと不正 JSON になり、後段が何も言わず行配列へ切り替わる。
    const redacted = redactSecrets('{"note":"aws_session_token=IQoJb3JpZ2luX2VjEXAMPLE"}')

    expect(redacted).toBe('{"note":"aws_session_token=[redacted]"}')
    expect(JSON.parse(redacted)).toEqual({ note: 'aws_session_token=[redacted]' })
  })

  it('同一パターンが複数回出ても全件伏せる', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE と ASIAIOSFODNN7EXAMPLE'))
      .toBe('[redacted] と [redacted]')
  })

  it('通常の JSON 出力は変えない', () => {
    const json = '{"UserId":"AIDAEXAMPLE","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/dev"}'
    expect(redactSecrets(json)).toBe(json)
  })
})
