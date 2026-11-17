/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { CancelledError } from '../../domain/errors.js'
import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { OsError } from '../os-error.js'
import { runSetupCommand } from '../worktree-setup.js'

useIsolatedEnvironment()

// 止めた子は、reap されないゾンビとして残ることがあるので、Z も終わったとみなす
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  }
  catch {
    return false
  }
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
}

describe('runSetupCommand', () => {
  it('成功すると stdout が載る', async () => {
    expect(await runSetupCommand('echo hello', makeTemporaryDirectory())).toEqual({ command: 'echo hello', exitCode: 0, stdout: 'hello\n', stderr: '' })
  })

  it('失敗しても例外にせず、終了コードと stderr が載る', async () => {
    const result = await runSetupCommand('>&2 echo boom; exit 1', makeTemporaryDirectory())
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('boom')
  })

  it('cwd が shell のカレントになる', async () => {
    const directory = makeTemporaryDirectory()
    const { stdout } = await runSetupCommand('pwd', directory)
    expect(stdout).toBe(`${directory}\n`)
  })

  it('timeout を超えたら exitCode -1。途中までの出力と timeout の文が載る', async () => {
    const result = await runSetupCommand('echo partial; sleep 5', makeTemporaryDirectory(), 1)
    expect(result).toEqual({ command: 'echo partial; sleep 5', exitCode: -1, stdout: 'partial\n', stderr: 'timeout after 1 seconds' })
  })

  it('stdin は閉じているので、対話プロンプトでも stall せず即 EOF になる', async () => {
    const started = Date.now()
    const result = await runSetupCommand('read line; echo got=$line', makeTemporaryDirectory(), 3)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.exitCode).not.toBe(-1)
  })

  it('シグナルで終わったときの終了コードは -(シグナル番号)', async () => {
    const { exitCode } = await runSetupCommand('kill -9 $$', makeTemporaryDirectory())
    expect(exitCode).toBe(-9)
  })

  it('改行は \\n に揃える', async () => {
    const { stdout } = await runSetupCommand('printf "a\\r\\nb\\rc"', makeTemporaryDirectory())
    expect(stdout).toBe('a\nb\nc')
  })

  it('cwd が無ければ OsError', async () => {
    const missing = path.join(makeTemporaryDirectory(), 'missing')
    await expect(runSetupCommand('echo hi', missing)).rejects.toBeInstanceOf(OsError)
  })

  it('timeout が 0 ならすぐ時間切れになる（Python と同じ。Node の 0 は無期限だが、そうしない）', async () => {
    const result = await runSetupCommand('sleep 1; echo hi', makeTemporaryDirectory(), 0)
    expect(result).toEqual({ command: 'sleep 1; echo hi', exitCode: -1, stdout: '', stderr: 'timeout after 0 seconds' })
  })

  it('取り消すと、シェルの下で動くコマンドごと止めて CancelledError を投げる', async () => {
    const directory = makeTemporaryDirectory()
    const pidFile = path.join(directory, 'sleep.pid')
    const controller = new AbortController()
    const running = runSetupCommand('sleep 30 & echo $! > sleep.pid; wait', directory, undefined, controller.signal)
    await vi.waitFor(() => {
      expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '').toBe(true)
    })
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    controller.abort('stopped by test')
    await expect(running).rejects.toThrow(new CancelledError('stopped by test'))
    await vi.waitFor(() => {
      expect(isAlive(pid)).toBe(false)
    }, { timeout: 2000 })
  })
})
