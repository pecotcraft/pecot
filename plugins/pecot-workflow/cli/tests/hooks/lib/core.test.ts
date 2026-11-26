/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// コアスクリプト（lib/core）の単体テスト。HOOK_COMMAND などを env で渡して直接起動する。
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { gitOrThrow, gitRepository } from '../_helpers/git.js'
import { adapterDirectory, coreDirectory } from '../_helpers/paths.js'
import { run, runHookScript } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { explains } from '../../_helpers/explains.js'

interface CommandRow {
  readonly label: string
  readonly command: string
}

// タブと改行は題に入れず、エスケープ表記の label にする。
function commandRows(commands: readonly string[]): CommandRow[] {
  return commands.map(command => ({ label: command.replaceAll('\t', String.raw`\t`).replaceAll('\n', String.raw`\n`), command }))
}

function runCore(hookCase: HookCase, scriptName: string, options: { readonly cwd?: string, readonly env?: EnvironmentOverrides } = {}): RunResult {
  return run(hookCase, path.join(coreDirectory, scriptName), [], options)
}

function checkout(hookCase: HookCase, repository: string, branch: string): void {
  gitOrThrow(hookCase, repository, ['checkout', '-b', branch, '--quiet'])
}

// 初期値は無効。止める・通すケースは設定で有効にして流す。
function enabledNoVerifyCase(): HookCase {
  const hookCase = createHookCase()
  hooksConfig(hookCase).write({ 'git-no-verify-check': true })
  return hookCase
}

describe('git-no-verify-check.sh', () => {
  it('設定が無いとき、--no-verify でも何も出力せず通す', async () => {
    await explains('`git-no-verify-check.sh` のテストです。設定ファイルが存在しない場合に、`git commit --no-verify` でも、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', path.join(hookCase.temporaryPath, 'missing.json'))
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: 'git commit --no-verify' } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.for(commandRows([
    'git commit --no-verify',
    'git push --no-verify',
    'git commit -n',
    'echo test && git commit --no-verify -m "msg"',
    'echo ok && git commit -n',
    'git -C /repo commit -n',
    'echo ng || git commit -n',
    'git commit -m \'my message\' -n',
    'git merge --no-verify',
    'git Commit -n',
    // 単独 & （バックグラウンド区切り）の後続も検出する
    'echo x & git commit --no-verify -m x',
    'echo x&git commit -n',
    'echo x & git push --no-verify',
    // -n のまとめ書きと、引用符で囲んだオプション
    'git commit -anm x',
    'git commit "--no-verify"',
    'git commit \'-n\'',
    // core.hooksPath を差し替える形
    'git -c core.hooksPath=/dev/null commit -m x',
    'git config core.hooksPath x',
    'git config --global core.hooksPath x',
    'git config set core.hooksPath x',
    'git config --unset core.hooksPath',
    'git config unset core.hooksPath',
    // フックを飛ばす環境変数
    'SKIP=lint git commit -m x',
    'HUSKY=0 git push',
    // ヒアドキュメントの後ろのコマンド
    'cat <<\'EOF\' > note.txt\nbody\nEOF\ngit commit -n',
  ]))('有効にしてコマンドが $label のとき、終了コード 1 で止める', async (row) => {
    await explains(`\`git-no-verify-check.sh\` のテストです。チェックを有効にして、コマンドが \`${row.label}\` の場合に、終了コード 1 で拒否することを確認します。`)
    const hookCase = enabledNoVerifyCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(1)
  })

  it.for(commandRows([
    'git commit -m "message"',
    'echo "--no-verify"',
    'git log --no-merges',
    'git status --short | head -n 5',
    'git log --oneline; sed -n 200,215p file.md',
    'git commit -m "msg" && grep -n foo bar.txt',
    'git commit -m "use -n flag"',
    'git merge --no-verify-signatures',
    'git diff --stat || sed -n 1,5p file.md',
    'git log -n 5',
    'git rev-list -n 5 HEAD',
    'git tag -n',
    // & で分けた後のセグメントが commit / push でなければ通す
    'sleep 1 & git log -n 5',
    'git push 2>&1',
    // push の -n は --dry-run
    'git push -n',
    // 値を取るオプションの値と、それより後ろの n
    'git commit -mn',
    'git commit -Fnote',
    'git commit -m "-n"',
    'git commit -m \'--no-verify\'',
    'git commit -m "a; b" && git status',
    // core.hooksPath を読む形と、ほかの設定
    'git config --get core.hooksPath',
    'git config get core.hooksPath',
    'git config core.hooksPath',
    'git config user.name x',
    'git -c user.name=x commit -m x',
    // フックを呼ばないサブコマンドの前の SKIP= / HUSKY=0
    'SKIP=x git status',
    'HUSKY=0 git log',
    // ヒアドキュメントの本文
    'cat <<\'EOF\' > note.txt\ngit commit -n\nEOF',
    'cat <<EOF > note.txt\ngit commit --no-verify\nEOF',
    'cat <<-EOF > note.txt\n\tgit commit -n\n\tEOF',
  ]))('有効にしてコマンドが $label のとき、何も出力せず通す', async (row) => {
    await explains(`\`git-no-verify-check.sh\` のテストです。チェックを有効にして、コマンドが \`${row.label}\` の場合に、何も出力せず終了コード 0 で許可することを確認します。`)
    const hookCase = enabledNoVerifyCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('--no-verify を使うとき、止めるメッセージにそのフラグを含める', async () => {
    await explains('`git-no-verify-check.sh` の拒否メッセージのテストです。`git commit --no-verify` を拒否する場合に、標準出力のメッセージへ `--no-verify` が含まれることを確認します。')
    const hookCase = enabledNoVerifyCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: 'git commit --no-verify' } })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('--no-verify')
  })

  it('--no-verify を使うとき、止めるメッセージにエラー見出しと修正の案内を含める', async () => {
    await explains('`git-no-verify-check.sh` の拒否メッセージのテストです。`git commit --no-verify` を拒否する場合に、エラーの見出し（`error: git-no-verify-check:`）と修正の案内が含まれることを確認します。')
    const hookCase = enabledNoVerifyCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: 'git commit --no-verify' } })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('error: git-no-verify-check:')
    expect(result.stdout).toContain('When a hook reports an error:')
    expect(result.stdout).toContain('Fix the root cause of the violation')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', async () => {
    await explains('`git-no-verify-check.sh` のテストです。環境変数 `HOOK_COMMAND` が設定されていない場合に、終了コード 2 を返すことを確認します。')
    const hookCase = enabledNoVerifyCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: undefined } })
    expect(result.exitCode).toBe(2)
  })
})

