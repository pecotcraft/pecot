import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { requireRepositoryMatch } from '../repository-match.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { capture } from './support.js'

useIsolatedEnvironment()

const ORIGIN_URL = 'https://github.com/acme/demo.git'

function repositoryWithOrigin(): string {
  const repository = createGitRepository()
  gitForTest(repository, ['remote', 'add', 'origin', ORIGIN_URL])
  return repository
}

function outsideGit(): string {
  const directory = makeTemporaryDirectory('pecot-nogit-')
  setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
  return directory
}

function inDirectory<T>(directory: string, body: () => T): T {
  const previous = process.cwd()
  process.chdir(directory)
  try {
    return body()
  }
  finally {
    process.chdir(previous)
  }
}

describe('requireRepositoryMatch', () => {
  it('--repo が無く、git の remote を解決できると、何も出さずに続ける', () => {
    const io = capture()
    const result = inDirectory(repositoryWithOrigin(), () => requireRepositoryMatch('reject', undefined, io))
    expect(result).toEqual({ kind: 'proceed', adopted: undefined })
    expect(io.err).toEqual([])
  })

  it('--repo が無く、git の外だと、曖昧の error の行を出して終了コード 1 にする', () => {
    const io = capture()
    const result = inDirectory(outsideGit(), () => requireRepositoryMatch('reject', undefined, io))
    expect(result).toEqual({ kind: 'exit', exitCode: 1 })
    expect(io.err.join('')).toBe('error: the repository is ambiguous\n  give --repo <owner/repo>\n')
  })

  it('--repo が git の外で渡されると、渡したリポジトリを採用する', () => {
    const io = capture()
    const result = inDirectory(outsideGit(), () => requireRepositoryMatch('reject', 'acme/demo', io))
    expect(result).toEqual({ kind: 'proceed', adopted: { owner: 'acme', repository: 'demo' } })
    expect(io.err).toEqual([])
  })

  it('--repo が remote と食い違うと、reject は error の行を出して終了コード 1 にする', () => {
    const io = capture()
    const result = inDirectory(repositoryWithOrigin(), () => requireRepositoryMatch('reject', 'other/thing', io))
    expect(result).toEqual({ kind: 'exit', exitCode: 1 })
    expect(io.err.join('')).toBe('error: --repo other/thing differs from the current Git remote (acme/demo)\n  this command works only on the repository of the current Git remote\n')
  })

  it('--repo が remote と食い違うと、warn は warning の行を出して渡したリポジトリを採用する', () => {
    const io = capture()
    const result = inDirectory(repositoryWithOrigin(), () => requireRepositoryMatch('warn', 'other/thing', io))
    expect(result).toEqual({ kind: 'proceed', adopted: { owner: 'other', repository: 'thing' } })
    expect(io.err.join('')).toBe('warning: using --repo other/thing (current Git remote: acme/demo)\n')
  })

  it('--repo が remote と一致すると、何も出さずに渡したリポジトリを採用する', () => {
    const io = capture()
    const result = inDirectory(repositoryWithOrigin(), () => requireRepositoryMatch('reject', 'acme/demo', io))
    expect(result).toEqual({ kind: 'proceed', adopted: { owner: 'acme', repository: 'demo' } })
    expect(io.err).toEqual([])
  })
})
