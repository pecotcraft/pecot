// 偽 awscli を PATH の先頭に置き、MCP 越しに SSO の 2 段構成を通す統合テスト。
//
// 見るのは次の 7 点。
//   (a) 開始 → pending → 完了確認の遷移。
//   (b) 未開始の状態確認。
//   (c) awscli の版不足。
//   (d) SSO 設定なし。
//   (e) 失敗したフローの状態確認。
//   (f) 時間切れの案内。
//   (g) SC-008（失敗の直後も同じ接続が次の呼び出しに応える）。
//
// PATH を stub するため it.concurrent は使わない。ensureAwscli の memo は毎ケース捨てる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetAwscliProbe } from '../../src/infra/awscli.js'
import type {
  LoginRegistryOptions,
} from '../../src/infra/sso/login-registry.js'
import { closeMcp, connectMcp, type ConnectedMcp } from '../../src/mcp/tests/_client.js'
import { allTools } from '../../src/mcp/tools/index.js'
import { useFakeAws, type FakeAws } from '../_helpers/fake-aws.js'
import { isRecord } from '../_helpers/records.js'
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

async function call(
  name: string,
  arguments_: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  if (mcp.connected === undefined) throw new Error('サーバへ接続できていません')
  const result = await mcp.connected.client.callTool({ name, arguments: { ...arguments_ } })
  const structured = result.structuredContent
  if (!isRecord(structured)) throw new Error(`${name} の structuredContent がありません`)
  return structured
}

function dataOf(structured: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const data = structured['data']
  if (!isRecord(data)) throw new Error('data が Record ではありません')
  return data
}

/**
`--version` の確認呼び出しを除いた awscli 呼び出しの件数。
*/
function commandCallCount(instance: Readonly<FakeAws>): number {
  return instance.callLog().filter(call => call[0] !== '--version').length
}

