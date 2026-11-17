/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// post-tool-use-exit-plan-mode.sh のテスト。ExitPlanMode の後は Issue へ投稿せず、次の案内だけを返す。
// 計画の投稿は、確認を求める前にエージェントが済ませる。
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { checkoutWorkBranch, gitRepository, workLayout } from './_helpers/git.js'
import { pecotBinMock } from './_helpers/mock-bin.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { jsonDumps, parseJson } from './_helpers/text.js'

const HOOK_SCRIPT = path.join(hooksDirectory, 'post-tool-use-exit-plan-mode.sh')
const EXIT_PLAN = jsonDumps({ tool_name: 'ExitPlanMode' })

interface Context {
  readonly project: string
  readonly quickMode: string
  readonly marker: string
}

function setUpContext(hookCase: HookCase): Context {
  const project = gitRepository(hookCase, 'project')
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
    quickMode: path.join(stateDirectory, '.pecot-quick-mode'),
    marker: mock.marker,
  }
}

// 作業中の Issue（ブランチ feat/x/123 と remote）を用意する。
function activate(hookCase: HookCase, context: Context): void {
  checkoutWorkBranch(hookCase, context.project, 'feat/x/123')
}

function runHook(hookCase: HookCase, stdin: string, mode = 'active'): RunResult {
  return run(hookCase, 'bash', [HOOK_SCRIPT, ...(mode === '' ? [] : [mode.startsWith('--') ? mode : `--mode=${mode}`])], { stdin })
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
  it('作業中の Issue が無いとき、.pecot-active があっても何も出力しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    checkoutWorkBranch(hookCase, context.project, 'main')
    writeFileSync(path.join(context.project, '.pecot', 'state', '.pecot-active'), 'org/repo/123\n')
    const result = runHook(hookCase, EXIT_PLAN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('pecot を使っていないリポジトリ（.pecot が無い）では、作業中の Issue のブランチでも、何も出さず .pecot も作らない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    checkoutWorkBranch(hookCase, context.project, 'x/1')
    rmSync(path.join(context.project, '.pecot'), { recursive: true })
    const result = runHook(hookCase, EXIT_PLAN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(context.project, '.pecot'))).toBe(false)
  })

  it('共有モードでは、コメントの更新と implementer への引き継ぎを案内する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
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
    activate(hookCase, context)
    const text = additionalContext(runHook(hookCase, EXIT_PLAN))
    expect(text).toContain('the model the plan gives')
    expect(text).not.toMatch(/^\s*model: sonnet\s*$/mu)
    expect(text).toContain('skills/w-help/references/agent-models.md')
    expect(text).toContain('In GitHub Copilot CLI, omit `model`.')
  })

  it('implementer への引き継ぎは、委譲する条件の置き場を示し、条件に当たらない単位を main が実装すると案内する', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    const text = additionalContext(runHook(hookCase, EXIT_PLAN))
    expect(text).toContain('subagent-usage.md')
    expect(text).toContain('main implements a unit unless it meets the delegation conditions.')
    expect(text).toContain('Do not spawn an agent for such a unit.')
  })

  it('Copilot の tool 名 exit_plan_mode では、何も出力しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    const result = runHook(hookCase, jsonDumps({ tool_name: 'exit_plan_mode' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('exit_plan のような別の tool 名では、何も出力しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    writeFileSync(context.quickMode, '')
    const result = runHook(hookCase, jsonDumps({ tool_name: 'exit_plan' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(context.quickMode)).toBe(true)
  })

  it('--mode=quick では、コメントの更新だけを案内し、実装の引き継ぎを足さない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    const result = runHook(hookCase, EXIT_PLAN, 'quick')
    expect(result.exitCode).toBe(0)
    const text = additionalContext(result)
    expect(text).toContain('Plan comment update')
    expect(text).not.toContain('Implementation handoff')
  })

  it.for(['active', 'quick'])('--mode=%s では、承認の後に止まらず実装へ進むよう案内する', (mode) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    const text = additionalContext(runHook(hookCase, EXIT_PLAN, mode))
    expect(text).toContain('go on to implement the plan in the same turn')
    expect(text).toContain('do not stop to ask')
  })

  it('.pecot-quick-mode があっても、--mode=active では引き継ぎを案内し、ファイルを読まず消さない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    writeFileSync(context.quickMode, '')
    const result = runHook(hookCase, EXIT_PLAN, 'active')
    expect(result.exitCode).toBe(0)
    expect(additionalContext(result)).toContain('Implementation handoff')
    expect(existsSync(context.quickMode)).toBe(true)
  })

  it.for([{ label: '無い', mode: '' }, { label: '不正', mode: 'both' }])('--mode が $label とき、終了コード 1 で stdout は空', ({ mode }) => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    const result = runHook(hookCase, EXIT_PLAN, mode)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('exit-plan-remind: --mode must be active or quick')
  })

  it('出力のトップレベルに additionalContext が無い（merge を通さない）', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    const parsed = parseJson(runHook(hookCase, EXIT_PLAN).stdout)
    expect(property(parsed, 'additionalContext')).toBeUndefined()
    expect(property(property(parsed, 'hookSpecificOutput'), 'hookEventName')).toBe('PostToolUse')
  })

  it('解決したルートの hooks-config.json で exit-plan-remind が false なら、何も出力しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    // PECOT_HOOKS_CONFIG_PATH は渡さず、CLAUDE_PROJECT_DIR は別のディレクトリにする。
    hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', undefined)
    const sessionDirectory = path.join(hookCase.temporaryPath, 'session')
    mkdirSync(sessionDirectory, { recursive: true })
    hookCase.setEnv('CLAUDE_PROJECT_DIR', sessionDirectory)
    const configDirectory = path.join(context.project, '.pecot', 'config')
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(path.join(configDirectory, 'hooks-config.json'), jsonDumps({ 'exit-plan-remind': false }))
    const payload = jsonDumps({ tool_name: 'ExitPlanMode', cwd: context.project })
    const result = runHook(hookCase, payload)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('bin/pecot があっても、ExitPlanMode の後に Issue へ投稿しない', () => {
    const hookCase = createHookCase()
    const context = setUpContext(hookCase)
    activate(hookCase, context)
    const result = runHook(hookCase, EXIT_PLAN)
    expect(result.exitCode).toBe(0)
    expect(existsSync(context.marker)).toBe(false)
    expect(existsSync(path.join(context.project, '.pecot', 'tmp', 'plan-post'))).toBe(false)
  })

  it('cwd が base の .pecot/work/N でも、セッションの worktree のブランチで判定する', () => {
    const hookCase = createHookCase()
    setUpContext(hookCase)
    const layout = workLayout(hookCase)
    mkdirSync(path.join(layout.wt, '.pecot', 'state'), { recursive: true })
    checkoutWorkBranch(hookCase, layout.wt, 'x/123')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', layout.wt)
    const payload = jsonDumps({ tool_name: 'ExitPlanMode', cwd: path.join(layout.work, '1244') })

    const result = runHook(hookCase, payload)

    expect(result.exitCode).toBe(0)
    expect(additionalContext(result)).toContain('Plan comment update')
  })
})
