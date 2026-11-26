/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AmbiguousRepositoryError, resolveRepository } from '../../domain/repository-resolver.js'
import { installFakeExecutable, prependToPath } from '../../../tests/_helpers/fake-executables.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import {
  GIT_TIMED_OUT,
  GitCommandError,
  activeIssueOf,
  gitCurrentBranch,
  gitRemoteUrl,
  gitRunnerFor,
  gitStdout,
  gitToplevel,
  primaryRemoteName,
  primaryRemoteRepository,
  remoteRepository,
  runGit,
} from '../git.js'
import { explains } from '../../../tests/_helpers/explains.js'

useIsolatedEnvironment()

/**
PATH を git の無いディレクトリだけにする（git が見つからない環境）
*/
function withoutGit(): void {
  setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
}

describe('runGit', () => {
  it('実際の git に引数を渡して実行すると、標準出力と終了コードを返す', async () => {
    await explains('git を実行する `runGit` のテストです。実際の git リポジトリで `status --short` を実行した場合に、終了コード 0 と標準出力（`?? b.txt`）を返すことを確認します。')
    const repository = createGitRepository({ 'a.txt': 'x' })
    writeFileSync(path.join(repository, 'b.txt'), 'y')
    const result = runGit(['status', '--short'], { cwd: repository, check: true })
    expect(result).toEqual({ exitCode: 0, stdout: '?? b.txt\n', stderr: '' })
  })

  it('cwd を指定しない場合は、呼び出し元の作業ディレクトリで git を実行する', async () => {
    await explains('`runGit` のテストです。`cwd` を指定しない場合に、呼び出し元の作業ディレクトリで git が実行されることを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'pwd\n')
    prependToPath(bin)
    expect(runGit(['status']).stdout.trim()).toBe(process.cwd())
  })

  it('stripGitEnvironment を指定すると、GIT_ で始まる環境変数を除き、ほかの変数は残す', async () => {
    await explains('`runGit` のテストです。`stripGitEnvironment` を指定した場合は、`GIT_` で始まる環境変数だけを git に渡さず、`PECOT_TEST_KEEP` などのほかの変数は渡すことを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'env\n')
    prependToPath(bin)
    setEnvironment({ GIT_DIR: '/elsewhere/.git', PECOT_TEST_KEEP: '1' })

    const stripped = runGit(['x'], { stripGitEnvironment: true }).stdout
    expect(stripped).not.toMatch(/^GIT_/mu)
    expect(stripped).toContain('PECOT_TEST_KEEP=1')

    expect(runGit(['x']).stdout).toContain('GIT_DIR=/elsewhere/.git')
  })

  it('env を指定すると、現在の環境変数に重ねて git に渡す', async () => {
    await explains('`runGit` のテストです。`env` を指定した場合に、指定した `GIT_TERMINAL_PROMPT` と現在の環境変数（`PECOT_TEST_KEEP`）の両方が git に渡ることを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'env\n')
    prependToPath(bin)
    setEnvironment({ PECOT_TEST_KEEP: '1' })
    const shown = runGit(['x'], { env: { GIT_TERMINAL_PROMPT: '0' } }).stdout
    expect(shown).toMatch(/^GIT_TERMINAL_PROMPT=0$/mu)
    expect(shown).toContain('PECOT_TEST_KEEP=1')
  })

  it('時間切れになると、git を停止し、終了コード GIT_TIMED_OUT の結果を返す', async () => {
    await explains('`runGit` のテストです。`timeoutMilliseconds` を超えて git の実行が続く場合に、git を停止し、終了コードが `GIT_TIMED_OUT` の結果を返すことを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'exec sleep 5\n')
    prependToPath(bin)
    expect(runGit(['x'], { timeoutMilliseconds: 200 })).toEqual({ exitCode: GIT_TIMED_OUT, stdout: '', stderr: '' })
  })

  it('出力の改行が CRLF や CR の場合は、改行を LF に統一して返す', async () => {
    await explains('`runGit` のテストです。標準出力に `\\r\\n` と `\\r` が含まれる場合に、改行がすべて `\\n` に統一されることを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'printf \'a\\r\\nb\\rc\\n\'\n')
    prependToPath(bin)
    expect(runGit(['x']).stdout).toBe('a\nb\nc\n')
  })

  it('check を指定して git が 0 以外で終了すると、終了コードと標準エラーを持つ GitCommandError を発生させる', async () => {
    await explains('`runGit` のテストです。`check` を指定し、git リポジトリの外で `rev-parse` が失敗した場合に、終了コード 128 と標準エラーを持つ `GitCommandError` が発生することを確認します。')
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

  it('check を指定しない場合は、git が 0 以外で終了しても、その結果を返す', async () => {
    await explains('`runGit` のテストです。`check` を指定せず、git リポジトリの外でコマンドを実行した場合に、例外を発生させず、0 以外の終了コードを返すことを確認します。')
    const outside = makeTemporaryDirectory()
    const result = runGit(['rev-parse', '--is-inside-work-tree'], { cwd: outside, stripGitEnvironment: true })
    expect(result.exitCode).not.toBe(0)
  })

  it('git が存在しない場合は、OSError と同じ文の例外を発生させる', async () => {
    await explains('`runGit` のテストです。git が `PATH` に存在しない場合は、`[Errno 2] No such file or directory: \'git\'` のメッセージで例外が発生することを確認します。')
    withoutGit()
    expect(() => runGit(['status'])).toThrow('[Errno 2] No such file or directory: \'git\'')
  })

  it('cwd が存在しない場合は、例外を発生させる', async () => {
    await explains('`runGit` のテストです。`cwd` に存在しないディレクトリを指定した場合は、`No such file or directory` を含む例外が発生することを確認します。')
    expect(() => runGit(['status'], { cwd: '/nonexistent/dir/for/pecot' })).toThrow(/No such file or directory/u)
  })
})

describe('gitToplevel', () => {
  it('サブディレクトリから実行すると、git リポジトリのルートを返す', async () => {
    await explains('git リポジトリのルートを返す `gitToplevel` のテストです。`cwd` に実際のリポジトリのサブディレクトリを指定した場合は、リポジトリのルートを返すことを確認します。')
    const repository = createGitRepository()
    const subdirectory = path.join(repository, 'a', 'b')
    mkdirSync(subdirectory, { recursive: true })
    expect(gitToplevel({ cwd: subdirectory })).toBe(repository)
  })

  it('GIT_DIR が別の場所を指していても、stripGitEnvironment を指定すれば cwd を基準に解決する', async () => {
    await explains('`gitToplevel` のテストです。`GIT_DIR` が存在しない場所を指していても、`stripGitEnvironment` を指定した場合は、`cwd` を基準にしたルートを返すことを確認します。')
    const repository = createGitRepository()
    const subdirectory = path.join(repository, 'a')
    mkdirSync(subdirectory)
    setEnvironment({ GIT_DIR: path.join(repository, 'nonexistent.git') })
    expect(gitToplevel({ cwd: subdirectory, stripGitEnvironment: true })).toBe(repository)
  })

  it('リポジトリの外では、undefined を返す', async () => {
    await explains('`gitToplevel` のテストです。`cwd` に git リポジトリの外を指定した場合は、`undefined` を返すことを確認します。')
    expect(gitToplevel({ cwd: makeTemporaryDirectory(), stripGitEnvironment: true })).toBeUndefined()
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('`gitToplevel` のテストです。git が `PATH` に存在しない場合は、`undefined` を返すことを確認します。')
    withoutGit()
    expect(gitToplevel()).toBeUndefined()
  })

  it('git に実行権限がない場合は、undefined を返さず例外を発生させる', async () => {
    await explains('`gitToplevel` のテストです。git に実行権限がない場合に、`undefined` を返さず、`[Errno 13] Permission denied` を含む例外が発生することを確認します。')
    const bin = makeTemporaryDirectory('pecot-noexec-')
    writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n')
    chmodSync(path.join(bin, 'git'), 0o644)
    setEnvironment({ PATH: bin })
    expect(() => gitToplevel()).toThrow('[Errno 13] Permission denied')
  })
})

describe('gitRemoteUrl', () => {
  it('origin の URL を返す', async () => {
    await explains('リモートの URL を返す `gitRemoteUrl` のテストです。`origin` を登録したリポジトリの場合に、その URL を返すことを確認します。')
    const repository = createGitRepository()
    gitForTest(repository, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
    expect(gitRemoteUrl(repository)).toBe('https://github.com/owner/repo.git')
  })

  it('remote 名を指定すると、その remote の URL を返し、指定しなければ undefined を返す', async () => {
    await explains('`gitRemoteUrl` のテストです。remote 名（`upstream`）を指定した場合にその URL を返し、`origin` が存在せず remote 名も指定しない場合に `undefined` を返すことを確認します。')
    const repository = createGitRepository()
    gitForTest(repository, ['remote', 'add', 'upstream', 'u'])
    expect(gitRemoteUrl(repository, 'upstream')).toBe('u')
    expect(gitRemoteUrl(repository)).toBeUndefined()
  })

  it('リポジトリの外では、undefined を返す', async () => {
    await explains('`gitRemoteUrl` のテストです。git リポジトリの外を指定した場合に、`undefined` を返すことを確認します。')
    expect(gitRemoteUrl(makeTemporaryDirectory())).toBeUndefined()
  })
})

describe('gitCurrentBranch', () => {
  it('checkout したブランチの名前を返す', async () => {
    await explains('現在のブランチ名を返す `gitCurrentBranch` のテストです。`feat/x/1` をチェックアウトした場合に、そのブランチ名を返すことを確認します。')
    const repository = createGitRepository()
    gitForTest(repository, ['checkout', '-q', '-b', 'feat/x/1'])
    expect(gitCurrentBranch(repository)).toBe('feat/x/1')
  })

  it('detached HEAD の場合は、HEAD を返す', async () => {
    await explains('`gitCurrentBranch` のテストです。detached HEAD の状態の場合に、`HEAD` を返すことを確認します。')
    const repository = createGitRepository()
    gitForTest(repository, ['checkout', '-q', '--detach'])
    expect(gitCurrentBranch(repository)).toBe('HEAD')
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('`gitCurrentBranch` のテストです。git が `PATH` に存在しない場合は、`undefined` を返すことを確認します。')
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
  ])('origin の URL が %j の場合は、host・owner・repository に分解する', async (url, host, owner, repository) => {
    await explains(`リモートの URL を分解する \`remoteRepository\` のテストです。\`origin\` の URL が \`${url}\` の場合に、\`${host}\` と \`${owner}/${repository}\` に分解して返すことを確認します。`)
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', url])
    expect(remoteRepository(directory, 'origin')).toEqual({ host, owner, repository })
  })

  it('URL の形式が不正な場合は、undefined を返す', async () => {
    await explains('`remoteRepository` のテストです。`origin` の URL が `invalid` のように不正な形式の場合に、`undefined` を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'invalid'])
    expect(remoteRepository(directory, 'origin')).toBeUndefined()
  })

  it('remote が存在しない場合は、undefined を返す', async () => {
    await explains('`remoteRepository` のテストです。指定した remote が存在しない場合に、`undefined` を返すことを確認します。')
    expect(remoteRepository(createGitRepository(), 'origin')).toBeUndefined()
  })
})

describe('primaryRemoteName', () => {
  it('origin が存在する場合は、ほかの remote が先に並んでいても origin を返す', async () => {
    await explains('主となる remote の名前を返す `primaryRemoteName` のテストです。`a-first` と `origin` が登録されている場合に、`origin` を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'a-first', 'https://github.com/o/a.git'])
    gitForTest(directory, ['remote', 'add', 'origin', 'https://github.com/o/b.git'])
    expect(primaryRemoteName(directory)).toBe('origin')
  })

  it('origin が存在しない場合は、最初の remote を返す', async () => {
    await explains('`primaryRemoteName` のテストです。`origin` が存在せず `upstream` と `zeta` が登録されている場合に、最初の `upstream` を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'upstream', 'https://github.com/o/a.git'])
    gitForTest(directory, ['remote', 'add', 'zeta', 'https://github.com/o/b.git'])
    expect(primaryRemoteName(directory)).toBe('upstream')
  })

  it('remote が存在しない場合は、undefined を返す', async () => {
    await explains('`primaryRemoteName` のテストです。remote が 1 つも登録されていない場合に、`undefined` を返すことを確認します。')
    expect(primaryRemoteName(createGitRepository())).toBeUndefined()
  })

  it('git の外では、undefined を返す', async () => {
    await explains('`primaryRemoteName` のテストです。git リポジトリの外を指定した場合に、`undefined` を返すことを確認します。')
    const directory = makeTemporaryDirectory('pecot-nogit-')
    setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
    expect(primaryRemoteName(directory)).toBeUndefined()
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('`primaryRemoteName` のテストです。git が `PATH` に存在しない場合は、`undefined` を返すことを確認します。')
    const repository = createGitRepository()
    withoutGit()
    expect(primaryRemoteName(repository)).toBeUndefined()
  })
})

describe('primaryRemoteRepository', () => {
  it('origin が存在しない場合は、最初の remote の URL を分解する', async () => {
    await explains('主となる remote の URL を分解する `primaryRemoteRepository` のテストです。`origin` が存在せず `upstream` だけがある場合に、その URL の host・owner・repository を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'upstream', 'git@ghes.example.com:acme/demo.git'])
    expect(primaryRemoteRepository(directory)).toEqual({ host: 'ghes.example.com', owner: 'acme', repository: 'demo' })
  })

  it('URL の形式が不正な場合は、undefined を返す', async () => {
    await explains('`primaryRemoteRepository` のテストです。`origin` の URL が `invalid` のように不正な形式の場合に、`undefined` を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'invalid'])
    expect(primaryRemoteRepository(directory)).toBeUndefined()
  })

  it('remote が存在しない場合は、undefined を返す', async () => {
    await explains('`primaryRemoteRepository` のテストです。remote が 1 つも登録されていない場合に、`undefined` を返すことを確認します。')
    expect(primaryRemoteRepository(createGitRepository())).toBeUndefined()
  })
})

describe('activeIssueOf', () => {
  it('origin のリポジトリとブランチ名の末尾の番号から、作業中の Issue を返す', async () => {
    await explains('作業中の Issue を返す `activeIssueOf` のテストです。`origin` が登録され、ブランチ名が `feat/x/387` の場合に、リポジトリと Issue 番号 387 を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
    gitForTest(directory, ['checkout', '-q', '-b', 'feat/x/387'])
    expect(activeIssueOf(directory)).toEqual({ repository: { owner: 'owner', repository: 'repo' }, number: 387 })
  })

  it('remote の URL の形式が不正な場合は、undefined を返す', async () => {
    await explains('`activeIssueOf` のテストです。`origin` の URL が `invalid` のように不正な形式の場合に、`undefined` を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'invalid'])
    gitForTest(directory, ['checkout', '-q', '-b', 'feat/x/387'])
    expect(activeIssueOf(directory)).toBeUndefined()
  })

  it('remote が存在しない場合は、undefined を返す', async () => {
    await explains('`activeIssueOf` のテストです。remote が登録されていない場合に、ブランチ名に番号があっても `undefined` を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['checkout', '-q', '-b', 'feat/x/387'])
    expect(activeIssueOf(directory)).toBeUndefined()
  })

  it('detached HEAD の場合は、undefined を返す', async () => {
    await explains('`activeIssueOf` のテストです。detached HEAD の状態の場合に、`undefined` を返すことを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
    gitForTest(directory, ['checkout', '-q', '--detach'])
    expect(activeIssueOf(directory)).toBeUndefined()
  })

  it('git の外では、undefined を返す', async () => {
    await explains('`activeIssueOf` のテストです。git リポジトリの外を指定した場合に、`undefined` を返すことを確認します。')
    const directory = makeTemporaryDirectory('pecot-nogit-')
    setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
    expect(activeIssueOf(directory)).toBeUndefined()
  })
})

describe('gitRunnerFor と resolveRepository（実 git）', () => {
  it('origin があるリポジトリでは、現在のリポジトリとして origin を解決する', async () => {
    await explains('`gitRunnerFor` と `resolveRepository` を実際の git で組み合わせたテストです。`origin` が登録されたリポジトリの場合に、`origin` の owner と repository を返し、`source` が `current-git` になることを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'origin', 'git@github.com:o/r.git'])
    expect(resolveRepository(undefined, gitRunnerFor(directory))).toEqual({ repository: { owner: 'o', repository: 'r' }, source: 'current-git', remoteName: 'origin' })
  })

  it('origin が存在しない場合は、先頭の remote を使って解決する', async () => {
    await explains('`gitRunnerFor` と `resolveRepository` を組み合わせたテストです。`origin` が存在せず `upstream` だけがある場合に、その remote を使って解決することを確認します。')
    const directory = createGitRepository()
    gitForTest(directory, ['remote', 'add', 'upstream', 'https://github.com/o/up.git'])
    expect(resolveRepository(undefined, gitRunnerFor(directory))).toEqual({ repository: { owner: 'o', repository: 'up' }, source: 'current-git', remoteName: 'upstream' })
  })

  it('リポジトリの外では、AmbiguousRepositoryError を発生させる', async () => {
    await explains('`gitRunnerFor` と `resolveRepository` を組み合わせたテストです。git リポジトリの外の場合に、リポジトリを特定できず `AmbiguousRepositoryError` が発生することを確認します。')
    expect(() => resolveRepository(undefined, gitRunnerFor(makeTemporaryDirectory(), { stripGitEnvironment: true }))).toThrow(AmbiguousRepositoryError)
  })
})

describe('gitStdout', () => {
  it('標準出力を、前後の空白と改行を削除せずに返す', async () => {
    await explains('git の標準出力を返す `gitStdout` のテストです。前後に空白や改行がある出力の場合に、削除せずそのまま返すことを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'git', 'printf "  a\\n\\n"\n')
    prependToPath(bin)
    expect(gitStdout(['x'])).toBe('  a\n\n')
  })

  it('git が 0 以外で終了した場合は、undefined を返す', async () => {
    await explains('`gitStdout` のテストです。git リポジトリの外でコマンドが失敗した場合に、`undefined` を返すことを確認します。')
    const outside = makeTemporaryDirectory()
    expect(gitStdout(['rev-parse', '--show-toplevel'], { cwd: outside, stripGitEnvironment: true })).toBeUndefined()
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('`gitStdout` のテストです。git が `PATH` に存在しない場合は、`undefined` を返すことを確認します。')
    withoutGit()
    expect(gitStdout(['status'])).toBeUndefined()
  })
})
