/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pre-tool-use/pecot-issue-pending-reminder.sh のテスト。issue-pending フラグと tool_name の組み合わせで、リマインダーを出し分ける。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase, HooksConfig } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { runHookScript } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'

const SCRIPT = path.join(hooksDirectory, 'lib', 'pre-tool-use', 'pecot-issue-pending-reminder.sh')

interface Context {
  readonly flag: string
  readonly config: HooksConfig
}

function setUpContext(hookCase: HookCase): Context {
  const project = path.join(hookCase.temporaryPath, 'project')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  const config = hooksConfig(hookCase)
  config.write({ 'pecot-issue-pending-reminder': true })
  return { flag: path.join(stateDirectory, 'issue-pending'), config }
}

function runReminder(hookCase: HookCase, json: string): RunResult {
  return runHookScript(hookCase, SCRIPT, json)
}

describe('pecot-issue-pending-reminder.sh', () => {
  it('フラグが無いとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpContext(hookCase)
    const result = runReminder(hookCase, '{"tool_name":"Edit","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('フラグが w-quick で Edit のとき、quick 向けのリマインダーを返す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-quick\n')
    const result = runReminder(hookCase, '{"tool_name":"Edit","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('warning: Issue filing is not complete')
    expect(result.stdout).toContain('pecot issue quick')
    expect(result.stdout).toContain('PreToolUse')
  })

  it('フラグが w-ready で EnterPlanMode のとき、ready 向けのリマインダーを返す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-ready\n')
    const result = runReminder(hookCase, '{"tool_name":"EnterPlanMode","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('warning: Subtask Issue')
    expect(result.stdout).toContain('pecot issue create --prepare')
  })

  it('フラグがあり git checkout を実行するとき、リマインダーを返す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-quick\n')
    const result = runReminder(hookCase, '{"tool_name":"Bash","tool_input":{"command":"git checkout feat/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('warning: Issue filing is not complete')
  })

  it('フラグがあり git switch を実行するとき、リマインダーを返す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-quick\n')
    const result = runReminder(hookCase, '{"tool_name":"Bash","tool_input":{"command":"git switch feat/foo"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('warning: Issue filing is not complete')
  })

  it('フラグがあっても無関係な Bash コマンドのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-quick\n')
    const result = runReminder(hookCase, '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('フラグがあっても Read のとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-quick\n')
    const result = runReminder(hookCase, '{"tool_name":"Read","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('フラグがあり Write のとき、リマインダーを返す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-ready\n')
    const result = runReminder(hookCase, '{"tool_name":"Write","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Issue')
  })

  it('フラグの値が未知のとき、quick と create の両方を案内する代替の文言を返す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-unknown\n')
    const result = runReminder(hookCase, '{"tool_name":"Edit","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('warning: Issue filing is not complete')
    expect(result.stdout).toContain('pecot issue quick')
    expect(result.stdout).toContain('pecot issue create')
  })

  it('フラグがあり MultiEdit のとき、リマインダーを返す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-quick\n')
    const result = runReminder(hookCase, '{"tool_name":"MultiEdit","tool_input":{"file_path":"/tmp/foo.py"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('warning: Issue filing is not complete')
  })

  it('.pecot/tmp/output 配下を Edit するとき、リマインダーの対象外にする', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-ready\n')
    const result = runReminder(hookCase, '{"tool_name":"Edit","tool_input":{"file_path":"/workspaces/foo/.pecot/tmp/output/issue-foo.md"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('.pecot/tmp/output 配下を Write するとき、リマインダーの対象外にする', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.flag, 'w-ready\n')
    const result = runReminder(hookCase, '{"tool_name":"Write","tool_input":{"file_path":"/workspaces/foo/.pecot/tmp/output/issue-bar.md"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('設定で pecot-issue-pending-reminder が無効なとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    context.config.write({ 'pecot-issue-pending-reminder': false })
    writeFileSync(context.flag, 'w-quick\n')
    const result = runReminder(hookCase, '{"tool_name":"Edit","tool_input":{}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
