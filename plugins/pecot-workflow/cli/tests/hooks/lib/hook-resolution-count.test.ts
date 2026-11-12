/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// Bash の PreToolUse / PostToolUse でのリポジトリ解決回数と commit 検出のテスト。
// git のシム（installGitCallLog）で rev-parse の呼び出しを数える。--show-toplevel はルート解決、--is-inside-work-tree は feature ブランチの判定。
// 後半は、git -C <path> commit と cd <path> && ... && git commit の Post で、commit-info-display と auto-push が揃って動くことを見る。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitOrThrow, gitRepository, installGitCallLog, workLayout } from '../_helpers/git.js'
import { mockBin } from '../_helpers/mock-bin.js'
import { run, runHookEntry } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { containing, parseJson } from '../_helpers/text.js'

const BRANCH = 'feat/count/1229'
const ORIGIN_URL = 'git@github.com:testowner/testrepo.git'

interface Sandbox {
  readonly repo: string
  readonly bare: string
}

// (repo, bare) を用意する。active な Issue の feat ブランチ・auto-push 有効・gh は常に失敗にする。
// origin は GitHub 形式の URL にし、push だけを pushInsteadOf で bare に向ける。
function setUpSandbox(hookCase: HookCase): Sandbox {
  const config = hooksConfig(hookCase)
  const repository = gitRepository(hookCase, 'proj')
  const bare = path.join(hookCase.temporaryPath, 'remote.git')
  gitOrThrow(hookCase, hookCase.temporaryPath, ['init', '-q', '--bare', bare])
  gitOrThrow(hookCase, repository, ['remote', 'add', 'origin', ORIGIN_URL])
  gitOrThrow(hookCase, repository, ['config', `url.${bare}.pushInsteadOf`, ORIGIN_URL])
  gitOrThrow(hookCase, repository, ['checkout', '-q', '-b', BRANCH])
  mkdirSync(path.join(repository, '.pecot', 'state'), { recursive: true })
  writeFileSync(path.join(repository, '.pecot', 'state', '.pecot-active'), 'testowner/testrepo/1229\n')
  config.write({ 'auto-push': true })
  mockBin(hookCase).install('gh', 'exit 1\n')
  hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)
  return { repo: repository, bare }
}

// 実際に commit して、その成功出力（`[branch sha] x ...`）を返す。
function commit(hookCase: HookCase, repository: string): string {
  const name = 'f.txt'
  writeFileSync(path.join(repository, name), name)
  gitOrThrow(hookCase, repository, ['add', name])
  return gitOrThrow(hookCase, repository, ['commit', '-m', 'x']).stdout
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

function postClaude(command: string, stdout: string, cwd: string): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', interrupted: false },
    cwd,
    session_id: 's',
  }
}

// Copilot CLI は tool_response を送らず、tool_result.text_result_for_llm に出力を入れる。
// Bash の出力の末尾には `<shellId: N completed with exit code 0>` が付く。
function postCopilot(command: string, stdout: string, cwd: string): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_result: {
      result_type: 'success',
      text_result_for_llm: `${stdout}\n<shellId: 0 completed with exit code 0>`,
    },
    cwd,
    session_id: 's',
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value !== 'object' || value === null ? {} : Object.fromEntries(Object.entries(value))
}

// 出力の hookSpecificOutput.additionalContext を返す。出力が空のときは空文字。
function additionalContext(result: RunResult): string {
  expect(result).toMatchObject({ exitCode: 0 })
  if (result.stdout.trim() === '') return ''
  const value = asRecord(asRecord(parseJson(result.stdout))['hookSpecificOutput'])['additionalContext']
  return typeof value === 'string' ? value : ''
}

function hookSpecificOutput(result: RunResult): Readonly<Record<string, unknown>> {
  return asRecord(asRecord(parseJson(result.stdout))['hookSpecificOutput'])
}

function countOf(counts: Readonly<Record<string, number>>, key: string): number | undefined {
  return new Map(Object.entries(counts)).get(key)
}

