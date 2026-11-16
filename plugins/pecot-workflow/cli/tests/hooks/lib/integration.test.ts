/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// エントリ sh 経由の統合テスト。pre-tool-use-bash.sh を通して、コアスクリプトの deny・許可・警告の挙動を確かめる。
// Copilot CLI も同じエントリを通る。
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { coreDirectory } from '../_helpers/paths.js'
import { run, runHookEntry } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'

const ENTRY = 'pre-tool-use-bash.sh'

function checkout(hookCase: HookCase, repository: string, branch: string): void {
  const result = run(hookCase, 'git', ['-C', repository, 'checkout', '-b', branch, '--quiet'])
  if (result.exitCode !== 0) throw new Error(`git checkout が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
}

// CLAUDE_PROJECT_DIR を tmp/project に向けた空のプロジェクトを作る。
function setUpEmptyProject(hookCase: HookCase): string {
  const project = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(project)
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  return project
}

// Copilot CLI 1.0.103 の PreToolUse 入力（PascalCase 定義では snake_case で、ツール名は Claude と同じ）。
function copilotToolPayload(command: string): Readonly<Record<string, unknown>> {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 'copilot-session',
  }
}

function runEntry(hookCase: HookCase, payload: Readonly<Record<string, unknown>>, cwd?: string): RunResult {
  return runHookEntry(hookCase, ENTRY, payload, cwd === undefined ? {} : { cwd })
}

function rowsOf(commands: readonly string[]): { readonly label: string }[] {
  return commands.map(label => ({ label }))
}

describe('統合: エントリ', () => {
  it('Claude Code のエントリで gh pr create を送るとき、deny を返す', () => {
    const hookCase = createHookCase()
    setUpEmptyProject(hookCase)
    const result = runEntry(hookCase, { tool_input: { command: 'gh pr create' } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).not.toContain('"decision"')
  })

  it('Claude Code のエントリで --no-verify を送るとき、deny を返す', () => {
    const hookCase = createHookCase()
    setUpEmptyProject(hookCase)
    const result = runEntry(hookCase, { tool_input: { command: 'git commit --no-verify' } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).not.toContain('"decision"')
    expect(result.stdout).toContain('--no-verify')
  })

  it('Claude Code のエントリで許可されるコマンドを送るとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpEmptyProject(hookCase)
    const result = runEntry(hookCase, { tool_input: { command: 'git status' } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // 入力 JSON の cwd で対象リポジトリを解決する。
  it('入力 JSON の cwd が保護ブランチの checkout を指すとき、セッション起点が feature でも deny を返す', () => {
    const hookCase = createHookCase()
    const session = gitRepository(hookCase, 'session')
    checkout(hookCase, session, 'feat/session-work')
    const target = gitRepository(hookCase, 'target')
    checkout(hookCase, target, 'wt7')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', session)
    const result = runEntry(hookCase, { cwd: target, tool_input: { command: 'git commit -m x' } }, session)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).toContain('\'wt7\'')
  })

  it('入力 JSON の cwd が feature ブランチの checkout を指すとき、セッション起点が保護ブランチでも許可する', () => {
    const hookCase = createHookCase()
    const session = gitRepository(hookCase, 'session')
    checkout(hookCase, session, 'wt7')
    const target = gitRepository(hookCase, 'target')
    checkout(hookCase, target, 'feat/target-work')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', session)
    const result = runEntry(hookCase, { cwd: target, tool_input: { command: 'git commit -m x' } }, session)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // PR のマージ・Bash の pecot・大きすぎるコマンドは止めず、何も返さない（spec 025 FR-001〜FR-008）。
  it.for(rowsOf([
    'gh pr merge 810',
    'pecot pr create ./x.md',
    'pecot issue quick -m x -r owner/repo',
    'pecot issue create x.md',
    'pecot pr create x.md --dry-run',
    '"${CLAUDE_PLUGIN_ROOT}/bin/pecot" issue show 1',
  ]))(
    'Claude Code のエントリでコマンドが $label のとき、何も出力しない',
    (row) => {
      const hookCase = createHookCase()
      setUpEmptyProject(hookCase)
      const result = runEntry(hookCase, { tool_input: { command: row.label } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    },
  )

  // ガードを通さずに素通しする。/tmp を含めると tmp-path-warner がコマンドを読み直して警告するので含めない。
  it('Claude Code のエントリでコマンドが上限のバイト数を超えるとき、何も出力しない', () => {
    const hookCase = createHookCase()
    setUpEmptyProject(hookCase)
    const command = `echo ${'x'.repeat(70_000)}`
    const result = runEntry(hookCase, { tool_input: { command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // 撤廃の前の版が作った免除のフラグは、どの判定にも使われない（FR-004）。
  it.for(rowsOf(['gh pr merge 810', 'pecot issue quick -m x -r owner/repo', 'gh pr create']))(
    '免除のフラグを残したまま $label を送っても、結果は変わらない',
    (row) => {
      const withoutFlags = createHookCase()
      setUpEmptyProject(withoutFlags)
      const expected = runEntry(withoutFlags, { tool_input: { command: row.label } })

      const hookCase = createHookCase()
      const project = setUpEmptyProject(hookCase)
      const state = path.join(project, '.pecot', 'state')
      mkdirSync(state, { recursive: true })
      for (const flag of ['pr-create-slash-pending', 'issue-create-slash-pending', 'merge-slash-pending']) {
        writeFileSync(path.join(state, flag), 'w-quick\n')
      }
      const result = runEntry(hookCase, { tool_input: { command: row.label } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(expected.stdout)
    },
  )

  it('Copilot CLI のエントリで --no-verify を送るとき、トップレベルの decision を使わず deny を返す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    const result = runEntry(hookCase, copilotToolPayload('git commit --no-verify'), repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    // Copilot CLI はトップレベルの decision を無視するため、deny は hookSpecificOutput で出す。
    expect(result.stdout).not.toContain('"decision"')
    expect(result.stdout).toContain('git-no-verify-check')
  })

  it('Copilot CLI のエントリで許可されるコマンドを送るとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    const result = runEntry(hookCase, copilotToolPayload('git status'), repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.for([
    { label: '.pecot-active があるとき', withPecotFlag: true },
    { label: '.pecot-active が無いとき', withPecotFlag: false },
  ])('Copilot CLI のエントリで gh pr create を送るとき、$label でも deny を返す', (row) => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    if (row.withPecotFlag) {
      const state = path.join(repository, '.pecot', 'state')
      mkdirSync(state, { recursive: true })
      writeFileSync(path.join(state, '.pecot-active'), '')
    }
    const result = runEntry(hookCase, copilotToolPayload('gh pr create'), repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).toContain('gh-pr-create-check')
  })

  it('Copilot CLI のエントリで Bash 以外のツールを送るとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    const result = runEntry(
      hookCase,
      { hook_event_name: 'PreToolUse', tool_name: 'report_intent', tool_input: { intent: 't' } },
      repository,
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.for(rowsOf(['gh pr merge 810', 'pecot pr create ./x.md', 'pecot issue quick -m x -r owner/repo', 'pecot pr create x.md --dry-run']))(
    'Copilot CLI のエントリでコマンドが $label のとき、何も出力しない',
    (row) => {
      const hookCase = createHookCase()
      const repository = gitRepository(hookCase)
      hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
      const result = runEntry(hookCase, copilotToolPayload(row.label), repository)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    },
  )

  it('Claude Code のエントリで wt ブランチから commit するとき、deny を返す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt3')
    // エントリ sh が CLAUDE_PROJECT_DIR 配下を参照するので、コアスクリプトを置く。
    mkdirSync(path.join(repository, 'hooks', 'lib'), { recursive: true })
    symlinkSync(coreDirectory, path.join(repository, 'hooks', 'lib', 'core'))
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    const result = runEntry(hookCase, { tool_input: { command: 'git commit -m test' } }, repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).not.toContain('"decision"')
  })

  it('Copilot CLI のエントリで wt ブランチから commit するとき、protected branch を示して deny を返す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    // エントリポイントの project-root.sh が揃える基準ディレクトリを再現する。
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
    checkout(hookCase, repository, 'wt4')
    const result = runEntry(hookCase, copilotToolPayload('git commit -m test'), repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).toContain('protected branch')
  })
})
