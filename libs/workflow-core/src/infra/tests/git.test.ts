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
import { stepSync } from '../../../tests/_helpers/step.js'

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
    const repository = stepSync('未追跡のファイルがあるリポジトリを用意する', () => {
      const created = createGitRepository({ 'a.txt': 'x' })
      writeFileSync(path.join(created, 'b.txt'), 'y')
      return created
    })
    const result = stepSync('git status を実行する', () => runGit(['status', '--short'], { cwd: repository, check: true }))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ exitCode: 0, stdout: '?? b.txt\n', stderr: '' })
    })
  })

  it('cwd を指定しない場合は、呼び出し元の作業ディレクトリで git を実行する', async () => {
    await explains('`runGit` のテストです。`cwd` を指定しない場合に、呼び出し元の作業ディレクトリで git が実行されることを確認します。')
    stepSync('作業ディレクトリを出す偽の git を用意する', () => {
      const bin = makeTemporaryDirectory()
      installFakeExecutable(bin, 'git', 'pwd\n')
      prependToPath(bin)
    })
    const result = stepSync('cwd を指定せずに git を実行する', () => runGit(['status']))
    stepSync('標準出力を比べる', () => {
      expect(result.stdout.trim()).toBe(process.cwd())
    })
  })

  it('stripGitEnvironment を指定すると、GIT_ で始まる環境変数を除き、ほかの変数は残す', async () => {
    await explains('`runGit` のテストです。`stripGitEnvironment` を指定した場合は、`GIT_` で始まる環境変数だけを git に渡さず、`PECOT_TEST_KEEP` などのほかの変数は渡すことを確認します。')
    stepSync('環境変数を出す偽の git と環境変数を用意する', () => {
      const bin = makeTemporaryDirectory()
      installFakeExecutable(bin, 'git', 'env\n')
      prependToPath(bin)
      setEnvironment({ GIT_DIR: '/elsewhere/.git', PECOT_TEST_KEEP: '1' })
    })
    const shown = stepSync('git を実行する', () => ({ stripped: runGit(['x'], { stripGitEnvironment: true }).stdout, plain: runGit(['x']).stdout }))
    stepSync('渡った環境変数を比べる', () => {
      expect(shown.stripped).not.toMatch(/^GIT_/mu)
      expect(shown.stripped).toContain('PECOT_TEST_KEEP=1')
      expect(shown.plain).toContain('GIT_DIR=/elsewhere/.git')
    })
  })

  it('env を指定すると、現在の環境変数に重ねて git に渡す', async () => {
    await explains('`runGit` のテストです。`env` を指定した場合に、指定した `GIT_TERMINAL_PROMPT` と現在の環境変数（`PECOT_TEST_KEEP`）の両方が git に渡ることを確認します。')
    stepSync('環境変数を出す偽の git と環境変数を用意する', () => {
      const bin = makeTemporaryDirectory()
      installFakeExecutable(bin, 'git', 'env\n')
      prependToPath(bin)
      setEnvironment({ PECOT_TEST_KEEP: '1' })
    })
    const shown = stepSync('env を指定して git を実行する', () => runGit(['x'], { env: { GIT_TERMINAL_PROMPT: '0' } }).stdout)
    stepSync('渡った環境変数を比べる', () => {
      expect(shown).toMatch(/^GIT_TERMINAL_PROMPT=0$/mu)
      expect(shown).toContain('PECOT_TEST_KEEP=1')
    })
  })

  it('時間切れになると、git を停止し、終了コード GIT_TIMED_OUT の結果を返す', async () => {
    await explains('`runGit` のテストです。`timeoutMilliseconds` を超えて git の実行が続く場合に、git を停止し、終了コードが `GIT_TIMED_OUT` の結果を返すことを確認します。')
    stepSync('止まらない偽の git を用意する', () => {
      const bin = makeTemporaryDirectory()
      installFakeExecutable(bin, 'git', 'exec sleep 5\n')
      prependToPath(bin)
    })
    const result = stepSync('時間切れを指定して git を実行する', () => runGit(['x'], { timeoutMilliseconds: 200 }))
    stepSync('時間切れの結果を比べる', () => {
      expect(result).toEqual({ exitCode: GIT_TIMED_OUT, stdout: '', stderr: '' })
    })
  })

  it('出力の改行が CRLF や CR の場合は、改行を LF に統一して返す', async () => {
    await explains('`runGit` のテストです。標準出力に `\\r\\n` と `\\r` が含まれる場合に、改行がすべて `\\n` に統一されることを確認します。')
    stepSync('CRLF と CR を出す偽の git を用意する', () => {
      const bin = makeTemporaryDirectory()
      installFakeExecutable(bin, 'git', 'printf \'a\\r\\nb\\rc\\n\'\n')
      prependToPath(bin)
    })
    const result = stepSync('git を実行する', () => runGit(['x']))
    stepSync('標準出力を比べる', () => {
      expect(result.stdout).toBe('a\nb\nc\n')
    })
  })

  it('check を指定して git が 0 以外で終了すると、終了コードと標準エラーを持つ GitCommandError を発生させる', async () => {
    await explains('`runGit` のテストです。`check` を指定し、git リポジトリの外で `rev-parse` が失敗した場合に、終了コード 128 と標準エラーを持つ `GitCommandError` が発生することを確認します。')
    const outside = makeTemporaryDirectory()
    const caught = stepSync('リポジトリの外で check を指定して git を実行する', () => {
      let thrown: unknown
      try {
        runGit(['rev-parse', '--show-toplevel'], { cwd: outside, check: true, stripGitEnvironment: true })
      }
      catch (error: unknown) {
        thrown = error
      }
      return thrown
    })
    stepSync('エラーの種類を確かめる', () => {
      expect(caught).toBeInstanceOf(GitCommandError)
    })
    stepSync('終了コードとメッセージを確かめる', () => {
      if (!(caught instanceof GitCommandError)) return
      expect(caught.exitCode).toBe(128)
      expect(caught.stderr).toContain('not a git repository')
      expect(caught.message).toBe('Command [\'git\', \'rev-parse\', \'--show-toplevel\'] returned non-zero exit status 128.')
    })
  })

  it('check を指定しない場合は、git が 0 以外で終了しても、その結果を返す', async () => {
    await explains('`runGit` のテストです。`check` を指定せず、git リポジトリの外でコマンドを実行した場合に、例外を発生させず、0 以外の終了コードを返すことを確認します。')
    const outside = makeTemporaryDirectory()
    const result = stepSync('リポジトリの外で git を実行する', () => runGit(['rev-parse', '--is-inside-work-tree'], { cwd: outside, stripGitEnvironment: true }))
    stepSync('終了コードを確かめる', () => {
      expect(result.exitCode).not.toBe(0)
    })
  })

  it('git が存在しない場合は、OSError と同じ文の例外を発生させる', async () => {
    await explains('`runGit` のテストです。git が `PATH` に存在しない場合は、`[Errno 2] No such file or directory: \'git\'` のメッセージで例外が発生することを確認します。')
    stepSync('git の無い環境にする', () => {
      withoutGit()
    })
    stepSync('例外のメッセージを確かめる', () => {
      expect(() => runGit(['status'])).toThrow('[Errno 2] No such file or directory: \'git\'')
    })
  })

  it('cwd が存在しない場合は、例外を発生させる', async () => {
    await explains('`runGit` のテストです。`cwd` に存在しないディレクトリを指定した場合は、`No such file or directory` を含む例外が発生することを確認します。')
    stepSync('例外のメッセージを確かめる', () => {
      expect(() => runGit(['status'], { cwd: '/nonexistent/dir/for/pecot' })).toThrow(/No such file or directory/u)
    })
  })
})

