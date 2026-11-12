/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pre-tool-use.sh のテスト。Issue 起票忘れのリマインダーだけを返す。Bash は pre-tool-use-bash.sh が受け持つ。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { workLayout } from './_helpers/git.js'
import { runHookEntry } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { containing, parseJson } from './_helpers/text.js'

function runHook(hookCase: HookCase, payload: Readonly<Record<string, unknown>>): RunResult {
  return runHookEntry(hookCase, 'pre-tool-use.sh', { hook_event_name: 'PreToolUse', ...payload })
}

// CLAUDE_PROJECT_DIR を tmp/project に向け、issue-pending のパスを返す。
function setUpProject(hookCase: HookCase): string {
  const project = path.join(hookCase.temporaryPath, 'project')
  const stateDirectory = path.join(project, '.pecot', 'state')
  mkdirSync(stateDirectory, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  return path.join(stateDirectory, 'issue-pending')
}

describe('pre-tool-use.sh', () => {
  it('フラグが無いとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpProject(hookCase)
    const result = runHook(hookCase, { tool_name: 'Edit', tool_input: { file_path: '/x' } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.for([
    { label: 'Edit', tool_name: 'Edit', tool_input: { file_path: '/work/a.py' } },
    { label: 'Write', tool_name: 'Write', tool_input: { file_path: '/work/a.py' } },
    { label: 'MultiEdit', tool_name: 'MultiEdit', tool_input: { file_path: '/work/a.py' } },
    { label: 'NotebookEdit', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/work/a.ipynb' } },
    { label: 'EnterPlanMode', tool_name: 'EnterPlanMode', tool_input: {} },
    // Copilot CLI の Edit は tool_input.path（file_path ではない）
    { label: 'Copilot CLI の Edit', tool_name: 'Edit', tool_input: { path: '/work/a.py', old_str: 'a', new_str: 'b' } },
  ])('Issue 起票が済んでいないとき、$label にはリマインダーを返す', (row) => {
    const hookCase = createHookCase()
    writeFileSync(setUpProject(hookCase), 'w-quick\n')
    const result = runHook(hookCase, { tool_name: row.tool_name, tool_input: row.tool_input })
    expect(result.exitCode).toBe(0)
    expect(parseJson(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: containing('warning: Issue filing is not complete'),
      },
    })
  })

  it('.pecot/tmp/output 配下への書き込みは、リマインダーの対象外にする', () => {
    const hookCase = createHookCase()
    writeFileSync(setUpProject(hookCase), 'w-quick\n')
    const result = runHook(hookCase, { tool_name: 'Write', tool_input: { file_path: '/p/.pecot/tmp/output/x.md' } })
    expect(result.stdout).toBe('')
  })

  it('tool_input が文字列の apply_patch でも、落ちずに Edit 扱いでリマインドする', () => {
    const hookCase = createHookCase()
    writeFileSync(setUpProject(hookCase), 'w-quick\n')
    const result = runHook(hookCase, { tool_name: 'Edit', tool_input: '*** Begin Patch\n...' })
    expect(result.exitCode).toBe(0)
    expect(parseJson(result.stdout)).toMatchObject({
      hookSpecificOutput: { additionalContext: containing('warning: Issue filing is not complete') },
    })
  })

  it('cwd が base の .pecot/work/N でも、セッションの worktree の state を読み、base の issue-pending は無視する', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    mkdirSync(path.join(layout.base, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(layout.base, '.pecot', 'state', 'issue-pending'), 'w-ready\n')
    mkdirSync(path.join(layout.wt, '.pecot', 'state'), { recursive: true })
    hookCase.setEnv('CLAUDE_PROJECT_DIR', layout.wt)

    const result = runHook(hookCase, {
      tool_name: 'Write',
      tool_input: { file_path: '/work/a.py' },
      cwd: path.join(layout.work, '1244'),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('セッションが base なら、cwd が base の .pecot/work/N でも base の issue-pending を読んでリマインドする', () => {
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    mkdirSync(path.join(layout.base, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(layout.base, '.pecot', 'state', 'issue-pending'), 'w-ready\n')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', layout.base)

    const result = runHook(hookCase, {
      tool_name: 'Write',
      tool_input: { file_path: '/work/a.py' },
      cwd: path.join(layout.work, '1244'),
    })
    expect(parseJson(result.stdout)).toMatchObject({
      hookSpecificOutput: { additionalContext: containing('warning: Subtask Issue filing is not complete.') },
    })
  })
})
