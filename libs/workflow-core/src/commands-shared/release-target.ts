// リリースの対象のリポジトリとブランチを決める。actions/ の release-check と MCP の release_check が使う
import { pythonStringRepr } from '../domain/python-format.js'
import { splitOwnerRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { primaryRemoteRepository } from '../infra/git.js'
import { commandHint, hinted, inputNameHint, placeholder } from './command-hint.js'
import { stopWith } from './command-stop.js'
import type { Output } from './output.js'

export const CHECK_PATH = ['release', 'check']

/**
順は採用済みの repo、明示の repo、主の remote。決められないと error の行を出して終了コード 1 で止める。
remote は process.cwd() から読む
*/
export function requireReleaseTargetRepository(adopted: RepositoryReference | undefined, explicit: string | undefined, out: Readonly<Output>): RepositoryReference {
  if (adopted !== undefined) return adopted
  if (explicit !== undefined) {
    return splitOwnerRepository(explicit) ?? stopWith(out, hinted`invalid ${inputNameHint(CHECK_PATH, 'repo')} format: ${pythonStringRepr(explicit)}\nspecify it as owner/repo`, 'invalid-input')
  }
  const remote = primaryRemoteRepository(process.cwd()) ?? stopWith(out, 'could not read the repository from the git remote', 'git-unresolved')
  return { owner: remote.owner, repository: remote.repository }
}

export function requireBranchSetting(out: Readonly<Output>, branch: string | undefined, kind: 'develop' | 'release', owner: string, repository: string): string {
  return branch === undefined || branch === '' ? stopWith(out, hinted`${kind}_branch is not set for ${owner}/${repository}\nset it with: ${commandHint(['project', 'link'], { repo: `${owner}/${repository}`, [`${kind}_branch`]: placeholder('branch') })}`, 'repo-setting-missing') : branch
}