describe('gitToplevel', () => {
  it('サブディレクトリから実行すると、git リポジトリのルートを返す', async () => {
    await explains('git リポジトリのルートを返す `gitToplevel` のテストです。`cwd` に実際のリポジトリのサブディレクトリを指定した場合は、リポジトリのルートを返すことを確認します。')
    const { repository, subdirectory } = stepSync('サブディレクトリのあるリポジトリを用意する', () => {
      const created = createGitRepository()
      const sub = path.join(created, 'a', 'b')
      mkdirSync(sub, { recursive: true })
      return { repository: created, subdirectory: sub }
    })
    const top = stepSync('サブディレクトリからルートを求める', () => gitToplevel({ cwd: subdirectory }))
    stepSync('ルートを比べる', () => {
      expect(top).toBe(repository)
    })
  })

  it('GIT_DIR が別の場所を指していても、stripGitEnvironment を指定すれば cwd を基準に解決する', async () => {
    await explains('`gitToplevel` のテストです。`GIT_DIR` が存在しない場所を指していても、`stripGitEnvironment` を指定した場合は、`cwd` を基準にしたルートを返すことを確認します。')
    const { repository, subdirectory } = stepSync('サブディレクトリのあるリポジトリと GIT_DIR を用意する', () => {
      const created = createGitRepository()
      const sub = path.join(created, 'a')
      mkdirSync(sub)
      setEnvironment({ GIT_DIR: path.join(created, 'nonexistent.git') })
      return { repository: created, subdirectory: sub }
    })
    const top = stepSync('stripGitEnvironment を指定してルートを求める', () => gitToplevel({ cwd: subdirectory, stripGitEnvironment: true }))
    stepSync('ルートを比べる', () => {
      expect(top).toBe(repository)
    })
  })

  it('リポジトリの外では、undefined を返す', async () => {
    await explains('`gitToplevel` のテストです。`cwd` に git リポジトリの外を指定した場合は、`undefined` を返すことを確認します。')
    const top = stepSync('リポジトリの外でルートを求める', () => gitToplevel({ cwd: makeTemporaryDirectory(), stripGitEnvironment: true }))
    stepSync('結果が無いことを確かめる', () => {
      expect(top).toBeUndefined()
    })
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('`gitToplevel` のテストです。git が `PATH` に存在しない場合は、`undefined` を返すことを確認します。')
    stepSync('git の無い環境にする', () => {
      withoutGit()
    })
    const top = stepSync('ルートを求める', () => gitToplevel())
    stepSync('結果が無いことを確かめる', () => {
      expect(top).toBeUndefined()
    })
  })

  it('git に実行権限がない場合は、undefined を返さず例外を発生させる', async () => {
    await explains('`gitToplevel` のテストです。git に実行権限がない場合に、`undefined` を返さず、`[Errno 13] Permission denied` を含む例外が発生することを確認します。')
    stepSync('実行権限の無い git を用意する', () => {
      const bin = makeTemporaryDirectory('pecot-noexec-')
      writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n')
      chmodSync(path.join(bin, 'git'), 0o644)
      setEnvironment({ PATH: bin })
    })
    stepSync('例外のメッセージを確かめる', () => {
      expect(() => gitToplevel()).toThrow('[Errno 13] Permission denied')
    })
  })
})

