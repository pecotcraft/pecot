// session_start が、前の PR の手元の後片付けの取りこぼしを確かめる。今のブランチの PR は、公式の MCP の list_pull_requests の結果で受ける
import { extractIssueNumberFromBranch } from '@pecot/workflow-core/domain/branch-name.js'
import { createIssueReference, issueReferenceToCliReference, issueReferenceToString } from '@pecot/workflow-core/domain/reference-parser.js'
import { isSameRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { RepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { gitCurrentBranch, primaryRemoteRepository } from '@pecot/workflow-core/infra/git.js'
import { commandHint, hinted, RUN } from '@pecot/workflow-core/commands-shared/command-hint.js'
import type { Output } from '@pecot/workflow-core/commands-shared/output.js'
import { LIST_PULL_REQUESTS, listedPullRequestsOf, parseOfficial } from './official-reads.js'

export interface Leftover {
  readonly pullRequest: string
}

/**
今のブランチの PR がマージ済みで、開いた PR が無ければ、手元が片付いていない。あれば warning を出す。
listed は list_pull_requests（head に今のブランチ、state all）の結果。無ければ、確かめられないことを warning にする
*/
export function checkLeftovers(out: Readonly<Output>, listed: unknown, repository: RepositoryReference, cwd: string): Leftover[] {
  const remote = primaryRemoteRepository(cwd)
  if (remote === undefined || !isSameRepository(remote, repository)) return []
  const branch = gitCurrentBranch(cwd)
  if (branch === undefined || extractIssueNumberFromBranch(branch) === undefined) return []
  if (listed === undefined) {
    out.warning(`leftovers are not checked: pass the result of list_pull_requests (head ${repository.owner}:${branch}, state all) in reads.pull_requests`)
    return []
  }
  const own = listedPullRequestsOf(parseOfficial(out, 'list_pull_requests', LIST_PULL_REQUESTS, listed, 'reads.pull_requests'))
    .filter(pullRequest => pullRequest.headRefName === branch && !pullRequest.isCrossRepository && isSameRepository(pullRequest.repository, repository))
  if (own.some(pullRequest => pullRequest.state === 'open')) return []
  const merged = own.find(pullRequest => pullRequest.state === 'merged')
  if (merged === undefined) return []
  const reference = createIssueReference(repository, merged.number)
  const finish = commandHint(['session', 'finish'], { pr_ref: issueReferenceToCliReference(reference) })
  out.warning(hinted`PR ${issueReferenceToString(reference)} of the current branch ${branch} is merged but not cleaned up; ${RUN} ${finish}`)
  return [{ pullRequest: issueReferenceToCliReference(reference) }]
}
