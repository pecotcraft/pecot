/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { CancelledError } from '@pecot/workflow-core/domain/errors.js'
import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { OsError } from '@pecot/workflow-core/infra/os-error.js'
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
  it('コマンドが成功した場合は、標準出力を結果に含める', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`echo hello` を実行した場合に、終了コード 0 と標準出力 `hello` を含む結果を返すことを確認します。')
    expect(await runSetupCommand('echo hello', makeTemporaryDirectory())).toEqual({ command: 'echo hello', exitCode: 0, stdout: 'hello\n', stderr: '' })
  })

  it('コマンドが失敗した場合でも、例外は発生せず、終了コードと標準エラー出力を結果に含める', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。標準エラー出力に `boom` を出力して終了コード 1 で終わるコマンドを実行した場合に、例外が発生せず、終了コードと `boom` を結果に含めることを確認します。')
    const result = await runSetupCommand('>&2 echo boom; exit 1', makeTemporaryDirectory())
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('boom')
  })

  it('指定した作業ディレクトリで、コマンドを実行する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`pwd` を実行した場合に、標準出力が指定した作業ディレクトリのパスになることを確認します。')
    const directory = makeTemporaryDirectory()
    const { stdout } = await runSetupCommand('pwd', directory)
    expect(stdout).toBe(`${directory}\n`)
  })

  it('時間制限を超えた場合は、終了コードを -1 にし、途中までの出力と時間切れのメッセージを結果に含める', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。制限時間の 1 秒を超えた場合に、終了コード `-1`・標準出力 `partial`・標準エラー出力 `timeout after 1 seconds` を返すことを確認します。')
    const result = await runSetupCommand('echo partial; sleep 5', makeTemporaryDirectory(), 1)
    expect(result).toEqual({ command: 'echo partial; sleep 5', exitCode: -1, stdout: 'partial\n', stderr: 'timeout after 1 seconds' })
  })

  it('標準入力は閉じているため、入力を待つコマンドでも止まらずに終了する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`read` で入力を待つコマンドを実行した場合に、時間切れにならず、2 秒未満で終了することを確認します。')
    const started = Date.now()
    const result = await runSetupCommand('read line; echo got=$line', makeTemporaryDirectory(), 3)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.exitCode).not.toBe(-1)
  })

  it('シグナルで終了した場合の終了コードは、シグナル番号に負の符号を付けた値にする', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`kill -9` で自身を終了させた場合に、終了コードが `-9` になることを確認します。')
    const { exitCode } = await runSetupCommand('kill -9 $$', makeTemporaryDirectory())
    expect(exitCode).toBe(-9)
  })

  it('出力の改行は、LF に統一する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。CRLF や CR を含む出力を得た場合に、改行を LF に統一した `a`・`b`・`c` の 3 行を返すことを確認します。')
    const { stdout } = await runSetupCommand('printf "a\\r\\nb\\rc"', makeTemporaryDirectory())
    expect(stdout).toBe('a\nb\nc')
  })

  it('作業ディレクトリが存在しない場合は、OsError を送出する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。存在しない作業ディレクトリを指定した場合に、`OsError` が発生することを確認します。')
    const missing = path.join(makeTemporaryDirectory(), 'missing')
    await expect(runSetupCommand('echo hi', missing)).rejects.toBeInstanceOf(OsError)
  })

  it('時間制限が 0 の場合は、すぐに時間切れにする（Python と同じ動作）', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。制限時間に 0 を指定した場合に、Node の既定のように無期限にはならず、終了コード `-1` と `timeout after 0 seconds` を返すことを確認します。')
    const result = await runSetupCommand('sleep 1; echo hi', makeTemporaryDirectory(), 0)
    expect(result).toEqual({ command: 'sleep 1; echo hi', exitCode: -1, stdout: '', stderr: 'timeout after 0 seconds' })
  })

  it('処理を取り消した場合は、シェルの下で動くコマンドごと停止し、CancelledError を送出する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`AbortController` で取り消した場合は、`CancelledError` が発生し、シェルが起動した `sleep` のプロセスも停止することを確認します。')
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