describe('gitRemoteUrl', () => {
  it('origin の URL を返す', async () => {
    await explains('リモートの URL を返す `gitRemoteUrl` のテストです。`origin` を登録したリポジトリの場合に、その URL を返すことを確認します。')
    const repository = stepSync('origin を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
      return created
    })
    const url = stepSync('remote の URL を求める', () => gitRemoteUrl(repository))
    stepSync('URL を比べる', () => {
      expect(url).toBe('https://github.com/owner/repo.git')
    })
  })

  it('remote 名を指定すると、その remote の URL を返し、指定しなければ undefined を返す', async () => {
    await explains('`gitRemoteUrl` のテストです。remote 名（`upstream`）を指定した場合にその URL を返し、`origin` が存在せず remote 名も指定しない場合に `undefined` を返すことを確認します。')
    const repository = stepSync('upstream を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'upstream', 'u'])
      return created
    })
    const urls = stepSync('remote の URL を求める', () => ({ named: gitRemoteUrl(repository, 'upstream'), unnamed: gitRemoteUrl(repository) }))
    stepSync('URL を比べる', () => {
      expect(urls.named).toBe('u')
      expect(urls.unnamed).toBeUndefined()
    })
  })

  it('リポジトリの外では、undefined を返す', async () => {
    await explains('`gitRemoteUrl` のテストです。git リポジトリの外を指定した場合に、`undefined` を返すことを確認します。')
    const url = stepSync('リポジトリの外で remote の URL を求める', () => gitRemoteUrl(makeTemporaryDirectory()))
    stepSync('結果が無いことを確かめる', () => {
      expect(url).toBeUndefined()
    })
  })
})

