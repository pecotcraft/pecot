/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// session-start/git-sync.sh のテスト。upstream の無いリポジトリで git pull が失敗しても、git のエラーは stderr だけに出し、stdout に混ぜない。
// SessionStart の stdout はモデルの文脈に入る。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import { mockBin } from './_helpers/mock-bin.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'

const HOOK_SCRIPT = path.join(hooksDirectory, 'lib', 'session-start', 'git-sync.sh')

describe('git-sync.sh', () => {
  it('upstream が無く pull に失敗しても、stdout を空に保ち、エラーは stderr だけに出す', () => {
    const hookCase = createHookCase()
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
    // uvx の有無に依存しないよう、スタブを PATH の先頭に置く
    mockBin(hookCase).install('uvx', '#!/bin/sh\nexit 0\n')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
    hooksConfig(hookCase).write({ 'git-sync': true })

    const result = run(hookCase, 'bash', [HOOK_SCRIPT], { stdin: '' })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('tracking information')
  })
})
