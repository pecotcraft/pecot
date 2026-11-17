// git の remote のリポから、プロジェクトの設定を選ぶ。origin を先に、残りの remote を git remote の順に当てる
import { ValidationFailure } from '../domain/python-format.js'
import { createRepositoryReference } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { findConfigFor } from './config-store.js'
import type { ConfigLookup, FoundConfig } from './config-store.js'
import { listRemotes, remoteRepository } from './git.js'

export type RemoteConfigLookup
  = | { readonly kind: 'no-remote' }
    | { readonly kind: 'found', readonly remote: string, readonly repository: RepositoryReference, readonly found: FoundConfig }
    | { readonly kind: 'failed', readonly repository: RepositoryReference, readonly lookup: Exclude<ConfigLookup, { readonly kind: 'found' }> }

// URL を GitHub の owner/repo として読めない remote は undefined
function repositoryOf(cwd: string, remote: string): RepositoryReference | undefined {
  const location = remoteRepository(cwd, remote)
  if (location === undefined) return undefined
  try {
    return createRepositoryReference(location.owner, location.repository)
  }
  catch (error: unknown) {
    if (error instanceof ValidationFailure) return undefined
    throw error
  }
}

function readRemoteRepositories(cwd: string): readonly { readonly remote: string, readonly repository: RepositoryReference }[] {
  const remotes = listRemotes(cwd) ?? []
  const ordered = remotes.includes('origin') ? ['origin', ...remotes.filter(remote => remote !== 'origin')] : remotes
  const read: { readonly remote: string, readonly repository: RepositoryReference }[] = []
  for (const remote of ordered) {
    const repository = repositoryOf(cwd, remote)
    if (repository !== undefined) read.push({ remote, repository })
  }
  return read
}

/**
remote のリポのうち、設定を選べた最初のもの。名前の誤りと、候補から選べないときは、ほかの remote を見ずに返す。
どの remote でも選べなければ、最初の remote のリポと、そのときの結果を返す
*/
export function findConfigForRemotes(cwd: string, project: string | undefined): RemoteConfigLookup {
  const candidates = readRemoteRepositories(cwd)
  let first: Extract<RemoteConfigLookup, { readonly kind: 'failed' }> | undefined
  for (const { remote, repository } of candidates) {
    const lookup = findConfigFor(repository, project)
    if (lookup.kind === 'found') return { kind: 'found', remote, repository, found: lookup.found }
    if (lookup.kind === 'unknown-project' || lookup.kind === 'ambiguous') return { kind: 'failed', repository, lookup }
    first ??= { kind: 'failed', repository, lookup }
  }
  return first ?? { kind: 'no-remote' }
}
