import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { verifies } from '../../../tests/_helpers/verifies.js'
import { redactSecrets } from '../redact.js'

describe('redactSecrets', () => {
  it('アクセスキー ID は、長期用と一時用のどちらも伏せ字にする', async (context) => {
    await verifies(context, 'PT-COMMON-15')
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。`AKIA` で始まる長期用と `ASIA` で始まる一時用のアクセスキー ID を含む文字列を渡した場合に、どちらも `[redacted]` に置き換わることを確認します。')
    expect(redactSecrets('key=AKIAIOSFODNN7EXAMPLE')).toBe('key=[redacted]')
    expect(redactSecrets('key=ASIAIOSFODNN7EXAMPLE')).toBe('key=[redacted]')
  })

  it('aws_secret_access_key は、値の部分だけを伏せ字にする', async (context) => {
    await verifies(context, 'PT-COMMON-12')
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。`aws_secret_access_key = …` の形の文字列を渡した場合に、キーと `=` は残り、値だけが `[redacted]` に置き換わることを確認します。')
    expect(redactSecrets('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('aws_secret_access_key = [redacted]')
  })

  it('aws_session_token は、値の部分だけを伏せ字にする', async (context) => {
    await verifies(context, 'PT-COMMON-12')
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。`aws_session_token=…` の形の文字列を渡した場合に、キーと `=` は残り、値だけが `[redacted]` に置き換わることを確認します。')
    expect(redactSecrets('aws_session_token=IQoJb3JpZ2luX2VjEXAMPLE')).toBe('aws_session_token=[redacted]')
  })

  it('x-amz-security-token ヘッダは、値の部分だけを伏せ字にする', async (context) => {
    await verifies(context, 'PT-COMMON-12')
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。`x-amz-security-token: …` の形の文字列を渡した場合に、ヘッダ名は残り、値だけが `[redacted]` に置き換わることを確認します。')
    expect(redactSecrets('x-amz-security-token: IQoJb3JpZ2luX2VjEXAMPLE'))
      .toBe('x-amz-security-token: [redacted]')
  })

  it('環境変数の形の大文字のキーも、値の部分を伏せ字にする', async () => {
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。`AWS_SESSION_TOKEN` と `AWS_SECRET_ACCESS_KEY` の形の文字列を渡した場合に、大文字のキーでも値だけが `[redacted]` に置き換わることを確認します。')
    // 混入元の本命は、`env` や `--debug` 相当の出力に混入する環境変数の大文字形。
    expect(redactSecrets('AWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEXAMPLE'))
      .toBe('AWS_SESSION_TOKEN=[redacted]')
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('AWS_SECRET_ACCESS_KEY=[redacted]')
  })

  it('先頭が大文字のヘッダ名 X-Amz-Security-Token も、値の部分を伏せ字にする', async () => {
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。`X-Amz-Security-Token: …` の形の文字列を渡した場合に、ヘッダ名の大文字と小文字を区別せず、値だけが `[redacted]` に置き換わることを確認します。')
    expect(redactSecrets('X-Amz-Security-Token: IQoJb3JpZ2luX2VjEXAMPLE'))
      .toBe('X-Amz-Security-Token: [redacted]')
  })

  it('JSON の文字列の中で伏せ字にしても、JSON として解析できる', async () => {
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。JSON の文字列の値の中に `aws_session_token=…` を含めた場合に、閉じ引用符まで置き換えず、結果を `JSON.parse` で解析できることを確認します。')
    // 値部が閉じ引用符まで飲み込むと不正 JSON になり、後段が何も言わず行配列へ切り替わる。
    const redacted = redactSecrets('{"note":"aws_session_token=IQoJb3JpZ2luX2VjEXAMPLE"}')

    expect(redacted).toBe('{"note":"aws_session_token=[redacted]"}')
    expect(JSON.parse(redacted)).toEqual({ note: 'aws_session_token=[redacted]' })
  })

  it('同じ形の資格情報が複数回出現するときは、すべて伏せ字にする', async () => {
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。`AKIA` と `ASIA` のアクセスキー ID を 1 つの文字列へ含めた場合は、どちらも `[redacted]` に置き換わることを確認します。')
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE と ASIAIOSFODNN7EXAMPLE'))
      .toBe('[redacted] と [redacted]')
  })

  it('資格情報を含まない JSON の出力は、変更しない', async () => {
    await explains('出力から資格情報を伏せ字にする `redactSecrets` のテストです。`UserId`、`Account`、`Arn` を含む通常の JSON 文字列を渡した場合に、入力と同じ文字列が返されることを確認します。')
    const json = '{"UserId":"AIDAEXAMPLE","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/dev"}'
    expect(redactSecrets(json)).toBe(json)
  })
})