describe('gitCurrentBranch', () => {
  it('checkout したブランチの名前を返す', async () => {
    await explains('現在のブランチ名を返す `gitCurrentBranch` のテストです。`feat/x/1` をチェックアウトした場合に、そのブランチ名を返すことを確認します。')
    const repository = stepSync('ブランチを切ったリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['checkout', '-q', '-b', 'feat/x/1'])
      return created
    })
    const branch = stepSync('現在のブランチを求める', () => gitCurrentBranch(repository))
    stepSync('ブランチ名を比べる', () => {
      expect(branch).toBe('feat/x/1')
    })
  })

  it('detached HEAD の場合は、HEAD を返す', async () => {
    await explains('`gitCurrentBranch` のテストです。detached HEAD の状態の場合に、`HEAD` を返すことを確認します。')
    const repository = stepSync('detached HEAD のリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['checkout', '-q', '--detach'])
      return created
    })
    const branch = stepSync('現在のブランチを求める', () => gitCurrentBranch(repository))
    stepSync('HEAD を比べる', () => {
      expect(branch).toBe('HEAD')
    })
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('`gitCurrentBranch` のテストです。git が `PATH` に存在しない場合は、`undefined` を返すことを確認します。')
    const repository = stepSync('リポジトリを用意し、git の無い環境にする', () => {
      const created = createGitRepository()
      withoutGit()
      return created
    })
    const branch = stepSync('現在のブランチを求める', () => gitCurrentBranch(repository))
    stepSync('結果が無いことを確かめる', () => {
      expect(branch).toBeUndefined()
    })
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
    const directory = stepSync('origin を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'origin', url])
      return created
    })
    const parsed = stepSync('URL を分解する', () => remoteRepository(directory, 'origin'))
    stepSync('分解した結果を比べる', () => {
      expect(parsed).toEqual({ host, owner, repository })
    })
  })

  it('URL の形式が不正な場合は、undefined を返す', async () => {
    await explains('`remoteRepository` のテストです。`origin` の URL が `invalid` のように不正な形式の場合に、`undefined` を返すことを確認します。')
    const directory = stepSync('不正な URL の origin を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'origin', 'invalid'])
      return created
    })
    const parsed = stepSync('URL を分解する', () => remoteRepository(directory, 'origin'))
    stepSync('結果が無いことを確かめる', () => {
      expect(parsed).toBeUndefined()
    })
  })

  it('remote が存在しない場合は、undefined を返す', async () => {
    await explains('`remoteRepository` のテストです。指定した remote が存在しない場合に、`undefined` を返すことを確認します。')
    const parsed = stepSync('remote の無いリポジトリで URL を分解する', () => remoteRepository(createGitRepository(), 'origin'))
    stepSync('結果が無いことを確かめる', () => {
      expect(parsed).toBeUndefined()
    })
  })
})

describe('primaryRemoteName', () => {
  it('origin が存在する場合は、ほかの remote が先に並んでいても origin を返す', async () => {
    await explains('主となる remote の名前を返す `primaryRemoteName` のテストです。`a-first` と `origin` が登録されている場合に、`origin` を返すことを確認します。')
    const directory = stepSync('2 つの remote を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'a-first', 'https://github.com/o/a.git'])
      gitForTest(created, ['remote', 'add', 'origin', 'https://github.com/o/b.git'])
      return created
    })
    const name = stepSync('主となる remote の名前を求める', () => primaryRemoteName(directory))
    stepSync('名前を比べる', () => {
      expect(name).toBe('origin')
    })
  })

  it('origin が存在しない場合は、最初の remote を返す', async () => {
    await explains('`primaryRemoteName` のテストです。`origin` が存在せず `upstream` と `zeta` が登録されている場合に、最初の `upstream` を返すことを確認します。')
    const directory = stepSync('2 つの remote を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'upstream', 'https://github.com/o/a.git'])
      gitForTest(created, ['remote', 'add', 'zeta', 'https://github.com/o/b.git'])
      return created
    })
    const name = stepSync('主となる remote の名前を求める', () => primaryRemoteName(directory))
    stepSync('名前を比べる', () => {
      expect(name).toBe('upstream')
    })
  })

  it('remote が存在しない場合は、undefined を返す', async () => {
    await explains('`primaryRemoteName` のテストです。remote が 1 つも登録されていない場合に、`undefined` を返すことを確認します。')
    const name = stepSync('remote の無いリポジトリで名前を求める', () => primaryRemoteName(createGitRepository()))
    stepSync('結果が無いことを確かめる', () => {
      expect(name).toBeUndefined()
    })
  })

  it('git の外では、undefined を返す', async () => {
    await explains('`primaryRemoteName` のテストです。git リポジトリの外を指定した場合に、`undefined` を返すことを確認します。')
    const directory = stepSync('git の外のディレクトリを用意する', () => {
      const created = makeTemporaryDirectory('pecot-nogit-')
      setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(created) })
      return created
    })
    const name = stepSync('主となる remote の名前を求める', () => primaryRemoteName(directory))
    stepSync('結果が無いことを確かめる', () => {
      expect(name).toBeUndefined()
    })
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('`primaryRemoteName` のテストです。git が `PATH` に存在しない場合は、`undefined` を返すことを確認します。')
    const repository = stepSync('リポジトリを用意し、git の無い環境にする', () => {
      const created = createGitRepository()
      withoutGit()
      return created
    })
    const name = stepSync('主となる remote の名前を求める', () => primaryRemoteName(repository))
    stepSync('結果が無いことを確かめる', () => {
      expect(name).toBeUndefined()
    })
  })
})

