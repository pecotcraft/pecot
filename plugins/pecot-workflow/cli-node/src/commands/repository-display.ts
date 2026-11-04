// `--show-repo` の出力。解決したリポジトリと解決元の 2 行。
import { repositoryFullName } from '../domain/repository-resolver.js'
import type { ResolvedRepository } from '../domain/repository-resolver.js'

export function formatResolvedRepository(resolved: Readonly<ResolvedRepository>): string {
  const source = resolved.source === 'explicit' ? 'explicit' : `current-git (${resolved.remoteName ?? ''})`
  return `resolved: ${repositoryFullName(resolved.repository)}\nsource:   ${source}\n`
}
