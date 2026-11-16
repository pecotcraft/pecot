/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// hooks が入力 JSON の cwd の git toplevel の .pecot/state を指すことのテスト。
// CLI の状態の置き場の解決は、session-show.test.ts の「--directory の toplevel がプロジェクトのルートと違う」ケースが受け持つ。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import { checkoutWorkBranch, gitRepository } from './_helpers/git.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import { jsonDumps } from './_helpers/text.js'

const EXIT_PLAN_MODE_ENTRY = path.join(hooksDirectory, 'post-tool-use-exit-plan-mode.sh')

describe('post-tool-use-exit-plan-mode.sh の状態の置き場', () => {
  it('CLAUDE_PROJECT_DIR でなく、ツールの cwd の git toplevel のブランチと設定で案内を出す', () => {
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
    const sessionDirectory = gitRepository(hookCase, 'session')
    mkdirSync(path.join(sessionDirectory, '.pecot', 'state'), { recursive: true })

    // セッション側は main ブランチにする。解決先が違えば、案内は出ない。
    checkoutWorkBranch(hookCase, sessionDirectory, 'main')
    const payload = jsonDumps({ session_id: 'sess-1185', tool_name: 'ExitPlanMode', cwd: subdirectory })

    const hook = run(hookCase, 'bash', [EXIT_PLAN_MODE_ENTRY, '--mode=active'], { stdin: payload, env: { CLAUDE_PROJECT_DIR: sessionDirectory } })
    expect(hook).toMatchObject({ exitCode: 0 })
    expect(hook.stdout).toContain('Plan comment update')
  })
})