describe('primaryRemoteRepository', () => {
  it('origin が存在しない場合は、最初の remote の URL を分解する', async () => {
    await explains('主となる remote の URL を分解する `primaryRemoteRepository` のテストです。`origin` が存在せず `upstream` だけがある場合に、その URL の host・owner・repository を返すことを確認します。')
    const directory = stepSync('upstream を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'upstream', 'git@ghes.example.com:acme/demo.git'])
      return created
    })
    const parsed = stepSync('主となる remote の URL を分解する', () => primaryRemoteRepository(directory))
    stepSync('分解した結果を比べる', () => {
      expect(parsed).toEqual({ host: 'ghes.example.com', owner: 'acme', repository: 'demo' })
    })
  })

  it('URL の形式が不正な場合は、undefined を返す', async () => {
    await explains('`primaryRemoteRepository` のテストです。`origin` の URL が `invalid` のように不正な形式の場合に、`undefined` を返すことを確認します。')
    const directory = stepSync('不正な URL の origin を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'origin', 'invalid'])
      return created
    })
    const parsed = stepSync('主となる remote の URL を分解する', () => primaryRemoteRepository(directory))
    stepSync('結果が無いことを確かめる', () => {
      expect(parsed).toBeUndefined()
    })
  })

  it('remote が存在しない場合は、undefined を返す', async () => {
    await explains('`primaryRemoteRepository` のテストです。remote が 1 つも登録されていない場合に、`undefined` を返すことを確認します。')
    const parsed = stepSync('remote の無いリポジトリで URL を分解する', () => primaryRemoteRepository(createGitRepository()))
    stepSync('結果が無いことを確かめる', () => {
      expect(parsed).toBeUndefined()
    })
  })
})

describe('activeIssueOf', () => {
  it('origin のリポジトリとブランチ名の末尾の番号から、作業中の Issue を返す', async () => {
    await explains('作業中の Issue を返す `activeIssueOf` のテストです。`origin` が登録され、ブランチ名が `feat/x/387` の場合に、リポジトリと Issue 番号 387 を返すことを確認します。')
    const directory = stepSync('origin とブランチを用意したリポジトリを作る', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
      gitForTest(created, ['checkout', '-q', '-b', 'feat/x/387'])
      return created
    })
    const issue = stepSync('作業中の Issue を求める', () => activeIssueOf(directory))
    stepSync('Issue を比べる', () => {
      expect(issue).toEqual({ repository: { owner: 'owner', repository: 'repo' }, number: 387 })
    })
  })

  it('remote の URL の形式が不正な場合は、undefined を返す', async () => {
    await explains('`activeIssueOf` のテストです。`origin` の URL が `invalid` のように不正な形式の場合に、`undefined` を返すことを確認します。')
    const directory = stepSync('不正な URL の origin とブランチを用意したリポジトリを作る', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'origin', 'invalid'])
      gitForTest(created, ['checkout', '-q', '-b', 'feat/x/387'])
      return created
    })
    const issue = stepSync('作業中の Issue を求める', () => activeIssueOf(directory))
    stepSync('結果が無いことを確かめる', () => {
      expect(issue).toBeUndefined()
    })
  })

  it('remote が存在しない場合は、undefined を返す', async () => {
    await explains('`activeIssueOf` のテストです。remote が登録されていない場合に、ブランチ名に番号があっても `undefined` を返すことを確認します。')
    const directory = stepSync('remote の無いリポジトリでブランチを切る', () => {
      const created = createGitRepository()
      gitForTest(created, ['checkout', '-q', '-b', 'feat/x/387'])
      return created
    })
    const issue = stepSync('作業中の Issue を求める', () => activeIssueOf(directory))
    stepSync('結果が無いことを確かめる', () => {
      expect(issue).toBeUndefined()
    })
  })

  it('detached HEAD の場合は、undefined を返す', async () => {
    await explains('`activeIssueOf` のテストです。detached HEAD の状態の場合に、`undefined` を返すことを確認します。')
    const directory = stepSync('origin を登録した detached HEAD のリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
      gitForTest(created, ['checkout', '-q', '--detach'])
      return created
    })
    const issue = stepSync('作業中の Issue を求める', () => activeIssueOf(directory))
    stepSync('結果が無いことを確かめる', () => {
      expect(issue).toBeUndefined()
    })
  })

  it('git の外では、undefined を返す', async () => {
    await explains('`activeIssueOf` のテストです。git リポジトリの外を指定した場合に、`undefined` を返すことを確認します。')
    const directory = stepSync('git の外のディレクトリを用意する', () => {
      const created = makeTemporaryDirectory('pecot-nogit-')
      setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(created) })
      return created
    })
    const issue = stepSync('作業中の Issue を求める', () => activeIssueOf(directory))
    stepSync('結果が無いことを確かめる', () => {
      expect(issue).toBeUndefined()
    })
  })
})

