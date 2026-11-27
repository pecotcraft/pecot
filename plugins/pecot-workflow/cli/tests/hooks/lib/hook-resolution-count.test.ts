/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// Bash の PreToolUse でのリポジトリ解決回数と、上限を超えるコマンドのテスト。
// git のシム（installGitCallLog）で rev-parse の呼び出しを数える。--show-toplevel はルート解決。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitOrThrow, gitRepository, installGitCallLog, workLayout } from '../_helpers/git.js'
import { runHookEntry } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { containing, parseJson } from '../_helpers/text.js'
import { explains } from '../../_helpers/explains.js'

const BRANCH = 'feat/count/1229'

// active な Issue の feat ブランチのリポを用意する。
function setUpRepository(hookCase: HookCase): string {
  const repository = gitRepository(hookCase, 'proj')
  gitOrThrow(hookCase, repository, ['checkout', '-q', '-b', BRANCH])
  mkdirSync(path.join(repository, '.pecot', 'state'), { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  return repository
}

function pre(command: string, cwd: string): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
    session_id: 's',
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value !== 'object' || value === null ? {} : Object.fromEntries(Object.entries(value))
}

function hookSpecificOutput(result: RunResult): Readonly<Record<string, unknown>> {
  return asRecord(asRecord(parseJson(result.stdout))['hookSpecificOutput'])
}

function countOf(counts: Readonly<Record<string, number>>, key: string): number | undefined {
  return new Map(Object.entries(counts)).get(key)
}

describe('リポジトリ解決回数', () => {
  it('ls を実行するとき、PreToolUse でリポジトリのルートを 1 回だけ解決する', async () => {
    await explains('Bash の PreToolUse フック（`pre-tool-use-bash.sh`）が、リポジトリのルートを解決する回数のテストです。`ls` を実行する場合に、`git rev-parse --show-toplevel` を 1 回だけ呼び出すことを確認します。')
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre('ls', repository))
    expect(gitCallLog.revParseCounts()).toEqual({ '--show-toplevel': 1 })
  })

  it.for([
    { label: 'git commit -m x' },
    { label: 'pecot issue create .pecot/work/1229/issue.md' },
  ])('$label を実行するとき、PreToolUse でリポジトリのルートを 1 回だけ解決する', async (row) => {
    await explains(`Bash の PreToolUse フック（\`pre-tool-use-bash.sh\`）が、リポジトリのルートを解決する回数のテストです。コマンドが \`${row.label}\` の場合に、\`git rev-parse --show-toplevel\` を 1 回だけ呼び出すことを確認します。`)
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(row.label, repository))
    expect(countOf(gitCallLog.revParseCounts(), '--show-toplevel')).toBe(1)
  })

  it('worktree の .pecot/work 配下の cwd でも、--show-toplevel は 1 回', async () => {
    await explains('Bash の PreToolUse フック（`pre-tool-use-bash.sh`）が、リポジトリのルートを解決する回数のテストです。worktree の `.pecot/work` 配下がカレントディレクトリの場合に、`--show-toplevel` を 1 回だけ呼び出すことを確認します。')
    // work は base への symlink
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre('ls', path.join(layout.work, '1244')), { env: { CLAUDE_PROJECT_DIR: layout.wt } })
    expect(gitCallLog.revParseCounts()).toEqual({ '--show-toplevel': 1 })
  })

  it('別リポの .pecot/work 配下は判定が外れ、セッションの toplevel と cwd の 2 回解決する', async () => {
    await explains('Bash の PreToolUse フック（`pre-tool-use-bash.sh`）が、リポジトリのルートを解決する回数のテストです。別のリポジトリの `.pecot/work` 配下がカレントディレクトリの場合に、セッションのルートとカレントディレクトリのルートを 1 回ずつ、計 2 回呼び出すことを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    const other = gitRepository(hookCase, 'other-repo')
    const cwd = path.join(other, '.pecot', 'work', '1244')
    mkdirSync(cwd, { recursive: true })
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre('ls', cwd), { env: { CLAUDE_PROJECT_DIR: layout.wt } })
    expect(gitCallLog.revParseCounts()).toEqual({ '--show-toplevel': 2 })
  })

  it('.pecot/work 配下の入れ子のリポは判定が外れ、セッションの toplevel と cwd の 2 回解決する', async () => {
    await explains('Bash の PreToolUse フック（`pre-tool-use-bash.sh`）が、リポジトリのルートを解決する回数のテストです。`.pecot/work` 配下の入れ子のリポジトリがカレントディレクトリの場合に、セッションのルートとカレントディレクトリのルートを 1 回ずつ、計 2 回呼び出すことを確認します。')
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    const nested = path.join(layout.work, '1244', 'clone')
    mkdirSync(nested)
    gitOrThrow(hookCase, nested, ['init', '--quiet'])
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre('ls', nested), { env: { CLAUDE_PROJECT_DIR: layout.wt } })
    expect(gitCallLog.revParseCounts()).toEqual({ '--show-toplevel': 2 })
  })
})

