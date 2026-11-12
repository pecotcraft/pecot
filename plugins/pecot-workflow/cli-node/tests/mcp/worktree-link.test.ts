// worktree_link は process.cwd() を読むので、実際に stdio でサーバを起動して呼ぶ（前後比較の起動方法と sandbox を使う）。
import { describe, expect, it } from 'vitest'

import { cliEntry, builtCliProblem } from '../parity/built-cli.js'
import { runScenario } from '../parity/run.js'
import type { Launcher } from '../parity/run.js'
import { readGolden, readScenario } from '../parity/scenario.js'

const TEST_TIMEOUT_MS = 30_000
const mcp: Launcher = { command: process.execPath, args: [cliEntry], env: {}, via: 'mcp' }

describe('worktree_link', () => {
  it('Node の CLI がビルドされている', () => {
    expect(builtCliProblem()).toBeUndefined()
  })

  it('force が false で上書きの確認が要ると、入力の終端と同じ結果で中止する', { timeout: TEST_TIMEOUT_MS }, async () => {
    const scenario = readScenario('worktree-link-state-overwrite-eof')
    expect(scenario.command.args).not.toContain('--force')
    const outcome = await runScenario(scenario, mcp)
    const golden = readGolden('worktree-link-state-overwrite-eof')
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden).toEqual(golden)
    expect(outcome.golden).toMatchObject({ exitCode: 1 })
    expect(outcome.golden.stderr).toMatch(/Aborted\.\n$/u)
  })

  it('force が true なら、確認せずに上書きする', { timeout: TEST_TIMEOUT_MS }, async () => {
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
