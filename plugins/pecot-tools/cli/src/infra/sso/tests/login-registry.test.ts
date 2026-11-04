// SSO ログインレジストリの単体テスト。偽 awscli を PATH の先頭へ置いて実プロセスで通す。
//
// PATH を stub するため it.concurrent は使わない。各ケースで shutdown しないと、
// 待機中の子が次のケースへ持ち越される。

/* eslint-disable security/detect-non-literal-fs-filename -- 扱うのは mkdtemp の戻り値のみ */

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { isTerminated } from '../../../../tests/_helpers/process.js'
import { type FakeAws, useFakeAws } from '../../../../tests/_helpers/fake-aws.js'
import {
  loginRegistry,
  shutdownLoginRegistry,
} from '../login-registry.js'
import { useLoginRegistry } from '../../../../tests/_helpers/login-registry.js'
import { useTemporaryDirectories } from '../../../../tests/_helpers/temporary-directory.js'

/**
状態遷移を待つ上限。子プロセスの close を待つだけなので短くてよい。
*/
const TRANSITION_TIMEOUT_MS = 5000

const fakeAws = useFakeAws()
const newRegistry = useLoginRegistry()
const makeFixtureDirectory = useTemporaryDirectories()

/**
待機中の子の PID を返す（start が resolve した時点の PID ファイルを読む）。
*/
function livePid(instance: Readonly<FakeAws>): number {
  const pid = instance.pid()
  if (pid === undefined) throw new Error('偽 awscli の PID が記録されていない')
  return pid
}

async function waitForTermination(pid: number): Promise<void> {
  await vi.waitFor(() => {
    expect(isTerminated(pid), `pid ${String(pid)} が生存している`).toBe(true)
  }, { timeout: TRANSITION_TIMEOUT_MS })
}

