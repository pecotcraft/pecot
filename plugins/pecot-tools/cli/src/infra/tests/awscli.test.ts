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
import { explains } from '../../../tests/_helpers/explains.js'

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
  it('正常に終了する awscli を実行すると、標準出力を返し、終了コード 0 で終わる', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。`sts get-caller-identity` を実行した場合に、終了コードが `0` で、時間切れや起動エラーがなく、フィクスチャの標準出力を返すことを確認します。')
    const fake = fakeAws.install()

    const result = await runAwscli(['sts', 'get-caller-identity'], { timeoutMs: 10_000 })

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.spawnErrorCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({ Account: '123456789012' })
    expect(fake.callLog()).toEqual([['sts', 'get-caller-identity']])
  })

  it('異常終了する awscli を実行すると、標準エラー出力と終了コード 254 をそのまま返す', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。`access-denied` のフィクスチャで実行した場合に、終了コードが `254`、標準エラー出力に `AccessDeniedException` が含まれ、標準出力が空であることを確認します。')
    fakeAws.install({ fixture: 'access-denied' })

    const result = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 10_000 })

    expect(result.exitCode).toBe(254)
    expect(result.stderr).toContain('AccessDeniedException')
    expect(result.stdout).toBe('')
  })

  it('時間切れになると、awscli のプロセスに SIGTERM を送り、プロセスを残さない', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。終了しない awscli を 500 ミリ秒の制限時間で実行した場合に、`timedOut` が真になり、起動したプロセスが回収されることを確認します。')
    const fake = fakeAws.install({ hang: true })

    const result = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 500 })

    expect(result.timedOut).toBe(true)
    const pid = fake.pid()
    expect(typeof pid).toBe('number')
    expect(typeof pid === 'number' && isReaped(pid)).toBe(true)
  })

  it('killRunningAwscli を呼ぶと、実行中の awscli のプロセスに SIGTERM を送る', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。実行中に、サーバの終了処理が使う `killRunningAwscli` を呼んだ場合は、プロセスが `SIGTERM` で終了し、回収されることを確認します。')
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

  it('終了した awscli のプロセスは、killRunningAwscli の対象から外れる', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。実行が完了した後に `killRunningAwscli` を呼んだ場合に、終了済みのプロセスへシグナルを送らず、例外が発生しないことを確認します。')
    fakeAws.install()

    await runAwscli(['sts', 'get-caller-identity'], { timeoutMs: 10_000 })

    // 生存集合から外れているので、既に消えた pid へシグナルが飛ばず例外にもならない。
    expect(() => {
      killRunningAwscli()
    }).not.toThrow()
  })

  it('実行中に abort すると、awscli のプロセスに SIGTERM を送り、timedOut は立てない', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。`AbortController` で実行を中断した場合に、`timedOut` が偽で、プロセスが `SIGTERM` で終了することを確認します。')
    fakeAws.install({ hang: true })
    const controller = new AbortController()

    const running = runAwscli(['lambda', 'list-functions'], { timeoutMs: 30_000, signal: controller.signal })
    controller.abort()
    const result = await running

    // timeout ではなくキャンセルなので timedOut は立たない。
    expect(result.timedOut).toBe(false)
    expectTerminated(result)
  })

  it('abort 済みの signal を渡して実行すると、すぐに SIGTERM を送る', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。最初から中断済みの `signal` を渡した場合に、`timedOut` が偽で、プロセスが `SIGTERM` で終了することを確認します。')
    fakeAws.install({ hang: true })

    const result = await runAwscli(['lambda', 'list-functions'], {
      timeoutMs: 30_000,
      signal: AbortSignal.abort(),
    })

    expect(result.timedOut).toBe(false)
    expectTerminated(result)
  })

  it('awscli が PATH に存在しないときは、ENOENT を spawnErrorCode に設定する', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。PATH に awscli が存在しない場合は、終了コードが `null`、`spawnErrorCode` が `ENOENT` となり、標準エラー出力にも `ENOENT` が含まれることを確認します。')
    fakeAws.withoutAws()

    const result = await runAwscli(['sts', 'get-caller-identity'], { timeoutMs: 10_000 })

    expect(result.exitCode).toBeNull()
    expect(result.spawnErrorCode).toBe('ENOENT')
    expect(result.stderr).toContain('ENOENT')
  })

  it('同じ名前のフィクスチャを 2 回目に使うと連番のフィクスチャを返し、以降は既定のフィクスチャに戻る', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。`sequence` のフィクスチャで 2 回実行した場合に、1 回目が `call` が `1` の出力、2 回目が `fallback` の出力になることを確認します。')
    fakeAws.install({ fixture: 'sequence' })

    const first = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 10_000 })
    const second = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 10_000 })

    expect(JSON.parse(first.stdout)).toEqual({ call: 1 })
    expect(JSON.parse(second.stdout)).toEqual({ call: 'fallback' })
  })

  it('フィクスチャが存在しないときは、標準出力を空にして終了コード 0 で返す', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。存在しないフィクスチャ名を指定した場合に、終了コードが `0` で、標準出力と標準エラー出力が空であることを確認します。')
    fakeAws.install({ fixture: 'no-such-fixture' })

    const result = await runAwscli(['lambda', 'list-functions'], { timeoutMs: 10_000 })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('連番のフィクスチャは、並行して呼び出しても、同じ連番を重複して配らない', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。5 件の連番のフィクスチャを用意し、5 回を並行して実行した場合に、`1` から `5` の出力が 1 回ずつ得られることを確認します。')
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

  it('標準出力の取り込みは、上限のバイト数で打ち切る', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、awscli を子プロセスとして実行する `runAwscli` を呼び出すテストです。上限より 4096 バイト大きい標準出力を出すフィクスチャを実行した場合に、結果の標準出力が `CAPTURE_LIMIT_BYTES` ちょうどになることを確認します。')
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
  ])('取り込んだ標準エラー出力 %j と追加の出力 %j は、%j に連結する', async (captured, extra, expected) => {
    await explains('標準エラー出力を連結する `mergeStderr` のテストです。取り込んだ出力と追加の出力がどちらも空の場合、片方だけの場合、両方ある場合で、空の側を除き、両方ある場合は改行で連結した文字列を返すことを確認します。')
    expect(mergeStderr(captured, extra)).toBe(expected)
  })
})

