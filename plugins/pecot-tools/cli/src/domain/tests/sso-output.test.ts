import { describe, expect, it } from 'vitest'

import { parseSsoLoginOutput } from '../sso-output.js'

/**
実 awscli 2.36.40 の `sso login --no-browser --use-device-code` の stdout 全文
（採取日 2026-09-07）。start URL とコードだけダミーへ置き換えてある。
*/
const REAL_OUTPUT = [
  'Browser will not be automatically opened.',
  'Please visit the following URL:',
  '',
  'https://example.awsapps.com/start/#/device',
  '',
  'Then enter the code:',
  '',
  'ABCD-EFGH',
  '',
  'Alternatively, you may visit the following URL which will autofill the code upon loading:',
  'https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH',
  '',
].join('\n')

/**
SSO 設定の無い profile の stderr（実採取。exit 253）。
*/
const NO_CONFIG_STDERR
  = '\naws: [ERROR]: An error occurred (Configuration): Missing the following required SSO '
    + 'configuration values: sso_start_url, sso_region. To make sure this profile is properly '
    + 'configured to use SSO, please run: aws configure sso\n'

describe('parseSsoLoginOutput', () => {
  it('実採取の全文から URL・コード・自動入力 URL を取り出す', () => {
    expect(parseSsoLoginOutput(REAL_OUTPUT)).toEqual({
      verificationUrl: 'https://example.awsapps.com/start/#/device',
      userCode: 'ABCD-EFGH',
      verificationUrlComplete: 'https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH',
    })
  })

  it('末尾の autofill URL ではなくマーカー直後の URL を verificationUrl にする', () => {
    // autofill 行はコードをクエリに含む。取り違えると 2 つの URL の役割が入れ替わる。
    expect(parseSsoLoginOutput(REAL_OUTPUT)?.verificationUrl).not.toContain('user_code=')
  })

  it('累積出力はコード行が届くまで undefined を返す', () => {
    // 子プロセスの出力は chunk 単位で届く。URL だけで確定させると、コードを持たない
    // 応答を返してしまい利用者が認証を完了できない。
    const lines = REAL_OUTPUT.split('\n')
    const untilUrl = lines.slice(0, 5).join('\n')

    expect(parseSsoLoginOutput(untilUrl)).toBeUndefined()
  })

  it('autofill 行が未到達なら自動入力 URL を省いて確定する', () => {
    // autofill 行を待つと、URL とコードが揃っているのに応答が遅れる。
    const untilCode = REAL_OUTPUT.split('\n').slice(0, 8).join('\n')

    expect(parseSsoLoginOutput(untilCode)).toEqual({
      verificationUrl: 'https://example.awsapps.com/start/#/device',
      userCode: 'ABCD-EFGH',
    })
  })

  it('後から届いた autofill 行は再 parse で補われる', () => {
    const lines = REAL_OUTPUT.split('\n')
    const untilCode = lines.slice(0, 8).join('\n')
    const withAutofill = lines.slice(0, 11).join('\n')

    expect(parseSsoLoginOutput(untilCode)?.verificationUrlComplete).toBeUndefined()
    expect(parseSsoLoginOutput(withAutofill)?.verificationUrlComplete)
      .toBe('https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH')
  })

  it('SSO 設定なしの stderr からは何も取り出さない', () => {
    expect(parseSsoLoginOutput(NO_CONFIG_STDERR)).toBeUndefined()
  })

  it('空文字は undefined', () => {
    expect(parseSsoLoginOutput('')).toBeUndefined()
  })

  it('コードの形をしない行は採らない', () => {
    // マーカーのみで値なし / 小文字混在 / 区切りなし、の各場合は確定させない。
    const text = [
      'Please visit the following URL:',
      'https://example.awsapps.com/start/#/device',
      'Then enter the code:',
      'abcd-efgh',
      'ABCDEFGH',
      'AB-CD',
    ].join('\n')

    expect(parseSsoLoginOutput(text)).toBeUndefined()
  })

  it('マーカーが無ければ URL 行があっても undefined', () => {
    expect(parseSsoLoginOutput('https://example.awsapps.com/start/#/device\nABCD-EFGH')).toBeUndefined()
  })
})
