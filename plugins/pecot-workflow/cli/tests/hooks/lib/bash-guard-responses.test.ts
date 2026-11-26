/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// PreToolUse の応答形式のテスト。
// 拒否は permissionDecision の deny と permissionDecisionReason で返し、トップレベルの decision は使わない。
// 承認を求める ask は返さない（spec 025 FR-001〜FR-008）。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { run, runHookEntry } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { containing, parseJson } from '../_helpers/text.js'
import { explains } from '../../_helpers/explains.js'

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

const DECISION_HEAD: ReadonlyMap<string, string> = new Map([['deny', 'error:'], ['allow', 'note:']])

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
  expect(context).toEqual(containing('/tmp/'))
}

function clientRows<T extends object>(rows: readonly T[]): (T & Client)[] {
  return rows.flatMap(row => CLIENTS.map(client => ({ ...row, ...client })))
}

describe('pre-tool-use-bash.sh の応答形式', () => {
  // PR のマージと Bash の pecot は止めず、何も返さない。
  it.for(clientRows([
    { label: 'gh pr merge 999999' },
    { label: 'pecot issue create .pecot/work/1229/issue.md' },
    { label: 'pecot issue quick -r owner/repo -m "summary"' },
    { label: 'pecot pr create' },
    { label: 'pecot issue show 1' },
  ]))('$clientName の入力でコマンドが $label のとき、何も返さない', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、コマンドが \`${row.label}\` の場合に、標準出力に何も出力しないことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, row.label, project)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  // deny（禁止操作）は hookSpecificOutput.permissionDecision で出す。
  it.for(CLIENTS)('$clientName の入力で git-no-verify-check を有効にして git commit に --no-verify が付くとき、deny を返す', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、\`git-no-verify-check\` を有効にして \`git commit --no-verify\` を実行しようとした場合に、\`deny\`（拒否）の判定を返すことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    hooksConfig(hookCase).write({ 'git-no-verify-check': true })
    const result = runBashEntry(hookCase, row.client, 'git commit --no-verify -m x', project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'deny', 'git-no-verify-check')
  })

  it.for(CLIENTS)('$clientName の入力で git-no-verify-check が初期値のまま git commit に --no-verify が付くとき、何も返さない', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、\`git-no-verify-check\` を初期値のまま \`git commit --no-verify\` を実行しようとした場合に、標準出力に何も出力しないことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, 'git commit --no-verify -m x', project)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it.for(clientRows([
    { label: 'gh pr create --title t', marker: 'gh-pr-create-check' },
    { label: 'gh issue create --title t', marker: 'gh-issue-create-check' },
  ]))('$clientName の入力でコマンドが $label のとき、deny を返す', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、コマンドが \`${row.label}\` の場合に、\`deny\`（拒否）の判定を返し、理由に \`${row.marker}\` を含めることを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, row.label, project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'deny', row.marker)
  })

  it.for(CLIENTS)('$clientName の入力で保護ブランチから commit するとき、deny を返す', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、保護ブランチ（\`wt3\`）から \`git commit\` を実行しようとした場合に、\`deny\`（拒否）の判定を返すことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const checkout = run(hookCase, 'git', ['checkout', '-q', '-b', 'wt3'], { cwd: project })
    expect(checkout.exitCode).toBe(0)
    const result = runBashEntry(hookCase, row.client, 'git commit -m x', project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'deny', 'git-worktree-branch-check')
  })

  // allow は理由が残る。
  it.for(CLIENTS)('$clientName の入力で reviewer の作業場所へ clone するとき、理由つきで allow を返す', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、reviewer の作業場所へ \`git clone\` を実行しようとした場合に、\`allow\`（許可）の判定を理由つきで返すことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const command = 'git clone https://github.com/owner/repo.git .pecot/work/1229/reviewer/repo'
    const result = runBashEntry(hookCase, row.client, command, project)
    expect(result.exitCode).toBe(0)
    assertDecision(result, 'allow', 'reviewer-clone-allow')
  })

  // 統合後のエントリは、リマインダーと判定が同時に当たっても判定が落ちない。判定の無いコマンドにはリマインダーだけを載せる。
  // リマインダーは、/tmp/... に当たる tmp-path-warner だけになる。
  it.for(CLIENTS)('$clientName の入力でリマインダーと gh pr merge が同時に当たるとき、判定を付けずにリマインダーだけを載せる', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、\`/tmp/\` を使う警告と \`gh pr merge\` が同時に当たる場合に、判定は付けず、警告だけを \`additionalContext\` に載せることを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const command = 'git switch feat/other; gh pr merge 999999 --body-file /tmp/note-1229'
    const result = runBashEntry(hookCase, row.client, command, project)
    const output = assertHookOutput(result)
    assertReminders(output)
    expect(getPath(output, ['hookSpecificOutput', 'permissionDecision'])).toBeUndefined()
  })

  it.for(CLIENTS)('$clientName の入力でリマインダーと deny が同時に当たるとき、deny を落とさず両方を載せる', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、\`/tmp/\` を使う警告と \`deny\`（拒否）の判定が同時に当たる場合に、判定を落とさず、警告も \`additionalContext\` に載せることを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    hooksConfig(hookCase).write({ 'git-no-verify-check': true })
    const command = 'git switch feat/other; git commit --no-verify -F /tmp/note-1229'
    const result = runBashEntry(hookCase, row.client, command, project)
    expect(result.exitCode).toBe(0)
    assertReminders(assertDecision(result, 'deny', 'git-no-verify-check'))
  })

  it.for(CLIENTS)('$clientName の入力で /tmp/ のパスを使うとき、Bash のエントリ経由でも警告を届ける', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、\`/tmp/\` のパスを使うコマンドを実行しようとした場合に、判定は付けず、警告を \`additionalContext\` に載せることを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, 'cat /tmp/x-1229', project)
    const output = assertHookOutput(result)
    expect(getPath(output, ['hookSpecificOutput', 'hookEventName'])).toBe('PreToolUse')
    expect(getPath(output, ['hookSpecificOutput', 'additionalContext'])).toEqual(containing('/tmp/'))
    expect(getPath(output, ['hookSpecificOutput', 'permissionDecision'])).toBeUndefined()
  })

  it.for(CLIENTS)('$clientName の入力で判定とリマインダーのどちらにも当たらないとき、何も出力しない', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）の応答のテストです。${row.clientName} の入力で、判定と警告のどちらにも当たらないコマンド（\`echo hi\`）を実行しようとした場合に、標準出力に何も出力しないことを確認します。`)
    const hookCase = createHookCase()
    const project = setUpProject(hookCase)
    const result = runBashEntry(hookCase, row.client, 'echo hi', project)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })
})
