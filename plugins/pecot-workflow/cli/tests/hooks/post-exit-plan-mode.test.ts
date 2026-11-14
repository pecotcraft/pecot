/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// post-tool-use-exit-plan-mode.sh のテスト。ExitPlanMode の後は Issue へ投稿せず、次の案内だけを返す。
// 計画の投稿は、確認を求める前にエージェントが済ませる。
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { workLayout } from './_helpers/git.js'
import { pecotBinMock } from './_helpers/mock-bin.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { jsonDumps, parseJson } from './_helpers/text.js'

const HOOK_SCRIPT = path.join(hooksDirectory, 'post-tool-use-exit-plan-mode.sh')
const EXIT_PLAN = jsonDumps({ tool_name: 'ExitPlanMode' })

interface Context {
  readonly project: string
  readonly pecotActive: string
  readonly quickMode: string
  readonly marker: string
}

function setUpContext(hookCase: HookCase): Context {
  const project = path.join(hookCase.temporaryPath, 'project')
  const plugin = path.join(hookCase.temporaryPath, 'plugin')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })

  const copied = path.join(plugin, 'hooks', 'templates')
  mkdirSync(copied, { recursive: true })
  for (const name of ['exit-plan-implementer-remind.md', 'exit-plan-comment-update.md']) {
    copyFileSync(path.join(hooksDirectory, 'templates', name), path.join(copied, name))
  }
  const mock = pecotBinMock(hookCase)
  mock.install(plugin)

  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  hookCase.setEnv('CLAUDE_PLUGIN_ROOT', plugin)
  hooksConfig(hookCase).write({})
  return {
    project,
    pecotActive: path.join(stateDirectory, '.pecot-active'),
    quickMode: path.join(stateDirectory, '.pecot-quick-mode'),
    marker: mock.marker,
  }
}

function runHook(hookCase: HookCase, stdin: string): RunResult {
  return run(hookCase, 'bash', [HOOK_SCRIPT], { stdin })
}

function property(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
}

// hookSpecificOutput.additionalContext の文字列を取り出す。
function additionalContext(result: RunResult): string {
  const output = property(parseJson(result.stdout), 'hookSpecificOutput')
  const context = property(output, 'additionalContext')
  if (typeof context !== 'string') throw new TypeError(`additionalContext が文字列ではありません: ${result.stdout}`)
  return context
}

describe('post-tool-use-exit-plan-mode.sh', () => {
  it('pecot-active が無いとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpContext(hookCase)
    const result = runHook(hookCase, EXIT_PLAN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('pecot を使っていないリポジトリ（.pecot が無い）では、何も書かず .pecot も作らない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    rmSync(path.join(context.project, '.pecot'), { recursive: true })
    const result = runHook(hookCase, EXIT_PLAN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(context.project, '.pecot'))).toBe(false)
  })

  it('共有モードでは、コメントの更新と implementer への引き継ぎを案内する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.pecotActive, 'org/repo/123\n')
    const result = runHook(hookCase, EXIT_PLAN)
    expect(result.exitCode).toBe(0)
    const text = additionalContext(result)
    expect(text).toContain('Plan comment update')
    expect(text).toContain('MCP tool issue_comment')
    expect(text).toContain('Implementation handoff')
    expect(text).toContain('Committing is main\'s responsibility')
    expect(text).not.toContain('team_name')
  })

  it('implementer への引き継ぎは、計画の作業単位のモデルを渡すよう案内し、Copilot CLI では省くよう示す', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.pecotActive, 'org/repo/123\n')
    const text = additionalContext(runHook(hookCase, EXIT_PLAN))
    expect(text).toContain('the model the plan gives')
    expect(text).not.toMatch(/^\s*model: sonnet\s*$/mu)
    expect(text).toContain('skills/w-help/references/agent-models.md')
    expect(text).toContain('In GitHub Copilot CLI, omit `model`.')
  })

  it('Copilot の tool 名 exit_plan_mode でも、コメントの更新と引き継ぎを案内する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.pecotActive, 'org/repo/123\n')
    const result = runHook(hookCase, jsonDumps({ tool_name: 'exit_plan_mode' }))
    expect(result.exitCode).toBe(0)
    const text = additionalContext(result)
    expect(text).toContain('Plan comment update')
    expect(text).toContain('Implementation handoff')
  })

  it('exit_plan のような別の tool 名では、何も出力しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.pecotActive, 'org/repo/123\n')
    writeFileSync(context.quickMode, '')
    const result = runHook(hookCase, jsonDumps({ tool_name: 'exit_plan' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(context.quickMode)).toBe(true)
  })

  it.for(['ExitPlanMode', 'exit_plan_mode'])('quick モードでは、%s でも、コメントの更新だけを案内し、quick モードのフラグを消す', (toolName) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.pecotActive, 'org/repo/123\n')
    writeFileSync(context.quickMode, '')
    const result = runHook(hookCase, jsonDumps({ tool_name: toolName }))
    expect(result.exitCode).toBe(0)
    const text = additionalContext(result)
    expect(text).toContain('Plan comment update')
    expect(text).not.toContain('Implementation handoff')
    expect(existsSync(context.quickMode)).toBe(false)
  })

  it('bin/pecot があっても、ExitPlanMode の後に Issue へ投稿しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    writeFileSync(context.pecotActive, 'org/repo/123\n')
    const result = runHook(hookCase, EXIT_PLAN)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.marker)).toBe(false)
    expect(existsSync(path.join(context.project, '.pecot', 'tmp', 'plan-post'))).toBe(false)
  })

  it('cwd が base の .pecot/work/N でも、セッションの worktree の pecot-active を読む', () => {
    const hookCase = createHookCase()
    setUpContext(hookCase)
    const layout = workLayout(hookCase)
    mkdirSync(path.join(layout.wt, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(layout.wt, '.pecot', 'state', '.pecot-active'), 'org/repo/123\n')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', layout.wt)
    const payload = jsonDumps({ tool_name: 'ExitPlanMode', cwd: path.join(layout.work, '1244') })

    const result = runHook(hookCase, payload)

    expect(result.exitCode).toBe(0)
    expect(additionalContext(result)).toContain('Plan comment update')
  })
})
