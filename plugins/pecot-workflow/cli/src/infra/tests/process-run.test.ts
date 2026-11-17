/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CancelledError } from '../../domain/errors.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { OsError } from '../os-error.js'
import { KILL_GRACE_MILLISECONDS, killRunningProcesses, runProcess } from '../process-run.js'

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
  it('終わったら、終了コードと標準出力・標準エラーを返す', async () => {
    const script = writeScript('echo out\necho err >&2\nexit 3\n')
    const result = await runProcess('sh', [script])
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', isTimedOut: false })
    expect(result.signal).toBeNull()
  })

  it('時間切れになると、子を止めて isTimedOut が true の結果を返す', async () => {
    const script = writeScript('echo started\nexec sleep 30\n')
    const result = await runProcess('sh', [script], { timeoutMilliseconds: 300 })
    expect(result).toMatchObject({ isTimedOut: true, signal: 'SIGTERM', stdout: 'started\n' })
  })

  it('取り消すと、孫までグループごと止めて CancelledError を投げる', async () => {
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nwait\n`)
    const controller = new AbortController()
    const running = runProcess('sh', [script], { signal: controller.signal })
    const pid = await readPid(grandchildPid)
    controller.abort('stop')
    await expect(running).rejects.toThrow(new CancelledError('stop'))
    await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
  })

  it('取り消し済みの signal を渡すと、起動せずに CancelledError を投げる', async () => {
    const marker = path.join(makeTemporaryDirectory('pecot-process-run-'), 'started')
    const script = writeScript(`touch '${marker}'\n`)
    const controller = new AbortController()
    controller.abort('already')
    await expect(runProcess('sh', [script], { signal: controller.signal })).rejects.toThrow(new CancelledError('already'))
    expect(existsSync(marker)).toBe(false)
  })

  it('子を、このプロセスとは別のプロセスグループで動かす', async () => {
    const script = writeScript('ps -o pgid= -p $$\n')
    const result = await runProcess('sh', [script])
    expect(result.stdout.trim()).not.toBe(groupOf(process.pid))
  })

  it('時間切れになると、孫までグループごと止める', async () => {
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nwait\n`)
    const result = await runProcess('sh', [script], { timeoutMilliseconds: 500 })
    expect(result.isTimedOut).toBe(true)
    const pid = await readPid(grandchildPid)
    await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
  })
  it('孫がパイプを握ったまま残っても、時間切れの時刻に返る', async () => {
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nexec sleep 30\n`)
    const started = Date.now()
    const result = await runProcess('sh', [script], { timeoutMilliseconds: 500 })
    expect(result.isTimedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    await readPid(grandchildPid)
  })

  it('SIGTERM を無視する子は、猶予の後に SIGKILL で止める', async () => {
    const childPid = path.join(makeTemporaryDirectory('pecot-process-run-'), 'child.pid')
    // 無視したシグナルは、exec した sleep にも引き継がれる
    const script = writeScript(`trap '' TERM\necho $$ > '${childPid}'\nexec sleep 30\n`)
    const controller = new AbortController()
    const running = runProcess('sh', [script], { signal: controller.signal })
    const pid = await readPid(childPid)
    const started = Date.now()
    controller.abort('stop')
    await expect(running).rejects.toThrow(new CancelledError('stop'))
    expect(Date.now() - started).toBeGreaterThanOrEqual(KILL_GRACE_MILLISECONDS - 100)
    expect(isAlive(pid)).toBe(false)
  })

  it('SIGTERM で片付けて 0 以外で終わる子は、片付けを終えてから止まる', async () => {
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const cleaned = path.join(directory, 'cleaned')
    const childPid = path.join(directory, 'child.pid')
    const script = writeScript(`trap 'touch "${cleaned}"; exit 143' TERM\necho $$ > '${childPid}'\nsleep 30 &\nwait\n`)
    const controller = new AbortController()
    const running = runProcess('sh', [script], { signal: controller.signal })
    await readPid(childPid)
    controller.abort('stop')
    await expect(running).rejects.toThrow(new CancelledError('stop'))
    expect(existsSync(cleaned)).toBe(true)
  })

  it('このプロセスが SIGHUP を受けると、子のグループへ SIGHUP を送ってから自分にも送り直す', async () => {
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const hungUp = path.join(directory, 'hung-up')
    const childPid = path.join(directory, 'child.pid')
    const script = writeScript(`trap 'touch "${hungUp}"; exit 1' HUP\necho $$ > '${childPid}'\nsleep 30 &\nwait\n`)
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
      void runProcess('sh', [script])
      await readPid(childPid)
      process.emit('SIGHUP', 'SIGHUP')
      await expect.poll(() => existsSync(hungUp), { timeout: 2000, interval: 20 }).toBe(true)
      expect(reraised).toStrictEqual(['SIGHUP'])
      expect(process.listenerCount('SIGHUP')).toBe(0)
    }
    finally {
      spied.mockRestore()
    }
  })

  it('killRunningProcesses は、動いている子のグループへ SIGTERM を送る', async () => {
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nwait\n`)
    const running = runProcess('sh', [script])
    const pid = await readPid(grandchildPid)
    killRunningProcesses()
    expect(await running).toMatchObject({ signal: 'SIGTERM', isTimedOut: false })
    await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
  })

  it('0 で終わった後、孫がパイプを握っている間に取り消されると、成功の結果を返す', async () => {
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\necho done\nexit 0\n`)
    const controller = new AbortController()
    const running = runProcess('sh', [script], { signal: controller.signal })
    await readPid(grandchildPid)
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
    controller.abort('late')
    expect(await running).toMatchObject({ exitCode: 0, isTimedOut: false, stdout: 'done\n' })
  })

  it('0 以外で終わった後、孫がパイプを握っている間の時間切れでは、子の終了コードを返す', async () => {
    const directory = makeTemporaryDirectory('pecot-process-run-')
    const grandchildPid = path.join(directory, 'grandchild.pid')
    const script = writeScript(`sleep 30 &\necho $! > '${grandchildPid}'\nexit 3\n`)
    const result = await runProcess('sh', [script], { timeoutMilliseconds: 500 })
    expect(result).toMatchObject({ exitCode: 3, isTimedOut: false })
    const pid = await readPid(grandchildPid)
    await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
  })

  it('起動に失敗すると OsError を投げる', async () => {
    const missing = path.join(makeTemporaryDirectory('pecot-process-run-'), 'no-such-command')
    await expect(runProcess(missing, [])).rejects.toThrow(OsError)
    await expect(runProcess(missing, [])).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
