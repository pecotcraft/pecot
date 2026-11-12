/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// PreToolUse の応答形式のテスト。
// 確認が必要な操作は hookSpecificOutput.permissionDecision の ask で返し、deny に置き換えない。
// 拒否は permissionDecision の deny と permissionDecisionReason で返し、トップレベルの decision は使わない。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { run, runHookEntry } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { containing, parseJson } from '../_helpers/text.js'

interface Client {
  readonly client: string
  readonly clientName: string
}

const CLIENTS: readonly Client[] = [
  { client: 'claude', clientName: 'Claude Code' },
  { client: 'copilot', clientName: 'Copilot CLI' },
]

function bashPayload(client: string, command: string, cwd: string): Readonly<Record<string, unknown>> {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
    session_id: 'sess-1229',
  }
  return client === 'claude' ? { ...payload, transcript_path: path.join(cwd, 'transcript.jsonl'), permission_mode: 'default' } : payload
}

// JSON の入れ子を辿る。無ければ undefined。
function getPath(value: unknown, keys: readonly string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return current
}

// feat ブランチの git リポ（.pecot あり）。リマインダー以外の既定の無効化を揃える。
function setUpProject(hookCase: HookCase): string {
  const repository = gitRepository(hookCase, 'proj')
  const checkout = run(hookCase, 'git', ['checkout', '-q', '-b', 'feat/guard/1229'], { cwd: repository })
  if (checkout.exitCode !== 0) throw new Error(`git checkout が失敗しました: ${checkout.stderr}`)
  mkdirSync(path.join(repository, '.pecot', 'state'), { recursive: true })
  hooksConfig(hookCase).write({})
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  return repository
}

function setUpIssuePending(project: string): void {
  writeFileSync(path.join(project, '.pecot', 'state', 'issue-pending'), 'w-quick\n')
}

function runBashEntry(hookCase: HookCase, client: string, command: string, project: string): RunResult {
  return runHookEntry(hookCase, 'pre-tool-use-bash.sh', bashPayload(client, command, project))
}

// hookSpecificOutput を持つ JSON を返したことを確かめ、解析した値を返す。
function assertHookOutput(result: RunResult): unknown {
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).not.toBe('')
  const output = parseJson(result.stdout)
  expect(getPath(output, ['hookSpecificOutput'])).toBeDefined()
  return output
}

const DECISION_HEAD: ReadonlyMap<string, string> = new Map([['deny', 'error:'], ['ask', 'warning:'], ['allow', 'note:']])

function assertDecision(result: RunResult, decision: string, reasonContains: string): unknown {
  const output = assertHookOutput(result)
  expect(getPath(output, ['hookSpecificOutput', 'hookEventName'])).toBe('PreToolUse')
  expect(getPath(output, ['hookSpecificOutput', 'permissionDecision'])).toBe(decision)
  const reason = getPath(output, ['hookSpecificOutput', 'permissionDecisionReason'])
  expect(reason).toBeTruthy()
  expect(reason).toEqual(containing(reasonContains))
  const head = DECISION_HEAD.get(decision) ?? ''
  expect(typeof reason === 'string' && reason.startsWith(head)).toBe(true)
  expect(getPath(output, ['decision'])).toBeUndefined()
  expect(getPath(output, ['reason'])).toBeUndefined()
  expect(getPath(output, ['hookSpecificOutput', 'reason'])).toBeUndefined()
  return output
}

function assertReminders(output: unknown): void {
  const context = getPath(output, ['hookSpecificOutput', 'additionalContext'])
  expect(context).toEqual(containing('warning: Issue filing is not complete'))
  expect(context).toEqual(containing('/tmp/'))
}

function clientRows<T extends object>(rows: readonly T[]): (T & Client)[] {
  return rows.flatMap(row => CLIENTS.map(client => ({ ...row, ...client })))
}

