/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// Copilot CLI の Skill 入力（名前空間なしのスキル名）のテスト。
// 名前空間なしの名前は、自プラグインの skills/<名前>/SKILL.md が実在するときだけ自プラグインのスキルとして扱う。
// 接頭辞だけで判定すると、他のプラグインの同名スキルを取り違えるため。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { toRecord } from '../_helpers/json.js'
import { pluginRoot } from '../_helpers/paths.js'
import { runHookEntry } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { containing, parseJson } from '../_helpers/text.js'

// CLAUDE_PROJECT_DIR を git リポに向け、スキルの実在確認に使う CLAUDE_PLUGIN_ROOT を設定する。
function setUpProject(hookCase: HookCase): string {
  const repository = gitRepository(hookCase, 'skill-proj')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  // スキルの実在確認は CLAUDE_PLUGIN_ROOT/skills/<名前>/SKILL.md を見る。
  hookCase.setEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
  return repository
}

function runEntry(hookCase: HookCase, entry: string, event: string, skill: string, cwd: string, extra: Readonly<Record<string, unknown>> = {}): RunResult {
  return runHookEntry(hookCase, entry, {
    hook_event_name: event,
    tool_name: 'skill',
    tool_input: { skill },
    cwd,
    session_id: 'copilot-session',
    ...extra,
  })
}

function isDirectory(target: string): boolean {
  return existsSync(target) && statSync(target).isDirectory()
}

// PreToolUse: pecot-skill-compliance / pecot-dir-init-detect
describe('pre-tool-use-skill.sh', () => {
  it.for([
    { label: '名前空間なし', skill: 'w-help' },
    { label: '名前空間付き', skill: 'pecot-w:w-help' },
  ])('自プラグインのスキル（$label）のとき、ワークフローの注意を注入する', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runEntry(hookCase, 'pre-tool-use-skill.sh', 'PreToolUse', row.skill, project)
    expect(result.exitCode).toBe(0)
    const specific = toRecord(toRecord(parseJson(result.stdout), '出力')['hookSpecificOutput'], 'hookSpecificOutput')
    expect(specific['hookEventName']).toBe('PreToolUse')
    expect(specific).toMatchObject({ additionalContext: containing('note: notes for the pecot-workflow skills') })
  })

  it('名前空間なしの自プラグインのスキルのとき、.pecot を初期化する', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    expect(existsSync(path.join(project, '.pecot'))).toBe(false)
    runEntry(hookCase, 'pre-tool-use-skill.sh', 'PreToolUse', 'w-help', project)
    expect(isDirectory(path.join(project, '.pecot'))).toBe(true)
  })

  it.for([
    // pecot-visual のスキル（pecot-workflow の skills/ に無い）
    { label: 'pecot-visual のスキル', skill: 'v-slidev' },
    // `w-` で始まるが実在しない
    { label: 'w- で始まるが実在しないスキル', skill: 'w-no-such-skill' },
    // パス遡上
    { label: 'パス遡上', skill: '../hooks' },
    // 他の名前空間
    { label: '他の名前空間', skill: 'pecot-v:v-slidev' },
    { label: '空文字', skill: '' },
  ])('このプラグインのものでないスキル（$label）のとき、何も出力せず、.pecot も作らない', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runEntry(hookCase, 'pre-tool-use-skill.sh', 'PreToolUse', row.skill, project)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(project, '.pecot'))).toBe(false)
  })
})

// PostToolUse: pecot-skill-reminder
describe('post-tool-use-skill.sh', () => {
  it('名前空間なしの w-quick のとき、issue-pending を立てて注意を出す', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    mkdirSync(path.join(project, '.pecot', 'state'), { recursive: true })
    const result = runEntry(hookCase, 'post-tool-use-skill.sh', 'PostToolUse', 'w-quick', project, {
      tool_result: { result_type: 'success', text_result_for_llm: 'Skill "w-quick" loaded' },
    })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(path.join(project, '.pecot', 'state', 'issue-pending'), 'utf8').trim()).toBe('w-quick')
    const out = toRecord(parseJson(result.stdout), '出力')
    const specific = toRecord(out['hookSpecificOutput'], 'hookSpecificOutput')
    expect(specific).toMatchObject({ additionalContext: containing('note: pecot-workflow skill started') })
    // Copilot CLI の PostToolUse はトップレベルの additionalContext だけをモデルに渡す。
    expect(out['additionalContext']).toBe(specific['additionalContext'])
    expect(out).toMatchObject({ additionalContext: containing('note: pecot-workflow skill started') })
  })

  it('名前空間なしの w-help のとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    mkdirSync(path.join(project, '.pecot', 'state'), { recursive: true })
    const result = runEntry(hookCase, 'post-tool-use-skill.sh', 'PostToolUse', 'w-help', project)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(project, '.pecot', 'state', 'issue-pending'))).toBe(false)
  })

  it('同じ接頭辞の他プラグインのスキルは、自プラグインのものとして扱わない', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    mkdirSync(path.join(project, '.pecot', 'state'), { recursive: true })
    const result = runEntry(hookCase, 'post-tool-use-skill.sh', 'PostToolUse', 'w-quick-clone', project)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(project, '.pecot', 'state', 'issue-pending'))).toBe(false)
  })

  // 案内は ExitPlanMode（Claude）でも exit_plan_mode（Copilot）でも merge を通る。
  // Copilot CLI が読むトップレベルの additionalContext に出る。
  it.for(['ExitPlanMode', 'exit_plan_mode'])('%s の案内を、トップレベルの additionalContext に出す', (toolName) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    mkdirSync(path.join(project, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(project, '.pecot', 'state', '.pecot-active'), 'org/repo/1\n')
    const result = runEntry(hookCase, 'post-tool-use-exit-plan-mode.sh', 'PostToolUse', 'x', project, { tool_name: toolName })
    expect(result.exitCode).toBe(0)
    const out = toRecord(parseJson(result.stdout), '出力')
    const specific = toRecord(out['hookSpecificOutput'], 'hookSpecificOutput')
    expect(out).toMatchObject({ additionalContext: containing('Plan comment update') })
    expect(specific['additionalContext']).toBe(out['additionalContext'])
    expect(specific['hookEventName']).toBe('PostToolUse')
  })
})
