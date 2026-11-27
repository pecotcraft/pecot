// MCP のサーバが、プラグインの root で起動されても、セッションのディレクトリのリポを対象にすることを、実際に stdio でサーバを起動して確かめる。
// session_show は directory を "." にして、サーバの cwd を見る。GitHub は呼ばない（ブランチ名の末尾に番号が無く、作業中の Issue が無い）。
import { describe, expect, it } from 'vitest'

import { createGitRepository, gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { builtServer, builtServerProblem } from '../parity/built-server.js'
import { runScenario } from '../parity/run.js'
import type { Outcome } from '../parity/run.js'
import { readScenario } from '../parity/scenario.js'
import { explains } from '../_helpers/explains.js'

const TEST_TIMEOUT_MS = 30_000
const REASON = 'cannot determine the target repository: the server was started in the plugin directory'

function repositoryWithRemote(name: string): string {
  const directory = createGitRepository()
  gitForTest(directory, ['remote', 'add', 'origin', `git@github.com:acme/${name}.git`])
  return directory
}

// cwd をプラグインの root（別の remote を持つ git リポ）にして起動する。空文字の環境変数は無いものとして扱われる
async function statusFrom(pluginRoot: string, environment: Readonly<Record<string, string>>): Promise<Outcome> {
  const base = readScenario('session-show-ok-no-issue')
  const variables = { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: '', COPILOT_SESSION_CWD: '', COPILOT_PLUGIN_ROOT: '', PLUGIN_ROOT: '', ...environment }
  return await runScenario({ ...base, setup: { ...base.setup, cwd: pluginRoot, env: variables } }, builtServer)
}

describe('MCP のサーバのセッションのディレクトリ', () => {
  it('MCP のサーバがビルドされている場合は、ビルドの問題を報告しない', async () => {
    await explains('ビルド済みの MCP のサーバ（`dist/main.js`）が存在するかを確認するテストです。ビルドに関する問題が報告されないことを確認します。')
    expect(builtServerProblem()).toBeUndefined()
  })

  it('プラグインの root で起動され、COPILOT_SESSION_CWD があれば、そのリポを対象にする', { timeout: TEST_TIMEOUT_MS }, async () => {
    await explains('プラグインの root で起動した MCP のサーバが、対象のリポジトリを決める方法のテストです。`COPILOT_SESSION_CWD` を指定した場合に、そのディレクトリのリポジトリ（`acme/session-repo`）を対象にすることを確認します。')
    const pluginRoot = repositoryWithRemote('plugin-root')
    const session = repositoryWithRemote('session-repo')
    const outcome = await statusFrom(pluginRoot, { COPILOT_SESSION_CWD: session })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden).toMatchObject({ isError: false, stderr: '', structuredContent: { repository: 'acme/session-repo' } })
  })

  it('COPILOT_SESSION_CWD が無くても、CLAUDE_PROJECT_DIR があれば、そのリポを対象にする', { timeout: TEST_TIMEOUT_MS }, async () => {
    await explains('プラグインの root で起動した MCP のサーバが、対象のリポジトリを決める方法のテストです。`COPILOT_SESSION_CWD` を指定せず、`CLAUDE_PROJECT_DIR` を指定した場合に、そのリポジトリ（`acme/project-repo`）を対象にすることを確認します。')
    const pluginRoot = repositoryWithRemote('plugin-root')
    const project = repositoryWithRemote('project-repo')
    const outcome = await statusFrom(pluginRoot, { CLAUDE_PROJECT_DIR: project })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden).toMatchObject({ isError: false, stderr: '', structuredContent: { repository: 'acme/project-repo' } })
  })

  it('どちらの環境変数も指定しなければ、プラグインの root のリポを使わず、理由を失敗で返す', { timeout: TEST_TIMEOUT_MS }, async () => {
    await explains('プラグインの root で起動し、どちらの環境変数も指定しない場合のテストです。プラグインの root のリポジトリを対象にせず、理由と対処を示す失敗の結果を返すことを確認します。')
    const pluginRoot = repositoryWithRemote('plugin-root')
    const outcome = await statusFrom(pluginRoot, {})
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden).toMatchObject({ isError: true, structuredContent: { kind: 'session-directory-unresolved' } })
    expect(outcome.golden?.structuredContent['detail']).toContain(`${REASON} (`)
    expect(outcome.golden?.structuredContent['detail']).toContain('upgrade GitHub Copilot CLI to 1.0.106 or later')
  })

  it('Copilot CLI の起動で COPILOT_SESSION_CWD が無ければ、継いだ CLAUDE_PROJECT_DIR のリポを使わず、理由を失敗で返す', { timeout: TEST_TIMEOUT_MS }, async () => {
    await explains('Copilot CLI から起動し、`COPILOT_SESSION_CWD` を指定しない場合のテストです。継承した `CLAUDE_PROJECT_DIR` のリポジトリを対象にせず、理由を示す失敗の結果を返すことを確認します。')
    const pluginRoot = repositoryWithRemote('plugin-root')
    const inherited = repositoryWithRemote('inherited-repo')
    const outcome = await statusFrom(pluginRoot, { COPILOT_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: inherited })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden).toMatchObject({ isError: true, structuredContent: { kind: 'session-directory-unresolved' } })
    expect(outcome.golden?.structuredContent['detail']).toContain(`${REASON} (`)
    expect(JSON.stringify(outcome.golden?.structuredContent)).not.toContain('inherited-repo')
  })

  it('COPILOT_SESSION_CWD が実在しなければ、理由を失敗で返す', { timeout: TEST_TIMEOUT_MS }, async () => {
    await explains('`COPILOT_SESSION_CWD` に存在しないディレクトリを指定した場合に、使用できないディレクトリであることを示す失敗の結果を返すことを確認します。')
    const pluginRoot = repositoryWithRemote('plugin-root')
    const missing = `${pluginRoot}/missing`
    const outcome = await statusFrom(pluginRoot, { COPILOT_SESSION_CWD: missing })
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.golden).toMatchObject({
      isError: true,
      structuredContent: { kind: 'session-directory-unresolved', detail: `cannot determine the target repository: COPILOT_SESSION_CWD is not a usable directory: ${missing}` },
    })
  })
})
