/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// session-start/create-slash-cleanup.sh のテスト。前セッションの未消費フラグを、セッション開始時に削除する。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase, HooksConfig } from './_helpers/environment.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'

const HOOK_SCRIPT = path.join(hooksDirectory, 'lib', 'session-start', 'create-slash-cleanup.sh')

interface Context {
  readonly prFlag: string
  readonly issueFlag: string
  readonly mergeFlag: string
  readonly config: HooksConfig
}

function setUpContext(hookCase: HookCase): Context {
  const project = path.join(hookCase.temporaryPath, 'project')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  const config = hooksConfig(hookCase)
  config.write({ 'create-slash-cleanup': true })
  return {
    prFlag: path.join(stateDirectory, 'pr-create-slash-pending'),
    issueFlag: path.join(stateDirectory, 'issue-create-slash-pending'),
    mergeFlag: path.join(stateDirectory, 'merge-slash-pending'),
    config,
  }
}

function runCleanup(hookCase: HookCase): RunResult {
  return run(hookCase, 'bash', [HOOK_SCRIPT], { stdin: '' })
}

describe('create-slash-cleanup.sh', () => {
  it('pr と issue のフラグがあるとき、どちらも削除する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.prFlag, '')
    writeFileSync(context.issueFlag, 'w-quick\n')
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(false)
    expect(existsSync(context.issueFlag)).toBe(false)
  })

  it('merge のフラグがあるとき、削除する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.mergeFlag, '')
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.mergeFlag)).toBe(false)
  })

  it('フラグが無いとき、エラーにならない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(false)
    expect(existsSync(context.issueFlag)).toBe(false)
  })

  it('設定で create-slash-cleanup が無効なとき、フラグを残す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    context.config.write({ 'create-slash-cleanup': false })
    writeFileSync(context.prFlag, '')
    writeFileSync(context.issueFlag, 'w-quick\n')
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(true)
    expect(existsSync(context.issueFlag)).toBe(true)
  })

  it('設定ファイルが無いとき、有効として扱い、フラグを削除する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', path.join(hookCase.temporaryPath, 'nonexistent-hooks-config.json'))
    writeFileSync(context.prFlag, '')
    writeFileSync(context.issueFlag, 'w-quick\n')
    const result = runCleanup(hookCase)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.prFlag)).toBe(false)
    expect(existsSync(context.issueFlag)).toBe(false)
  })
})
