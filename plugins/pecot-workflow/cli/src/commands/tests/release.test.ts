import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { requireReleaseTargetRepository } from '@pecot/workflow-core/commands-shared/release-check.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { createGitRepository, gitForTest } from '../../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
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
  it('採用済みのリポジトリがあると、repo や remote を見ずにそれを返す', async () => {
    await explains('リリース対象のリポジトリを決める `requireReleaseTargetRepository` のテストです。採用済みのリポジトリ（`adopted`）が渡された場合に、`repo` と git の remote を使わず、採用済みのリポジトリを返すことを確認します。')
    const adopted = { owner: 'a', repository: 'b' }
    expect(resolve(repositoryWithOrigin(), adopted, 'c/d')).toEqual({ result: adopted, stderr: '' })
  })

  it('採用済みのリポジトリが存在しない場合に repo を渡すと、remote より repo を優先する', async () => {
    await explains('リリース対象のリポジトリを決める `requireReleaseTargetRepository` のテストです。採用済みのリポジトリが存在せず、`repo` に `c/d` を渡した場合に、remote の `acme/demo` でなく `c/d` を返すことを確認します。')
    expect(resolve(repositoryWithOrigin(), undefined, 'c/d')).toEqual({ result: { owner: 'c', repository: 'd' }, stderr: '' })
  })

  it('採用済みのリポジトリと repo のどちらも存在しない場合は、主の remote のリポジトリを返す', async () => {
    await explains('リリース対象のリポジトリを決める `requireReleaseTargetRepository` のテストです。採用済みのリポジトリと `repo` のどちらも渡さない場合に、git の remote `origin` の URL から求めた `acme/demo` を返すことを確認します。')
    expect(resolve(repositoryWithOrigin(), undefined, undefined)).toEqual({ result: { owner: 'acme', repository: 'demo' }, stderr: '' })
  })

  it.for(['noslash', 'a/b/c'])('repo が %j の場合は、形式の誤りの error の行を表示し、invalid-input で終了コード 1 にする', async (explicit) => {
    await explains('`repo` の形式が不正な場合のテストです。`noslash` や `a/b/c` を渡した場合に、`error: invalid repo format` を表示し、種類 `invalid-input`・終了コード `1` で終了することを確認します。')
    expect(resolve(repositoryWithOrigin(), undefined, explicit)).toEqual({
      result: { exitCode: 1, kind: 'invalid-input' },
      stderr: `error: invalid repo format: '${explicit}'\n  specify it as owner/repo\n`,
    })
  })

  it('主の remote が読み取れない場合は、error の行を表示し、git-unresolved で終了コード 1 にする', async () => {
    await explains('git リポジトリの外で、`repo` と採用済みのリポジトリのどちらも指定しない場合のテストです。`error: could not read the repository from the git remote` を表示し、`git-unresolved`・終了コード `1` で終了することを確認します。')
    const directory = makeTemporaryDirectory('pecot-nogit-')
    setEnvironment({ GIT_CEILING_DIRECTORIES: path.dirname(directory) })
    expect(resolve(directory, undefined, undefined)).toEqual({
      result: { exitCode: 1, kind: 'git-unresolved' },
      stderr: 'error: could not read the repository from the git remote\n',
    })
  })
})