describe('pre-tool-use-bash.sh の応答形式', () => {
  // ask（確認が必要な操作）は deny に置き換えない。
  it.for(clientRows([
    { label: 'pecot issue create .pecot/work/1229/issue.md' },
    { label: 'pecot issue quick -r owner/repo -m "summary"' },
    { label: 'pecot pr create' },
    { label: 'gh pr merge 999999' },
  ]))('$clientName の入力でコマンドが $label のとき、ask を返す', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, row.label, project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'ask', 'external-post-check')
  })

  // deny（禁止操作）は hookSpecificOutput.permissionDecision で出す。
  it.for(CLIENTS)('$clientName の入力で git commit に --no-verify が付くとき、deny を返す', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, 'git commit --no-verify -m x', project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'deny', 'git-no-verify-check')
  })

  it.for(clientRows([
    { label: 'gh pr create --title t', marker: 'gh-pr-create-check' },
    { label: 'gh issue create --title t', marker: 'gh-issue-create-check' },
  ]))('$clientName の入力でコマンドが $label のとき、deny を返す', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, row.label, project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'deny', row.marker)
  })

  it.for(CLIENTS)('$clientName の入力で保護ブランチから commit するとき、deny を返す', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const checkout = run(hookCase, 'git', ['checkout', '-q', '-b', 'wt3'], { cwd: project })
    expect(checkout.exitCode).toBe(0)
    const result = runBashEntry(hookCase, row.client, 'git commit -m x', project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'deny', 'git-worktree-branch-check')
  })

  it('GitHub の MCP で PR を作るとき、deny を返す', () => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { title: 't' },
      cwd: project,
    }
    const result = runHookEntry(hookCase, 'pre-tool-use-mcp.sh', payload)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'deny', 'pr-create-block')
  })

  // allow は理由が残る。
  it.for(CLIENTS)('$clientName の入力で tech-advisor の作業場所へ clone するとき、理由つきで allow を返す', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const command = 'git clone https://github.com/owner/repo.git .pecot/work/1229/tech-advisor/repo'
    const result = runBashEntry(hookCase, row.client, command, project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'allow', 'tech-advisor-clone-allow')
  })

  // 統合後のエントリは、リマインダーと判定が同時に当たっても判定が落ちない。
  // git switch は issue-pending のリマインダーの対象で、/tmp/... は tmp-path-warner の対象になる。
  it.for(CLIENTS)('$clientName の入力でリマインダーと ask が同時に当たるとき、ask を落とさず両方を載せる', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    setUpIssuePending(project)
    const command = 'git switch feat/other; gh pr merge 999999 --body-file /tmp/note-1229'
    const result = runBashEntry(hookCase, row.client, command, project)
    expect(result.exitCode).toBe(0)
    assertReminders(assertDecision(result, 'ask', 'external-post-check'))
  })

  it.for(CLIENTS)('$clientName の入力でリマインダーと deny が同時に当たるとき、deny を落とさず両方を載せる', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    setUpIssuePending(project)
    const command = 'git switch feat/other; git commit --no-verify -F /tmp/note-1229'
    const result = runBashEntry(hookCase, row.client, command, project)
    expect(result.exitCode).toBe(0)
    assertReminders(assertDecision(result, 'deny', 'git-no-verify-check'))
  })

  it.for(CLIENTS)('$clientName の入力で /tmp/ のパスを使うとき、Bash のエントリ経由でも警告を届ける', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, 'cat /tmp/x-1229', project)
    const output = assertHookOutput(result)
    expect(getPath(output, ['hookSpecificOutput', 'hookEventName'])).toBe('PreToolUse')
    expect(getPath(output, ['hookSpecificOutput', 'additionalContext'])).toEqual(containing('/tmp/'))
    expect(getPath(output, ['hookSpecificOutput', 'permissionDecision'])).toBeUndefined()
  })

  it.for(CLIENTS)('$clientName の入力で Issue 起票が済んでいないとき、Bash のエントリ経由でもリマインダーを届ける', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    setUpIssuePending(project)
    const result = runBashEntry(hookCase, row.client, 'git switch feat/other', project)
    const output = assertHookOutput(result)
    expect(getPath(output, ['hookSpecificOutput', 'additionalContext'])).toEqual(containing('warning: Issue filing is not complete'))
  })

  it.for(CLIENTS)('$clientName の入力で判定とリマインダーのどちらにも当たらないとき、何も出力しない', (row) => {
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, 'echo hi', project)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })
})
