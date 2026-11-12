/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AmbiguousRepositoryError, resolveRepository } from '../../domain/repository-resolver.js'
import { installFakeExecutable, prependToPath } from '../../tests/_helpers/fake-executables.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import {
  GitCommandError,
  gitCurrentBranch,
  gitRemoteUrl,
  gitRunnerFor,
  gitToplevel,
  primaryRemoteName,
  primaryRemoteRepository,
  remoteRepository,
  runGit,
} from '../git.js'

useIsolatedEnvironment()

/**
PATH を git の無いディレクトリだけにする（git が見つからない環境）
*/
function withoutGit(): void {
  setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
}

describe('runGit', () => {
  it('git に引数を渡し、標準出力を返す（実 git）', () => {
    const repository = createGitRepository({ 'a.txt': 'x' })
    writeFileSync(path.join(repository, 'b.txt'), 'y')
    const result = runGit(['status', '--short'], { cwd: repository, check: true })
    expect(result).toEqual({ exitCode: 0, stdout: '?? b.txt\n', stderr: '' })
  })

  it('cwd を省略すると呼び出し元の作業ディレクトリで動く', () => {
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'pwd\n')
    prependToPath(bin)
    expect(runGit(['status']).stdout.trim()).toBe(process.cwd())
  })

  it('stripGitEnvironment で GIT_* を除き、他の変数は残す', () => {
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'env\n')
    prependToPath(bin)
    setEnvironment({ GIT_DIR: '/elsewhere/.git', PECOT_TEST_KEEP: '1' })

    const stripped = runGit(['x'], { stripGitEnvironment: true }).stdout
    expect(stripped).not.toMatch(/^GIT_/mu)
    expect(stripped).toContain('PECOT_TEST_KEEP=1')

    expect(runGit(['x']).stdout).toContain('GIT_DIR=/elsewhere/.git')
  })

  it('改行は \\n に揃える（universal newlines）', () => {
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'printf \'a\\r\\nb\\rc\\n\'\n')
    prependToPath(bin)
    expect(runGit(['x']).stdout).toBe('a\nb\nc\n')
  })

  it('check なら非 0 終了で GitCommandError。終了コードと stderr を持つ', () => {
    const outside = makeTemporaryDirectory()
    let caught: unknown
    try {
      runGit(['rev-parse', '--show-toplevel'], { cwd: outside, check: true, stripGitEnvironment: true })
    }
    catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(GitCommandError)
    if (!(caught instanceof GitCommandError)) return
    expect(caught.exitCode).toBe(128)
    expect(caught.stderr).toContain('not a git repository')
    expect(caught.message).toBe('Command [\'git\', \'rev-parse\', \'--show-toplevel\'] returned non-zero exit status 128.')
  })

  it('check なしなら非 0 の結果をそのまま返す（実 git: リポジトリの外）', () => {
    const outside = makeTemporaryDirectory()
    const result = runGit(['rev-parse', '--is-inside-work-tree'], { cwd: outside, stripGitEnvironment: true })
    expect(result.exitCode).not.toBe(0)
  })

  it('git が無ければ OSError の文で例外', () => {
    withoutGit()
    expect(() => runGit(['status'])).toThrow('[Errno 2] No such file or directory: \'git\'')
  })

  it('cwd が存在しなければ例外（Python の FileNotFoundError に当たる）', () => {
    expect(() => runGit(['status'], { cwd: '/nonexistent/dir/for/pecot' })).toThrow(/No such file or directory/u)
  })
})

describe('gitToplevel', () => {
  it('作業ディレクトリのルートを返す（実 git）', () => {
    const repository = createGitRepository()
    const subdirectory = path.join(repository, 'a', 'b')
    mkdirSync(subdirectory, { recursive: true })
    expect(gitToplevel({ cwd: subdirectory })).toBe(repository)
  })

  it('GIT_DIR が別の場所を指していても、strip すれば cwd 基準で解決する', () => {
    const repository = createGitRepository()
    const subdirectory = path.join(repository, 'a')
    mkdirSync(subdirectory)
    setEnvironment({ GIT_DIR: path.join(repository, 'nonexistent.git') })
    expect(gitToplevel({ cwd: subdirectory, stripGitEnvironment: true })).toBe(repository)
  })

  it('リポジトリの外は undefined', () => {
    expect(gitToplevel({ cwd: makeTemporaryDirectory(), stripGitEnvironment: true })).toBeUndefined()
  })

  it('git が無ければ undefined', () => {
    withoutGit()
    expect(gitToplevel()).toBeUndefined()
  })

  it('git を実行する権限が無いときは undefined にせず例外（Python の PermissionError と同じ）', () => {
    const bin = makeTemporaryDirectory('pecot-noexec-')
    writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n')
    chmodSync(path.join(bin, 'git'), 0o644)
    setEnvironment({ PATH: bin })
    expect(() => gitToplevel()).toThrow('[Errno 13] Permission denied')
  })
})

