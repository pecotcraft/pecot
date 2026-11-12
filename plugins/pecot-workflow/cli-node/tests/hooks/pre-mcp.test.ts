/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pre-tool-use-mcp.sh のテスト。PR 作成の MCP ツールを常にブロックし、context7 の読み取りを許可する。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'

const HOOK_SCRIPT = path.join(hooksDirectory, 'pre-tool-use-mcp.sh')

// CLAUDE_PROJECT_DIR を tmp/project に向け、state ディレクトリを返す。
function setUpStateDirectory(hookCase: HookCase): string {
  const project = path.join(hookCase.temporaryPath, 'project')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  return stateDirectory
}

// エントリは stdin の JSON を project-root.sh で読む。ハンドラは PECOT_HOOK_* を読む。
function runHook(hookCase: HookCase, stdin: string): RunResult {
  return run(hookCase, 'bash', [HOOK_SCRIPT], { stdin })
}

describe('pre-tool-use-mcp.sh', () => {
  // PR 作成: pecot-active フラグなしでもブロックする（常時ブロック）。

  it('PR 作成の MCP ツールが pecot-active なしで呼ばれるとき、拒否する', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    const result = runHook(hookCase, '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
  })

  it('Enterprise の PR 作成の MCP ツールが pecot-active なしで呼ばれるとき、拒否する', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    const result = runHook(hookCase, '{"tool_name":"mcp__githubEnterprise__create_pull_request","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
  })

  // PR 作成: pecot-active フラグありでもブロックする。

  it('PR 作成の MCP ツールが pecot-active ありで呼ばれても、拒否する', () => {
    const hookCase = createHookCase()
    writeFileSync(path.join(setUpStateDirectory(hookCase), '.pecot-active'), 'org/repo/123\n')
    const result = runHook(hookCase, '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
  })

  it('拒否の理由に、w-pr スキルへの案内を含める', () => {
    const hookCase = createHookCase()
    writeFileSync(path.join(setUpStateDirectory(hookCase), '.pecot-active'), 'org/repo/123\n')
    const result = runHook(hookCase, '{"tool_name":"mcp__githubEnterprise__create_pull_request","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('pecot-w:w-pr')
  })

  // PR 作成以外の MCP ツールは、何も出力せずにすり抜ける。

  it('PR 作成以外の MCP ツールのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    writeFileSync(path.join(setUpStateDirectory(hookCase), '.pecot-active'), 'org/repo/123\n')
    const result = runHook(hookCase, '{"tool_name":"mcp__drawio__open_drawio_mermaid","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('tool_name が無いとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    const result = runHook(hookCase, '{"tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // context7 の読み取りツールは自動で許可する（context7-allow）。

  it('context7 の resolve-library-id が呼ばれるとき、許可する', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    hooksConfig(hookCase).write({})
    const result = runHook(hookCase, '{"tool_name":"mcp__plugin_pecot-w_context7__resolve-library-id","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "allow"')
    expect(result.stdout).toContain('"hookEventName": "PreToolUse"')
  })

  it('context7 の query-docs が呼ばれるとき、許可する', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    hooksConfig(hookCase).write({})
    const result = runHook(hookCase, '{"tool_name":"mcp__plugin_pecot-w_context7__query-docs","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "allow"')
  })

  // プラグイン名のプレフィックスまで一致したときだけ許可する。
  it('プラグイン名のプレフィックスが違う context7 のツールのとき、許可しない', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    hooksConfig(hookCase).write({})
    const result = runHook(hookCase, '{"tool_name":"mcp__context7__resolve-library-id","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('設定で context7-allow が無効なとき、許可しない', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    hooksConfig(hookCase).write({ 'context7-allow': false })
    const result = runHook(hookCase, '{"tool_name":"mcp__plugin_pecot-w_context7__query-docs","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // context7-allow は Claude Code のツール名専用。Copilot のツール名（<mcpServers のキー>-<ツール名>）では allow が出ない。
  it('Copilot 形式の context7 のツール名のとき、許可を出さない', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    hooksConfig(hookCase).write({})
    const result = runHook(hookCase, '{"tool_name":"context7-query-docs","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('permissionDecision')
  })

  // Copilot CLI 1.0.103 の組み込み GitHub MCP の PR 作成。matcher は hooks-copilot.json の `mcp__.*|github-mcp-server-create_pull_request`。
  it('Copilot 形式の GitHub MCP の PR 作成のとき、拒否する', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    hooksConfig(hookCase).write({})
    const result = runHook(hookCase, '{"tool_name":"github-mcp-server-create_pull_request","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).not.toContain('"decision"')
    expect(result.stdout).toContain('pecot-w:w-pr')
  })

  // deny 系（pr-create-block）は allow のハンドラーより先に評価される。
  it('PR 作成のブロックは、allow のハンドラーより先に評価して拒否する', () => {
    const hookCase = createHookCase()
    setUpStateDirectory(hookCase)
    hooksConfig(hookCase).write({})
    const result = runHook(hookCase, '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).not.toContain('"permissionDecision": "allow"')
  })
})
