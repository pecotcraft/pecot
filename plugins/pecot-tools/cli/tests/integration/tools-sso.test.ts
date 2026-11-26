// 偽 awscli を PATH の先頭に置き、MCP 越しに SSO の 2 段構成（開始・状態確認）を通す統合テスト。
// PATH を stub するため it.concurrent は使わない。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetAwscliProbe } from '../../src/infra/awscli.js'
import type {
  LoginRegistryOptions,
} from '../../src/infra/sso/login-registry.js'
import { closeMcp, connectMcp, type ConnectedMcp } from '../../src/mcp/tests/_client.js'
import { allTools } from '../../src/mcp/tools/index.js'
import { useFakeAws, type FakeAws } from '../_helpers/fake-aws.js'
import { isRecord } from '../_helpers/records.js'
import { explains } from '../../tests/_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { useLoginRegistry } from '../_helpers/login-registry.js'

/**
状態遷移を待つ上限。
*/
const TRANSITION_TIMEOUT_MS = 5000

const mcp: { connected: ConnectedMcp | undefined } = { connected: undefined }
const newRegistry = useLoginRegistry()
const fakeAws = useFakeAws()

beforeEach(() => {
  resetAwscliProbe()
})

afterEach(async () => {
  if (mcp.connected !== undefined) await closeMcp(mcp.connected)
  mcp.connected = undefined
})

/**
レジストリを差し替えたサーバへ接続する。共有インスタンスを使うとケース間で状態が混在する。
*/
async function connect(options: Readonly<LoginRegistryOptions> = {}): Promise<void> {
  const registry = newRegistry(options)
  mcp.connected = await connectMcp(allTools({ loginRegistry: registry }))
}

/**
偽 awscli の差し込み条件を張り替える。MCP の接続は保ったまま次の呼び出しへ進む。
*/
function reinstall(options: Parameters<typeof fakeAws.reinstall>[0] = {}): void {
  resetAwscliProbe()
  fakeAws.reinstall(options)
}

/**
tools/call の応答のうち、テストが見る部分。sentence は content の 1 つ目の text（成功の文か失敗の detail）。
*/
interface Called {
  readonly structured: Record<string, unknown>
  readonly isError: boolean
  readonly sentence: string
}

async function callTool(
  name: string,
  arguments_: Readonly<Record<string, unknown>> = {},
): Promise<Called> {
  if (mcp.connected === undefined) throw new Error('サーバへ接続できていません')
  const result = await mcp.connected.client.callTool({ name, arguments: { ...arguments_ } })
  const structured = result.structuredContent
  if (!isRecord(structured)) throw new Error(`${name} の structuredContent がありません`)
  const [first] = Array.isArray(result.content) ? result.content : []
  const sentence = first?.type === 'text' ? first.text : ''
  return { structured, isError: result.isError === true, sentence }
}

async function call(
  name: string,
  arguments_: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const called = await callTool(name, arguments_)
  return called.structured
}

/**
`--version` の確認呼び出しを除いた awscli 呼び出しの件数。
*/
function commandCallCount(instance: Readonly<FakeAws>): number {
  return instance.callLog().filter(call => call[0] !== '--version').length
}

