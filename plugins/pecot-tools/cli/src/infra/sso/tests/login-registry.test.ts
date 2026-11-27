// SSO ログインレジストリの単体テスト。偽 awscli を PATH の先頭へ置いて実プロセスで通す。
// PATH を stub するため it.concurrent は使わない。各ケースで shutdown する。

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
import { explains } from '../../../../tests/_helpers/explains.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'
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
  it('URL とコードが揃った時点で pending の状態を返し、awscli のプロセスは終了させない', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。偽の awscli が URL とコードを出力した場合は、状態が `pending` で URL とコードを含む結果を返し、プロセスは終了しないことを確認します。')
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

  it('profile を指定してログインを開始すると、--profile=値 の 1 つの引数で awscli に渡す', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。profile に `stg1-login` を指定した場合に、awscli へ `--profile=stg1-login` の 1 つの引数で渡されることを確認します。')
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    await registry.start('stg1-login')

    expect(fake.callLog()).toEqual([
      ['sso', 'login', '--profile=stg1-login', '--no-browser', '--use-device-code'],
    ])
  })

  it('同じ profile の pending のログインがあるときの再度の開始は、新しく起動せず、既存の結果を返す', async (context) => {
    await verifies(context, 'PT-AWS-SSO-LOGIN-02')
    await explains('SSO ログインの開始（`start`）のテストです。状態が `pending` の同じ profile で 2 回目に開始した場合は、1 回目と同じ結果を返し、awscli の起動回数が 1 回のままであることを確認します。')
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    const first = await registry.start()
    const second = await registry.start()

    expect(second).toEqual(first)
    expect(fake.callLog()).toHaveLength(1)
  })

  it('結果が確定する前に同時に開始しても、awscli のプロセスは 1 つだけ起動する', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。2 回の開始を同時に行った場合に、どちらも同じ結果を返し、awscli を起動する回数が 1 回であることを確認します。')
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    const [first, second] = await Promise.all([registry.start(), registry.start()])

    expect(second).toEqual(first)
    expect(fake.callLog()).toHaveLength(1)
  })

  it('認証が完了すると completed になり、output には案内の出力と成功の行の両方が残る', async () => {
    await explains('SSO ログインの状態遷移のテストです。認証の完了を偽の awscli へ伝えた場合は、状態が `completed` になり、`output` に認証コードと成功の行の両方が含まれることを確認します。')
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

  it('URL を出力せずに終了コード 0 で終了したときは、completed の状態にする', async (context) => {
    await verifies(context, 'PT-AWS-SSO-LOGIN-05')
    await explains('SSO ログインの開始（`start`）のテストです。認証済みで URL を出力せず終了コード 0 で終了した場合は、状態が `completed` で `verificationUrl` が未設定になり、`output` に成功の行が含まれることを確認します。')
    // `--use-device-code` は毎回デバイスフローに入るため未観測の場面。防御として completed にする。
    fakeAws.install({ fixture: 'sso-login.cached' })
    const registry = newRegistry()

    const session = await registry.start()

    expect(session.state).toBe('completed')
    expect(session.verificationUrl).toBeUndefined()
    expect(session.output).toContain('Successfully logged into Start URL')
  })

  it('SSO の設定がない profile でログインを開始すると、failed の状態で auth-missing を返す', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。SSO の設定がない profile を指定した場合に、状態が `failed`、種類が `auth-missing` で、終了コード `253` と設定不足のメッセージを返すことを確認します。')
    fakeAws.install({ fixture: 'sso-login.no-config' })
    const registry = newRegistry()

    const session = await registry.start('plain')

    expect(session.state).toBe('failed')
    expect(session.kind).toBe('auth-missing')
    // awscli の終了コードをそのまま持つ（応答の exitCode の材料になる）。
    expect(session.exitCode).toBe(253)
    expect(session.output).toContain('Missing the following required SSO configuration values')
  })

  it('awscli が見つからない場合の SSO ログイン開始は、failed の状態で awscli-missing を返す', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。PATH に awscli が存在しない場合は、状態が `failed` で、種類が `awscli-missing` の結果を返すことを確認します。')
    fakeAws.withoutAws()
    const registry = newRegistry()

    const session = await registry.start()

    expect(session.state).toBe('failed')
    expect(session.kind).toBe('awscli-missing')
  })

  it('ログインの制限時間を過ぎると、timed-out の状態にして awscli のプロセスを終了する', async () => {
    await explains('SSO ログインの状態の遷移のテストです。制限時間を 1 秒にして `pending` のまま待った場合に、状態が `timed-out` になり、awscli のプロセスが終了することを確認します。')
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

  it('URL が出力されないまま上限を過ぎたときは、種類が timeout の failed にして、awscli のプロセスを終了する', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。URL とコードを出力しないまま案内を待つ上限を過ぎた場合に、状態が `failed`、種類が `timeout` になり、awscli のプロセスが終了することを確認します。')
    // 出力を持たない fixture 名で、URL / コードが永久に確定しない状態を作る。
    const fake = fakeAws.install({ fixture: 'sso-login.silent', hang: true })
    const registry = newRegistry({ promptTimeoutMs: 200 })

    const session = await registry.start()

    expect(session.state).toBe('failed')
    expect(session.kind).toBe('timeout')
    await waitForTermination(livePid(fake))
  })

  it('ログインが終了した状態のセッションは、次の開始で新しいプロセスに置き換える', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。失敗で終了した後に再度開始した場合は、awscli を 2 回起動し、2 回目の開始時刻が 1 回目以降であることを確認します。')
    const fake = fakeAws.install({ fixture: 'sso-login.no-config' })
    const registry = newRegistry()

    const first = await registry.start()
    const second = await registry.start()

    expect(first.state).toBe('failed')
    expect(second.state).toBe('failed')
    expect(second.startedAt).toBeGreaterThanOrEqual(first.startedAt)
    expect(fake.callLog()).toHaveLength(2)
  })

  it('自動入力用の URL を出力しないログインは、pending の状態でも verificationUrlComplete を持たない', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。出力に自動入力用の URL の行がない場合は、状態が `pending` になり、`verificationUrlComplete` は含まれないことを確認します。')
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

  it('シャットダウン後にログインを開始すると、awscli を起動せず failed を返す', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。`shutdown` を呼んだ後で開始した場合は、状態が `failed`、種類が `other` になり、awscli は一度も起動されないことを確認します。')
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    registry.shutdown()
    const session = await registry.start()

    expect(session.state).toBe('failed')
    expect(session.kind).toBe('other')
    expect(fake.callLog()).toEqual([])
  })

  it('ログインが終了した後は、出力の取り込みを止め、確定した output を返し続ける', async () => {
    await explains('SSO ログインの状態の取得（`get`）のテストです。失敗で終了した後に `output` を 2 回取得した場合に、どちらも同じ内容で、設定の不足を示すメッセージを含むことを確認します。')
    fakeAws.install({ fixture: 'sso-login.no-config' })
    const registry = newRegistry()

    await registry.start('plain')
    const first = registry.get('plain')?.output
    const second = registry.get('plain')?.output

    expect(first).toBe(second)
    expect(first).toContain('Missing the following required SSO configuration values')
  })

  it('profile が異なるログインは、別のセッションとして並行して保持する', async () => {
    await explains('SSO ログインの開始（`start`）のテストです。`alpha` と `beta` の 2 つの profile で開始した場合は、awscli が 2 回起動され、それぞれの profile のセッションを取得できることを確認します。')
    const fake = fakeAws.install({ exitWhenFile: true })
    const registry = newRegistry()

    await Promise.all([registry.start('alpha'), registry.start('beta')])

    expect(fake.callLog()).toHaveLength(2)
    expect(registry.get('alpha')?.profile).toBe('alpha')
    expect(registry.get('beta')?.profile).toBe('beta')
    // 未指定は空文字キー。指定ありのセッションとは別物として扱う。
    expect(registry.get()).toBeUndefined()
  })

  it('output に、資格情報と判断できる文字列を残さない', async () => {
    await explains('SSO ログインの出力の取り扱いのテストです。stderr にアクセスキー ID と `aws_session_token` を含む出力があった場合に、`output` にそれらの値が含まれず、`[redacted]` に置き換わることを確認します。')
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

  it('シャットダウンすると、動作中の awscli のプロセスをすべて終了し、以後の get は undefined を返す', async () => {
    await explains('SSO ログインの終了処理（`shutdown`）のテストです。2 つの profile でログインを開始して `shutdown` を呼んだ場合に、2 つのプロセスがどちらも終了し、`get` が `undefined` を返すことを確認します。')
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
  it('共有のレジストリは常に同じインスタンスで、開始していなくてもシャットダウンで例外が発生しない', async () => {
    await explains('共有のレジストリ（`loginRegistry`）のテストです。`loginRegistry` を 2 回呼んだ結果が同じインスタンスであり、ログインを開始していなくても `shutdownLoginRegistry` が例外を発生させないことを確認します。')
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
