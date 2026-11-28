import { afterEach, describe, expect, it } from 'vitest'

import { stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'

import { gitForTest, createGitRepository } from '../../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../tests/_helpers/environment.js'
import { CommandExit } from '../command-definition.js'
import { readCurrentRepository, requireRepositoryMatch, resolveCurrentRepository } from '../repository-match.js'
import { capture } from '../../../tests/_helpers/captured-io.js'

useIsolatedEnvironment()

function repositoryWithRemote(): string {
  const directory = createGitRepository()
  gitForTest(directory, ['remote', 'add', 'origin', 'git@ghes.example.com:acme/demo.git'])
  return directory
}

function repositoryWithLocalOrigin(): string {
  const directory = createGitRepository()
  gitForTest(directory, ['remote', 'add', 'origin', makeTemporaryDirectory('pecot-bare-')])
  return directory
}

afterEach(() => {
  setEnvironment({ GIT_CEILING_DIRECTORIES: undefined })
})

describe('resolveCurrentRepository', () => {
  it('git remote から owner/repo を解決する', async () => {
    await explains('現在のリポジトリを求める `resolveCurrentRepository` のテストです。`origin` が `git@ghes.example.com:acme/demo.git` の場合に、`acme/demo` と取得元 `current-git` を返すことを確認します。')
    const resolved = stepSync('remote を持つリポを用意する', () => resolveCurrentRepository(repositoryWithRemote()))
    stepSync('結果を確認する', () => {
      expect(resolved?.repository).toMatchObject({ owner: 'acme', repository: 'demo' })
      expect(resolved?.source).toBe('current-git')
    })
  })

  it('git の外では undefined を返す', async () => {
    await explains('現在のリポジトリを求める `resolveCurrentRepository` のテストです。git リポジトリの外のディレクトリを渡した場合に、`undefined` を返すことを確認します。')
    const directory = stepSync('一時ディレクトリを用意する', () => makeTemporaryDirectory('pecot-nogit-'))
    stepSync('環境変数を用意する', () => {
      setEnvironment({ GIT_CEILING_DIRECTORIES: directory.slice(0, directory.lastIndexOf('/')) })
    })
    stepSync('結果を確認する', () => {
      expect(resolveCurrentRepository(directory)).toBeUndefined()
    })
  })

  it('remote の URL が手元のパスなら undefined を返す', async () => {
    await explains('現在のリポジトリを求める `resolveCurrentRepository` のテストです。remote の URL が手元のディレクトリのパスの場合に、リポジトリを求められず `undefined` を返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect(resolveCurrentRepository(repositoryWithLocalOrigin())).toBeUndefined()
    })
  })
})

describe('readCurrentRepository', () => {
  it('remote の URL が手元のパスなら、unreadable-remote を返す', async () => {
    await explains('現在のリポジトリを読み取る `readCurrentRepository` のテストです。remote の URL が手元のディレクトリのパスの場合に、取得元が `unreadable-remote`、remote の名前が `origin` の結果を返すことを確認します。')
    stepSync('結果を確認する', () => {
      expect(readCurrentRepository(repositoryWithLocalOrigin())).toEqual({ source: 'unreadable-remote', remoteName: 'origin' })
    })
  })
})

describe('requireRepositoryMatch', () => {
  it('repo が存在せず git の中にいる場合は、採用する値なしで続ける', async () => {
    await explains('入力 `repo` が現在の git の remote と一致するかを判定する `requireRepositoryMatch` のテストです。入力 `repo` を指定せずに git の中で実行した場合に、`undefined` を返し、標準エラー出力には何も表示しないことを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    stepSync('結果を確認する', () => {
      expect(requireRepositoryMatch('reject', undefined, io, repositoryWithRemote())).toBeUndefined()
      expect(io.err).toEqual([])
    })
  })

  it('repo が git remote と一致するなら、その値を採用する', async () => {
    await explains('入力 `repo` が現在の git の remote と一致するかを判定する `requireRepositoryMatch` のテストです。`repo: acme/demo` が remote と一致する場合に、その値を採用し、標準エラー出力には何も表示しないことを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    const adopted = stepSync('remote を持つリポを用意する', () => requireRepositoryMatch('reject', 'acme/demo', io, repositoryWithRemote()))
    stepSync('結果を確認する', () => {
      expect(adopted).toMatchObject({ owner: 'acme', repository: 'demo' })
      expect(io.err).toEqual([])
    })
  })

  it('reject: 食い違う場合は、error の行を標準エラー出力に表示して CommandExit(1) を投げる', async () => {
    await explains('入力 `repo` が remote と異なる場合の、`reject` モードの `requireRepositoryMatch` のテストです。`error: repo other/tree differs from …` を表示し、種類 `repo-mismatch`・終了コード `1` の `CommandExit` が発生することを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    const directory = stepSync('remote を持つリポを用意する', () => repositoryWithRemote())
    let thrown: unknown
    stepSync('リポジトリの一致を確かめる', () => {
      try {
        requireRepositoryMatch('reject', 'other/tree', io, directory)
      }
      catch (error: unknown) {
        thrown = error
      }
    })
    stepSync('結果を確認する', () => {
      expect(thrown).toBeInstanceOf(CommandExit)
      expect(thrown).toMatchObject({ exitCode: 1, kind: 'repo-mismatch' })
      expect(io.err.join('')).toBe('error: repo other/tree differs from the current Git remote (acme/demo)\n  this command works only on the repository of the current Git remote\n')
    })
  })

  it('warn: 食い違う場合は、warning の行を表示して続け、repo の値を採用する', async () => {
    await explains('`warn` モードの `requireRepositoryMatch` のテストです。入力 `repo` が remote と食い違う場合でも、`warning:` で始まる行を表示して処理を続け、入力 `repo` の `other/tree` を採用することを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    const adopted = stepSync('remote を持つリポを用意する', () => requireRepositoryMatch('warn', 'other/tree', io, repositoryWithRemote()))
    stepSync('結果を確認する', () => {
      expect(adopted).toMatchObject({ owner: 'other', repository: 'tree' })
      expect(io.err.join('')).toMatch(/^warning: /u)
    })
  })

  it('repo が存在せず git の外の場合は、リポジトリが曖昧である旨の行を表示して CommandExit(1) を投げる', async () => {
    await explains('入力 `repo` を省略して git の外で実行した場合の、`requireRepositoryMatch` のテストです。`error: the repository is ambiguous` を表示し、種類 `git-unresolved`・終了コード `1` の `CommandExit` が発生することを確認します。')
    const io = stepSync('出力の捕捉を用意する', () => capture())
    const directory = stepSync('一時ディレクトリを用意する', () => makeTemporaryDirectory('pecot-nogit-'))
    stepSync('環境変数を用意する', () => {
      setEnvironment({ GIT_CEILING_DIRECTORIES: directory.slice(0, directory.lastIndexOf('/')) })
    })
    stepSync('結果を確認する', () => {
      expect(() => requireRepositoryMatch('reject', undefined, io, directory)).toThrow(expect.objectContaining({ exitCode: 1, kind: 'git-unresolved' }))
      expect(io.err.join('')).toBe('error: the repository is ambiguous\n  give repo: <owner/repo>\n')
    })
  })
})