// 上限を超えるコマンド（F-04）。
// 環境変数 1 個が 128KiB を超えると execve が失敗する。heredoc 付きの約 130KiB のコマンド。
const BIG_BODY = 'x'.repeat(130_000)

function bigCommand(head: string): string {
  return `${head} && cat <<'EOF' > .pecot/work/1229/big.txt\n${BIG_BODY}\nEOF`
}

describe('上限を超えるコマンド', () => {
  it('上限を超えるコマンドは、PreToolUse でガードを通さずに素通しし、何も返さない', async () => {
    await explains('サイズの上限を超えるコマンド（約 130KiB）を、Bash の PreToolUse フックに渡した場合のテストです。`git commit --no-verify` を含んでいても、ガードを通さず、標準出力に何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    hooksConfig(hookCase).write({ 'git-no-verify-check': true })
    const result = runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(bigCommand('git commit --no-verify -m x'), repository))
    expect(result).toMatchObject({ exitCode: 0 })
    expect(result.stderr).not.toContain('Argument list too long')
    expect(result.stdout.trim()).toBe('')
  })

  it('上限を超えるコマンドでも、/tmp を使う警告は出力する', async () => {
    await explains('サイズの上限を超えるコマンド（約 130KiB）を、Bash の PreToolUse フックに渡した場合のテストです。`/tmp/` のパスを使うコマンドでは、`additionalContext` に警告を載せ、`permissionDecision` は含めないことを確認します。')
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    const result = runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(bigCommand('cat /tmp/x-1229'), repository))
    expect(result).toMatchObject({ exitCode: 0 })
    expect(hookSpecificOutput(result)).toMatchObject({ additionalContext: containing('/tmp/') })
    expect(hookSpecificOutput(result)).not.toHaveProperty('permissionDecision')
  })

  it('上限ぎりぎりのコマンドは、コアのガードが止める', async () => {
    await explains('上限ぎりぎりのサイズ（約 50KB）のコマンドを、Bash の PreToolUse フックに渡した場合のテストです。`git commit --no-verify` を含む場合に、コアのガードが `deny`（拒否）の判定を返すことを確認します。')
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    hooksConfig(hookCase).write({ 'git-no-verify-check': true })
    const command = `# ${'x'.repeat(50_000)}\ngit commit --no-verify -m x`
    const result = runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(command, repository))
    expect(hookSpecificOutput(result)).toMatchObject({ permissionDecision: 'deny' })
  })

  // トークンごとに残りを複製すると、長さの 2 乗で遅くなり PreToolUse の 10 秒を超える。
  it('上限未満で単語の多いコマンドも、コアのガードが数秒以内に止める', async () => {
    await explains('上限未満で単語の多いコマンド（約 10,000 語）を、Bash の PreToolUse フックに渡した場合のテストです。`git commit --no-verify` を含む場合に、5 秒以内に `deny`（拒否）の判定を返すことを確認します。')
    const hookCase = createHookCase()
    const repository = setUpRepository(hookCase)
    hooksConfig(hookCase).write({ 'git-no-verify-check': true })
    const command = `cat <<'EOF' > .pecot/work/1229/words.txt\n${'word '.repeat(10_000)}\nEOF\ngit commit --no-verify -m x`
    expect(Buffer.byteLength(command)).toBeLessThan(60_000)
    const started = performance.now()
    const result = runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(command, repository))
    expect(performance.now() - started).toBeLessThan(5000)
    expect(hookSpecificOutput(result)).toMatchObject({ permissionDecision: 'deny' })
  })
})
