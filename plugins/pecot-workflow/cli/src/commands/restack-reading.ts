// 積んだブランチを載せ直す先の判断を、下の段の PR と remote の先頭から求める。pr restack・pr check・pr create・session show が共有する。
import type { PullRequestReadout } from '../domain/issue-readout.js'
import { pickLowerPullRequest } from '../domain/pull-request.js'
import { decideRestack } from '../domain/restack.js'
import type { RestackDecision } from '../domain/restack.js'
import type { BaseReading } from '../domain/state.js'
import { remoteBranchHead } from '../infra/git.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { GitHubClient } from '../infra/github/index.js'

export interface RestackTarget {
  readonly client: () => Readonly<GitHubClient>
  readonly owner: string
  readonly repository: string
  readonly cwd: string
  /**
  remote が無ければ undefined。そのときは remote に届かないのと同じに扱う
  */
  readonly remote: string | undefined
  readonly reading: Extract<BaseReading, { kind: 'stacked' }>
  readonly developBranch: string
}

export type RestackReading
  = | { readonly kind: 'decided', readonly decision: RestackDecision, readonly lowerPullRequest: PullRequestReadout | undefined }
    | { readonly kind: 'remote-unreachable', readonly lowerPullRequest: PullRequestReadout | undefined }
    | { readonly kind: 'pull-request-unreadable', readonly error: GitHubAPIError }

/**
下の段の PR を読み、remote の先頭を尋ねて、載せ直す先を決める。PR を読めないか remote に届かなければ、その種類を返す
*/
export async function readRestackDecision(target: Readonly<RestackTarget>): Promise<RestackReading> {
  const { reading, remote } = target
  let lowerPullRequest: PullRequestReadout | undefined
  try {
    const found = await target.client().listPullRequestsByHead(target.owner, target.repository, reading.record.branch)
    lowerPullRequest = pickLowerPullRequest(found.pullRequests)
  }
  catch (error: unknown) {
    if (error instanceof GitHubAPIError) return { kind: 'pull-request-unreadable', error }
    throw error
  }
  if (remote === undefined) return { kind: 'remote-unreachable', lowerPullRequest }
  const lowerHead = remoteBranchHead(target.cwd, remote, reading.record.branch)
  return lowerHead.isReachable
    ? { kind: 'decided', decision: decideRestack({ reading, developBranch: target.developBranch, lowerPullRequest, lowerHead: lowerHead.sha }), lowerPullRequest }
    : { kind: 'remote-unreachable', lowerPullRequest }
}