describe('ensureAwscli', () => {
  it('版が要件を満たすときは ok を返し、--version は 1 回だけ実行する', async () => {
    await explains('awscli の版を確認する `ensureAwscli` のテストです。版が要件を満たす awscli で 2 回確認した場合に、どちらも `ok` が真で版が `2.36.40` の同じ結果を返し、`--version` の実行が 1 回だけであることを確認します。')
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
  ])('版の出力 %s は、要件を満たすと判定する', async (version, expected) => {
    await explains('awscli の版を確認する `ensureAwscli` のテストです。`aws-cli/3.0.0` と `aws-cli/2.22.0` のように要件の版以上の出力を返す場合に、`ok` が真で、版の番号を取り出して返すことを確認します。')
    fakeAws.install({ version })

    expect(await ensureAwscli()).toEqual({ ok: true, version: expected })
  })

  it('版が 2.22 未満のときは、awscli-missing と判定する', async () => {
    await explains('awscli の版を確認する `ensureAwscli` のテストです。`aws-cli/2.21.0` を返す awscli を確認した場合に、`ok` が偽で種類が `awscli-missing`、メッセージに `2.21.0` が含まれることを確認します。')
    fakeAws.install({ version: 'aws-cli/2.21.0 Python/3.12.6 Linux/6.1 exe/x86_64' })

    const probe = await ensureAwscli()

    expect(probe).toMatchObject({ ok: false, kind: 'awscli-missing' })
    expect(probe.ok ? '' : probe.message).toContain('2.21.0')
  })

  it('版を判定できない出力のときは、awscli-missing と判定する', async () => {
    await explains('awscli の版を確認する `ensureAwscli` のテストです。版を含まない出力を返す awscli を用意した場合は、`ok` が偽で種類が `awscli-missing` となり、メッセージに版を判定できない旨が含まれることを確認します。')
    fakeAws.install({ version: 'unexpected version banner' })

    const probe = await ensureAwscli()

    expect(probe).toMatchObject({ ok: false, kind: 'awscli-missing' })
    expect(probe.ok ? '' : probe.message).toContain('Could not determine the awscli version')
  })

  it('awscli が PATH に存在しないときは、導入を促すメッセージを返す', async () => {
    await explains('awscli の版を確認する `ensureAwscli` のテストです。PATH に awscli が存在しない場合は、`ok` が偽で種類が `awscli-missing` となり、メッセージに `awscli not found` が含まれることを確認します。')
    fakeAws.withoutAws()

    const probe = await ensureAwscli()

    expect(probe).toMatchObject({ ok: false, kind: 'awscli-missing' })
    expect(probe.ok ? '' : probe.message).toContain('awscli not found')
  })

  it('失敗した判定は保存せず、次の呼び出しで再度判定する', async () => {
    await explains('awscli の版を確認する `ensureAwscli` のテストです。要件を満たさない版で失敗した後に、要件を満たす版 `2.27.0` へ入れ替えて再度確認した場合に、2 回目は `ok` が真になり、`--version` が 2 回実行されることを確認します。')
    // 失敗を memo すると、利用者が awscli を導入してもサーバ再起動まで awscli-missing が続く。
    const fake = fakeAws.install({ version: 'aws-cli/2.21.0 Python/3.12.6 Linux/6.1 exe/x86_64' })

    expect(await ensureAwscli()).toMatchObject({ ok: false, kind: 'awscli-missing' })

    // PATH 上の awscli が要件を満たす版に入れ替わった状況。
    vi.stubEnv('FAKE_AWS_VERSION', 'aws-cli/2.27.0 Python/3.12.6 Linux/6.1 exe/x86_64')

    expect(await ensureAwscli()).toEqual({ ok: true, version: '2.27.0' })
    expect(fake.callLog()).toEqual([['--version'], ['--version']])
  })

  it('resetAwscliProbe を呼んだ後は、再度 --version を実行する', async () => {
    await explains('awscli の版を確認する `ensureAwscli` のテストです。1 回確認した後に `resetAwscliProbe` を呼んでからもう一度確認した場合に、`--version` が 2 回実行されることを確認します。')
    const fake = fakeAws.install()

    await ensureAwscli()
    resetAwscliProbe()
    await ensureAwscli()

    expect(fake.callLog()).toEqual([['--version'], ['--version']])
  })
})
