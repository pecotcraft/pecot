/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// hooks と pecot CLI が同じ .pecot/state を指すことの結合テスト。
// hooks には CLAUDE_PROJECT_DIR と入力 JSON の cwd が渡り、CLI には渡らず cwd の git toplevel を使う。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { builtCliProblem, cliEntry } from '../parity/built-cli.js'
import { createHookCase, hooksConfig } from './_helpers/environment.js'
import { checkoutWorkBranch, gitRepository } from './_helpers/git.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import { jsonDumps } from './_helpers/text.js'

const EXIT_PLAN_MODE_ENTRY = path.join(hooksDirectory, 'post-tool-use-exit-plan-mode.sh')

describe('post-tool-use-exit-plan-mode.sh と pecot session show', () => {
  it('hook と CLI が、ツールの cwd の git toplevel を指す', () => {
    // build 済みの Node の CLI（dist/cli.js）を使う
    expect(builtCliProblem()).toBeUndefined()
    const hookCase = createHookCase()
    hooksConfig(hookCase).write({})
    // .pecot と Issue の番号付きのブランチを持つ git リポジトリと、そのサブディレクトリ
    const repository = gitRepository(hookCase, 'worktree')
    checkoutWorkBranch(hookCase, repository, 'feat/x/123', 'https://github.com/org/repo.git')
    const stateDirectory = path.join(repository, '.pecot', 'state')
    mkdirSync(stateDirectory, { recursive: true })
    writeFileSync(path.join(repository, '.pecot', '.gitignore'), 'state/\ntmp/\n')
    const subdirectory = path.join(repository, 'plugins', 'pecot-workflow')
    mkdirSync(subdirectory, { recursive: true })
    // セッション開始時の CLAUDE_PROJECT_DIR（別ディレクトリ。こちらにも .pecot を置く）
    const sessionDirectory = path.join(hookCase.temporaryPath, 'session')
    mkdirSync(path.join(sessionDirectory, '.pecot', 'state'), { recursive: true })

    // exit-plan-remind は ExitPlanMode で .pecot-quick-mode を消す。両方に置き、消える側で解決先を見る。
    writeFileSync(path.join(stateDirectory, '.pecot-quick-mode'), 'x\n')
    writeFileSync(path.join(sessionDirectory, '.pecot', 'state', '.pecot-quick-mode'), 'x\n')
    const payload = jsonDumps({ session_id: 'sess-1185', tool_name: 'ExitPlanMode', cwd: subdirectory })

    const hook = run(hookCase, 'bash', [EXIT_PLAN_MODE_ENTRY], { stdin: payload, env: { CLAUDE_PROJECT_DIR: sessionDirectory } })
    expect(hook).toMatchObject({ exitCode: 0 })

    expect(existsSync(path.join(stateDirectory, '.pecot-quick-mode'))).toBe(false)
    expect(existsSync(path.join(sessionDirectory, '.pecot', 'state', '.pecot-quick-mode'))).toBe(true)

    // Bash ツールから呼ぶ CLI と同じ条件。CLAUDE_PROJECT_DIR なし、cwd はサブディレクトリ。
    const home = path.join(hookCase.temporaryPath, 'home')
    mkdirSync(home)
    const status = run(hookCase, process.execPath, [cliEntry, 'session', 'show', '-D', subdirectory], {
      cwd: subdirectory,
      env: { CLAUDE_PROJECT_DIR: undefined, HOME: home },
    })
    expect(status).toMatchObject({ exitCode: 0 })
    expect(status.stdout).toContain('- Active Issue: org/repo#123')
  })
})
