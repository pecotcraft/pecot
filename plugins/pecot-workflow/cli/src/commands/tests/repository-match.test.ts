import { afterEach, describe, expect, it } from 'vitest'

import { gitForTest, createGitRepository } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { CommandExit } from '../command-definition.js'
import { requireRepositoryMatch, resolveCurrentRepository } from '../repository-match.js'
import { capture } from './support.js'

useIsolatedEnvironment()

function repositoryWithRemote(): string {
  const directory = createGitRepository()
  gitForTest(directory, ['remote', 'add', 'origin', 'git@ghes.example.com:acme/demo.git'])
  return directory
}

afterEach(() => {
  setEnvironment({ GIT_CEILING_DIRECTORIES: undefined })
})

describe('resolveCurrentRepository', () => {
  it('git remote から owner/repo を解決する', () => {
    const resolved = resolveCurrentRepository(repositoryWithRemote())
    expect(resolved?.repository).toMatchObject({ owner: 'acme', repository: 'demo' })
    expect(resolved?.source).toBe('current-git')
  })

  it('git の外では undefined を返す', () => {
    const directory = makeTemporaryDirectory('pecot-nogit-')
    setEnvironment({ GIT_CEILING_DIRECTORIES: directory.slice(0, directory.lastIndexOf('/')) })
    expect(resolveCurrentRepository(directory)).toBeUndefined()
  })
})

describe('requireRepositoryMatch', () => {
  it('--repo が無く git 内なら、採用値なしで続ける', () => {
    const io = capture()
    expect(requireRepositoryMatch('reject', undefined, io, repositoryWithRemote())).toBeUndefined()
    expect(io.err).toEqual([])
  })

  it('--repo が git remote と一致するなら、その値を採用する', () => {
    const io = capture()
    const adopted = requireRepositoryMatch('reject', 'acme/demo', io, repositoryWithRemote())
    expect(adopted).toMatchObject({ owner: 'acme', repository: 'demo' })
    expect(io.err).toEqual([])
  })

  it('reject: 食い違うと error の行を stderr に書いて CommandExit(1) を投げる', () => {
    const io = capture()
    const directory = repositoryWithRemote()
    let thrown: unknown
    try {
      requireRepositoryMatch('reject', 'other/tree', io, directory)
    }
    catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CommandExit)
    expect(thrown).toMatchObject({ exitCode: 1 })
    expect(io.err.join('')).toBe('error: --repo other/tree differs from the current Git remote (acme/demo)\n  this command works only on the repository of the current Git remote\n')
  })

  it('warn: 食い違っても warning の行を書いて続け、明示値を採用する', () => {
    const io = capture()
    const adopted = requireRepositoryMatch('warn', 'other/tree', io, repositoryWithRemote())
    expect(adopted).toMatchObject({ owner: 'other', repository: 'tree' })
    expect(io.err.join('')).toMatch(/^warning: /u)
  })

  it('--repo が無く git の外だと、曖昧の行を書いて CommandExit(1) を投げる', () => {
    const io = capture()
    const directory = makeTemporaryDirectory('pecot-nogit-')
    setEnvironment({ GIT_CEILING_DIRECTORIES: directory.slice(0, directory.lastIndexOf('/')) })
    expect(() => requireRepositoryMatch('reject', undefined, io, directory)).toThrow(CommandExit)
    expect(io.err.join('')).toBe('error: the repository is ambiguous\n  give --repo <owner/repo>\n')
  })
})
