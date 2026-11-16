/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// user-prompt-submit.sh（エントリ）のテスト。pecot のコマンドでも、決まりの注入と起票待ちのフラグを作らない（spec 025 FR-010）。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { runHookEntry } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'

const ENTRY = 'user-prompt-submit.sh'

// 同期済みの印は、.pecot の初期化（変えない振る舞い）が書くので、先に置いておく。
const SYNC_MARKER = '.plugin-sync-version'

// .pecot/state を持つリポを作り、そのパスを返す。
function setUpRepository(hookCase: HookCase): string {
  const repository = gitRepository(hookCase, 'project')
  mkdirSync(path.join(repository, '.pecot', 'state'), { recursive: true })
  writeFileSync(path.join(repository, '.pecot', 'state', SYNC_MARKER), '')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  return repository
}

function runEntry(hookCase: HookCase, repository: string, prompt: string): RunResult {
  return runHookEntry(hookCase, ENTRY, { hook_event_name: 'UserPromptSubmit', cwd: repository, session_id: 's', prompt }, { cwd: repository })
}

describe('user-prompt-submit.sh', () => {
  it.for([
    { label: '/pecot-w:w-quick', prompt: '/pecot-w:w-quick README の誤字を直す' },
    { label: '/w-ready', prompt: '/w-ready' },
    { label: '/pecot-w:w-active', prompt: '/pecot-w:w-active' },
    { label: '通常の文', prompt: 'hello world' },
  ])('プロンプトが $label のとき、何も出さず、起票待ちのフラグを作らない', (row) => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const result = runEntry(hookCase, repository, row.prompt)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    const state = path.join(repository, '.pecot', 'state')
    expect(existsSync(path.join(state, 'issue-pending'))).toBe(false)
    expect(readdirSync(state)).toEqual([SYNC_MARKER])
  })
})
