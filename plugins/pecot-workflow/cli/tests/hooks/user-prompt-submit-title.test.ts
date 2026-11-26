/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// user-prompt-submit-title.sh のテスト。エントリを起動し、ブランチ名と remote から求めた作業中の Issue で sessionTitle を出す。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { checkoutWorkBranch, gitRepository } from './_helpers/git.js'
import { runHookEntry } from './_helpers/run.js'
import { parseJson } from './_helpers/text.js'
import { explains } from '../_helpers/explains.js'

const ENTRY = 'user-prompt-submit-title.sh'

// 作業中の Issue のブランチにいるプロジェクトを作り、入力に使う cwd を返す。
function setUpProject(hookCase: HookCase, branch = 'feat/x/7'): string {
  const project = gitRepository(hookCase)
  checkoutWorkBranch(hookCase, project, branch)
  const state = path.join(project, '.pecot', 'state')
  mkdirSync(state, { recursive: true })
  writeFileSync(path.join(project, '.pecot', '.gitignore'), '*\n')
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
  it('作業対象の Issue があるとき、題名を sessionTitle に出す', async () => {
    await explains('`user-prompt-submit-title.sh` のテストです。作業中の Issue のブランチで実行した場合に、題名（`#7 題名`）を `sessionTitle` として出力することを確認します。')
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runHookEntry(hookCase, ENTRY, payload(project, ''))
    expect(result.exitCode).toBe(0)
    expect(parseJson(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: '#7 題名' },
    })
  })

  it('別の番号の .pecot-active があっても読まず、ブランチの番号で出す', async () => {
    await explains('`user-prompt-submit-title.sh` のテストです。別の番号の `.pecot-active` がある場合でも、それを読まずに、ブランチの番号の題名を出力することを確認します。')
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    writeFileSync(path.join(project, '.pecot', 'state', '.pecot-active'), 'owner/repo/1\n')
    const result = runHookEntry(hookCase, ENTRY, payload(project, ''))
    expect(parseJson(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: '#7 題名' },
    })
  })

  it('作業中の Issue のブランチでないとき、.pecot-active があっても何も出力しない', async () => {
    await explains('`user-prompt-submit-title.sh` のテストです。作業中の Issue のブランチでない場合は、`.pecot-active` があっても、何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpProject(hookCase, 'main')
    writeFileSync(path.join(project, '.pecot', 'state', '.pecot-active'), 'owner/repo/7\n')
    const result = runHookEntry(hookCase, ENTRY, payload(project, ''))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('入力のセッション名が題名と同じとき、何も出力しない', async () => {
    await explains('`user-prompt-submit-title.sh` のテストです。入力のセッション名がすでに題名と同じ場合に、何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runHookEntry(hookCase, ENTRY, payload(project, '#7 題名'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
