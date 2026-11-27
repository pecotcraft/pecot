import { describe, expect, it } from 'vitest'

import { parseSsoLoginOutput } from '../sso-output.js'
import { explains } from '../../../tests/_helpers/explains.js'

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
  it('実際の awscli の出力の全文から、URL、コード、自動入力用の URL を取り出す', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。`sso login --no-browser --use-device-code` の実際の出力を渡した場合に、URL とコードなど 3 つの項目が得られることを確認します。')
    expect(parseSsoLoginOutput(REAL_OUTPUT)).toEqual({
      verificationUrl: 'https://example.awsapps.com/start/#/device',
      userCode: 'ABCD-EFGH',
      verificationUrlComplete: 'https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH',
    })
  })

  it('verificationUrl には、末尾の自動入力用の URL ではなく、マーカー直後の URL を使う', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。出力の全文を渡した場合に、`verificationUrl` が、コードをクエリに含む自動入力用の URL でないことを確認します。')
    // autofill 行はコードをクエリに含む。取り違えると 2 つの URL の役割が入れ替わる。
    expect(parseSsoLoginOutput(REAL_OUTPUT)?.verificationUrl).not.toContain('user_code=')
  })

  it('累積した出力にコードの行が含まれないときは、undefined を返す', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。子プロセスの出力が URL の行まで届いた時点の文字列を渡した場合に、確定させず `undefined` を返すことを確認します。')
    // 子プロセスの出力は chunk 単位で届く。URL だけで確定させると、コードを持たない
    // 応答を返してしまい利用者が認証を完了できない。
    const lines = REAL_OUTPUT.split('\n')
    const untilUrl = lines.slice(0, 5).join('\n')

    expect(parseSsoLoginOutput(untilUrl)).toBeUndefined()
  })

  it('自動入力用の URL の行がまだ届いていないときは、その URL を除いて結果を確定する', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。コードの行までの出力を渡した場合に、`verificationUrl` と `userCode` だけを持つ結果を返すことを確認します。')
    // autofill 行を待つと、URL とコードが揃っているのに応答が遅れる。
    const untilCode = REAL_OUTPUT.split('\n').slice(0, 8).join('\n')

    expect(parseSsoLoginOutput(untilCode)).toEqual({
      verificationUrl: 'https://example.awsapps.com/start/#/device',
      userCode: 'ABCD-EFGH',
    })
  })

  it('自動入力用の URL の行が後から届いたときは、再度の解析でその URL を追加する', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。コードの行までの出力では `verificationUrlComplete` が `undefined` で、自動入力用の URL の行を含む出力では、その URL が得られることを確認します。')
    const lines = REAL_OUTPUT.split('\n')
    const untilCode = lines.slice(0, 8).join('\n')
    const withAutofill = lines.slice(0, 11).join('\n')

    expect(parseSsoLoginOutput(untilCode)?.verificationUrlComplete).toBeUndefined()
    expect(parseSsoLoginOutput(withAutofill)?.verificationUrlComplete)
      .toBe('https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH')
  })

  it('SSO の設定がないときの stderr からは、何も取り出さない', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。SSO の設定がない profile の実際の stderr を渡した場合に、`undefined` を返すことを確認します。')
    expect(parseSsoLoginOutput(NO_CONFIG_STDERR)).toBeUndefined()
  })

  it('空文字を渡すと、undefined を返す', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。空文字を渡した場合に、`undefined` を返すことを確認します。')
    expect(parseSsoLoginOutput('')).toBeUndefined()
  })

  it('コードの形式に合わない行は、認証コードとして取り出さない', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。コードの行が、小文字を含む `abcd-efgh`、区切りのない `ABCDEFGH`、桁数の短い `AB-CD` の場合に、`undefined` を返すことを確認します。')
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

  it('案内の見出しの行がないときは、URL の行があっても、undefined を返す', async () => {
    await explains('SSO ログインの出力から認証の案内を取り出す `parseSsoLoginOutput` のテストです。`Please visit the following URL:` などの見出しを含まず、URL とコードだけを渡した場合に、`undefined` を返すことを確認します。')
    expect(parseSsoLoginOutput('https://example.awsapps.com/start/#/device\nABCD-EFGH')).toBeUndefined()
  })
})
