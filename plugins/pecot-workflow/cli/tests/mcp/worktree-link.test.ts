// worktree_link は process.cwd() を読むので、実際に stdio でサーバを起動して呼ぶ（前後比較の起動方法と sandbox を使う）。
import { describe, expect, it } from 'vitest'

import { cliEntry, builtCliProblem } from '../parity/built-cli.js'
import { mcpViewOfStderr } from '../parity/mcp-view.js'
import { runScenario } from '../parity/run.js'
import type { Launcher } from '../parity/run.js'
import { readGolden, readScenario } from '../parity/scenario.js'
import { explains } from '../_helpers/explains.js'

const TEST_TIMEOUT_MS = 30_000
const mcp: Launcher = { command: process.execPath, args: [cliEntry], env: {}, via: 'mcp' }

describe('worktree_link', () => {
  it('Node の CLI がビルドされている場合は、ビルドの問題を報告しない', async () => {
    await explains('ビルド済みの Node の CLI（`pecot`）が存在するかを確認するテストです。ビルドに関する問題が報告されないことを確認します。')
    expect(builtCliProblem()).toBeUndefined()
  })

  it('force が false で上書きの確認が要ると、入力の終端と同じ結果で中止する', { timeout: TEST_TIMEOUT_MS }, async () => {
    await explains('MCP 経由の `worktree_link` を、`force` を `false` にして、上書きの確認が必要な状態で実行した場合のテストです。入力の終端に達したときと同じ結果（終了コード 1 と `Aborted.`）で中止することを確認します。')
    const scenario = readScenario('worktree-link-state-overwrite-eof')
    expect(scenario.command.args).not.toContain('--force')
    const outcome = await runScenario(scenario, mcp)
    const golden = readGolden('worktree-link-state-overwrite-eof')
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden).toEqual({ ...golden, stdout: '', stderr: mcpViewOfStderr(golden.stderr.replace(' [y/N]:', '\n'), golden.exitCode) })
    expect(outcome.golden).toMatchObject({ exitCode: 1 })
    expect(outcome.golden.stderr).toMatch(/Aborted\.\n$/u)
  })

  it('force が true なら、確認せずに上書きする', { timeout: TEST_TIMEOUT_MS }, async () => {
    await explains('MCP 経由の `worktree_link` を、`force` を `true` にして実行した場合のテストです。上書きの確認（`overwrite it?`）を表示せずに処理が成功し、作成されるファイルが期待どおりであることを確認します。')
    const confirmed = readScenario('worktree-link-ok-overwrite-confirmed')
    const forced = { ...confirmed, stdin: '', command: { ...confirmed.command, args: [...confirmed.command.args, '--force'] } }
    const outcome = await runScenario(forced, mcp)
    const golden = readGolden('worktree-link-ok-overwrite-confirmed')
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden.exitCode).toBe(0)
    expect(outcome.golden.stderr).not.toContain('overwrite it?')
    expect(outcome.golden.files).toEqual(golden.files)
  })
})
