/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// session-start/issue-pending-cleanup.sh のテスト。古い issue-pending フラグを、セッション開始時に削除する。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase, HooksConfig } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'

const HOOK_SCRIPT = path.join(hooksDirectory, 'lib', 'session-start', 'issue-pending-cleanup.sh')

interface Context {
  readonly issuePending: string
  readonly config: HooksConfig
}

function setUpContext(hookCase: HookCase): Context {
  const project = path.join(hookCase.temporaryPath, 'project')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  const config = hooksConfig(hookCase)
  config.write({ 'issue-pending-cleanup': true })
  return { issuePending: path.join(stateDirectory, 'issue-pending'), config }
}

function runCleanup(hookCase: HookCase): RunResult {
  return run(hookCase, 'bash', [HOOK_SCRIPT], { stdin: '' })
}

describe('issue-pending-cleanup.sh', () => {
  it('issue-pending フラグがあるとき、削除する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.issuePending, 'w-quick\n')
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.issuePending)).toBe(false)
  })

  it('フラグが無いとき、エラーにならない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.issuePending)).toBe(false)
  })

  it('設定で issue-pending-cleanup が無効なとき、フラグを残す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    context.config.write({ 'issue-pending-cleanup': false })
    writeFileSync(context.issuePending, 'w-ready\n')
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.issuePending)).toBe(true)
  })

  it('設定ファイルが無いとき、有効として扱い、フラグを削除する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', path.join(hookCase.temporaryPath, 'nonexistent-hooks-config.json'))
    writeFileSync(context.issuePending, 'w-quick\n')
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.issuePending)).toBe(false)
  })
})
