/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CancelledError } from '../../domain/errors.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { OsError } from '../os-error.js'
import { runProcess } from '../process-run.js'

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
    expect(result).toMatchObject({ isTimedOut: true, signal: 'SIGKILL', stdout: 'started\n' })
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

  it('起動に失敗すると OsError を投げる', async () => {
    const missing = path.join(makeTemporaryDirectory('pecot-process-run-'), 'no-such-command')
    await expect(runProcess(missing, [])).rejects.toThrow(OsError)
    await expect(runProcess(missing, [])).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
