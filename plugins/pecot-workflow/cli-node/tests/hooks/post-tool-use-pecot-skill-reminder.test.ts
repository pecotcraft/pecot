/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// post-tool-use/pecot-skill-reminder.sh のテスト。w-quick・w-ready の起動で issue-pending フラグを作る（中身はスキル名）。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { runHookScript } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'

const SCRIPT = path.join(hooksDirectory, 'lib', 'post-tool-use', 'pecot-skill-reminder.sh')

// issue-pending フラグのパスを返す。
function setUpFlag(hookCase: HookCase): string {
  const project = path.join(hookCase.temporaryPath, 'project')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  hooksConfig(hookCase).write({ 'pecot-skill-reminder': true })
  return path.join(stateDirectory, 'issue-pending')
}

function runReminder(hookCase: HookCase, json: string): RunResult {
  return runHookScript(hookCase, SCRIPT, json)
}

describe('pecot-skill-reminder.sh', () => {
  it('w-quick のスキルが起動されると、内容が w-quick のフラグを作る', () => {
    const hookCase = createHookCase()
    const flag = setUpFlag(hookCase)
    const result = runReminder(hookCase, '{"tool_input":{"skill":"pecot-w:w-quick"}}')
    expect(result.exitCode).toBe(0)
    expect(existsSync(flag)).toBe(true)
    expect(readFileSync(flag, 'utf8').trim()).toBe('w-quick')
  })

  it('w-ready のスキルが起動されると、内容が w-ready のフラグを作る', () => {
    const hookCase = createHookCase()
    const flag = setUpFlag(hookCase)
    const result = runReminder(hookCase, '{"tool_input":{"skill":"pecot-w:w-ready"}}')
    expect(result.exitCode).toBe(0)
    expect(existsSync(flag)).toBe(true)
    expect(readFileSync(flag, 'utf8').trim()).toBe('w-ready')
  })

  it('起票しない w-task が起動されても、フラグを作らない', () => {
    const hookCase = createHookCase()
    const flag = setUpFlag(hookCase)
    const result = runReminder(hookCase, '{"tool_input":{"skill":"pecot-w:w-task"}}')
    expect(result.exitCode).toBe(0)
    expect(existsSync(flag)).toBe(false)
  })

  it('無関係なスキルが起動されても、フラグを作らない', () => {
    const hookCase = createHookCase()
    const flag = setUpFlag(hookCase)
    const result = runReminder(hookCase, '{"tool_input":{"skill":"some-other-skill"}}')
    expect(result.exitCode).toBe(0)
    expect(existsSync(flag)).toBe(false)
  })

  it('w-quick の後に w-ready が起動されると、フラグの内容を上書きする', () => {
    const hookCase = createHookCase()
    const flag = setUpFlag(hookCase)

    runReminder(hookCase, '{"tool_input":{"skill":"pecot-w:w-quick"}}')
    expect(readFileSync(flag, 'utf8').trim()).toBe('w-quick')

    runReminder(hookCase, '{"tool_input":{"skill":"pecot-w:w-ready"}}')
    expect(readFileSync(flag, 'utf8').trim()).toBe('w-ready')
  })

  it('w-quick が起動されたとき、リマインダーの出力も保つ', () => {
    const hookCase = createHookCase()
    setUpFlag(hookCase)
    const result = runReminder(hookCase, '{"tool_input":{"skill":"pecot-w:w-quick"}}')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('note: pecot-workflow skill started')
  })
})