describe('createLoginRegistry', () => {
  it('URL とコードが揃った時点で pending を返し、子は生かしたままにする', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    const session = await registry.start()

    expect(session).toMatchObject({
      profile: '',
      state: 'pending',
      verificationUrl: 'https://example.awsapps.com/start/#/device',
      verificationUrlComplete: 'https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    })
    // 完了を待たずに応答するのが 2 段構成の趣旨。ここで子が死んでいると status が引けない。
    expect(isTerminated(livePid(fake))).toBe(false)
    expect(fake.callLog()).toEqual([['sso', 'login', '--no-browser', '--use-device-code']])
  })

  it('profile は --profile=<value> の 1 トークンで渡す', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    await registry.start('stg1-login')

    expect(fake.callLog()).toEqual([
      ['sso', 'login', '--profile=stg1-login', '--no-browser', '--use-device-code'],
    ])
  })

  it('pending の同一キーへの再 start は新規起動せず既存の値を返す', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    const first = await registry.start()
    const second = await registry.start()

    expect(second).toEqual(first)
    expect(fake.callLog()).toHaveLength(1)
  })

  it('確定前の同時 start でも子は 1 本しか起こさない', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    const [first, second] = await Promise.all([registry.start(), registry.start()])

    expect(second).toEqual(first)
    expect(fake.callLog()).toHaveLength(1)
  })

  it('認証が完了すると completed になり output には prompt と成功行の両方が残る', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    await registry.start()
    fake.release()

    await vi.waitFor(() => {
      expect(registry.get()?.state).toBe('completed')
    }, { timeout: TRANSITION_TIMEOUT_MS })
    const session = registry.get()
    // 確定後も読み続けているので、URL / コードと完了行が 1 本の output に揃う。
    expect(session?.output).toContain('ABCD-EFGH')
    expect(session?.output).toContain('Successfully logged into Start URL')
    expect(session?.verificationUrl).toBe('https://example.awsapps.com/start/#/device')
  })

  it('URL を出さずに exit 0 で終わったときは completed', async () => {
    // 2.36.40 で確認したところ、`--use-device-code` は毎回デバイスフローに入るため、この場面は未観測。
    // 防御として completed にする。R5 の「抽出できずに終了は failed」は、SSO 設定なし
    // = exit ≠ 0 を想定した記述。
    fakeAws.install({ fixture: 'sso-login.cached' })
    const registry = newRegistry()

    const session = await registry.start()

    expect(session.state).toBe('completed')
    expect(session.verificationUrl).toBeUndefined()
    expect(session.output).toContain('Successfully logged into Start URL')
  })

  it('SSO 設定の無い profile は failed + auth-missing', async () => {
    fakeAws.install({ fixture: 'sso-login.no-config' })
    const registry = newRegistry()

    const session = await registry.start('plain')

    expect(session.state).toBe('failed')
    expect(session.category).toBe('auth-missing')
    // awscli の終了コードをそのまま持つ（応答の exitCode の材料になる）。
    expect(session.exitCode).toBe(253)
    expect(session.output).toContain('Missing the following required SSO configuration values')
  })

  it('awscli が PATH に無いときは failed + awscli-missing', async () => {
    fakeAws.withoutAws()
    const registry = newRegistry()

    const session = await registry.start()

    expect(session.state).toBe('failed')
    expect(session.category).toBe('awscli-missing')
  })

  it('制限時間を過ぎると timed-out にして子を落とす', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry({ timeoutMs: 1000 })

    const session = await registry.start()
    expect(session.state).toBe('pending')
    const pid = livePid(fake)

    await vi.waitFor(() => {
      expect(registry.get()?.state).toBe('timed-out')
    }, { timeout: TRANSITION_TIMEOUT_MS })
    await waitForTermination(pid)
  })

  it('URL が出ないまま上限を過ぎたら failed(timeout) にして子を落とす', async () => {
    // 出力を持たない fixture 名で、URL / コードが永久に確定しない状態を作る。
    const fake = fakeAws.install({ fixture: 'sso-login.silent', hang: true })
    const registry = newRegistry({ promptTimeoutMs: 200 })

    const session = await registry.start()

    expect(session.state).toBe('failed')
    expect(session.category).toBe('timeout')
    await waitForTermination(livePid(fake))
  })

  it('終端状態のセッションは次の start で新しい子に置き換わる', async () => {
    const fake = fakeAws.install({ fixture: 'sso-login.no-config' })
    const registry = newRegistry()

    const first = await registry.start()
    const second = await registry.start()

    expect(first.state).toBe('failed')
    expect(second.state).toBe('failed')
    expect(second.startedAt).toBeGreaterThanOrEqual(first.startedAt)
    expect(fake.callLog()).toHaveLength(2)
  })

  it('autofill 行を出さないフローは pending でも verificationUrlComplete を持たない', async () => {
    // promptData（mcp/tools/sso.ts）は未確定のキーを data から落とす。
    // autofill 行は URL・コードより後の chunk で届くことがある。
    // そのため、揃う前の pending 応答にこのキーが無いのは正しい。
    const generatedFixtures = makeFixtureDirectory('pecot-tools-sso-no-autofill-')
    writeFileSync(
      path.join(generatedFixtures, 'sso-login.stdout'),
      'Browser will not be automatically opened.\n'
      + 'Please visit the following URL:\n\n'
      + 'https://example.awsapps.com/start/#/device\n\n'
      + 'Then enter the code:\n\n'
      + 'ABCD-EFGH\n',
    )
    fakeAws.install({ exitWhenFile: true, fixtureDir: generatedFixtures })
    const registry = newRegistry()

    const session = await registry.start()

    expect(session.state).toBe('pending')
    expect(session.verificationUrl).toBe('https://example.awsapps.com/start/#/device')
    expect(session.userCode).toBe('ABCD-EFGH')
    expect(session.verificationUrlComplete).toBeUndefined()
    expect('verificationUrlComplete' in session).toBe(false)
  })

  it('shutdown 後の start は spawn せず failed を返す', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    registry.shutdown()
    const session = await registry.start()

    expect(session.state).toBe('failed')
    expect(session.category).toBe('other')
    expect(fake.callLog()).toEqual([])
  })

  it('終端後は capture を手放し、確定した output を返し続ける', async () => {
    fakeAws.install({ fixture: 'sso-login.no-config' })
    const registry = newRegistry()

    await registry.start('plain')
    const first = registry.get('plain')?.output
    const second = registry.get('plain')?.output

    expect(first).toBe(second)
    expect(first).toContain('Missing the following required SSO configuration values')
  })

  it('profile が違えば別セッションとして並行に持つ', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    await Promise.all([registry.start('alpha'), registry.start('beta')])

    expect(fake.callLog()).toHaveLength(2)
    expect(registry.get('alpha')?.profile).toBe('alpha')
    expect(registry.get('beta')?.profile).toBe('beta')
    // 未指定は空文字キー。指定ありのセッションとは別物として扱う。
    expect(registry.get()).toBeUndefined()
  })

  it('output に資格情報らしき文字列を残さない', async () => {
    const generatedFixtures = makeFixtureDirectory('pecot-tools-sso-redact-')
    writeFileSync(
      path.join(generatedFixtures, 'sso-login.stderr'),
      'AKIAIOSFODNN7EXAMPLE aws_session_token=FwoGZXIvYXdzEExampleToken\n',
    )
    writeFileSync(path.join(generatedFixtures, 'sso-login.exit'), '255\n')
    fakeAws.install({ fixtureDir: generatedFixtures })
    const registry = newRegistry()

    const session = await registry.start()

    expect(session.state).toBe('failed')
    expect(session.output).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(session.output).not.toContain('FwoGZXIvYXdzEExampleToken')
    expect(session.output).toContain('[redacted]')
  })

  it('shutdown で生存中の子を全て落とし、以後 get は undefined', async () => {
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    // PID ファイルは最後に起動した子で上書きされるため、逐次 start して 1 件ずつ控える。
    await registry.start('alpha')
    const alphaPid = livePid(fake)
    await registry.start('beta')
    const betaPid = livePid(fake)

    registry.shutdown()

    await waitForTermination(alphaPid)
    await waitForTermination(betaPid)
    expect(registry.get('alpha')).toBeUndefined()
    expect(registry.get('beta')).toBeUndefined()
  })
})

describe('loginRegistry', () => {
  it('共有インスタンスは同一で、未開始でも shutdown は throw しない', () => {
    // ツールと終了配線が同じインスタンスを見ないと、開始したフローを status が引けない。
    expect(() => {
      shutdownLoginRegistry()
    }).not.toThrow()

    expect(loginRegistry()).toBe(loginRegistry())

    expect(() => {
      shutdownLoginRegistry()
    }).not.toThrow()
  })
})
