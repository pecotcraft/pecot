/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// exit-plan-remind.sh の tool 名ガードのテスト。
// Copilot CLI は matcher を honor せず全ツールで発火する。
// そのため冒頭の tool 名ガードで、ExitPlanMode と exit_plan_mode 以外を弾く。
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { runScript } from '../_helpers/run.js'

const EXIT_PLAN_REMIND = path.join(hooksDirectory, 'lib', 'post-tool-use', 'exit-plan-remind.sh')

// 一時ディレクトリそのものを project にし、.pecot/state を作る。
function setUpGuard(hookCase: HookCase): string {
  const stateDirectory = path.join(hookCase.temporaryPath, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', hookCase.temporaryPath)
  return stateDirectory
}

describe('exit-plan-remind.sh', () => {
  it('Copilot CLI の bash ツールのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const stateDirectory = setUpGuard(hookCase)
    writeFileSync(path.join(stateDirectory, '.pecot-active'), 'org/repo/1\n')
    const result = runScript(hookCase, EXIT_PLAN_REMIND, [], { stdin: '{"tool_name":"bash","tool_input":{"command":"ls"}}' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('Copilot CLI の exit_plan_mode のとき、ガードを通って quick-mode のフラグを消す', () => {
    const hookCase = createHookCase()
    const stateDirectory = setUpGuard(hookCase)
    const quickMode = path.join(stateDirectory, '.pecot-quick-mode')
    writeFileSync(quickMode, '')
    const result = runScript(hookCase, EXIT_PLAN_REMIND, [], { stdin: '{"tool_name":"exit_plan_mode"}' })
    expect(result.exitCode).toBe(0)
    expect(existsSync(quickMode)).toBe(false)
  })

  it('Bash ツールのとき、quick-mode のフラグを残す', () => {
    const hookCase = createHookCase()
    const stateDirectory = setUpGuard(hookCase)
    const quickMode = path.join(stateDirectory, '.pecot-quick-mode')
    writeFileSync(quickMode, '')
    const result = runScript(hookCase, EXIT_PLAN_REMIND, [], { stdin: '{"tool_name":"Bash"}' })
    expect(result.exitCode).toBe(0)
    expect(existsSync(quickMode) && statSync(quickMode).isFile()).toBe(true)
  })
})
