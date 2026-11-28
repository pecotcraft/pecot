/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../tests/_helpers/step.js'

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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error: unknown) {
    return error
  }
  return new Error('例外が投げられなかった')
}

describe('runSetupCommand', () => {
  it('コマンドが成功した場合は、標準出力を結果に含める', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`echo hello` を実行した場合に、終了コード 0 と標準出力 `hello` を含む結果を返すことを確認します。')
    const directory = makeTemporaryDirectory()
    const result = await step('コマンドを実行する', () => runSetupCommand('echo hello', directory))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ command: 'echo hello', exitCode: 0, stdout: 'hello\n', stderr: '' })
    })
  })

  it('コマンドが失敗した場合でも、例外は発生せず、終了コードと標準エラー出力を結果に含める', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。標準エラー出力に `boom` を出力して終了コード 1 で終わるコマンドを実行した場合に、例外が発生せず、終了コードと `boom` を結果に含めることを確認します。')
    const directory = makeTemporaryDirectory()
    const result = await step('失敗するコマンドを実行する', () => runSetupCommand('>&2 echo boom; exit 1', directory))
    stepSync('終了コードと標準エラー出力を比べる', () => {
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('boom')
    })
  })

  it('指定した作業ディレクトリで、コマンドを実行する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`pwd` を実行した場合に、標準出力が指定した作業ディレクトリのパスになることを確認します。')
    const directory = makeTemporaryDirectory()
    const { stdout } = await step('pwd を実行する', () => runSetupCommand('pwd', directory))
    stepSync('標準出力を比べる', () => {
      expect(stdout).toBe(`${directory}\n`)
    })
  })

  it('時間制限を超えた場合は、終了コードを -1 にし、途中までの出力と時間切れのメッセージを結果に含める', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。制限時間の 1 秒を超えた場合に、終了コード `-1`・標準出力 `partial`・標準エラー出力 `timeout after 1 seconds` を返すことを確認します。')
    const directory = makeTemporaryDirectory()
    const result = await step('制限時間を超えるコマンドを実行する', () => runSetupCommand('echo partial; sleep 5', directory, 1))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ command: 'echo partial; sleep 5', exitCode: -1, stdout: 'partial\n', stderr: 'timeout after 1 seconds' })
    })
  })

  it('標準入力は閉じているため、入力を待つコマンドでも止まらずに終了する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`read` で入力を待つコマンドを実行した場合に、時間切れにならず、2 秒未満で終了することを確認します。')
    const directory = makeTemporaryDirectory()
    const started = Date.now()
    const result = await step('入力を待つコマンドを実行する', () => runSetupCommand('read line; echo got=$line', directory, 3))
    const elapsed = Date.now() - started
    stepSync('所要時間と終了コードを比べる', () => {
      expect(elapsed).toBeLessThan(2000)
      expect(result.exitCode).not.toBe(-1)
    })
  })

  it('シグナルで終了した場合の終了コードは、シグナル番号に負の符号を付けた値にする', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`kill -9` で自身を終了させた場合に、終了コードが `-9` になることを確認します。')
    const directory = makeTemporaryDirectory()
    const { exitCode } = await step('自身を kill するコマンドを実行する', () => runSetupCommand('kill -9 $$', directory))
    stepSync('終了コードを比べる', () => {
      expect(exitCode).toBe(-9)
    })
  })

  it('出力の改行は、LF に統一する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。CRLF や CR を含む出力を得た場合に、改行を LF に統一した `a`・`b`・`c` の 3 行を返すことを確認します。')
    const directory = makeTemporaryDirectory()
    const { stdout } = await step('CRLF と CR を出力するコマンドを実行する', () => runSetupCommand('printf "a\\r\\nb\\rc"', directory))
    stepSync('標準出力を比べる', () => {
      expect(stdout).toBe('a\nb\nc')
    })
  })

  it('作業ディレクトリが存在しない場合は、OsError を送出する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。存在しない作業ディレクトリを指定した場合に、`OsError` が発生することを確認します。')
    const missing = path.join(makeTemporaryDirectory(), 'missing')
    const failure = await step('存在しない作業ディレクトリで実行する', async () => {
      try {
        await runSetupCommand('echo hi', missing)
      }
      catch (error: unknown) {
        return error
      }
      return new Error('例外が投げられなかった')
    })
    stepSync('例外を比べる', () => {
      expect(failure).toBeInstanceOf(OsError)
    })
  })

  it('時間制限が 0 の場合は、すぐに時間切れにする（Python と同じ動作）', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。制限時間に 0 を指定した場合に、Node の既定のように無期限にはならず、終了コード `-1` と `timeout after 0 seconds` を返すことを確認します。')
    const directory = makeTemporaryDirectory()
    const result = await step('制限時間 0 でコマンドを実行する', () => runSetupCommand('sleep 1; echo hi', directory, 0))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ command: 'sleep 1; echo hi', exitCode: -1, stdout: '', stderr: 'timeout after 0 seconds' })
    })
  })

  it('処理を取り消した場合は、シェルの下で動くコマンドごと停止し、CancelledError を送出する', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。`AbortController` で取り消した場合は、`CancelledError` が発生し、シェルが起動した `sleep` のプロセスも停止することを確認します。')
    const directory = makeTemporaryDirectory()
    const pidFile = path.join(directory, 'sleep.pid')
    const controller = new AbortController()
    const { running } = await step('コマンドを起動し、子の pid が書かれるのを待つ', async () => {
      const started = runSetupCommand('sleep 30 & echo $! > sleep.pid; wait', directory, undefined, controller.signal)
      await vi.waitFor(() => {
        expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '').toBe(true)
      })
      return { running: started }
    })
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    const failure = await step('処理を取り消す', () => {
      controller.abort('stopped by test')
      return rejectionOf(running)
    })
    await step('例外と子の停止を比べる', async () => {
      expect(failure).toEqual(new CancelledError('stopped by test'))
      await vi.waitFor(() => {
        expect(isAlive(pid)).toBe(false)
      }, { timeout: 2000 })
    })
  })
})
