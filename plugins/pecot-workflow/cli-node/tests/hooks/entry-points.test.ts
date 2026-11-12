/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// post-tool-use-bash.sh と post-tool-use-skill.sh のエントリの統合テスト。JSON を stdin に流し、hookSpecificOutput への注入を確かめる。
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { gitRepository } from './_helpers/git.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { jsonDumps } from './_helpers/text.js'

const ENTRY_BASH = path.join(hooksDirectory, 'post-tool-use-bash.sh')
const ENTRY_SKILL = path.join(hooksDirectory, 'post-tool-use-skill.sh')

// リポジトリを作り、CLAUDE_PROJECT_DIR をそこへ向ける。
// 設定は auto-push=false、commit-info-display=true、pecot-skill-reminder=true。
function setUpRepository(hookCase: HookCase): string {
  hooksConfig(hookCase).write({
    'auto-push': false,
    'commit-info-display': true,
    'pecot-skill-reminder': true,
  })
  const repository = gitRepository(hookCase)
  // commit-info-display が git log -1 を使うので、意味のあるコミットを作る
  writeFileSync(path.join(repository, 'test-file.txt'), 'test content\n')
  expect(run(hookCase, 'git', ['-C', repository, 'add', 'test-file.txt']).exitCode).toBe(0)
  expect(run(hookCase, 'git', ['-C', repository, 'commit', '--quiet', '-m', 'feat: add auth']).exitCode).toBe(0)
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  return repository
}

function runEntry(hookCase: HookCase, script: string, stdin: string, cwd: string): RunResult {
  return run(hookCase, 'bash', [script], { stdin, cwd })
}

describe('post-tool-use-bash.sh', () => {
  it('commit が成功したとき、commit 完了の案内を hookSpecificOutput に入れる', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const input = jsonDumps({
      tool_input: { command: 'git commit -m "feat: add auth"' },
      tool_response: {
        stdout: '[feat/test abc1234] feat: add auth\n 1 file changed, 1 insertion(+)',
        interrupted: false,
      },
    })
    const result = runEntry(hookCase, ENTRY_BASH, input, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('note: commit complete')
    expect(result.stdout).toContain('hookSpecificOutput')
  })

  it('commit 以外のコマンドのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const input = jsonDumps({
      tool_input: { command: 'git status' },
      tool_response: {
        stdout: 'On branch main\nnothing to commit',
        interrupted: false,
      },
    })
    const result = runEntry(hookCase, ENTRY_BASH, input, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})

describe('post-tool-use-skill.sh', () => {
  it('pecot のスキルが起動されたとき、ワークフローの案内を hookSpecificOutput に入れる', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const result = runEntry(hookCase, ENTRY_SKILL, '{"tool_input":{"skill":"pecot-w"}}', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('note: pecot-workflow skill started')
    expect(result.stdout).toContain('hookSpecificOutput')
  })

  it('pecot 以外のスキルが起動されたとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const result = runEntry(hookCase, ENTRY_SKILL, '{"tool_input":{"skill":"other-skill"}}', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
