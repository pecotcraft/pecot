import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { OsError } from '../os-error.js'
import { runSetupCommand } from '../worktree-setup.js'

useIsolatedEnvironment()

function thrownError(action: () => void): unknown {
  try {
    action()
  }
  catch (error: unknown) {
    return error
  }
  return new Error('例外が投げられなかった')
}

describe('runSetupCommand', () => {
  it('成功すると stdout が載る', () => {
    expect(runSetupCommand('echo hello', makeTemporaryDirectory())).toEqual({ command: 'echo hello', exitCode: 0, stdout: 'hello\n', stderr: '' })
  })

  it('失敗しても例外にせず、終了コードと stderr が載る', () => {
    const result = runSetupCommand('>&2 echo boom; exit 1', makeTemporaryDirectory())
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('boom')
  })

  it('cwd が shell のカレントになる', () => {
    const directory = makeTemporaryDirectory()
    expect(runSetupCommand('pwd', directory).stdout).toBe(`${directory}\n`)
  })

  it('timeout を超えたら exitCode -1。途中までの出力と timeout の文が載る', () => {
    const result = runSetupCommand('echo partial; sleep 5', makeTemporaryDirectory(), 1)
    expect(result).toEqual({ command: 'echo partial; sleep 5', exitCode: -1, stdout: 'partial\n', stderr: 'timeout after 1 seconds' })
  })

  it('stdin は閉じているので、対話プロンプトでも stall せず即 EOF になる', () => {
    const started = Date.now()
    const result = runSetupCommand('read line; echo got=$line', makeTemporaryDirectory(), 3)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.exitCode).not.toBe(-1)
  })

  it('シグナルで終わったときの終了コードは -(シグナル番号)', () => {
    expect(runSetupCommand('kill -9 $$', makeTemporaryDirectory()).exitCode).toBe(-9)
  })

  it('改行は \\n に揃える', () => {
    expect(runSetupCommand('printf "a\\r\\nb\\rc"', makeTemporaryDirectory()).stdout).toBe('a\nb\nc')
  })

  it('cwd が無ければ OsError', () => {
    expect(thrownError(() => runSetupCommand('echo hi', path.join(makeTemporaryDirectory(), 'missing')))).toBeInstanceOf(OsError)
  })

  it('timeout が 0 ならすぐ時間切れになる（Python と同じ。Node の 0 は無期限だが、そうしない）', () => {
    const result = runSetupCommand('sleep 1; echo hi', makeTemporaryDirectory(), 0)
    expect(result).toEqual({ command: 'sleep 1; echo hi', exitCode: -1, stdout: '', stderr: 'timeout after 0 seconds' })
  })
})
