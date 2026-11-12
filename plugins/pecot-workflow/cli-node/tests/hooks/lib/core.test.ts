/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// コアスクリプト（lib/core）の単体テスト。HOOK_COMMAND などを env で渡して直接起動する。
import { chmodSync, copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
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

function runGit(hookCase: HookCase, repository: string, argv: readonly string[]): RunResult {
  const result = run(hookCase, 'git', ['-C', repository, ...argv])
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(' ')} が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
  return result
}

function checkout(hookCase: HookCase, repository: string, branch: string): void {
  runGit(hookCase, repository, ['checkout', '-b', branch, '--quiet'])
}

function touch(file: string): void {
  writeFileSync(file, '')
}

function isFile(file: string): boolean {
  return statSync(file, { throwIfNoEntry: false })?.isFile() === true
}

interface SlashFlag {
  readonly env: EnvironmentOverrides
  readonly flag: string
}

// HOOK_WORKING_DIR 配下の .pecot/state にフラグを置く。
function setUpSlashFlag(hookCase: HookCase, projectName: string, flagName: string, content = ''): SlashFlag {
  const project = path.join(hookCase.temporaryPath, projectName)
  const state = path.join(project, '.pecot', 'state')
  mkdirSync(state, { recursive: true })
  const flag = path.join(state, flagName)
  writeFileSync(flag, content)
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

describe('external-post-check.sh', () => {
  it.for(commandRows([
    // pecot pr create（実投稿）
    'pecot pr create x.md',
    'pecot pr create -m "fix bug" -t topic -b main',
    '$PECOT pr create ./x.md',
    // 引数なしでも承認を求める
    'pecot pr create',
    // クオート内の -n を除外フラグと誤認しない
    'pecot pr create -m "fix -n bug" -t t -b main',
    // 各起動形
    '"$PECOT" pr create x.md',
    '/home/vscode/.claude/plugins/pecot/pecot-w/bin/pecot pr create x.md',
    '"${CLAUDE_PLUGIN_ROOT}/bin/pecot" pr create x.md',
    // gh pr merge の各形
    'gh pr merge 789',
    'gh pr merge --squash',
    'GH_HOST=ghes.example.com gh pr merge 810',
    'git push && gh pr merge 1',
    // 単独 & の後続も検出する
    'git push & gh pr merge 1',
    '/usr/bin/gh pr merge 1',
    // 2>&1 は & 分割で断片になるが、起動形のセグメントは残る
    'pecot pr create x.md 2>&1 | tail -5',
    // 確認フラグは同一セグメント内にしか働かない
    'pecot pr create --prepare && pecot pr create body.md',
    'pecot pr create --prepare; pecot pr create body.md',
    'pecot pr create body.md && pecot pr create --prepare',
    'pecot pr create --prepare&&pecot pr create body.md',
    'pecot pr create --prepare & pecot pr create body.md',
    'pecot pr create --prepare\npecot pr create body.md',
    'PECOT_DEBUG=1 pecot pr create --prepare && PECOT_DEBUG=1 pecot pr create body.md',
    // 非先頭セグメントの環境変数前置
    'pecot pr create --prepare && GH_HOST=ghes.example.com pecot pr create y.md',
    '(pecot pr create --prepare) && (pecot pr create body.md)',
    'echo $(pecot pr create --prepare) && pecot pr create x.md',
    'pecot pr create --prepare | pecot pr create x.md',
    'pecot pr create --help && pecot pr create body.md',
  ]))('コマンドが $label のとき、承認を求める（終了コード 11）', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('warning: external-post-check:')
  })

  it.for(commandRows([
    // 確認用フラグ（位置は問わない）は通す
    'pecot pr create --prepare',
    'pecot pr create -p',
    'pecot pr create --help',
    'pecot pr create x.md --dry-run',
    'pecot pr create x.md -n',
    // 検出の対象外のサブコマンド
    'pecot pr cleanup 810',
    'pecot pr cleanup 810 --delete-branch',
    '"$PECOT" pr cleanup 810',
    'pecot pr read acme-labs/aist-plugin/810',
    'pecot pr preflight',
    // 文字列内・ファイル名内
    'echo "gh pr merge"',
    'cat gh-pr-merge-notes.txt',
    // ${PECOT} 展開形は対象外
    '${PECOT} pr create x.md',
    // 実投稿のセグメントが無ければ通す
    'pecot pr create --prepare && pecot pr read acme-labs/aist-plugin/1',
    'pecot pr create --prepare && pecot pr create --dry-run',
    'pecot pr create --prepare && git push',
    'pecot pr create --prepare | tee log.txt',
    // 2>&1 の断片が確認フラグの比較を壊さない
    'pecot pr create --prepare 2>&1',
    'pecot pr create --dry-run x.md 2>&1 | tail -5',
    // セグメント先頭のアンカーで先頭一致が緩んでいない
    'mypecot pr create x.md',
  ]))('コマンドが $label のとき、何も出力せず通す', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('gh pr merge のとき、w-merge と pecot pr cleanup を案内する', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: 'gh pr merge 810' } })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('/pecot-w:w-merge')
    expect(result.stdout).toContain('pecot pr cleanup')
  })

  it('確認フラグ付きの pr create と gh pr merge が混在するとき、gh pr merge 側で承認を求める', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { HOOK_COMMAND: 'pecot pr create --prepare && gh pr merge 810' },
    })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('/pecot-w:w-merge')
    expect(result.stdout).toContain('pecot pr cleanup')
  })

  it('HOOK_COMMAND が未設定のとき、終了コード 2 を返す', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: undefined } })
    expect(result.exitCode).toBe(2)
  })

  // pr-create-slash-pending は存在だけで判定し、消費しない。どのケースもフラグの残存を確かめる。
  it('pr-create-slash-pending があるとき、pecot pr create を通し、フラグを残す', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'slash-project', 'pr-create-slash-pending')
    const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: 'pecot pr create x.md' } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(isFile(slash.flag)).toBe(true)
  })

  it('pr-create-slash-pending があるとき、同じコマンドを繰り返しても免除が続く', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'slash-project', 'pr-create-slash-pending')
    const first = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: 'pecot pr create x.md' } })
    const second = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: 'pecot pr create x.md' } })
    expect(first.exitCode).toBe(0)
    expect(second.exitCode).toBe(0)
    expect(isFile(slash.flag)).toBe(true)
  })

  it('pr-create-slash-pending があるとき、-m 形の pecot pr create も通し、フラグを残す', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'slash-project', 'pr-create-slash-pending')
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { ...slash.env, HOOK_COMMAND: 'pecot pr create -m "fix" -t t -b main' },
    })
    expect(result.exitCode).toBe(0)
    expect(isFile(slash.flag)).toBe(true)
  })

  it.for(commandRows(['pecot pr create --prepare', 'pecot pr create x.md --dry-run', 'pecot pr create x.md -n']))(
    'pr-create-slash-pending があり、コマンドが $label のとき、通してフラグを残す',
    (row) => {
      const hookCase = createHookCase()
      const slash = setUpSlashFlag(hookCase, 'slash-project', 'pr-create-slash-pending')
      const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: row.command } })
      expect(result.exitCode).toBe(0)
      expect(isFile(slash.flag)).toBe(true)
    },
  )

  it('pr-create-slash-pending があるとき、分割した連結コマンド全体を免除する', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'slash-project', 'pr-create-slash-pending')
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { ...slash.env, HOOK_COMMAND: 'pecot pr create --prepare && pecot pr create x.md' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(isFile(slash.flag)).toBe(true)
  })

  it('pr-create-slash-pending があっても、gh pr merge は免除せず承認を求める', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'slash-project', 'pr-create-slash-pending')
    const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: 'gh pr merge 810' } })
    expect(result.exitCode).toBe(11)
    expect(isFile(slash.flag)).toBe(true)
  })

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

  it('merge-slash-pending があっても、pecot pr create は免除せず承認を求める', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'merge-slash-project', 'merge-slash-pending')
    const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: 'pecot pr create x.md' } })
    expect(result.exitCode).toBe(11)
  })

  it('pr-create-slash-pending が無いとき、pecot pr create は承認を求める', () => {
    const hookCase = createHookCase()
    const project = setUpProjectWithoutFlag(hookCase, 'noflag-project')
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { HOOK_WORKING_DIR: project, HOOK_COMMAND: 'pecot pr create x.md' },
    })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('warning: external-post-check:')
  })

  it('設定で pecot-pr-create-ask を無効にしていても、pr-create-slash-pending があれば通す', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'slash-project', 'pr-create-slash-pending')
    const config = path.join(hookCase.temporaryPath, 'hooks-config.json')
    writeFileSync(config, '{"pecot-pr-create-ask": false}')
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { ...slash.env, HOOK_COMMAND: 'pecot pr create x.md', PECOT_HOOKS_CONFIG_PATH: config },
    })
    expect(result.exitCode).toBe(0)
    expect(isFile(slash.flag)).toBe(true)
  })

  // すり抜けの回帰（改行区切り・decoy のクオート文字列・シングルクオートのパス）
  it.for(commandRows([
    // 改行区切りは ; と同じ区切りとして扱う
    'echo done\ngh pr merge 5',
    // decoy のクオート内の -n を除外フラグと誤認せず、後続の実コマンドを検出する
    'echo "&& gh pr merge -n stuff" && gh pr merge 5',
    // シングルクオートで囲んだフルパスの起動
    '\'/home/user/pecot\' pr create x.md',
  ]))('コマンドが $label のとき、すり抜けを許さず承認を求める', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('warning: external-post-check:')
  })

  // 別セグメントの --dry-run / -n を、同じコマンドの確認フラグと誤認しない
  it.for(commandRows(['pecot pr create x.md && echo -n done', 'pecot pr create x.md | grep -n foo']))(
    'コマンドが $label のとき、別セグメントのフラグを確認フラグと見なさず承認を求める',
    (row) => {
      const hookCase = createHookCase()
      const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
      expect(result.exitCode).toBe(11)
      expect(result.stdout).toContain('warning: external-post-check:')
    },
  )

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

  it.for(commandRows([
    // pecot issue quick（実投稿）
    'pecot issue quick -r owner/repo -m "fix"',
    // 引数なしでも承認を求める
    'pecot issue quick',
    '$PECOT issue quick -r owner/repo -m x',
    '"$PECOT" issue quick -r owner/repo -m x',
    '/home/vscode/.claude/plugins/pecot/pecot-w/bin/pecot issue quick -m x',
    '"${CLAUDE_PLUGIN_ROOT}/bin/pecot" issue quick -m x',
    // pecot issue create（ファイル指定、-m の直接指定）
    'pecot issue create x.md',
    'pecot issue create phase1.md phase2.md',
    'pecot issue create -t "t" -r owner/repo -m "body"',
    // クオート内の -p を確認フラグと誤認しない
    'pecot issue create x.md -m "fix -p bug"',
    // 確認フラグは同一セグメント内にしか働かない
    'pecot issue create --prepare --template task && pecot issue create x.md',
    'pecot issue create --prepare; pecot issue create x.md',
    'pecot issue create x.md && pecot issue create --prepare',
    'pecot issue create --help && pecot issue create x.md',
    'pecot issue quick --help && pecot issue quick -m x',
    'PECOT_DEBUG=1 pecot issue quick -m x',
    'git status && pecot issue quick -m x',
    'echo done\npecot issue create x.md',
  ]))('コマンドが $label のとき、canonical route を案内して承認を求める', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('warning: external-post-check:')
    expect(result.stdout).toContain('canonical route')
  })

  it.for(commandRows([
    // 確認用フラグ（--prepare / -p）は通す
    'pecot issue create --prepare --template task --repo owner/repo',
    'pecot issue create -p --template task --repo owner/repo',
    'pecot issue create --help',
    'pecot issue quick --help',
    'pecot issue create --prepare --template task-implement --suffix phase1 --repo o/r',
    // 検出の対象外のサブコマンド
    'pecot issue read acme-labs/aist-plugin/937',
    'pecot issue reopen acme-labs/aist-plugin/937',
    'pecot issue comment --prepare',
    'pecot update-issue-status acme-labs/aist-plugin/1 active',
    // 文字列内・ファイル名内
    'echo "pecot issue quick"',
    'cat pecot-issue-create-notes.txt',
    // ${PECOT} 展開形は対象外（pr 側と同じ方針）
    '${PECOT} issue quick -m x',
    // セグメント先頭のアンカー
    'mypecot issue quick -m x',
    // 実投稿のセグメントが無ければ通す
    'pecot issue create --prepare --template task --repo o/r && git status',
  ]))('コマンドが $label のとき、issue 起票の確認を何も出力せず通す', (row) => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', { env: { HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  // issue-create-slash-pending は存在だけで判定し、消費しない（消費は CLI 側）。
  it.for(commandRows([
    'pecot issue quick -r owner/repo -m "fix"',
    'pecot issue create x.md',
    'pecot issue create phase1.md phase2.md',
  ]))('issue-create-slash-pending があり、コマンドが $label のとき、通してフラグを残す', (row) => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'issue-slash-project', 'issue-create-slash-pending', 'w-quick\n')
    const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: row.command } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(isFile(slash.flag)).toBe(true)
  })

  it('issue-create-slash-pending があっても、pecot pr create は免除せず承認を求める', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'issue-slash-project', 'issue-create-slash-pending', 'w-quick\n')
    const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: 'pecot pr create x.md' } })
    expect(result.exitCode).toBe(11)
    expect(isFile(slash.flag)).toBe(true)
  })

  it('pr-create-slash-pending があっても、pecot issue quick は免除せず承認を求める', () => {
    const hookCase = createHookCase()
    const slash = setUpSlashFlag(hookCase, 'slash-project', 'pr-create-slash-pending')
    const result = runCore(hookCase, 'external-post-check.sh', { env: { ...slash.env, HOOK_COMMAND: 'pecot issue quick -m x' } })
    expect(result.exitCode).toBe(11)
    expect(isFile(slash.flag)).toBe(true)
  })

  it('issue-create-slash-pending が無いとき、pecot issue quick は承認を求める', () => {
    const hookCase = createHookCase()
    const project = setUpProjectWithoutFlag(hookCase, 'issue-noflag-project')
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { HOOK_WORKING_DIR: project, HOOK_COMMAND: 'pecot issue quick -m x' },
    })
    expect(result.exitCode).toBe(11)
  })

  // どちらも終了コード 11 なので、issue 側のメッセージにしか無い語で見分ける。
  it('issue と pr の承認が混在するとき、issue のチェックを先に確定する', () => {
    const hookCase = createHookCase()
    const result = runCore(hookCase, 'external-post-check.sh', {
      env: { HOOK_COMMAND: 'pecot issue quick -m x && pecot pr create x.md' },
    })
    expect(result.exitCode).toBe(11)
    expect(result.stdout).toContain('canonical route')
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
    const head = runGit(hookCase, repository, ['rev-parse', 'HEAD']).stdout.trim()
    runGit(hookCase, repository, ['checkout', head, '--quiet'])
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
