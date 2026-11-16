/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// Copilot CLI の Skill 入力（名前空間なしのスキル名）のテスト。
// 名前空間なしの名前は、自プラグインの skills/<名前>/SKILL.md が実在するときだけ自プラグインのスキルとして扱う。
// 接頭辞だけで判定すると、他のプラグインの同名スキルを取り違えるため。
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { pluginRoot } from '../_helpers/paths.js'
import { runHookEntry } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'

// CLAUDE_PROJECT_DIR を git リポに向け、スキルの実在確認に使う CLAUDE_PLUGIN_ROOT を設定する。
function setUpProject(hookCase: HookCase): string {
  const repository = gitRepository(hookCase, 'skill-proj')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  // スキルの実在確認は CLAUDE_PLUGIN_ROOT/skills/<名前>/SKILL.md を見る。
  hookCase.setEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
  return repository
}

function runEntry(hookCase: HookCase, skill: string, cwd: string): RunResult {
  return runHookEntry(hookCase, 'pre-tool-use-skill.sh', {
    hook_event_name: 'PreToolUse',
    tool_name: 'skill',
    tool_input: { skill },
    cwd,
    session_id: 'copilot-session',
  })
}

function isDirectory(target: string): boolean {
  return existsSync(target) && statSync(target).isDirectory()
}

// PreToolUse: pecot-dir-init-detect
describe('pre-tool-use-skill.sh', () => {
  it.for([
    { label: '名前空間なし', skill: 'w-help' },
    { label: '名前空間付き', skill: 'pecot-w:w-help' },
  ])('自プラグインのスキル（$label）のとき、何も出力せず、.pecot を初期化する', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    expect(existsSync(path.join(project, '.pecot'))).toBe(false)
    const result = runEntry(hookCase, row.skill, project)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
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
    const result = runEntry(hookCase, row.skill, project)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(existsSync(path.join(project, '.pecot'))).toBe(false)
  })
})
