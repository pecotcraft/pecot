/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// hooks-config.json 個別無効化のテスト（SC-004）と、撤廃したキーが残る設定のテスト（spec 025 FR-023）。
import { mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase, HooksConfig } from '../_helpers/environment.js'
import { adapterDirectory, coreDirectory, hooksDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

const GH_PR_CREATE_JSON = jsonDumps({ tool_input: { command: 'gh pr create --title "feat: test" --body "test"' } })

// spec 025 で撤廃した設定キー。利用者の hooks-config.json に残っていても無視する。
const RETIRED_KEYS = [
  'pecot-skill-compliance',
  'pecot-skill-reminder',
  'workflow-compliance-injector',
  'pecot-issue-pending-state',
  'pecot-issue-pending-reminder',
  'issue-pending-cleanup',
  'git-checkout-check',
  'commit-info-display',
  'auto-push',
  'branch-guard',
  'misplaced-pecot-notice',
  'vscode-workspace-detector',
  'gitignore-track-notice',
  'plugin-update-notice',
  'session-project-dir',
  'websearch-allow',
  'terminal-bell',
  'pty-bell-sender',
]

function runEntry(hookCase: HookCase, entry: string, stdin: string): RunResult {
  return run(hookCase, 'bash', [path.join(hooksDirectory, entry)], { stdin })
}

// PECOT_HOOKS_CONFIG_PATH / CLAUDE_PROJECT_DIR を設定する。hooks-config の内容は各テストが書く。
function setUpDisable(hookCase: HookCase): HooksConfig {
  const config = hooksConfig(hookCase)
  const project = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(path.join(project, 'tmp'), { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  return config
}

// CLAUDE_PLUGIN_ROOT に core/adapters の symlink を配置する。
function setUpPluginRoot(hookCase: HookCase): void {
  const pluginRoot = path.join(hookCase.temporaryPath, 'plugin')
  mkdirSync(path.join(pluginRoot, 'hooks', 'lib'), { recursive: true })
  symlinkSync(coreDirectory, path.join(pluginRoot, 'hooks', 'lib', 'core'))
  symlinkSync(adapterDirectory, path.join(pluginRoot, 'hooks', 'lib', 'adapters'))
  hookCase.setEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
}

describe('claude-bash-guards', () => {
  it('false のとき、gh pr create をブロックしない', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'claude-bash-guards': false })
    setUpPluginRoot(hookCase)

    const result = runEntry(hookCase, 'pre-tool-use-bash.sh', GH_PR_CREATE_JSON)
    expect(result.exitCode).toBe(0)
    // ブロック JSON が出力されないことを確認
    expect(result.stdout).not.toContain('"permissionDecision": "deny"')
    expect(result.stdout).not.toContain('"decision"')
  })

  it('true のとき、gh pr create をブロックする', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'claude-bash-guards': true })
    setUpPluginRoot(hookCase)

    const result = runEntry(hookCase, 'pre-tool-use-bash.sh', GH_PR_CREATE_JSON)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
  })
})

describe('撤廃したキー', () => {
  it.for([{ value: false }, { value: true }])('撤廃した 18 キーを $value で残しても、gh pr create の deny は今どおり返り、エラーと警告を出さない', (row) => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write(Object.fromEntries(RETIRED_KEYS.map(key => [key, row.value])))
    setUpPluginRoot(hookCase)

    const result = runEntry(hookCase, 'pre-tool-use-bash.sh', GH_PR_CREATE_JSON)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stderr).toBe('')
  })

  it.for([{ value: false }, { value: true }])('撤廃した 18 キーを $value で残しても、SessionStart はエラーと警告を出さない', (row) => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    // git-sync は git の外で警告を出すので止める。撤廃したキーと関わらない。
    config.write({ ...Object.fromEntries(RETIRED_KEYS.map(key => [key, row.value])), 'git-sync': false })

    const result = runEntry(hookCase, 'session-start.sh', jsonDumps({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's' }))
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('additionalContext')
  })
})
