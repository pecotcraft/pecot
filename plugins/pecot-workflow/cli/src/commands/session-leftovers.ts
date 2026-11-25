/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// session start が、前の PR の手元の後片付けの取りこぼしを確かめる。
import { extractIssueNumberFromBranch } from '../domain/branch-name.js'
import { createIssueReference, issueReferenceToCliReference, issueReferenceToString } from '../domain/reference-parser.js'
import type { IssueReference } from '../domain/reference-parser.js'
import { isSameRepository } from '../domain/repository-resolver.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { gitCurrentBranch, primaryRemoteRepository } from '../infra/git.js'
import type { GitHubClient } from '../infra/github/index.js'
import { commandHint, hinted, RUN } from './command-hint.js'
import { apiFailureMessage } from './github-client.js'
import type { Output } from './output.js'

export interface Leftover {
  readonly pullRequest: string
}

// 今のブランチの PR がマージ済みで、開いた PR が無ければ、手元が片付いていない
async function findUncleanedPullRequest(out: Readonly<Output>, client: GitHubClient, repository: RepositoryReference, cwd: string): Promise<IssueReference | undefined> {
  const remote = primaryRemoteRepository(cwd)
  if (remote === undefined || !isSameRepository(remote, repository)) return undefined
  const branch = gitCurrentBranch(cwd)
  if (branch === undefined || extractIssueNumberFromBranch(branch) === undefined) return undefined
  const { pullRequests } = await client.listPullRequestsByHead(repository.owner, repository.repository, branch)
  const own = pullRequests.filter(pullRequest => !pullRequest.isCrossRepository)
  if (own.some(pullRequest => pullRequest.state === 'OPEN')) return undefined
  const merged = own.find(pullRequest => pullRequest.state === 'MERGED')
  if (merged === undefined) return undefined
  const reference = createIssueReference(repository, merged.number)
  const finish = commandHint(['session', 'finish'], { pr_ref: issueReferenceToCliReference(reference), delete_branch: true })
  out.warning(hinted`PR ${issueReferenceToString(reference)} of the current branch ${branch} is merged but not cleaned up; ${RUN} ${finish}`)
  return reference
}

/**
前の PR の手元の後片付けの取りこぼしを確かめ、あれば warning を出す。読む失敗も warning にして、空を返す
*/
export async function checkLeftovers(out: Readonly<Output>, client: GitHubClient, repository: RepositoryReference, cwd: string): Promise<Leftover[]> {
  try {
    const uncleaned = await findUncleanedPullRequest(out, client, repository, cwd)
    return uncleaned === undefined ? [] : [{ pullRequest: issueReferenceToCliReference(uncleaned) }]
  }
  catch (error: unknown) {
    out.warning(`could not check leftovers: reading the PR of the current branch failed: ${apiFailureMessage(error)}`)
    return []
  }
}
