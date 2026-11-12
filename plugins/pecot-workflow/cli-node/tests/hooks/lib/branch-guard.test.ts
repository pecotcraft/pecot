/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// branch-guard.sh の is_feature_branch 関数のテスト。関数は source が要るので、bash -c で source してから呼ぶ。
// 終了コード 0 は feature ブランチ、0 以外は feature ブランチではない。
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase, hooksConfig } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { gitRepository } from '../_helpers/git.js'
import { coreDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'

function runIsFeatureBranch(hookCase: HookCase, repositoryDirectory: string): RunResult {
  return run(hookCase, 'bash', ['-c', 'source "$1/branch-guard.sh" && is_feature_branch "$2"', '_', coreDirectory, repositoryDirectory])
}

function runGit(hookCase: HookCase, repositoryDirectory: string, argv: readonly string[]): RunResult {
  const result = run(hookCase, 'git', ['-C', repositoryDirectory, ...argv])
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(' ')} が ${String(result.exitCode)} で終わりました: ${result.stderr}`)
  return result
}

// -B は対象ブランチが既存でも作成（リセット）して checkout する。
// 初期コミットが乗る既定ブランチ名は init.defaultBranch に依存し、main の行で衝突しても失敗しないようにする。
function checkout(hookCase: HookCase, repositoryDirectory: string, branch: string): void {
  runGit(hookCase, repositoryDirectory, ['checkout', '-B', branch])
}

describe('branch-guard.sh の is_feature_branch', () => {
  it.for([
    { branch: 'feat/add-auth', isFeature: true, verdict: 'feature と判定する' },
    { branch: 'fix/login-bug', isFeature: true, verdict: 'feature と判定する' },
    { branch: 'wt1', isFeature: false, verdict: 'feature と判定しない' },
    { branch: 'wt2', isFeature: false, verdict: 'feature と判定しない' },
    { branch: 'develop-aist', isFeature: false, verdict: 'feature と判定しない' },
    { branch: 'main', isFeature: false, verdict: 'feature と判定しない' },
  ])('ブランチが $branch のとき、$verdict', (row) => {
    const hookCase = createHookCase()
    // PECOT_HOOKS_CONFIG_PATH を一時ディレクトリに隔離する
    hooksConfig(hookCase)
    const repositoryDirectory = gitRepository(hookCase)
    checkout(hookCase, repositoryDirectory, row.branch)

    const result = runIsFeatureBranch(hookCase, repositoryDirectory)

    expect(result.exitCode === 0).toBe(row.isFeature)
  })

  it('設定で branch-guard が false のとき、wt ブランチでも feature として扱う', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase).write({ 'branch-guard': false })
    const repositoryDirectory = gitRepository(hookCase)
    checkout(hookCase, repositoryDirectory, 'wt1')

    const result = runIsFeatureBranch(hookCase, repositoryDirectory)

    expect(result.exitCode).toBe(0)
  })

  it('設定で branch-guard が true のとき、通常どおり判定し、develop-aist は feature としない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase).write({ 'branch-guard': true })
    const repositoryDirectory = gitRepository(hookCase)
    checkout(hookCase, repositoryDirectory, 'develop-aist')

    const result = runIsFeatureBranch(hookCase, repositoryDirectory)

    expect(result.exitCode).not.toBe(0)
  })

  it('git リポジトリでないディレクトリのとき、feature としない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const notRepository = path.join(hookCase.temporaryPath, 'not-a-repo')
    mkdirSync(notRepository)

    const result = runIsFeatureBranch(hookCase, notRepository)

    expect(result.exitCode).not.toBe(0)
  })

  it('detached HEAD のとき、feature としない', () => {
    const hookCase = createHookCase()
    hooksConfig(hookCase)
    const repositoryDirectory = gitRepository(hookCase)
    const commitHash = runGit(hookCase, repositoryDirectory, ['rev-parse', 'HEAD']).stdout.trim()
    runGit(hookCase, repositoryDirectory, ['checkout', commitHash])

    const result = runIsFeatureBranch(hookCase, repositoryDirectory)

    expect(result.exitCode).not.toBe(0)
  })
})
