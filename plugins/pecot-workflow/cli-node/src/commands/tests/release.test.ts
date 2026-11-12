import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveReleaseTargetRepository } from '../release.js'
import { createOutput } from '../output.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
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
  const result = inDirectory(directory, () => resolveReleaseTargetRepository(adopted, explicit, createOutput(false, io)))
  return { result, stderr: io.err.join('') }
}

describe('resolveReleaseTargetRepository', () => {
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

  it.for(['noslash', 'a/b/c'])('--repo が %j だと、形式の error の行を出して undefined を返す', (explicit) => {
    const { result, stderr } = resolve(repositoryWithOrigin(), undefined, explicit)
    expect(result).toBeUndefined()
    expect(stderr).toBe(`error: invalid --repo format: '${explicit}'\n  specify it as owner/repo\n`)
  })

  it('主の remote が読めないと、error の行を出して undefined を返す', () => {
    const directory = makeTemporaryDirectory('pecot-nogit-')
    setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
    const { result, stderr } = resolve(directory, undefined, undefined)
    expect(result).toBeUndefined()
    expect(stderr).toBe('error: could not read the repository from the git remote\n')
  })
})
