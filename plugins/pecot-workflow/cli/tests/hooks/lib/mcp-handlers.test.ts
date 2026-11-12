/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pr-create-block.sh のテスト。MCP の PR 作成ツールを常時ブロックし、非 PR ツールと tool_name の欠落ではすり抜けさせる。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeProjectDirectory, createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { runHookScript } from '../_helpers/run.js'

const HANDLER = path.join(hooksDirectory, 'lib', 'mcp-handlers', 'pr-create-block.sh')

// CLAUDE_PROJECT_DIR/.pecot/state を用意し、その state ディレクトリを返す。
function setUpState(hookCase: HookCase): string {
  const stateDirectory = path.join(claudeProjectDirectory(hookCase), '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  return stateDirectory
}

describe('pr-create-block.sh', () => {
  it('フラグが無くても、GitHub の PR 作成ツールをブロックする', () => {
    const hookCase = createHookCase()
    setUpState(hookCase)
    const result = runHookScript(hookCase, HANDLER, '{"tool_name":"mcp__github__create_pull_request"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
  })

  it('フラグがあるとき、githubEnterprise の PR 作成ツールをブロックし、w-pr を案内する', () => {
    const hookCase = createHookCase()
    writeFileSync(path.join(setUpState(hookCase), '.pecot-active'), '')
    const result = runHookScript(hookCase, HANDLER, '{"tool_name":"mcp__githubEnterprise__create_pull_request"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).toContain('pecot-w:w-pr')
  })

  it('フラグがあるとき、GitHub の PR 作成ツールをブロックする', () => {
    const hookCase = createHookCase()
    writeFileSync(path.join(setUpState(hookCase), '.pecot-active'), '')
    const result = runHookScript(hookCase, HANDLER, '{"tool_name":"mcp__github__create_pull_request"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
  })

  it('PR 作成でない MCP ツールのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpState(hookCase)
    const result = runHookScript(hookCase, HANDLER, '{"tool_name":"mcp__github__list_issues"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('tool_name が無いとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpState(hookCase)
    const result = runHookScript(hookCase, HANDLER, '{"other_field":"value"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('Copilot の組み込み GitHub MCP の PR 作成ツールを拒否し、w-pr を案内する', () => {
    // Copilot CLI の MCP ツール名は <mcpServers のキー>-<ツール名>（組み込み GitHub MCP の PR 作成）
    const hookCase = createHookCase()
    setUpState(hookCase)
    const result = runHookScript(hookCase, HANDLER, '{"tool_name":"github-mcp-server-create_pull_request"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).not.toContain('"decision"')
    expect(result.stdout).toContain('pecot-w:w-pr')
  })

  it('Copilot の組み込み GitHub MCP の PR 作成以外のツールのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpState(hookCase)
    const result = runHookScript(hookCase, HANDLER, '{"tool_name":"github-mcp-server-get_file_contents"}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
