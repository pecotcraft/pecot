/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// コアスクリプト（lib/core）の単体テスト。HOOK_COMMAND などを env で渡して直接起動する。
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { isFile } from '../_helpers/files.js'
import { gitOrThrow, gitRepository } from '../_helpers/git.js'
import { adapterDirectory, coreDirectory } from '../_helpers/paths.js'
import { run, runHookScript } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'

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

function touch(file: string): void {
  writeFileSync(file, '')
}

interface SlashFlag {
  readonly env: EnvironmentOverrides
  readonly flag: string
}

// HOOK_WORKING_DIR 配下の .pecot/state にフラグを置く。
function setUpSlashFlag(hookCase: HookCase, projectName: string, flagName: string): SlashFlag {
  const project = path.join(hookCase.temporaryPath, projectName)
  const state = path.join(project, '.pecot', 'state')
  mkdirSync(state, { recursive: true })
  const flag = path.join(state, flagName)
  writeFileSync(flag, '')
  return { env: { HOOK_WORKING_DIR: project }, flag }
}

function setUpProjectWithoutFlag(hookCase: HookCase, projectName: string): string {
  const project = path.join(hookCase.temporaryPath, projectName)
  mkdirSync(path.join(project, '.pecot', 'state'), { recursive: true })
  return project
}

describe('git-no-verify-check.sh', () => {
  it.for(commandRows([
    'git commit --no-verify',
    'git push --no-verify',
    'git commit -n',
    'echo test && git commit --no-verify -m "msg"',
    'echo ok && git commit -n',
    'git push -n',
    'git -C /repo commit -n',
    'echo ng || git commit -n',
    'git commit -m \'my message\' -n',
    'git merge --no-verify',
    'git Commit -n',
    // 単独 & （バックグラウンド区切り）の後続も検出する
    'echo x & git commit --no-verify -m x',
    'echo x&git commit -n',
    'echo x & git push --no-verify',
  ]))('コマンドが $label のとき、終了コード 1 で止める', (row) => {
    const hookCase = createHookCase()
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
  ]))('コマンドが $label のとき、何も出力せず通す', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('--no-verify を使うとき、止めるメッセージにそのフラグを含める', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: 'git commit --no-verify' } })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('--no-verify')
  })

  it('--no-verify を使うとき、止めるメッセージにエラー見出しと修正の案内を含める', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: 'git commit --no-verify' } })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('error: git-no-verify-check:')
    expect(result.stdout).toContain('When a hook reports an error:')
    expect(result.stdout).toContain('Fix the root cause of the violation')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'git-no-verify-check.sh', { env: { HOOK_COMMAND: undefined } })
    expect(result.exitCode).toBe(2)
  })
})