describe('SSO の 2 段構成', () => {
  it('開始で URL とコードを返し、承認後の状態確認で completed になる', async () => {
    const instance = fakeAws.install({ exitWhenFile: true })
    await connect()

    const started = await call('aws_sso_login')
    expect(started).toMatchObject({ ok: true, exitCode: 0 })
    expect(dataOf(started)).toMatchObject({
      state: 'pending',
      profile: '',
      verificationUrl: 'https://example.awsapps.com/start/#/device',
      // コード入力を省ける URL。利用者へ案内する第一候補になる。
      verificationUrlComplete: 'https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    })
    expect(String(started['message'])).toContain('verificationUrlComplete')

    const pending = await call('aws_sso_login_status')
    expect(dataOf(pending)).toMatchObject({ state: 'pending' })
    // 状態確認は awscli を起こさない（契約書 §SSO 認証）。
    expect(commandCallCount(instance)).toBe(1)

    instance.release()
    await vi.waitFor(async () => {
      expect(dataOf(await call('aws_sso_login_status'))).toMatchObject({ state: 'completed' })
    }, { timeout: TRANSITION_TIMEOUT_MS })

    const completed = await call('aws_sso_login_status')
    expect(completed).toMatchObject({ ok: true, exitCode: 0 })
    expect(String(dataOf(completed)['output'])).toContain('Successfully logged into Start URL')
    expect(commandCallCount(instance)).toBe(1)
  })

  it('開始していない状態確認は invalid-input で awscli を起こさない', async () => {
    const instance = fakeAws.install()
    await connect()

    const structured = await call('aws_sso_login_status')

    expect(structured).toMatchObject({ ok: false, exitCode: 2, category: 'invalid-input' })
    expect(String(structured['message'])).toContain('aws_sso_login')
    expect(commandCallCount(instance)).toBe(0)
  })

  it('awscli が 2.22 未満なら開始せず awscli-missing を返す', async () => {
    // `--use-device-code` は 2.22 以降にしか無い。そのまま起動すると invalid-input に化けて
    // 打ち手（awscli の更新）が伝わらない。
    const instance = fakeAws.install({ version: 'aws-cli/2.15.0 Python/3.14.6 Linux/7.0.0' })
    await connect()

    const structured = await call('aws_sso_login')

    expect(structured).toMatchObject({ ok: false, exitCode: 127, category: 'awscli-missing' })
    expect(String(structured['message'])).toContain('2.22.0 以上')
    expect(commandCallCount(instance)).toBe(0)
  })

  it('SSO 設定の無い profile は auth-missing を返す', async () => {
    fakeAws.install({ fixture: 'sso-login.no-config' })
    await connect()

    const structured = await call('aws_sso_login', { profile: 'plain' })

    // exitCode は awscli の終了コードをそのまま返す（許可リストの呼び出しと同じ規約）。
    expect(structured).toMatchObject({ ok: false, exitCode: 253, category: 'auth-missing' })
    expect(String(structured['stderr'])).toContain('Missing the following required SSO configuration')
    expect(String(structured['message'])).toContain('aws configure sso')
  })

  it('失敗したフローの状態確認は同じ種別と出力を返す', async () => {
    // 開始が失敗した直後に状態を引きにいくケース。開始の応答を取りこぼしたエージェントが
    // ここで理由に辿り着けないと、原因不明のまま再試行を繰り返す。
    fakeAws.install({ fixture: 'sso-login.no-config' })
    await connect()

    await call('aws_sso_login', { profile: 'plain' })
    const structured = await call('aws_sso_login_status', { profile: 'plain' })

    expect(structured).toMatchObject({ ok: false, exitCode: 253, category: 'auth-missing' })
    expect(dataOf(structured)).toMatchObject({ state: 'failed' })
    expect(String(structured['stderr'])).toContain('Missing the following required SSO configuration')
  })

  it('時間切れの状態確認は 124 と再開始の案内を返す', async () => {
    fakeAws.install({ exitWhenFile: true })
    await connect({ timeoutMs: 1000 })

    expect(dataOf(await call('aws_sso_login'))).toMatchObject({ state: 'pending' })

    await vi.waitFor(async () => {
      expect(dataOf(await call('aws_sso_login_status'))).toMatchObject({ state: 'timed-out' })
    }, { timeout: TRANSITION_TIMEOUT_MS })

    const structured = await call('aws_sso_login_status')
    expect(structured).toMatchObject({ ok: false, exitCode: 124, category: 'timeout' })
    expect(String(structured['message'])).toContain('aws_sso_login を再度呼び出してください')
  })

  it('region と未知キーを渡しても拒否されず通常応答を返し、awscli の引数にも現れない', async () => {
    // SSO の 2 件は inputSchema に region を持たない（profile だけを公開）。z.object は
    // デフォルトで未知キーを strip する。そのため渡しても入力検証エラーにはならず、通常の失敗応答が返る。
    const instance = fakeAws.install({ fixture: 'sso-login.no-config' })
    await connect()

    const structured = await call('aws_sso_login', {
      profile: 'plain',
      region: 'ap-northeast-1',
      bogus: 'unexpected',
    })

    expect(structured).toMatchObject({ ok: false, exitCode: 253, category: 'auth-missing' })
    expect(instance.callLog().filter(call => call[0] !== '--version')).toEqual([
      ['sso', 'login', '--profile=plain', '--no-browser', '--use-device-code'],
    ])
  })

  it('失敗の直後も同じ接続が次の呼び出しに応える', async () => {
    // SC-008。失敗した呼び出しがサーバを畳んでしまうと、再認証の導線が途切れる。
    fakeAws.install({ fixture: 'sso-login.no-config' })
    await connect()

    expect(await call('aws_sso_login')).toMatchObject({ ok: false, category: 'auth-missing' })

    reinstall({ exitWhenFile: true })
    const retried = await call('aws_sso_login')

    expect(retried).toMatchObject({ ok: true, exitCode: 0 })
    expect(dataOf(retried)).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH' })
  })
})
