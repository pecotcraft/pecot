/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// session-start/git-sync.sh のテスト。upstream の無いリポジトリで git pull が失敗しても、git のエラーは stderr だけに出し、stdout に混ぜない。
// SessionStart の stdout はモデルの文脈に入る。初期値は無効で、設定で有効にしたときだけ pull する。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { installGitCallLog } from './_helpers/git.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import { explains } from '../_helpers/explains.js'

const HOOK_SCRIPT = path.join(hooksDirectory, 'lib', 'session-start', 'git-sync.sh')

// upstream の無いリポジトリを作り、CLAUDE_PROJECT_DIR に向ける。
function setUpProject(hookCase: HookCase): void {
  const project = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(project)
  const gitEnvironment = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  expect(run(hookCase, 'git', ['init', '-q', '-b', 'main'], { cwd: project }).exitCode).toBe(0)
  expect(run(hookCase, 'git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: project, env: gitEnvironment }).exitCode).toBe(0)
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
}

describe('git-sync.sh', () => {
  it('upstream が無く pull に失敗しても、stdout を空に保ち、エラーは stderr だけに出す', async () => {
    await explains('`git-sync.sh` のテストです。upstream が無く `git pull` が失敗する場合に、標準出力を空に保ち、git のエラーを標準エラー出力だけへ出すことを確認します。')
    const hookCase = createHookCase()
    setUpProject(hookCase)
    hooksConfig(hookCase).write({ 'git-sync': true })

    const result = run(hookCase, 'bash', [HOOK_SCRIPT], { stdin: '' })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('tracking information')
  })

  it('設定が無いとき、pull しない', async () => {
    await explains('`git-sync.sh` のテストです。設定ファイルが存在しない場合に、`git pull` を呼ばず、標準出力と標準エラー出力のどちらも空であることを確認します。')
    const hookCase = createHookCase()
    setUpProject(hookCase)
    hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', path.join(hookCase.temporaryPath, 'missing.json'))
    const gitCallLog = installGitCallLog(hookCase)

    const result = run(hookCase, 'bash', [HOOK_SCRIPT], { stdin: '' })

    expect(result.exitCode).toBe(0)
    expect(gitCallLog.count('pull')).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })
})