describe('gitRunnerFor と resolveRepository（実 git）', () => {
  it('origin があるリポジトリでは、現在のリポジトリとして origin を解決する', async () => {
    await explains('`gitRunnerFor` と `resolveRepository` を実際の git で組み合わせたテストです。`origin` が登録されたリポジトリの場合に、`origin` の owner と repository を返し、`source` が `current-git` になることを確認します。')
    const directory = stepSync('origin を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'origin', 'git@github.com:o/r.git'])
      return created
    })
    const resolved = stepSync('リポジトリを解決する', () => resolveRepository(undefined, gitRunnerFor(directory)))
    stepSync('解決した結果を比べる', () => {
      expect(resolved).toEqual({ repository: { owner: 'o', repository: 'r' }, source: 'current-git', remoteName: 'origin' })
    })
  })

  it('origin が存在しない場合は、先頭の remote を使って解決する', async () => {
    await explains('`gitRunnerFor` と `resolveRepository` を組み合わせたテストです。`origin` が存在せず `upstream` だけがある場合に、その remote を使って解決することを確認します。')
    const directory = stepSync('upstream を登録したリポジトリを用意する', () => {
      const created = createGitRepository()
      gitForTest(created, ['remote', 'add', 'upstream', 'https://github.com/o/up.git'])
      return created
    })
    const resolved = stepSync('リポジトリを解決する', () => resolveRepository(undefined, gitRunnerFor(directory)))
    stepSync('解決した結果を比べる', () => {
      expect(resolved).toEqual({ repository: { owner: 'o', repository: 'up' }, source: 'current-git', remoteName: 'upstream' })
    })
  })

  it('リポジトリの外では、AmbiguousRepositoryError を発生させる', async () => {
    await explains('`gitRunnerFor` と `resolveRepository` を組み合わせたテストです。git リポジトリの外の場合に、リポジトリを特定できず `AmbiguousRepositoryError` が発生することを確認します。')
    const outside = makeTemporaryDirectory()
    stepSync('エラーの種類を確かめる', () => {
      expect(() => resolveRepository(undefined, gitRunnerFor(outside, { stripGitEnvironment: true }))).toThrow(AmbiguousRepositoryError)
    })
  })
})

describe('gitStdout', () => {
  it('標準出力を、前後の空白と改行を削除せずに返す', async () => {
    await explains('git の標準出力を返す `gitStdout` のテストです。前後に空白や改行がある出力の場合に、削除せずそのまま返すことを確認します。')
    stepSync('空白と改行を出す偽の git を用意する', () => {
      const bin = makeTemporaryDirectory()
      installFakeExecutable(bin, 'git', 'printf "  a\\n\\n"\n')
      prependToPath(bin)
    })
    const out = stepSync('標準出力を求める', () => gitStdout(['x']))
    stepSync('標準出力を比べる', () => {
      expect(out).toBe('  a\n\n')
    })
  })

  it('git が 0 以外で終了した場合は、undefined を返す', async () => {
    await explains('`gitStdout` のテストです。git リポジトリの外でコマンドが失敗した場合に、`undefined` を返すことを確認します。')
    const outside = makeTemporaryDirectory()
    const out = stepSync('リポジトリの外で標準出力を求める', () => gitStdout(['rev-parse', '--show-toplevel'], { cwd: outside, stripGitEnvironment: true }))
    stepSync('結果が無いことを確かめる', () => {
      expect(out).toBeUndefined()
    })
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('`gitStdout` のテストです。git が `PATH` に存在しない場合は、`undefined` を返すことを確認します。')
    stepSync('git の無い環境にする', () => {
      withoutGit()
    })
    const out = stepSync('標準出力を求める', () => gitStdout(['status']))
    stepSync('結果が無いことを確かめる', () => {
      expect(out).toBeUndefined()
    })
  })
})