describe('リポジトリ解決回数', () => {
  it('ls は、Pre で 1 回解決し、Post では解決しない', () => {
    const hookCase = createHookCase()
    const { repo } = setUpSandbox(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre('ls', repo))
    expect(gitCallLog.revParseCounts()).toEqual({ '--show-toplevel': 1 })

    gitCallLog.reset()
    runHookEntry(hookCase, 'post-tool-use-bash.sh', postClaude('ls', 'f.txt\n', repo))
    expect(gitCallLog.revParseCounts()).toEqual({})
  })

  it.for([
    { label: 'Claude', post: postClaude },
    { label: 'Copilot', post: postCopilot },
  ])('commit は、$label の形式で、Pre で 1 回、Post で 1 回解決する', (row) => {
    const hookCase = createHookCase()
    const { repo } = setUpSandbox(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre('git commit -m x', repo))
    expect(countOf(gitCallLog.revParseCounts(), '--show-toplevel')).toBe(1)

    const stdout = commit(hookCase, repo)
    gitCallLog.reset()
    const result = runHookEntry(hookCase, 'post-tool-use-bash.sh', row.post('git commit -m x', stdout, repo))
    const counts = gitCallLog.revParseCounts()
    expect(countOf(counts, '--show-toplevel')).toBe(1)
    expect(countOf(counts, '--is-inside-work-tree') ?? 0).toBeLessThanOrEqual(2)
    expect(additionalContext(result)).toContain('note: commit complete')
  })

  it('pecot issue create は、Pre で 1 回解決し、Post では解決しない', () => {
    const hookCase = createHookCase()
    const { repo } = setUpSandbox(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    const command = 'pecot issue create .pecot/work/1229/issue.md'
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(command, repo))
    expect(countOf(gitCallLog.revParseCounts(), '--show-toplevel')).toBe(1)

    gitCallLog.reset()
    runHookEntry(hookCase, 'post-tool-use-bash.sh', postClaude(command, 'Created: #12\n', repo))
    const counts = gitCallLog.revParseCounts()
    // issue-pending は CLI が消すため、起票の Post は何も解決しない。
    expect(counts).toEqual({})
  })

  it('worktree の .pecot/work 配下の cwd でも、--show-toplevel は 1 回', () => {
    // work は base への symlink
    const hookCase = createHookCase()
    const layout = workLayout(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    gitCallLog.reset()
    runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre('ls', path.join(layout.work, '1244')), { env: { CLAUDE_PROJECT_DIR: layout.wt } })
    expect(gitCallLog.revParseCounts()).toEqual({ '--show-toplevel': 1 })
  })

  it('別リポの .pecot/work 配下は判定が外れ、セッションの toplevel と cwd の 2 回解決する', () => {
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

  it('.pecot/work 配下の入れ子のリポは判定が外れ、セッションの toplevel と cwd の 2 回解決する', () => {
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

// commit の検出形。
function expectWipPushed(hookCase: HookCase, bare: string): void {
  const reference = run(hookCase, 'git', ['--git-dir', bare, 'rev-parse', '--verify', `refs/heads/wip/${BRANCH}`])
  expect(reference, `bare に wip/${BRANCH} が push されていない`).toMatchObject({ exitCode: 0 })
}

describe('commit の検出形', () => {
  it('git -C <path> commit のとき、commit-info-display と auto-push が動く', () => {
    const hookCase = createHookCase()
    const { repo, bare } = setUpSandbox(hookCase)
    const elsewhere = path.join(hookCase.temporaryPath, 'elsewhere')
    mkdirSync(elsewhere)
    const stdout = commit(hookCase, repo)
    const result = runHookEntry(hookCase, 'post-tool-use-bash.sh', postClaude(`git -C ${repo} commit -m x`, stdout, elsewhere), { cwd: elsewhere })
    expect(additionalContext(result)).toContain('note: commit complete')
    expectWipPushed(hookCase, bare)
  })

  it('cd <path> && git add && git commit のとき、commit-info-display と auto-push が動く', () => {
    const hookCase = createHookCase()
    const { repo, bare } = setUpSandbox(hookCase)
    const elsewhere = path.join(hookCase.temporaryPath, 'elsewhere')
    mkdirSync(elsewhere)
    const stdout = commit(hookCase, repo)
    const result = runHookEntry(hookCase, 'post-tool-use-bash.sh', postClaude(`cd ${repo} && git add . && git commit -m x`, stdout, elsewhere), { cwd: elsewhere })
    expect(additionalContext(result)).toContain('note: commit complete')
    expectWipPushed(hookCase, bare)
  })

  // Copilot CLI 1.0.103 は PostToolUse ではトップレベルの additionalContext だけをモデルに渡す。
  it('commit の Post 出力は、トップレベルにも additionalContext を持つ', () => {
    const hookCase = createHookCase()
    const { repo } = setUpSandbox(hookCase)
    const stdout = commit(hookCase, repo)
    const result = runHookEntry(hookCase, 'post-tool-use-bash.sh', postCopilot('git commit -m x', stdout, repo))
    const data = asRecord(parseJson(result.stdout))
    expect(data).toMatchObject({ additionalContext: containing('note: commit complete') })
    expect(data['additionalContext']).toBe(hookSpecificOutput(result)['additionalContext'])
  })
})

// commit と issue 起票を 1 つのコマンドで行ったとき（F-03）。
describe('commit と issue 起票を 1 つのコマンドで行うとき', () => {
  it('すべてのサブスクリプトが動く', () => {
    const hookCase = createHookCase()
    const { repo, bare } = setUpSandbox(hookCase)
    const gitCallLog = installGitCallLog(hookCase)
    const stdout = `${commit(hookCase, repo)}Created: #12\n`
    gitCallLog.reset()
    const result = runHookEntry(hookCase, 'post-tool-use-bash.sh', postClaude('git commit -m x && pecot issue create x.md', stdout, repo))
    expect(additionalContext(result)).toContain('note: commit complete')
    expectWipPushed(hookCase, bare)
    const counts = gitCallLog.revParseCounts()
    expect(countOf(counts, '--show-toplevel')).toBe(1)
    expect(countOf(counts, '--is-inside-work-tree') ?? 0).toBeLessThanOrEqual(2)
  })
})

// 上限を超えるコマンド（F-04）。
// 環境変数 1 個が 128KiB を超えると execve が失敗する。heredoc 付きの約 130KiB のコマンド。
const BIG_BODY = 'x'.repeat(130_000)

function bigCommand(head: string): string {
  return `${head} && cat <<'EOF' > .pecot/work/1229/big.txt\n${BIG_BODY}\nEOF`
}

describe('上限を超えるコマンド', () => {
  it('Pre では、そのまま通さず、確認を求める', () => {
    const hookCase = createHookCase()
    const { repo } = setUpSandbox(hookCase)
    const result = runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(bigCommand('git commit --no-verify -m x'), repo))
    expect(result).toMatchObject({ exitCode: 0 })
    expect(result.stderr).not.toContain('Argument list too long')
    expect(hookSpecificOutput(result)).toMatchObject({ permissionDecision: 'ask', permissionDecisionReason: containing('exceeds') })
  })

  it('/tmp のリマインダーは、上限を超えても出す', () => {
    const hookCase = createHookCase()
    const { repo } = setUpSandbox(hookCase)
    const result = runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(bigCommand('cat /tmp/x-1229'), repo))
    expect(result).toMatchObject({ exitCode: 0 })
    expect(hookSpecificOutput(result)).toMatchObject({ permissionDecision: 'ask', additionalContext: containing('/tmp/') })
  })

  it('Issue 起票のリマインダーは、上限を超えても出す', () => {
    const hookCase = createHookCase()
    const { repo } = setUpSandbox(hookCase)
    writeFileSync(path.join(repo, '.pecot', 'state', 'issue-pending'), 'w-quick\n')
    const result = runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(bigCommand('git switch feat/other'), repo))
    expect(hookSpecificOutput(result)).toMatchObject({ additionalContext: containing('warning: Issue filing is not complete') })
  })

  it('上限を超える commit も、Post で検出する', () => {
    const hookCase = createHookCase()
    const { repo, bare } = setUpSandbox(hookCase)
    const stdout = commit(hookCase, repo)
    const result = runHookEntry(hookCase, 'post-tool-use-bash.sh', postClaude(bigCommand('git commit --no-verify -m x'), stdout, repo))
    expect(result.stderr).not.toContain('Argument list too long')
    expect(additionalContext(result)).toContain('note: commit complete')
    expectWipPushed(hookCase, bare)
  })

  it('上限ぎりぎりのコマンドは、コアのガードが止める', () => {
    const hookCase = createHookCase()
    const { repo } = setUpSandbox(hookCase)
    const command = `# ${'x'.repeat(50_000)}\ngit commit --no-verify -m x`
    const result = runHookEntry(hookCase, 'pre-tool-use-bash.sh', pre(command, repo))
    expect(hookSpecificOutput(result)).toMatchObject({ permissionDecision: 'deny' })
  })
})
