// 偽 awscli（tests/_fixtures/fake-aws/aws）を PATH 先頭へ差し込む。
// 子プロセス実行の 4 パターン（正常終了 / 異常終了 / 時間切れ / 未導入）と版確認の memo を検証する。
//
// PATH を stub するため it.concurrent は使わない。ensureAwscli は module-level に memo を
// 持つので、各ケースの前に resetAwscliProbe() で捨てる。

/* eslint-disable security/detect-non-literal-fs-filename -- 扱うのは mkdtemp の戻り値だけ */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CAPTURE_LIMIT_BYTES, ensureAwscli, killRunningAwscli, mergeStderr, resetAwscliProbe, runAwscli } from '../awscli.js'
import { useFakeAws } from '../../../tests/_helpers/fake-aws.js'
import { isReaped } from '../../../tests/_helpers/process.js'
import { compareStrings } from '../../../tests/_helpers/compare-strings.js'

/**
テストが生成する fixture の置き場。使い終わったら消す。
*/
async function withFixtureDirectory(use: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecot-tools-fixture-'))
  try {
    await use(directory)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const fakeAws = useFakeAws()

beforeEach(() => {
  resetAwscliProbe()
})

/**
SIGTERM で子が終わったことの判定。

偽 awscli（fake-aws/aws）は SIGTERM を trap して孫（sleep infinity）を先に落とし、
trap を外してから自分へ SIGTERM を撃ち直す（再送出）。既定動作に戻した状態でシグナルを
受けて死ぬため、trap 設置前に届いた場合（既定動作のまま）も含めて常に signal 側に出る
（exit 143 で抜ける場合は無い）。
*/
function expectTerminated(result: Readonly<{ signal: NodeJS.Signals | null, exitCode: number | null }>): void {
  expect(result.signal).toBe('SIGTERM')
}

describe('runAwscli', () => {
  it('fixture の stdout を返して exit 0 で終わる', async () => {
    const fake = fakeAws.install()

    const result = await runAwscli(['sts', 'get-caller-identity'], { timeoutMs: 10_000 })

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.spawnErrorCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({ Account: '123456789012' })
    expect(fake.callLog()).toEqual([['sts', 'get-caller-identity']])
  })

  it('fixture の stderr と exit 254 をそのまま返す', async () => {
    fakeAws.install({ fixture: 'access-denied' })

    const result = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 10_000 })

    expect(result.exitCode).toBe(254)
    expect(result.stderr).toContain('AccessDeniedException')
    expect(result.stdout).toBe('')
  })

  it('timeout で SIGTERM を送り、子プロセスを残さない', async () => {
    const fake = fakeAws.install({ hang: true })

    const result = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 500 })

    expect(result.timedOut).toBe(true)
    const pid = fake.pid()
    expect(typeof pid).toBe('number')
    expect(typeof pid === 'number' && isReaped(pid)).toBe(true)
  })

  it('killRunningAwscli が実行中の子プロセスへ SIGTERM を送る', async () => {
    // サーバの終了処理（mcp/serve.ts の onShutdown）が使う。ここが働かないと、親が消えた後の
    // 子が PPID 1 へ再親付けされ、timeout を張っていた親ごと打ち切りが失われる。
    const instance = fakeAws.install({ hang: true })

    const running = runAwscli(['lambda', 'list-functions'], { timeoutMs: 30_000 })
    await vi.waitFor(() => {
      expect(typeof instance.pid()).toBe('number')
    })

    killRunningAwscli()
    const result = await running

    expectTerminated(result)
    const pid = instance.pid()
    expect(typeof pid === 'number' && isReaped(pid)).toBe(true)
  })

  it('終了した子プロセスは killRunningAwscli の対象から外れる', async () => {
    fakeAws.install()

    await runAwscli(['sts', 'get-caller-identity'], { timeoutMs: 10_000 })

    // 生存集合から外れているので、既に消えた pid へシグナルが飛ばず例外にもならない。
    expect(() => {
      killRunningAwscli()
    }).not.toThrow()
  })

  it('abort で SIGTERM を送る', async () => {
    fakeAws.install({ hang: true })
    const controller = new AbortController()

    const running = runAwscli(['lambda', 'list-functions'], { timeoutMs: 30_000, signal: controller.signal })
    controller.abort()
    const result = await running

    // timeout ではなくキャンセルなので timedOut は立たない。
    expect(result.timedOut).toBe(false)
    expectTerminated(result)
  })

  it('abort 済みの signal を渡しても即座に SIGTERM を送る', async () => {
    fakeAws.install({ hang: true })

    const result = await runAwscli(['lambda', 'list-functions'], {
      timeoutMs: 30_000,
      signal: AbortSignal.abort(),
    })

    expect(result.timedOut).toBe(false)
    expectTerminated(result)
  })

  it('awscli が PATH に無ければ ENOENT を spawnErrorCode に載せる', async () => {
    fakeAws.withoutAws()

    const result = await runAwscli(['sts', 'get-caller-identity'], { timeoutMs: 10_000 })

    expect(result.exitCode).toBeNull()
    expect(result.spawnErrorCode).toBe('ENOENT')
    expect(result.stderr).toContain('ENOENT')
  })

  it('同名 fixture の 2 回目は連番 fixture を使い、以降は既定へ戻る', async () => {
    fakeAws.install({ fixture: 'sequence' })

    const first = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 10_000 })
    const second = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 10_000 })

    expect(JSON.parse(first.stdout)).toEqual({ call: 1 })
    expect(JSON.parse(second.stdout)).toEqual({ call: 'fallback' })
  })

  it('fixture が無ければ stdout 空・exit 0 で返す', async () => {
    fakeAws.install({ fixture: 'no-such-fixture' })

    const result = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 10_000 })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('連番は並行呼び出しでも重複しない', async () => {
    // 連番の read-modify-write が非アトミックだと、同じ連番が複数プロセスへ配られる。
    await withFixtureDirectory(async (directory) => {
      for (const index of [1, 2, 3, 4, 5]) {
        writeFileSync(path.join(directory, `concurrent.${String(index)}.stdout`), `{"call":${String(index)}}\n`)
      }
      fakeAws.install({ fixture: 'concurrent', fixtureDir: directory })

      const results = await Promise.all(Array.from({ length: 5 }, async () =>
        runAwscli(['lambda', 'list-functions'], { timeoutMs: 30_000 })))

      expect(results.map(result => result.stdout.trim()).toSorted(compareStrings)).toEqual([
        '{"call":1}', '{"call":2}', '{"call":3}', '{"call":4}', '{"call":5}',
      ])
    })
  }, 30_000)

  it('捕捉は上限で打ち切る', async () => {
    // filter-log-events の数 MiB 出力を全件溜めると常駐メモリに直結する。
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'huge.stdout'), 'x'.repeat(CAPTURE_LIMIT_BYTES + 4096))
      fakeAws.install({ fixture: 'huge', fixtureDir: directory })

      const result = await runAwscli(['logs', 'filter-log-events'], { timeoutMs: 30_000 })

      expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(CAPTURE_LIMIT_BYTES)
    })
  }, 30_000)
})