interface MarkerRow extends CommandRow {
  readonly marker: string | undefined
}

function markerRows(rows: readonly (readonly [string, string?])[]): MarkerRow[] {
  return rows.flatMap(([command, marker]) => commandRows([command]).map(row => ({ ...row, marker })))
}

describe('gh-command-check.sh', () => {
  it.for(markerRows([
    ['gh pr create --title test', 'gh pr create'],
    ['GH_HOST=ghes.example.com gh pr create'],
    ['echo test && gh pr create --title foo'],
    ['/usr/bin/gh pr create --title test'],
    ['gh pr create'],
    ['gh stack submit', 'gh-stack-check'],
    ['gh stack merge'],
    ['GH_HOST=x gh stack push'],
    ['echo x && gh stack submit'],
    ['gh stack view && gh stack submit'],
    ['gh stack submit 2>&1'],
    ['gh issue create --title test', 'gh issue create'],
    ['echo test && gh issue create --title foo'],
    ['/usr/bin/gh issue create'],
    // 単独 & （バックグラウンド区切り）の後続も検出する
    ['echo x & gh pr create'],
    ['echo x & gh issue create'],
    ['echo x&gh pr create'],
    ['echo x & GH_HOST=y gh pr create'],
    ['echo a & echo b & gh pr create'],
    ['GH_HOST=x gh pr create & echo y'],
    // 改行連結の後続も検出する
    ['echo x\ngh pr create'],
    ['echo x\ngh issue create'],
    // タブ・連続空白の区切りも検出する
    ['gh\tpr create'],
    ['gh  pr\tcreate --title t'],
    ['gh\tissue  create'],
    ['echo a;  gh\tpr create'],
    ['GH_HOST=x\tgh pr create'],
  ]))('コマンドが $label のとき、終了コード 1 で止める', async (row) => {
    await explains(`\`gh-command-check.sh\` のテストです。コマンドが \`${row.label}\` の場合に、終了コード 1 で拒否することを確認します。`)
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'gh-command-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(1)
    expect(row.marker === undefined || result.stdout.includes(row.marker)).toBe(true)
  })

  it.for(commandRows([
    'gh pr list',
    'gh issue list',
    'gh auth status',
    'gh api repos/owner/repo',
    'gh issue view 123',
    'gh pr view 456',
    'gh stack view',
    'gh stack --help',
    'gh stack -h',
    'gh stack view 2>&1',
    'gh stack submit --help',
    'echo gh-stack',
    'gh pr merge 789',
    'GH_HOST=ghes.example.com gh pr list',
    'echo test && gh issue view 123',
    '/usr/bin/gh project list',
    'echo "gh pr create"',
    'cat high.txt',
    // & を含むが create ではない、または連結でもない形は通す
    'gh pr list 2>&1',
    'gh pr list 2>&1 | grep create',
    'sleep 1 & gh pr view 1',
    'gh api "search?a=1&b=2"',
    // ヒアドキュメント本文は実行されないので、行頭に現れても通す
    'cat > doc.md <<EOF\ngh pr create is banned\nEOF',
  ]))('コマンドが $label のとき、何も出力せず通す', async (row) => {
    await explains(`\`gh-command-check.sh\` のテストです。コマンドが \`${row.label}\` の場合に、何も出力せず終了コード 0 で許可することを確認します。`)
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'gh-command-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', async () => {
    await explains('`gh-command-check.sh` のテストです。環境変数 `HOOK_COMMAND` が設定されていない場合に、終了コード 2 を返すことを確認します。')
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'gh-command-check.sh', { env: { HOOK_COMMAND: undefined } })
    expect(result.exitCode).toBe(2)
  })
})