describe('gitRemoteUrl', () => {
  it('origin の URL を返す', () => {
    const repository = createGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
    expect(gitRemoteUrl(repository)).toBe('https://github.com/owner/repo.git')
  })

  it('remote 名を渡すと、その remote の URL を返し、渡さなければ undefined を返す', () => {
    const repository = createGitRepository()
    gitForTest(repository, ['remote', 'add', 'upstream', 'u'])
    expect(gitRemoteUrl(repository, 'upstream')).toBe('u')
    expect(gitRemoteUrl(repository)).toBeUndefined()
  })

  it('リポジトリの外は undefined', () => {
    expect(gitRemoteUrl(makeTemporaryDirectory())).toBeUndefined()
  })
})

describe('gitCurrentBranch', () => {
  it('checkout したブランチの名前を返す', () => {
    const repository = createGitRepository()
    gitForTest(repository, ['checkout', '-q', '-b', 'feat/x/1'])
    expect(gitCurrentBranch(repository)).toBe('feat/x/1')
  })

  it('detached HEAD は HEAD', () => {
    const repository = createGitRepository()
    gitForTest(repository, ['checkout', '-q', '--detach'])
    expect(gitCurrentBranch(repository)).toBe('HEAD')
  })

  it('git が無ければ undefined', () => {
    const repository = createGitRepository()
    withoutGit()
    expect(gitCurrentBranch(repository)).toBeUndefined()
  })
})

describe('remoteRepository', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'github.com', 'owner', 'repo'],
    ['https://github.com/owner/repo.git', 'github.com', 'owner', 'repo'],
    ['https://ghes.example.com/acme-labs/my.repo.git', 'ghes.example.com', 'acme-labs', 'my.repo'],
    ['ssh://git@ghes.example.com/acme-labs/aist-plugin.git', 'ghes.example.com', 'acme-labs', 'aist-plugin'],
  ])('origin の URL %j を分ける', (url, host, owner, repository) => {
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', url])
    expect(remoteRepository(directory, 'origin')).toEqual({ host, owner, repository })
  })

  it('URL の形式が不正なら undefined', () => {
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'invalid'])
    expect(remoteRepository(directory, 'origin')).toBeUndefined()
  })

  it('remote が無ければ undefined', () => {
    expect(remoteRepository(createGitRepository(), 'origin')).toBeUndefined()
  })
})

describe('primaryRemoteName', () => {
  it('origin があれば、ほかの remote より先に並んでいても origin を返す', () => {
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'a-first', 'https://github.com/o/a.git'])
    gitForTest(directory, ['remote', 'add', 'origin', 'https://github.com/o/b.git'])
    expect(primaryRemoteName(directory)).toBe('origin')
  })

  it('origin が無ければ最初の remote を返す', () => {
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'upstream', 'https://github.com/o/a.git'])
    gitForTest(directory, ['remote', 'add', 'zeta', 'https://github.com/o/b.git'])
    expect(primaryRemoteName(directory)).toBe('upstream')
  })

  it('remote が無ければ undefined', () => {
    expect(primaryRemoteName(createGitRepository())).toBeUndefined()
  })

  it('git の外では undefined', () => {
    const directory = makeTemporaryDirectory('pecot-nogit-')
    setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
    expect(primaryRemoteName(directory)).toBeUndefined()
  })

  it('git が無ければ undefined', () => {
    const repository = createGitRepository()
    withoutGit()
    expect(primaryRemoteName(repository)).toBeUndefined()
  })
})

describe('primaryRemoteRepository', () => {
  it('origin が無いときは最初の remote の URL を分ける', () => {
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'upstream', 'git@ghes.example.com:acme/demo.git'])
    expect(primaryRemoteRepository(directory)).toEqual({ host: 'ghes.example.com', owner: 'acme', repository: 'demo' })
  })

  it('URL の形式が不正なら undefined', () => {
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'invalid'])
    expect(primaryRemoteRepository(directory)).toBeUndefined()
  })

  it('remote が無ければ undefined', () => {
    expect(primaryRemoteRepository(createGitRepository())).toBeUndefined()
  })
})

describe('gitRunnerFor と resolveRepository（実 git）', () => {
  it('origin のあるリポジトリから現在のリポジトリを解決する', () => {
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'git@github.com:o/r.git'])
    expect(resolveRepository(undefined, gitRunnerFor(directory))).toEqual({ repository: { owner: 'o', repository: 'r' }, source: 'current-git', remoteName: 'origin' })
  })

  it('origin が無ければ先頭の remote を使う', () => {
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'upstream', 'https://github.com/o/up.git'])
    expect(resolveRepository(undefined, gitRunnerFor(directory))).toEqual({ repository: { owner: 'o', repository: 'up' }, source: 'current-git', remoteName: 'upstream' })
  })

  it('リポジトリの外では曖昧', () => {
    expect(() => resolveRepository(undefined, gitRunnerFor(makeTemporaryDirectory(), { stripGitEnvironment: true }))).toThrow(AmbiguousRepositoryError)
  })
})
