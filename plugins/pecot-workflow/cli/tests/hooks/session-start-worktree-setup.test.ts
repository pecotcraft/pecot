/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// session-start-worktree-setup.sh のテスト。Claude Code が作る worktree（.claude/worktrees/<name>）でだけ setup を流す。
// 流すのは main worktree の worktree-config.json の setup_command で、成功したら git の管理ディレクトリに印を置く。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { gitOrThrow, gitRepository } from './_helpers/git.js'
import { runHookEntry } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { readOutput } from '../../../../../libs/interface-spec/src/vitest/attach.js'

const ENTRY = 'session-start-worktree-setup.sh'
const COUNT_FILE = 'setup-count.txt'
const COUNTING_SETUP = `echo ran >> ${COUNT_FILE}`

interface Layout {
  readonly main: string
  readonly worktree: string
}

function writeWorktreeConfig(main: string, config: Readonly<Record<string, unknown>>): void {
  mkdirSync(path.join(main, '.pecot', 'config'), { recursive: true })
  writeFileSync(path.join(main, '.pecot', 'config', 'worktree-config.json'), JSON.stringify({ version: 3, links: [], ...config }))
}

const COUNTING_CONFIG = { setup_command: COUNTING_SETUP }

// main worktree と、その下の .claude/worktrees/bold-oak の worktree を作る
function claudeWorktree(hookCase: HookCase, config: Readonly<Record<string, unknown>>): Layout {
  const main = gitRepository(hookCase, 'main')
  writeWorktreeConfig(main, config)
  const worktree = path.join(main, '.claude', 'worktrees', 'bold-oak')
  gitOrThrow(hookCase, main, ['worktree', 'add', '-q', '-b', 'worktree-bold-oak', worktree])
  return { main, worktree }
}

function startSession(hookCase: HookCase, cwd: string, source = 'startup'): RunResult {
  return runHookEntry(hookCase, ENTRY, { hook_event_name: 'SessionStart', source, cwd, session_id: 's1' }, { cwd })
}

function gitPath(hookCase: HookCase, worktree: string, name: string): string {
  return gitOrThrow(hookCase, worktree, ['rev-parse', '--path-format=absolute', '--git-path', name]).stdout.trim()
}

function runCount(directory: string): number {
  const file = path.join(directory, COUNT_FILE)
  return existsSync(file) ? readOutput(file).split('\n').filter(line => line !== '').length : 0
}

describe('session-start-worktree-setup.sh', () => {
  it('.claude/worktrees/<name> の最初のセッション開始で、worktree のルートで setup を流し、印を置く', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const { worktree } = claudeWorktree(hookCase, COUNTING_CONFIG)

    const result = startSession(hookCase, worktree)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`note: ran the worktree setup command: ${COUNTING_SETUP}`)
    expect(runCount(worktree)).toBe(1)
    expect(existsSync(gitPath(hookCase, worktree, 'pecot-worktree-setup'))).toBe(true)
  })

  it('印があると、もう一度は流さない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const { worktree } = claudeWorktree(hookCase, COUNTING_CONFIG)

    startSession(hookCase, worktree)
    const second = startSession(hookCase, worktree, 'resume')

    expect(second.exitCode).toBe(0)
    expect(second.stdout).toBe('')
    expect(runCount(worktree)).toBe(1)
  })

  it('setup が失敗すると、印を置かずに warning とログのパスを出し、次のセッション開始でもう一度流す', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const { worktree } = claudeWorktree(hookCase, { setup_command: `${COUNTING_SETUP}; echo broken >&2; exit 3` })

    const first = startSession(hookCase, worktree)
    const log = gitPath(hookCase, worktree, 'pecot-worktree-setup.log')

    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('warning: the worktree setup command failed (exit 3)')
    expect(first.stdout).toContain(`log: ${log}`)
    expect(readOutput(log)).toContain('broken')
    expect(existsSync(gitPath(hookCase, worktree, 'pecot-worktree-setup'))).toBe(false)

    startSession(hookCase, worktree, 'resume')
    expect(runCount(worktree)).toBe(2)
  })

  it('setup_command_timeout を超えると、打ち切って印を置かずに warning を出す', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const { worktree } = claudeWorktree(hookCase, { setup_command: 'sleep 5', setup_command_timeout: 1 })

    const result = startSession(hookCase, worktree)

    expect(result.stdout).toContain('warning: the worktree setup command timed out after 1 seconds: sleep 5')
    expect(existsSync(gitPath(hookCase, worktree, 'pecot-worktree-setup'))).toBe(false)
  })

  it.for([
    { name: 'setup_command_timeout が無い', config: { setup_command: 'sleep 5' } },
    { name: 'setup_command_timeout がフックの上限より長い', config: { setup_command: 'sleep 5', setup_command_timeout: 1000 } },
  ])('$name と、フックの上限で打ち切って warning を出す', ({ config }) => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const { worktree } = claudeWorktree(hookCase, config)

    const result = runHookEntry(
      hookCase,
      ENTRY,
      { hook_event_name: 'SessionStart', source: 'startup', cwd: worktree, session_id: 's1' },
      { cwd: worktree, env: { PECOT_WORKTREE_SETUP_LIMIT: '1' } },
    )

    expect(result.stdout).toContain('warning: the worktree setup command timed out after 1 seconds: sleep 5')
    expect(existsSync(gitPath(hookCase, worktree, 'pecot-worktree-setup'))).toBe(false)
  })

  it('.claude/worktrees の外のサブ worktree では流さない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const main = gitRepository(hookCase, 'main')
    writeWorktreeConfig(main, { setup_command: COUNTING_SETUP })
    const worktree = path.join(hookCase.temporaryPath, 'wt1', 'main')
    gitOrThrow(hookCase, main, ['worktree', 'add', '-q', '-b', 'wt1', worktree])

    const result = startSession(hookCase, worktree)

    expect(result.stdout).toBe('')
    expect(runCount(worktree)).toBe(0)
  })

  it('main worktree では流さない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const { main } = claudeWorktree(hookCase, COUNTING_CONFIG)

    const result = startSession(hookCase, main)

    expect(result.stdout).toBe('')
    expect(runCount(main)).toBe(0)
  })

  it('compact のセッション開始では流さない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const { worktree } = claudeWorktree(hookCase, COUNTING_CONFIG)

    const result = startSession(hookCase, worktree, 'compact')

    expect(result.stdout).toBe('')
    expect(runCount(worktree)).toBe(0)
  })

  it('worktree-config.json に setup_command が無いと、何もしない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const { worktree } = claudeWorktree(hookCase, {})

    const result = startSession(hookCase, worktree)

    expect(result.stdout).toBe('')
    expect(existsSync(gitPath(hookCase, worktree, 'pecot-worktree-setup'))).toBe(false)
  })

  it('hooks-config.json で worktree-setup を切ると、流さない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase).write({ 'worktree-setup': false })
    const { worktree } = claudeWorktree(hookCase, COUNTING_CONFIG)

    const result = startSession(hookCase, worktree)

    expect(result.stdout).toBe('')
    expect(runCount(worktree)).toBe(0)
  })
})
