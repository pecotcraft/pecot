/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// hooks-config.json 個別無効化のテスト（SC-004）。
// 各フック機能を hooks-config.json で false に設定すると動作しないことを検証する。
import { mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase, HooksConfig } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { adapterDirectory, coreDirectory, hooksDirectory } from '../_helpers/paths.js'
import { run, runShell } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

const COMMIT_SUCCESS_JSON = jsonDumps({
  tool_input: { command: 'git commit -m "feat: add auth"' },
  tool_response: {
    stdout: '[feat/test abc1234] feat: add auth\n 1 file changed, 1 insertion(+)',
    interrupted: false,
  },
})

const GH_PR_CREATE_JSON = jsonDumps({ tool_input: { command: 'gh pr create --title "feat: test" --body "test"' } })

function pecotSkillJson(skill: string): string {
  return jsonDumps({ tool_input: { skill } })
}

// サブスクリプトは stdin ではなく PECOT_HOOK_* / PECOT_POST_* を読むので、エントリと同じ前段を source してから起動する。
const SOURCE_HOOK_INPUT = 'source "$(dirname "$1")/../core/hook-input.sh" && pecot_hook_input_load "$2" && exec bash "$1"'
const SOURCE_POST_MATCH = [
  'PECOT_PROJECT_ROOT_LAZY=1; ',
  'source "$(dirname "$1")/../core/project-root.sh" "$2" && ',
  'source "$(dirname "$1")/bash-post-match.sh" "$2" && exec bash "$1"',
].join('')

function runWithFront(hookCase: HookCase, script: string, stdin: string, cwd?: string): RunResult {
  const parent = path.dirname(script)
  const where = cwd === undefined ? {} : { cwd }
  if (path.basename(parent) === 'post-tool-use') return runShell(hookCase, SOURCE_POST_MATCH, [script, stdin], where)
  if (path.basename(parent) === 'lib' || path.basename(path.dirname(parent)) === 'lib') {
    return runShell(hookCase, SOURCE_HOOK_INPUT, [script, stdin], where)
  }
  return run(hookCase, 'bash', [script], { stdin, ...where })
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

const POST_TOOL_USE = path.join(hooksDirectory, 'lib', 'post-tool-use')
const PRE_TOOL_USE_BASH = path.join(hooksDirectory, 'pre-tool-use-bash.sh')

describe('commit-info-display', () => {
  it('false のとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'commit-info-display': false })
    const repository = gitRepository(hookCase)

    const result = runWithFront(hookCase, path.join(POST_TOOL_USE, 'commit-info-display.sh'), COMMIT_SUCCESS_JSON, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('true のとき、出力する', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'commit-info-display': true })
    const repository = gitRepository(hookCase)

    const result = runWithFront(hookCase, path.join(POST_TOOL_USE, 'commit-info-display.sh'), COMMIT_SUCCESS_JSON, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('note: commit complete')
  })
})

describe('claude-bash-guards', () => {
  it('false のとき、gh pr create をブロックしない', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'claude-bash-guards': false })
    setUpPluginRoot(hookCase)

    const result = runWithFront(hookCase, PRE_TOOL_USE_BASH, GH_PR_CREATE_JSON)
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

    const result = runWithFront(hookCase, PRE_TOOL_USE_BASH, GH_PR_CREATE_JSON)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
  })
})

describe('pecot-skill-reminder', () => {
  it('false のとき、警告を出さない', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'pecot-skill-reminder': false })

    const result = runWithFront(hookCase, path.join(POST_TOOL_USE, 'pecot-skill-reminder.sh'), pecotSkillJson('pecot-w'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('true のとき、警告を出す', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'pecot-skill-reminder': true })

    const result = runWithFront(hookCase, path.join(POST_TOOL_USE, 'pecot-skill-reminder.sh'), pecotSkillJson('pecot-w'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('note: pecot-workflow skill started')
  })

  it('false で w-quick を起動したときも、警告を出さない', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'pecot-skill-reminder': false })

    const result = runWithFront(hookCase, path.join(POST_TOOL_USE, 'pecot-skill-reminder.sh'), pecotSkillJson('pecot-w:w-quick'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})

// external-post-check のキー: false で ask（exit 11）が抑止され、true で ask される。
// pecot-pr-create-ask・pecot-issue-create-ask は MCP ハンドラの pecot-post-ask.sh が見る。
const EXTERNAL_POST_ROWS = [
  { label: 'gh pr merge', configKey: 'gh-pr-merge-ask', command: 'gh pr merge 810' },
]

describe('external-post-check', () => {
  it.for(EXTERNAL_POST_ROWS)('キー $configKey を false にすると、$label を ask せず通す', (row) => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ [row.configKey]: false })
    hookCase.setEnv('HOOK_COMMAND', row.command)

    const result = runWithFront(hookCase, path.join(coreDirectory, 'external-post-check.sh'), '')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.for(EXTERNAL_POST_ROWS)('キー $configKey を true にすると、$label を ask する', (row) => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ [row.configKey]: true })
    hookCase.setEnv('HOOK_COMMAND', row.command)

    const result = runWithFront(hookCase, path.join(coreDirectory, 'external-post-check.sh'), '')
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('warning: external-post-check:')
  })
})

// pecot-cli-deny: false で deny（exit 1）が抑止され、true で deny される
describe('pecot-cli-deny', () => {
  it('キー pecot-cli-deny を false にすると、pecot の起動を deny せず通す', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'pecot-cli-deny': false })
    hookCase.setEnv('HOOK_COMMAND', 'pecot issue show 1')

    const result = runWithFront(hookCase, path.join(coreDirectory, 'pecot-cli-deny.sh'), '')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('キー pecot-cli-deny を true にすると、pecot の起動を deny する', () => {
    const hookCase = createHookCase()
    const config = setUpDisable(hookCase)
    config.write({ 'pecot-cli-deny': true })
    hookCase.setEnv('HOOK_COMMAND', 'pecot issue show 1')

    const result = runWithFront(hookCase, path.join(coreDirectory, 'pecot-cli-deny.sh'), '')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('MCP tool issue_show')
  })
})