describe('SSO の 2 段構成', () => {
  it('開始すると URL とコードを返し、承認後の状態確認で completed になる', async (context) => {
    await verifies(context, 'PT-AWS-SSO-LOGIN-01')
    await explains('偽の awscli を PATH の先頭に置き、MCP 経由で SSO の 2 段構成（開始と状態確認）を通すテストです。`aws_sso_login` が `pending` で URL とコードを返し、承認後の状態確認で `completed` になることを確認します。')
    await verifies(context, 'PT-AWS-SSO-LOGIN-STATUS-01')
    await verifies(context, 'PT-AWS-SSO-LOGIN-STATUS-02')
    const instance = fakeAws.install({ exitWhenFile: true })
    await connect()

    const startedCall = await callTool('aws_sso_login')
    const started = startedCall.structured
    expect(startedCall.isError).toBe(false)
    expect(started).toMatchObject({
      state: 'pending',
      profile: '',
      verificationUrl: 'https://example.awsapps.com/start/#/device',
      // コード入力を省ける URL。利用者へ案内する第一候補になる。
      verificationUrlComplete: 'https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    })
    expect(startedCall.sentence).toContain('verificationUrlComplete')

    const pending = await callTool('aws_sso_login_status')
    expect(pending.structured).toMatchObject({ state: 'pending' })
    expect(pending.sentence).toContain('Not approved yet')
    // 状態確認は awscli を起こさない（契約書 §SSO 認証）。
    expect(commandCallCount(instance)).toBe(1)

    instance.release()
    await vi.waitFor(async () => {
      expect(await call('aws_sso_login_status')).toMatchObject({ state: 'completed' })
    }, { timeout: TRANSITION_TIMEOUT_MS })

    const completed = await callTool('aws_sso_login_status')
    expect(completed.isError).toBe(false)
    expect(String(completed.structured['output'])).toContain('Successfully logged into Start URL')
    expect(commandCallCount(instance)).toBe(1)
  })

  it('ログインを開始していない状態確認は、invalid-input を返し、awscli を起動しない', async (context) => {
    await verifies(context, 'PT-AWS-SSO-LOGIN-STATUS-03')
    await explains('偽の awscli を PATH の先頭に置き、MCP 経由で SSO の 2 段構成（開始と状態確認）を通すテストです。ログインを開始する前に `aws_sso_login_status` を呼び出した場合は、種類が `invalid-input` になり、awscli が呼ばれないことを確認します。')
    const instance = fakeAws.install()
    await connect()

    const structured = await call('aws_sso_login_status')

    expect(structured).toMatchObject({ kind: 'invalid-input' })
    expect(String(structured['detail'])).toContain('aws_sso_login')
    expect(commandCallCount(instance)).toBe(0)
  })

  it('awscli が 2.22 未満のときは、ログインを開始せず awscli-missing を返す', async (context) => {
    await verifies(context, 'PT-AWS-SSO-LOGIN-03')
    await explains('偽の awscli を PATH の先頭に置き、MCP 経由で SSO の 2 段構成（開始と状態確認）を通すテストです。版が `2.15.0` の awscli でログインを開始した場合は、種類が `awscli-missing` になり、awscli のコマンドが呼ばれないことを確認します。')
    await verifies(context, 'PT-COMMON-07')
    // `--use-device-code` は 2.22 以降にしか無い。そのまま起動すると invalid-input に化けて
    // 打ち手（awscli の更新）が伝わらない。
    const instance = fakeAws.install({ version: 'aws-cli/2.15.0 Python/3.14.6 Linux/7.0.0' })
    await connect()

    const structured = await call('aws_sso_login')

    expect(structured).toMatchObject({ kind: 'awscli-missing' })
    expect(String(structured['detail'])).toContain('2.22.0 or later')
    expect(commandCallCount(instance)).toBe(0)
  })

  it('SSO の設定がない profile でログインを開始すると、auth-missing を返す', async (context) => {
    await verifies(context, 'PT-AWS-SSO-LOGIN-04')
    await explains('偽の awscli を PATH の先頭に置き、MCP 経由で SSO の 2 段構成（開始と状態確認）を通すテストです。SSO の設定がない profile を指定した場合は、種類が `auth-missing` になり、`detail` に `aws configure sso` が含まれることを確認します。')
    fakeAws.install({ fixture: 'sso-login.no-config' })
    await connect()

    const structured = await call('aws_sso_login', { profile: 'plain' })

    expect(structured).toMatchObject({ kind: 'auth-missing' })
    expect(String(structured['log'])).toContain('Missing the following required SSO configuration')
    expect(String(structured['detail'])).toContain('aws configure sso')
  })

  it('失敗したログインの状態確認は、同じ種類と出力を返す', async (context) => {
    await verifies(context, 'PT-AWS-SSO-LOGIN-STATUS-04')
    await explains('偽の awscli を PATH の先頭に置き、MCP 経由で SSO の 2 段構成（開始と状態確認）を通すテストです。ログインの開始に失敗した後で状態確認を呼び出した場合は、種類が `auth-missing`、`state` が `failed` になることを確認します。')
    // 開始が失敗した直後に状態を引きにいくケース。開始の応答を取りこぼしたエージェントが
    // ここで理由に辿り着けないと、原因不明のまま再試行を繰り返す。
    fakeAws.install({ fixture: 'sso-login.no-config' })
    await connect()

    await call('aws_sso_login', { profile: 'plain' })
    const structured = await call('aws_sso_login_status', { profile: 'plain' })

    expect(structured).toMatchObject({ kind: 'auth-missing' })
    expect(structured).toMatchObject({ state: 'failed' })
    expect(String(structured['log'])).toContain('Missing the following required SSO configuration')
  })

  it('時間切れになったログインの状態確認は、timeout と再開始の案内を返す', async (context) => {
    await verifies(context, 'PT-AWS-SSO-LOGIN-STATUS-05')
    await explains('偽の awscli を PATH の先頭に置き、MCP 経由で SSO の 2 段構成（開始と状態確認）を通すテストです。制限時間を 1 秒にして開始し、`pending` のまま時間切れになった場合は、状態確認が `timed-out` と種類 `timeout` を返すことを確認します。')
    fakeAws.install({ exitWhenFile: true })
    await connect({ timeoutMs: 1000 })

    expect(await call('aws_sso_login')).toMatchObject({ state: 'pending' })

    await vi.waitFor(async () => {
      expect(await call('aws_sso_login_status')).toMatchObject({ state: 'timed-out' })
    }, { timeout: TRANSITION_TIMEOUT_MS })

    const structured = await call('aws_sso_login_status')
    expect(structured).toMatchObject({ kind: 'timeout' })
    expect(String(structured['detail'])).toContain('Call aws_sso_login again')
  })

  it('region と未知のキーを渡しても、入力として拒否せず通常の応答を返し、awscli の引数にも含めない', async () => {
    await explains('偽の awscli を PATH の先頭に置き、MCP 経由で SSO の 2 段構成（開始と状態確認）を通すテストです。`region` と `bogus` を渡してログインを開始した場合は、拒否されず `auth-missing` の応答を返すことを確認します。')
    // SSO の 2 件は inputSchema に region を持たない（profile だけを公開）。z.object は
    // デフォルトで未知キーを strip する。そのため渡しても入力検証エラーにはならず、通常の失敗応答が返る。
    const instance = fakeAws.install({ fixture: 'sso-login.no-config' })
    await connect()

    const structured = await call('aws_sso_login', {
      profile: 'plain',
      region: 'ap-northeast-1',
      bogus: 'unexpected',
    })

    expect(structured).toMatchObject({ kind: 'auth-missing' })
    expect(instance.callLog().filter(call => call[0] !== '--version')).toEqual([
      ['sso', 'login', '--profile=plain', '--no-browser', '--use-device-code'],
    ])
  })

  it('ログインが失敗した直後でも、同じ接続が次の呼び出しに応答する', async (context) => {
    await verifies(context, 'PT-COMMON-13')
    await explains('偽の awscli を PATH の先頭に置き、MCP 経由で SSO の 2 段構成（開始と状態確認）を通すテストです。`auth-missing` で失敗した後に、偽の awscli を差し替えて再度開始した場合に、同じ接続のまま `pending` で認証コードを含む結果を返すことを確認します。')
    // SC-008。失敗した呼び出しがサーバを畳んでしまうと、再認証の導線が途切れる。
    fakeAws.install({ fixture: 'sso-login.no-config' })
    await connect()

    expect(await callTool('aws_sso_login')).toMatchObject({ isError: true, structured: { kind: 'auth-missing' } })

    reinstall({ exitWhenFile: true })
    const retried = await callTool('aws_sso_login')

    expect(retried.isError).toBe(false)
    expect(retried.structured).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH' })
  })
})
