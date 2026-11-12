// `pecot mcp` が、プラグインの root で起動されても、セッションのディレクトリのリポを対象にすることを、実際に stdio でサーバを起動して確かめる。
// session_status は directory を "." にして、サーバの cwd を見る。GitHub は呼ばない（Active Issue の状態ファイルを置かない）。
import { describe, expect, it } from 'vitest'

import { createGitRepository, gitForTest } from '../../src/tests/_helpers/git-repository.js'
import { cliEntry, builtCliProblem } from '../parity/built-cli.js'
import { runScenario } from '../parity/run.js'
import type { Launcher, Outcome } from '../parity/run.js'
import { readScenario } from '../parity/scenario.js'

const TEST_TIMEOUT_MS = 30_000
const REASON = 'cannot determine the target repository: the server was started in the plugin directory'

function repositoryWithRemote(name: string): string {
  const directory = createGitRepository()
  gitForTest(directory, ['remote', 'add', 'origin', `git@github.com:acme/${name}.git`])
  return directory
}

// cwd をプラグインの root（別の remote を持つ git リポ）にして起動する。env は launcher.env が基本の env に重なる。空文字は無いものとして扱われる
async function statusFrom(pluginRoot: string, environment: Readonly<Record<string, string>>): Promise<Outcome> {
  const base = readScenario('session-status-ok-no-flags')
  const scenario = { ...base, setup: { ...base.setup, cwd: pluginRoot } }
  const launcher: Launcher = { command: process.execPath, args: [cliEntry], env: { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: '', COPILOT_SESSION_CWD: '', COPILOT_PLUGIN_ROOT: '', PLUGIN_ROOT: '', ...environment }, via: 'mcp' }
  return await runScenario(scenario, launcher)
}

describe('pecot mcp のセッションのディレクトリ', () => {
  it('Node の CLI がビルドされている', () => {
    expect(builtCliProblem()).toBeUndefined()
  })

  it('プラグインの root で起動され、COPILOT_SESSION_CWD があれば、そのリポを対象にする', { timeout: TEST_TIMEOUT_MS }, async () => {
    const pluginRoot = repositoryWithRemote('plugin-root')
    const session = repositoryWithRemote('session-repo')
    const outcome = await statusFrom(pluginRoot, { COPILOT_SESSION_CWD: session })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden.exitCode).toBe(0)
    expect(outcome.golden.stdout).toContain('- Repository: acme/session-repo')
    expect(outcome.golden.stdout).not.toContain('plugin-root')
  })

  it('COPILOT_SESSION_CWD が無くても、CLAUDE_PROJECT_DIR があれば、そのリポを対象にする', { timeout: TEST_TIMEOUT_MS }, async () => {
    const pluginRoot = repositoryWithRemote('plugin-root')
    const project = repositoryWithRemote('project-repo')
    const outcome = await statusFrom(pluginRoot, { CLAUDE_PROJECT_DIR: project })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden.exitCode).toBe(0)
    expect(outcome.golden.stdout).toContain('- Repository: acme/project-repo')
  })

  it('どちらの変数も無ければ、プラグインの root のリポを使わず、理由を失敗で返す', { timeout: TEST_TIMEOUT_MS }, async () => {
    const pluginRoot = repositoryWithRemote('plugin-root')
    const outcome = await statusFrom(pluginRoot, {})
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden.exitCode).toBe(1)
    expect(outcome.golden.stdout).toBe('')
    expect(outcome.golden.stderr).toContain(`error: ${REASON} (`)
    expect(outcome.golden.stderr).toContain('upgrade GitHub Copilot CLI to 1.0.106 or later')
  })

  it('Copilot CLI の起動で COPILOT_SESSION_CWD が無ければ、継いだ CLAUDE_PROJECT_DIR のリポを使わず、理由を失敗で返す', { timeout: TEST_TIMEOUT_MS }, async () => {
    const pluginRoot = repositoryWithRemote('plugin-root')
    const inherited = repositoryWithRemote('inherited-repo')
    const outcome = await statusFrom(pluginRoot, { COPILOT_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: inherited })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden.exitCode).toBe(1)
    expect(outcome.golden.stdout).toBe('')
    expect(outcome.golden.stderr).toContain(`error: ${REASON} (`)
    expect(outcome.golden.stderr).not.toContain('inherited-repo')
  })

  it('COPILOT_SESSION_CWD が実在しなければ、理由を失敗で返す', { timeout: TEST_TIMEOUT_MS }, async () => {
    const pluginRoot = repositoryWithRemote('plugin-root')
    const missing = `${pluginRoot}/missing`
    const outcome = await statusFrom(pluginRoot, { COPILOT_SESSION_CWD: missing })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden.exitCode).toBe(1)
    expect(outcome.golden.stderr).toBe(`error: cannot determine the target repository: COPILOT_SESSION_CWD is not a usable directory: ${missing}\n`)
  })
})
