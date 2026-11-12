/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// user-prompt-submit-title.sh のテスト。エントリを起動し、state の作業対象から sessionTitle を出す。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { gitRepository } from './_helpers/git.js'
import { runHookEntry } from './_helpers/run.js'
import { parseJson } from './_helpers/text.js'

const ENTRY = 'user-prompt-submit-title.sh'

// 作業対象の Issue を持つプロジェクトを作り、入力に使う cwd を返す。
function setUpProject(hookCase: HookCase): string {
  const project = gitRepository(hookCase)
  const state = path.join(project, '.pecot', 'state')
  mkdirSync(state, { recursive: true })
  writeFileSync(path.join(project, '.pecot', '.gitignore'), '*\n')
  writeFileSync(path.join(state, '.pecot-active'), 'owner/repo/7\n')
  writeFileSync(path.join(state, '.pecot-session-title'), '#7 題名\n')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  return project
}

function payload(cwd: string, sessionTitle: string): Record<string, unknown> {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 's1',
    transcript_path: '/t/s.jsonl',
    cwd,
    prompt: 'こんにちは',
    session_title: sessionTitle,
  }
}

describe('user-prompt-submit-title.sh', () => {
  it('作業対象の Issue があるとき、題名を sessionTitle に出す', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runHookEntry(hookCase, ENTRY, payload(project, ''))
    expect(result.exitCode).toBe(0)
    expect(parseJson(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: '#7 題名' },
    })
  })

  it('入力のセッション名が題名と同じとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runHookEntry(hookCase, ENTRY, payload(project, '#7 題名'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
