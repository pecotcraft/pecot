import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CommandExit } from '../command-definition.js'
import { requireReleaseTargetRepository } from '../release.js'
import { createOutput } from '../output.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import '../registry.js'
import { capture } from './support.js'

useIsolatedEnvironment()

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

function repositoryWithOrigin(): string {
  const repository = createGitRepository()
  gitForTest(repository, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
  return repository
}

function resolve(directory: string, adopted: Readonly<{ owner: string, repository: string }> | undefined, explicit: string | undefined): { result: unknown, stderr: string } {
  const io = capture()
  let result: unknown
  try {
    result = inDirectory(directory, () => requireReleaseTargetRepository(adopted, explicit, createOutput(false, io)))
  }
  catch (error: unknown) {
    if (!(error instanceof CommandExit)) throw error
    result = { exitCode: error.exitCode, kind: error.kind }
  }
  return { result, stderr: io.err.join('') }
}

describe('requireReleaseTargetRepository', () => {
  it('採用済みのリポジトリがあると、--repo や remote を見ずにそれを返す', () => {
    const adopted = { owner: 'a', repository: 'b' }
    expect(resolve(repositoryWithOrigin(), adopted, 'c/d')).toEqual({ result: adopted, stderr: '' })
  })

  it('採用済みの無いときに --repo を渡すと、remote より --repo を返す', () => {
    expect(resolve(repositoryWithOrigin(), undefined, 'c/d')).toEqual({ result: { owner: 'c', repository: 'd' }, stderr: '' })
  })

  it('採用済みと --repo のどちらも無いと、主の remote のリポジトリを返す', () => {
    expect(resolve(repositoryWithOrigin(), undefined, undefined)).toEqual({ result: { owner: 'acme', repository: 'demo' }, stderr: '' })
  })

  it.for(['noslash', 'a/b/c'])('--repo が %j だと、形式の error の行を出し、invalid-input で終了コード 1 にする', (explicit) => {
    expect(resolve(repositoryWithOrigin(), undefined, explicit)).toEqual({
      result: { exitCode: 1, kind: 'invalid-input' },
      stderr: `error: invalid --repo format: '${explicit}'\n  specify it as owner/repo\n`,
    })
  })

  it('主の remote が読めないと、error の行を出し、git-unresolved で終了コード 1 にする', () => {
    const directory = makeTemporaryDirectory('pecot-nogit-')
    setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
    expect(resolve(directory, undefined, undefined)).toEqual({
      result: { exitCode: 1, kind: 'git-unresolved' },
      stderr: 'error: could not read the repository from the git remote\n',
    })
  })
})
