/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CancelledError } from '../../domain/errors.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { OsError } from '../os-error.js'
import { KILL_GRACE_MILLISECONDS, killRunningProcesses, runProcess } from '../process-run.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../tests/_helpers/step.js'

const leftovers: number[] = []

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {
      // 既に終わっている
    }
  }
})

function writeScript(body: string): string {
  const script = path.join(makeTemporaryDirectory('pecot-process-run-'), 'script.sh')
  writeFileSync(script, body)
  return script
}

async function readPid(file: string): Promise<number> {
  await expect.poll(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '', { timeout: 10_000, interval: 20 }).toBe(true)
  const pid = Number(readFileSync(file, 'utf8').trim())
  leftovers.push(pid)
  return pid
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

function groupOf(pid: number): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
}

describe('runProcess', () => {
  it('子プロセスが終了すると、終了コードと標準出力・標準エラーを返す', async () => {
    await explains('子プロセスを実行する `runProcess` のテストです。`exit 3` で終了するスクリプトの場合に、終了コード 3 と標準出力・標準エラーの内容を返し、時間切れではないことを確認します。')
    const script = stepSync('終了コード 3 で終わるスクリプトを置く', () => writeScript('echo out\necho err >&2\nexit 3\n'))
    const result = await step('スクリプトを実行する', async () => await runProcess('sh', [script]))
    await step('終了コードと出力を比べる', () => {
      expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', isTimedOut: false })
      expect(result.signal).toBeNull()
    })
  })

  it('時間切れになると、子を止めて isTimedOut が true の結果を返す', async () => {
    await explains('`runProcess` のテストです。`timeoutMilliseconds` を超えて実行が続く場合に、子プロセスを `SIGTERM` で停止し、`isTimedOut` が `true` の結果を返すことを確認します。')
    const script = stepSync('実行が続くスクリプトを置く', () => writeScript('echo started\nexec sleep 30\n'))
    const result = await step('時間切れを指定して実行する', async () => await runProcess('sh', [script], { timeoutMilliseconds: 300 }))
    await step('時間切れの結果を比べる', () => {
      expect(result).toMatchObject({ isTimedOut: true, signal: 'SIGTERM', stdout: 'started\n' })
    })
  })

  it('取り消すと、孫プロセスまでグループごと停止し、CancelledError を発生させる', async () => {
    await explains('`runProcess` のテストです。孫プロセスを持つ子の実行中に `AbortSignal` で取り消した場合は、孫プロセスも停止し、`CancelledError` が発生することを確認します。')
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = stepSync('孫プロセスを起こすスクリプトを置く', () => writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nwait\n`))
    const controller = new AbortController()
    const { running } = await step('スクリプトを実行し始める', () => ({ running: runProcess('sh', [script], { signal: controller.signal }) }))
    const pid = await step('孫プロセスの pid を読む', async () => await readPid(grandchildPid))
    await step('実行を取り消す', () => {
      controller.abort('stop')
    })
    await step('取り消しのエラーを確かめる', async () => {
      await expect(running).rejects.toThrow(new CancelledError('stop'))
    })
    await step('孫プロセスが止まったことを確かめる', async () => {
      await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
    })
  })

  it('取り消し済みの signal を指定すると、起動せずに CancelledError を発生させる', async () => {
    await explains('`runProcess` のテストです。取り消し済みの `AbortSignal` を指定した場合に、子プロセスを起動せず、`CancelledError` が発生することを確認します。')
    const marker = path.join(makeTemporaryDirectory('pecot-process-run-'), 'started')
    const script = stepSync('印を作るスクリプトを置く', () => writeScript(`touch '${marker}'\n`))
    const controller = new AbortController()
    stepSync('signal を取り消しておく', () => {
      controller.abort('already')
    })
    await step('取り消し済みの signal で実行する', async () => {
      await expect(runProcess('sh', [script], { signal: controller.signal })).rejects.toThrow(new CancelledError('already'))
    })
    stepSync('子プロセスが起動していないことを確かめる', () => {
      expect(existsSync(marker)).toBe(false)
    })
  })

  it('子プロセスを、呼び出し元とは別のプロセスグループで実行する', async () => {
    await explains('`runProcess` のテストです。子プロセスのプロセスグループ ID が、呼び出し元のプロセスと異なることを確認します。')
    const script = stepSync('グループ ID を出すスクリプトを置く', () => writeScript('ps -o pgid= -p $$\n'))
    const result = await step('スクリプトを実行する', async () => await runProcess('sh', [script]))
    stepSync('グループ ID を比べる', () => {
      expect(result.stdout.trim()).not.toBe(groupOf(process.pid))
    })
  })

  it('時間切れになると、孫プロセスまでグループごと停止する', async () => {
    await explains('`runProcess` のテストです。孫プロセスを持つ子が時間切れになった場合は、孫プロセスも同じグループとして停止することを確認します。')
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = stepSync('孫プロセスを起こすスクリプトを置く', () => writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nwait\n`))
    const result = await step('時間切れを指定して実行する', async () => await runProcess('sh', [script], { timeoutMilliseconds: 500 }))
    await step('時間切れになったことを確かめる', () => {
      expect(result.isTimedOut).toBe(true)
    })
    const pid = await step('孫プロセスの pid を読む', async () => await readPid(grandchildPid))
    await step('孫プロセスが止まったことを確かめる', async () => {
      await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
    })
  })
  it('孫プロセスがパイプを保持し続けても、時間切れの時刻に結果を返す', async () => {
    await explains('`runProcess` のテストです。孫プロセスが標準出力のパイプを保持したまま終了しない場合でも、時間切れの設定から 5 秒未満で `isTimedOut` が `true` の結果を返すことを確認します。')
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = stepSync('パイプを保持する孫プロセスを起こすスクリプトを置く', () => writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nexec sleep 30\n`))
    const started = Date.now()
    const result = await step('時間切れを指定して実行する', async () => await runProcess('sh', [script], { timeoutMilliseconds: 500 }))
    const elapsed = Date.now() - started
    await step('時間切れの結果と経過時間を比べる', () => {
      expect(result.isTimedOut).toBe(true)
      expect(elapsed).toBeLessThan(5000)
    })
    await step('孫プロセスの pid を読む', async () => await readPid(grandchildPid))
  })

  it('SIGTERM を無視する子プロセスは、猶予時間の後に SIGKILL で停止する', async () => {
    await explains('`runProcess` のテストです。`SIGTERM` を無視する子を取り消した場合は、猶予時間（`KILL_GRACE_MILLISECONDS`）を過ぎてから `SIGKILL` で停止することを確認します。')
    const childPid = path.join(makeTemporaryDirectory('pecot-process-run-'), 'child.pid')
    // 無視したシグナルは、exec した sleep にも引き継がれる
    const script = stepSync('SIGTERM を無視するスクリプトを置く', () => writeScript(`trap '' TERM\necho $$ > '${childPid}'\nexec sleep 30\n`))
    const controller = new AbortController()
    const { running } = await step('スクリプトを実行し始める', () => ({ running: runProcess('sh', [script], { signal: controller.signal }) }))
    const pid = await step('子プロセスの pid を読む', async () => await readPid(childPid))
    const started = Date.now()
    await step('実行を取り消す', () => {
      controller.abort('stop')
    })
    await step('取り消しのエラーを確かめる', async () => {
      await expect(running).rejects.toThrow(new CancelledError('stop'))
    })
    const elapsed = Date.now() - started
    await step('猶予時間の後に停止したことを確かめる', () => {
      expect(elapsed).toBeGreaterThanOrEqual(KILL_GRACE_MILLISECONDS - 100)
      expect(isAlive(pid)).toBe(false)
    })
  })

  it('SIGTERM を受けて後始末をする子プロセスは、後始末を終えてから停止する', async () => {
    await explains('`runProcess` のテストです。`SIGTERM` を受けて後始末をし、終了コード 143 で終了する子を取り消した場合に、後始末が完了してから `CancelledError` が発生することを確認します。')
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const cleaned = path.join(directory, 'cleaned')
    const childPid = path.join(directory, 'child.pid')
    const script = stepSync('後始末をするスクリプトを置く', () => writeScript(`trap 'touch "${cleaned}"; exit 143' TERM\necho $$ > '${childPid}'\nsleep 30 &\nwait\n`))
    const controller = new AbortController()
    const { running } = await step('スクリプトを実行し始める', () => ({ running: runProcess('sh', [script], { signal: controller.signal }) }))
    await step('子プロセスの pid を読む', async () => await readPid(childPid))
    await step('実行を取り消す', () => {
      controller.abort('stop')
    })
    await step('取り消しのエラーを確かめる', async () => {
      await expect(running).rejects.toThrow(new CancelledError('stop'))
    })
    stepSync('後始末が済んだことを確かめる', () => {
      expect(existsSync(cleaned)).toBe(true)
    })
  })

  it('呼び出し元が SIGHUP を受けると、子プロセスのグループへ SIGHUP を送信してから、自分にも再送する', async () => {
    await explains('`runProcess` のテストです。呼び出し元のプロセスが `SIGHUP` を受けた場合に、子のグループへ `SIGHUP` を送信し、自分自身にも `SIGHUP` を再送し、リスナーを残さないことを確認します。')
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const hungUp = path.join(directory, 'hung-up')
    const childPid = path.join(directory, 'child.pid')
    const script = stepSync('SIGHUP で印を作るスクリプトを置く', () => writeScript(`trap 'touch "${hungUp}"; exit 1' HUP\necho $$ > '${childPid}'\nsleep 30 &\nwait\n`))
    // eslint-disable-next-line unicorn/consistent-boolean-name -- process.kill は boolean を返す関数で、真偽の値ではない
    const kill = process.kill.bind(process)
    // 自分へ送り直すシグナルは記録だけにして、テストのプロセスを終わらせない
    const reraised: (number | string | undefined)[] = []
    // eslint-disable-next-line unicorn/consistent-boolean-name -- process.kill の spy で、真偽の値ではない
    const spied = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | string) => {
      if (pid !== process.pid) return kill(pid, signal)
      reraised.push(signal)
      return true
    })
    try {
      // 送り直しの後は決着しない（本物ならこのプロセスが終わる）
      stepSync('スクリプトを実行し始める', () => {
        void runProcess('sh', [script])
      })
      await step('子プロセスの pid を読む', async () => await readPid(childPid))
      stepSync('SIGHUP を送る', () => {
        process.emit('SIGHUP', 'SIGHUP')
      })
      await step('子プロセスが SIGHUP を受けたことを確かめる', async () => {
        await expect.poll(() => existsSync(hungUp), { timeout: 2000, interval: 20 }).toBe(true)
      })
      stepSync('再送とリスナーを確かめる', () => {
        expect(reraised).toStrictEqual(['SIGHUP'])
        expect(process.listenerCount('SIGHUP')).toBe(0)
      })
    }
    finally {
      spied.mockRestore()
    }
  })

  it('killRunningProcesses を呼ぶと、実行中の子プロセスのグループへ SIGTERM を送信する', async () => {
    await explains('実行中の子を停止する `killRunningProcesses` のテストです。孫プロセスを持つ子の実行中に呼び出した場合は、`SIGTERM` で停止した結果を返し、孫プロセスも停止することを確認します。')
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = stepSync('孫プロセスを起こすスクリプトを置く', () => writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nwait\n`))
    const { running } = await step('スクリプトを実行し始める', () => ({ running: runProcess('sh', [script]) }))
    const pid = await step('孫プロセスの pid を読む', async () => await readPid(grandchildPid))
    const result = await step('実行中の子プロセスを止めて結果を待つ', async () => {
      killRunningProcesses()
      return await running
    })
    await step('SIGTERM で止まった結果を比べる', () => {
      expect(result).toMatchObject({ signal: 'SIGTERM', isTimedOut: false })
    })
    await step('孫プロセスが止まったことを確かめる', async () => {
      await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
    })
  })

  it('終了コード 0 で終了した後、孫プロセスがパイプを保持している間に取り消されても、成功の結果を返す', async () => {
    await explains('`runProcess` のテストです。子が終了コード 0 で終了した後、孫プロセスがパイプを保持している間に取り消した場合は、`CancelledError` ではなく成功の結果を返すことを確認します。')
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = stepSync('孫プロセスを残して終わるスクリプトを置く', () => writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\necho done\nexit 0\n`))
    const controller = new AbortController()
    const { running } = await step('スクリプトを実行し始める', () => ({ running: runProcess('sh', [script], { signal: controller.signal }) }))
    await step('孫プロセスの pid を読む', async () => await readPid(grandchildPid))
    await step('子の終了を待ってから取り消す', async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 200)
      })
      controller.abort('late')
    })
    const result = await step('実行の結果を待つ', async () => await running)
    await step('成功の結果を比べる', () => {
      expect(result).toMatchObject({ exitCode: 0, isTimedOut: false, stdout: 'done\n' })
    })
  })

  it('0 以外の終了コードで終了した子は、孫プロセスのパイプが残ったまま時間切れになっても、その終了コードを返す', async () => {
    await explains('`runProcess` のテストです。子が終了コード 3 で終了した後、孫プロセスがパイプを保持している間に時間切れとなった場合は、`isTimedOut` が `false` で終了コード 3 の結果を返すことを確認します。')
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = stepSync('孫プロセスを残して終わるスクリプトを置く', () => writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nexit 3\n`))
    const result = await step('時間切れを指定して実行する', async () => await runProcess('sh', [script], { timeoutMilliseconds: 500 }))
    await step('終了コードを比べる', () => {
      expect(result).toMatchObject({ exitCode: 3, isTimedOut: false })
    })
    const pid = await step('孫プロセスの pid を読む', async () => await readPid(grandchildPid))
    await step('孫プロセスが止まったことを確かめる', async () => {
      await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
    })
  })

  it('起動に失敗すると、OsError を発生させる', async () => {
    await explains('`runProcess` のテストです。存在しないコマンドを指定した場合に、`code` が `ENOENT` の `OsError` が発生することを確認します。')
    const missing = path.join(makeTemporaryDirectory('pecot-process-run-'), 'no-such-command')
    await step('エラーの種類と code を確かめる', async () => {
      await expect(runProcess(missing, [])).rejects.toThrow(OsError)
      await expect(runProcess(missing, [])).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