function runWorktreeCheck(hookCase: HookCase, repository: string, command: string, workingDirectory: string | undefined): RunResult {
  return runCore(hookCase, 'git-worktree-branch-check.sh', {
    cwd: repository,
    env: { HOOK_COMMAND: command, HOOK_WORKING_DIR: workingDirectory },
  })
}

interface WordRow extends CommandRow {
  readonly word: string
}

function wordRows(commands: readonly string[], word: string): WordRow[] {
  return commandRows(commands).map(row => ({ ...row, word }))
}

describe('git-worktree-branch-check.sh', () => {
  it('保護ブランチで git commit するとき、止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。保護ブランチ（`wt3`）で `git commit` を実行しようとした場合に、終了コード 1 で拒否し、標準出力へ `commit` を含めることを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt3')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "msg"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('commit')
  })

  it('保護ブランチで git push するとき、止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。保護ブランチ（`wt1`）で `git push` を実行しようとした場合に、終了コード 1 で拒否し、標準出力へ `push` を含めることを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runWorktreeCheck(hookCase, repository, 'git push', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('push')
  })

  it('連結コマンドの中の git commit も、保護ブランチなら止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。保護ブランチ（`wt2`）で連結したコマンド（`echo test && git commit`）を実行しようとした場合に、後半の `git commit` を検出して終了コード 1 で拒否することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt2')
    const result = runWorktreeCheck(hookCase, repository, 'echo test && git commit -m "msg"', repository)
    expect(result.exitCode).toBe(1)
  })

  it.for([
    ...wordRows(['git\tcommit -m x', 'git  commit -m x', 'echo a;  git\tcommit -m x'], 'commit'),
    ...wordRows(['git\tpush', 'git  push', 'echo a &&\tgit  push'], 'push'),
  ])('コマンドが $label のとき、タブや連続空白の区切りでも保護ブランチなら止める', async (row) => {
    await explains(`\`git-worktree-branch-check.sh\` のテストです。コマンドが \`${row.label}\` の場合に、タブや連続した空白でも、保護ブランチ（\`wt3\`）への操作として終了コード 1 で拒否することを確認します。`)
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt3')
    const result = runWorktreeCheck(hookCase, repository, row.command, repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(row.word)
  })

  it('git -C で commit するとき、HOOK_WORKING_DIR だけで保護ブランチを判定して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`git -C` を付けた `git commit` を保護ブランチ（`wt4`）で実行しようとした場合に、`HOOK_WORKING_DIR` だけを根拠に終了コード 1 で拒否することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt4')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      env: { HOOK_COMMAND: `git -C ${repository} commit -m msg`, HOOK_WORKING_DIR: repository },
    })
    expect(result.exitCode).toBe(1)
  })

  it('git status のとき、保護ブランチでも何も出力しない', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。保護ブランチ（`wt1`）で `git status` を実行する場合に、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      env: { HOOK_COMMAND: 'git status', HOOK_WORKING_DIR: repository },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('wt3 ブランチで commit するとき、ブランチ名を示して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`wt3` ブランチで `git commit` を実行しようとした場合に、標準出力へブランチ名（`\'wt3\'`）を示して拒否することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt3')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt3\'')
  })

  it('wt10 ブランチで commit するとき、ブランチ名を示して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`wt10` ブランチで `git commit` を実行しようとした場合に、標準出力へブランチ名（`\'wt10\'`）を示して拒否することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt10')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt10\'')
  })

  it('wt1 ブランチで push するとき、止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`wt1` ブランチで `git push origin wt1` を実行しようとした場合に、終了コード 1 で拒否し、標準出力へ `push` を含めることを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runWorktreeCheck(hookCase, repository, 'git push origin wt1', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('push')
  })

  it('feature ブランチで commit するとき、何も出力せず通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。feature ブランチ（`feat/test-feature`）で `git commit` を実行する場合に、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'feat/test-feature')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('develop-aist ブランチで commit するとき、何も出力せず通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`develop-aist` ブランチで `git commit` を実行する場合に、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'develop-aist')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('main ブランチで commit するとき、何も出力せず通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`main` ブランチで `git commit` を実行する場合に、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    // 既定ブランチ名と衝突しうるので -B で切り替える。失敗しても続行する。
    run(hookCase, 'git', ['-C', repository, 'checkout', '-B', 'main', '--quiet'])
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('wt の後ろに数字が無いブランチで commit するとき、何も出力せず通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`wt-feature` のように、`wt` の後ろに数字が続かないブランチで `git commit` を実行する場合に、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt-feature')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('detached HEAD で commit するとき、何も出力せず通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。detached HEAD の状態で `git commit` を実行する場合に、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    const head = gitOrThrow(hookCase, repository, ['rev-parse', 'HEAD']).stdout.trim()
    gitOrThrow(hookCase, repository, ['checkout', head, '--quiet'])
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。環境変数 `HOOK_COMMAND` が設定されていない場合に、終了コード 2 を返すことを確認します。')
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', { env: { HOOK_COMMAND: undefined } })
    expect(result.exitCode).toBe(2)
  })

  it('claude-bash-guards をプラグインの環境で動かすとき、--no-verify を deny で止める', async () => {
    await explains('`claude-bash-guards.sh` のテストです。`git-no-verify-check` を有効にして `git commit --no-verify` を実行する場合に、`deny` の判定を出力し、`decision` は出力しないことを確認します。')
    const hookCase = createHookCase()
    const pluginRoot = path.join(hookCase.temporaryPath, 'plugin')
    const pluginCore = path.join(pluginRoot, 'hooks', 'lib', 'core')
    mkdirSync(pluginCore, { recursive: true })
    for (const name of [
      'gh-command-check.sh',
      'git-worktree-branch-check.sh',
      'git-no-verify-check.sh',
      'config-dispatcher.sh',
      'hook-message.sh',
    ]) {
      const destination = path.join(pluginCore, name)
      copyFileSync(path.join(coreDirectory, name), destination)
      chmodSync(destination, 0o755)
    }
    const project = path.join(hookCase.temporaryPath, 'project')
    mkdirSync(path.join(project, '.pecot', 'state'), { recursive: true })
    const config = path.join(hookCase.temporaryPath, 'hooks-config.json')
    writeFileSync(config, '{"claude-bash-guards": true, "git-no-verify-check": true}')

    const result = runHookScript(
      hookCase,
      path.join(adapterDirectory, 'claude-bash-guards.sh'),
      '{"tool_input":{"command":"git commit --no-verify"}}',
      { env: { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: project, PECOT_HOOKS_CONFIG_PATH: config } },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"permissionDecision": "deny"')
    expect(result.stdout).not.toContain('"decision"')
    expect(result.stdout).toContain('--no-verify')
  })

  it('git リポジトリでないディレクトリで commit するとき、何も出力せず通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。git リポジトリでないディレクトリで `git commit` を実行する場合に、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    const nonGit = path.join(hookCase.temporaryPath, 'non-git')
    mkdirSync(nonGit, { recursive: true })
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      cwd: nonGit,
      env: { HOOK_COMMAND: 'git commit -m "test"', HOOK_WORKING_DIR: nonGit },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('commit を止めるとき、メッセージに commit と feature を含める', async () => {
    await explains('`git-worktree-branch-check.sh` の拒否メッセージのテストです。保護ブランチで `git commit` を拒否する場合に、標準出力のメッセージへ `commit` と `feature` が含まれることを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('commit')
    expect(result.stdout).toContain('feature')
  })

  it('push を止めるとき、メッセージに push と feature を含める', async () => {
    await explains('`git-worktree-branch-check.sh` の拒否メッセージのテストです。保護ブランチで `git push` を拒否する場合に、標準出力のメッセージへ `push` と `feature` が含まれることを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt2')
    const result = runWorktreeCheck(hookCase, repository, 'git push', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('push')
    expect(result.stdout).toContain('feature')
  })

  // pwd と HOOK_WORKING_DIR が別のリポを指すクロスリポジトリのケース
  it('git -C の対象が feature で HOOK_WORKING_DIR が保護ブランチのとき、通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`git -C` の対象が feature ブランチで、`HOOK_WORKING_DIR` が保護ブランチの場合に、何も出力せず終了コード 0 で許可することを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'wt1')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'feat/awesome')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      env: { HOOK_COMMAND: `git -C ${secondary} commit -m msg`, HOOK_WORKING_DIR: primary },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('git -C の対象が保護ブランチで HOOK_WORKING_DIR が feature のとき、止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`git -C` の対象が保護ブランチ（`wt2`）で、`HOOK_WORKING_DIR` が feature ブランチの場合に、終了コード 1 で拒否し、ブランチ名を示すことを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'feat/main-work')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'wt2')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      env: { HOOK_COMMAND: `git -C ${secondary} commit -m msg`, HOOK_WORKING_DIR: primary },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt2\'')
  })

  it('pwd が保護ブランチでも HOOK_WORKING_DIR が feature のとき、HOOK_WORKING_DIR を優先して通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。現在のディレクトリが保護ブランチで、`HOOK_WORKING_DIR` が feature ブランチの場合に、`HOOK_WORKING_DIR` を優先して許可することを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'feat/work')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'wt1')
    const result = runWorktreeCheck(hookCase, secondary, 'git commit -m "msg"', primary)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('pwd が feature でも HOOK_WORKING_DIR が保護ブランチのとき、HOOK_WORKING_DIR を優先して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。現在のディレクトリが feature ブランチで、`HOOK_WORKING_DIR` が保護ブランチ（`wt2`）の場合に、`HOOK_WORKING_DIR` を優先して拒否することを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'wt2')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'feat/other')
    const result = runWorktreeCheck(hookCase, secondary, 'git commit -m "msg"', primary)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt2\'')
  })

  it('HOOK_WORKING_DIR が未設定のとき、pwd のブランチで判定して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`HOOK_WORKING_DIR` が設定されていない場合に、現在のディレクトリのブランチ（`wt1`）で判定し、終了コード 1 で拒否することを確認します。')
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "msg"', undefined)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt1\'')
  })

  // 対象リポジトリの解決順は、cd チェイン / HOOK_TOOL_CWD が HOOK_WORKING_DIR より先になる。
  it('cd 先が保護ブランチで HOOK_WORKING_DIR が feature のとき、cd 先で判定して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`cd` の移動先が保護ブランチ（`wt5`）で、`HOOK_WORKING_DIR` が feature ブランチの場合に、移動先のブランチで判定して拒否することを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'feat/work')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'wt5')
    const result = runWorktreeCheck(hookCase, primary, `cd ${secondary} && git commit -m "msg"`, primary)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt5\'')
  })

  it('cd 先が feature で HOOK_WORKING_DIR が保護ブランチのとき、cd 先で判定して通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`cd` の移動先が feature ブランチで、`HOOK_WORKING_DIR` が保護ブランチの場合に、移動先のブランチで判定して許可することを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'wt1')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'feat/other')
    const result = runWorktreeCheck(hookCase, primary, `cd ${secondary} && git commit -m "msg"`, primary)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('HOOK_TOOL_CWD が保護ブランチで HOOK_WORKING_DIR が feature のとき、HOOK_TOOL_CWD で判定して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`HOOK_TOOL_CWD` が保護ブランチ（`wt6`）で、`HOOK_WORKING_DIR` が feature ブランチの場合に、`HOOK_TOOL_CWD` で判定して拒否することを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'feat/work')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'wt6')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      cwd: primary,
      env: { HOOK_COMMAND: 'git commit -m "msg"', HOOK_TOOL_CWD: secondary, HOOK_WORKING_DIR: primary },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt6\'')
  })

  it('HOOK_TOOL_CWD が feature で HOOK_WORKING_DIR が保護ブランチのとき、HOOK_TOOL_CWD で判定して通す', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`HOOK_TOOL_CWD` が feature ブランチで、`HOOK_WORKING_DIR` が保護ブランチの場合に、`HOOK_TOOL_CWD` で判定して許可することを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'wt2')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'feat/other')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      cwd: primary,
      env: { HOOK_COMMAND: 'git commit -m "msg"', HOOK_TOOL_CWD: secondary, HOOK_WORKING_DIR: primary },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // cd チェインは、git ワークツリーとして解決できた cd 先だけを採る。
  it('cd 先が git でないとき、cd を採らず HOOK_TOOL_CWD 以降で判定して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`cd` の移動先が git リポジトリでない場合に、その `cd` を採用せず、`HOOK_TOOL_CWD` 以降の指定で判定して拒否することを確認します。')
    const hookCase = createHookCase()
    const plain = path.join(hookCase.temporaryPath, 'plain-dir')
    mkdirSync(plain)
    const protectedRepository = gitRepository(hookCase, 'protected')
    checkout(hookCase, protectedRepository, 'wt7')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      cwd: protectedRepository,
      env: {
        HOOK_COMMAND: `cd ${plain} && git commit -m "msg"`,
        HOOK_TOOL_CWD: protectedRepository,
        HOOK_WORKING_DIR: protectedRepository,
      },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt7\'')
  })

  it('多段の cd の先頭が git でないとき、後段の cd も評価して保護ブランチなら止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。多段の `cd` の先頭が git リポジトリでない場合に、後段の `cd` の移動先（保護ブランチ `wt8`）も評価して拒否することを確認します。')
    const hookCase = createHookCase()
    const plain = path.join(hookCase.temporaryPath, 'plain-dir')
    mkdirSync(plain)
    const protectedRepository = gitRepository(hookCase, 'protected')
    checkout(hookCase, protectedRepository, 'wt8')
    // 解決に失敗すると HOOK_WORKING_DIR（feature）で判定して通すので、止まること自体が後段を評価した証拠になる。
    const session = gitRepository(hookCase, 'session')
    checkout(hookCase, session, 'feat/session-work')
    const result = runWorktreeCheck(hookCase, session, `cd ${plain} && cd ${protectedRepository} && git commit -m "msg"`, session)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt8\'')
  })

  it('相対 cd のとき、フックの pwd ではなく HOOK_TOOL_CWD を基点に解決して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。相対パスの `cd` を含む場合に、フックの現在のディレクトリではなく `HOOK_TOOL_CWD` を基点に解決し、保護ブランチ（`wt9`）を拒否することを確認します。')
    const hookCase = createHookCase()
    // 同名の target を、ツール cwd 側とフック pwd 側の両方に置き、選ばれた側をブランチ名で見分ける。
    const toolSide = gitRepository(hookCase, 'tool-base/target')
    checkout(hookCase, toolSide, 'wt9')
    const hookSide = gitRepository(hookCase, 'hook-base/target')
    checkout(hookCase, hookSide, 'feat/hook-side')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      cwd: path.dirname(hookSide),
      env: {
        HOOK_COMMAND: 'cd target && git commit -m "msg"',
        HOOK_TOOL_CWD: path.dirname(toolSide),
        HOOK_WORKING_DIR: path.dirname(hookSide),
      },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt9\'')
  })

  it('cd チェイン経由の push のとき、commit と同じく cd 先のブランチで判定して止める', async () => {
    await explains('`git-worktree-branch-check.sh` のテストです。`cd` を連結した `git push` を実行しようとした場合に、`git commit` と同様に移動先のブランチ（`wt5`）で判定して拒否することを確認します。')
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'feat/work')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'wt5')
    const result = runWorktreeCheck(hookCase, primary, `cd ${secondary} && git push origin HEAD`, primary)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt5\'')
    expect(result.stdout).toContain('push')
  })
})