describe('mergeStderr', () => {
  it.each([
    ['', '', ''],
    ['captured', '', 'captured'],
    ['', 'extra', 'extra'],
    ['captured', 'extra', 'captured\nextra'],
  ])('captured %j と extra %j を %j に束ねる', (captured, extra, expected) => {
    expect(mergeStderr(captured, extra)).toBe(expected)
  })
})

describe('ensureAwscli', () => {
  it('版が要件を満たせば ok を返し、--version は 1 回しか呼ばない', async () => {
    const fake = fakeAws.install()

    const first = await ensureAwscli()
    const second = await ensureAwscli()

    // 偽 awscli の既定 --version は実 awscli 2.36.40 の 1 行をそのまま出す。
    expect(first).toEqual({ ok: true, version: '2.36.40' })
    expect(second).toBe(first)
    expect(fake.callLog()).toEqual([['--version']])
  })

  it.each([
    ['aws-cli/3.0.0 Python/3.12.6 Linux/6.1 exe/x86_64', '3.0.0'],
    ['aws-cli/2.22.0 Python/3.12.6 Linux/6.1 exe/x86_64', '2.22.0'],
  ])('%s は要件を満たす', async (version, expected) => {
    fakeAws.install({ version })

    expect(await ensureAwscli()).toEqual({ ok: true, version: expected })
  })

  it('2.22 未満は awscli-missing にする', async () => {
    fakeAws.install({ version: 'aws-cli/2.21.0 Python/3.12.6 Linux/6.1 exe/x86_64' })

    const probe = await ensureAwscli()

    expect(probe).toMatchObject({ ok: false, kind: 'awscli-missing' })
    expect(probe.ok ? '' : probe.message).toContain('2.21.0')
  })

  it('版を判定できない出力は awscli-missing にする', async () => {
    fakeAws.install({ version: 'unexpected version banner' })

    const probe = await ensureAwscli()

    expect(probe).toMatchObject({ ok: false, kind: 'awscli-missing' })
    expect(probe.ok ? '' : probe.message).toContain('Could not determine the awscli version')
  })

  it('awscli が PATH に無ければ導入を促す message を返す', async () => {
    fakeAws.withoutAws()

    const probe = await ensureAwscli()

    expect(probe).toMatchObject({ ok: false, kind: 'awscli-missing' })
    expect(probe.ok ? '' : probe.message).toContain('awscli not found')
  })

  it('失敗した判定は memo せず、次の呼び出しで再判定する', async () => {
    // 失敗を memo すると、利用者が awscli を導入してもサーバ再起動まで awscli-missing が続く。
    const fake = fakeAws.install({ version: 'aws-cli/2.21.0 Python/3.12.6 Linux/6.1 exe/x86_64' })

    expect(await ensureAwscli()).toMatchObject({ ok: false, kind: 'awscli-missing' })

    // PATH 上の awscli が要件を満たす版に入れ替わった状況。
    vi.stubEnv('FAKE_AWS_VERSION', 'aws-cli/2.27.0 Python/3.12.6 Linux/6.1 exe/x86_64')

    expect(await ensureAwscli()).toEqual({ ok: true, version: '2.27.0' })
    expect(fake.callLog()).toEqual([['--version'], ['--version']])
  })

  it('resetAwscliProbe の後は再度 --version を呼ぶ', async () => {
    const fake = fakeAws.install()

    await ensureAwscli()
    resetAwscliProbe()
    await ensureAwscli()

    expect(fake.callLog()).toEqual([['--version'], ['--version']])
  })
})