describe('git-checkout-check.sh', () => {
  it('untracked ファイルがあるとき、警告を出す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    touch(path.join(repository, 'untracked-file.txt'))
    const result = runCore(hookCase, 'git-checkout-check.sh', {
      cwd: repository,
      env: { HOOK_COMMAND: 'git checkout main', HOOK_WORKING_DIR: repository },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('untracked')
  })

  it.for(commandRows(['git switch\tmain', 'git  checkout main', 'git\tcheckout\tmain', 'git switch  main']))(
    'コマンドが $label のとき、タブや連続空白の区切りでも untracked を警告する',
    (row) => {
      const hookCase = createHookCase()
      const repository = gitRepository(hookCase)
      touch(path.join(repository, 'untracked-file.txt'))
      const result = runCore(hookCase, 'git-checkout-check.sh', {
        cwd: repository,
        env: { HOOK_COMMAND: row.command, HOOK_WORKING_DIR: repository },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('untracked')
    },
  )

  it('untracked ファイルが無いとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    const result = runCore(hookCase, 'git-checkout-check.sh', {
      cwd: repository,
      env: { HOOK_COMMAND: 'git checkout main', HOOK_WORKING_DIR: repository },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('git checkout -b で新しいブランチを作るときも、untracked があれば警告を出す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    touch(path.join(repository, 'untracked-file.txt'))
    const result = runCore(hookCase, 'git-checkout-check.sh', {
      cwd: repository,
      env: { HOOK_COMMAND: 'git checkout -b new-branch', HOOK_WORKING_DIR: repository },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('untracked')
  })

  it('cd で別リポへ移ってから checkout するとき、cd 先の untracked を見る', () => {
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    const secondary = gitRepository(hookCase, 'secondary')
    touch(path.join(secondary, 'untracked-file.txt'))
    const result = runCore(hookCase, 'git-checkout-check.sh', {
      cwd: primary,
      env: { HOOK_COMMAND: `cd ${secondary} && git checkout main`, HOOK_WORKING_DIR: primary },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('untracked-file.txt')
  })

  it('HOOK_TOOL_CWD があるとき、HOOK_WORKING_DIR より優先して別リポの untracked を拾う', () => {
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    const secondary = gitRepository(hookCase, 'secondary')
    touch(path.join(secondary, 'untracked-file.txt'))
    const result = runCore(hookCase, 'git-checkout-check.sh', {
      cwd: primary,
      env: { HOOK_COMMAND: 'git checkout main', HOOK_TOOL_CWD: secondary, HOOK_WORKING_DIR: primary },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('untracked-file.txt')
  })

  it('checkout 以外のコマンドのとき、何も出力しない', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'git-checkout-check.sh', { env: { HOOK_COMMAND: 'git status' } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'git-checkout-check.sh', { env: { HOOK_COMMAND: undefined } })
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
  ]))('コマンドが $label のとき、終了コード 1 で止める', (row) => {
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
  ]))('コマンドが $label のとき、何も出力せず通す', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'gh-command-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'gh-command-check.sh', { env: { HOOK_COMMAND: undefined } })
    expect(result.exitCode).toBe(2)
  })
})

// gh pr merge のユーザー承認ガード。pecot の起動は pecot-cli-deny.sh が deny し、
// MCP ツールの投稿の ask は pecot-post-ask.sh が持つ。そのため external-post-check.sh は pecot の起動を判定しない。
describe('external-post-check.sh', () => {
  it.for(commandRows([
    'gh pr merge 789',
    'gh pr merge --squash',
    'GH_HOST=ghes.example.com gh pr merge 810',
    'git push && gh pr merge 1',
    // 単独の & の後続も検出する
    'git push & gh pr merge 1',
    '/usr/bin/gh pr merge 1',
    // リダイレクト 2>&1 は & で分割されるが、起動形のセグメントは残る
    'gh pr merge 1 2>&1 | tail -5',
    '(gh pr merge 1) && echo done',
    'echo $(gh pr merge 1)',
    'gh pr merge 1 --help && gh pr merge 2',
    // pecot の起動があっても、gh pr merge 側で承認を求める
    'pecot pr create --prepare && gh pr merge 810',
  ]))('コマンドが $label のとき、承認を求める（終了コード 11）', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('warning: external-post-check:')
  })

  it.for(commandRows([
    // pecot の起動は判定しない（deny は pecot-cli-deny.sh）
    'pecot pr create x.md',
    'pecot pr create --prepare',
    'pecot issue quick -r owner/repo -m x',
    'pecot issue create x.md',
    '$PECOT pr create ./x.md',
    '"${CLAUDE_PLUGIN_ROOT}/bin/pecot" issue create x.md',
    'pecot pr cleanup 810',
    'pecot pr read acme-labs/aist-plugin/810',
    // 文字列内・ファイル名内
    'echo "gh pr merge"',
    'cat gh-pr-merge-notes.txt',
    // gh の別の操作
    'gh pr view 810',
    'gh pr list',
  ]))('コマンドが $label のとき、何も出力せず通す', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('gh pr merge のとき、w-merge と MCP ツールの pr_cleanup を案内する', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: 'gh pr merge 810' } })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('/pecot-w:w-merge')
    expect(result.stdout).toContain('the MCP tool pr_cleanup')
    expect(result.stdout).not.toContain('pecot pr cleanup')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: undefined } })
    expect(result.exitCode).toBe(2)
  })

  // merge-slash-pending は存在だけで判定し、消費しない。どのケースもフラグの残存を確かめる。
  it.for(commandRows(['gh pr merge 810', 'gh pr merge 810 --squash --auto']))(
    'merge-slash-pending があり、コマンドが $label のとき、通してフラグを残す',
    (row) => {
      const hookCase = createHookCase()
      const slash = setUpSlashFlag(hookCase, 'merge-slash-project', 'merge-slash-pending')
      const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: row.command } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(isFile(slash.flag)).toBe(true)
    },
  )

  it('merge-slash-pending が無いとき、gh pr merge は承認を求める', () => {
    const hookCase = createHookCase()
    const project = setUpProjectWithoutFlag(hookCase, 'noflag-merge-project')
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { HOOK_WORKING_DIR: project, HOOK_COMMAND: 'gh pr merge 810' },
    })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('warning: external-post-check:')
  })

  it.for(commandRows(['pr-create-slash-pending', 'issue-create-slash-pending']))(
    '$label があっても、gh pr merge は免除せず承認を求める',
    (row) => {
      const hookCase = createHookCase()
      const slash = setUpSlashFlag(hookCase, 'other-flag-project', row.command)
      const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: 'gh pr merge 810' } })
      expect(result.exitCode).toBe(11)
      expect(isFile(slash.flag)).toBe(true)
    },
  )

  it('設定で gh-pr-merge-ask を無効にしているとき、gh pr merge を通す', () => {
    const hookCase = createHookCase()
    const config = path.join(hookCase.temporaryPath, 'hooks-config.json')
    writeFileSync(config, '{"gh-pr-merge-ask": false}')
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { HOOK_COMMAND: 'gh pr merge 810', PECOT_HOOKS_CONFIG_PATH: config },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // すり抜けの回帰（改行区切り・decoy のクオート文字列）
  it.for(commandRows([
    // 改行区切りは ; と同じ区切りとして扱う
    'echo done\ngh pr merge 5',
    // decoy のクオート内の -n を除外フラグと誤認せず、後続の実コマンドを検出する
    'echo "&& gh pr merge -n stuff" && gh pr merge 5',
  ]))('コマンドが $label のとき、すり抜けを許さず承認を求める', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('warning: external-post-check:')
  })

  // gh pr merge は確認フラグの免除を持たない
  it.for(commandRows(['gh pr merge 810 --dry-run', 'gh pr merge 810 -n']))(
    'コマンドが $label のとき、確認フラグを無視して承認を求める',
    (row) => {
      const hookCase = createHookCase()
      const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
      expect(result.exitCode).toBe(11)
      expect(result.stdout).toContain('warning: external-post-check:')
    },
  )
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
  it('保護ブランチで git commit するとき、止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt3')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "msg"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('commit')
  })

  it('保護ブランチで git push するとき、止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runWorktreeCheck(hookCase, repository, 'git push', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('push')
  })

  it('連結コマンドの中の git commit も、保護ブランチなら止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt2')
    const result = runWorktreeCheck(hookCase, repository, 'echo test && git commit -m "msg"', repository)
    expect(result.exitCode).toBe(1)
  })

  it.for([
    ...wordRows(['git\tcommit -m x', 'git  commit -m x', 'echo a;  git\tcommit -m x'], 'commit'),
    ...wordRows(['git\tpush', 'git  push', 'echo a &&\tgit  push'], 'push'),
  ])('コマンドが $label のとき、タブや連続空白の区切りでも保護ブランチなら止める', (row) => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt3')
    const result = runWorktreeCheck(hookCase, repository, row.command, repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(row.word)
  })

  it('git -C で commit するとき、HOOK_WORKING_DIR だけで保護ブランチを判定して止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt4')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      env: { HOOK_COMMAND: `git -C ${repository} commit -m msg`, HOOK_WORKING_DIR: repository },
    })
    expect(result.exitCode).toBe(1)
  })

  it('git status のとき、保護ブランチでも何も出力しない', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', {
      env: { HOOK_COMMAND: 'git status', HOOK_WORKING_DIR: repository },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('wt3 ブランチで commit するとき、ブランチ名を示して止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt3')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt3\'')
  })

  it('wt10 ブランチで commit するとき、ブランチ名を示して止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt10')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt10\'')
  })

  it('wt1 ブランチで push するとき、止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runWorktreeCheck(hookCase, repository, 'git push origin wt1', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('push')
  })

  it('feature ブランチで commit するとき、何も出力せず通す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'feat/test-feature')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('develop-aist ブランチで commit するとき、ブランチ名を示して止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'develop-aist')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'develop-aist\'')
  })

  it('main ブランチで commit するとき、何も出力せず通す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    // 既定ブランチ名と衝突しうるので -B で切り替える。失敗しても続行する。
    run(hookCase, 'git', ['-C', repository, 'checkout', '-B', 'main', '--quiet'])
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('wt の後ろに数字が無いブランチで commit するとき、何も出力せず通す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt-feature')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('detached HEAD で commit するとき、何も出力せず通す', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    const head = gitOrThrow(hookCase, repository, ['rev-parse', 'HEAD']).stdout.trim()
    gitOrThrow(hookCase, repository, ['checkout', head, '--quiet'])
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'git-worktree-branch-check.sh', { env: { HOOK_COMMAND: undefined } })
    expect(result.exitCode).toBe(2)
  })

  it('claude-bash-guards をプラグインの環境で動かすとき、--no-verify を deny で止める', () => {
    const hookCase = createHookCase()
    const pluginRoot = path.join(hookCase.temporaryPath, 'plugin')
    const pluginCore = path.join(pluginRoot, 'hooks', 'lib', 'core')
    mkdirSync(pluginCore, { recursive: true })
    for (const name of [
      'git-checkout-check.sh',
      'gh-command-check.sh',
      'git-worktree-branch-check.sh',
      'git-no-verify-check.sh',
      'external-post-check.sh',
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
    writeFileSync(config, '{"claude-bash-guards": true}')

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

  it('git リポジトリでないディレクトリで commit するとき、何も出力せず通す', () => {
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

  it('commit を止めるとき、メッセージに commit と feature を含める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "test"', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('commit')
    expect(result.stdout).toContain('feature')
  })

  it('push を止めるとき、メッセージに push と feature を含める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt2')
    const result = runWorktreeCheck(hookCase, repository, 'git push', repository)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('push')
    expect(result.stdout).toContain('feature')
  })

  // pwd と HOOK_WORKING_DIR が別のリポを指すクロスリポジトリのケース
  it('git -C の対象が feature で HOOK_WORKING_DIR が保護ブランチのとき、通す', () => {
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

  it('git -C の対象が保護ブランチで HOOK_WORKING_DIR が feature のとき、止める', () => {
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

  it('pwd が保護ブランチでも HOOK_WORKING_DIR が feature のとき、HOOK_WORKING_DIR を優先して通す', () => {
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'feat/work')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'wt1')
    const result = runWorktreeCheck(hookCase, secondary, 'git commit -m "msg"', primary)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('pwd が feature でも HOOK_WORKING_DIR が保護ブランチのとき、HOOK_WORKING_DIR を優先して止める', () => {
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'wt2')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'feat/other')
    const result = runWorktreeCheck(hookCase, secondary, 'git commit -m "msg"', primary)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt2\'')
  })

  it('HOOK_WORKING_DIR が未設定のとき、pwd のブランチで判定して止める', () => {
    const hookCase = createHookCase()
    const repository = gitRepository(hookCase)
    checkout(hookCase, repository, 'wt1')
    const result = runWorktreeCheck(hookCase, repository, 'git commit -m "msg"', undefined)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt1\'')
  })

  // 対象リポジトリの解決順は、cd チェイン / HOOK_TOOL_CWD が HOOK_WORKING_DIR より先になる。
  it('cd 先が保護ブランチで HOOK_WORKING_DIR が feature のとき、cd 先で判定して止める', () => {
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'feat/work')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'wt5')
    const result = runWorktreeCheck(hookCase, primary, `cd ${secondary} && git commit -m "msg"`, primary)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('\'wt5\'')
  })

  it('cd 先が feature で HOOK_WORKING_DIR が保護ブランチのとき、cd 先で判定して通す', () => {
    const hookCase = createHookCase()
    const primary = gitRepository(hookCase, 'primary')
    checkout(hookCase, primary, 'wt1')
    const secondary = gitRepository(hookCase, 'secondary')
    checkout(hookCase, secondary, 'feat/other')
    const result = runWorktreeCheck(hookCase, primary, `cd ${secondary} && git commit -m "msg"`, primary)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('HOOK_TOOL_CWD が保護ブランチで HOOK_WORKING_DIR が feature のとき、HOOK_TOOL_CWD で判定して止める', () => {
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

  it('HOOK_TOOL_CWD が feature で HOOK_WORKING_DIR が保護ブランチのとき、HOOK_TOOL_CWD で判定して通す', () => {
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
  it('cd 先が git でないとき、cd を採らず HOOK_TOOL_CWD 以降で判定して止める', () => {
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

  it('多段の cd の先頭が git でないとき、後段の cd も評価して保護ブランチなら止める', () => {
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

  it('相対 cd のとき、フックの pwd ではなく HOOK_TOOL_CWD を基点に解決して止める', () => {
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

  it('cd チェイン経由の push のとき、commit と同じく cd 先のブランチで判定して止める', () => {
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
