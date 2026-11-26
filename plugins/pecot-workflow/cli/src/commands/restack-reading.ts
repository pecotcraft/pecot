// スタックしたブランチをスタックし直す先の判断を、親 PR と remote の先頭から求める。pr restack・pr check・pr create・session show が共有する。
import type { PullRequestReadout } from '@pecot/workflow-core/domain/issue-readout.js'
import { pickLowerPullRequest } from '@pecot/workflow-core/domain/pull-request.js'
import { decideRestack } from '@pecot/workflow-core/domain/restack.js'
import type { RestackDecision } from '@pecot/workflow-core/domain/restack.js'
import type { BaseReading } from '@pecot/workflow-core/domain/state.js'
import { isAncestor, remoteBranchHead, resolveCommit } from '@pecot/workflow-core/infra/git.js'
import { GitHubAPIError } from '@pecot/workflow-core/infra/github/errors.js'
import type { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'

/**
既に読んだ親 PR。PR が無かったことも示せるよう、包んで渡す
*/
export interface KnownLowerPullRequest {
  readonly pullRequest: PullRequestReadout | undefined
}

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
  /**
  渡されたら、親 PR を読み直さない
  */
  readonly lowerPullRequest?: KnownLowerPullRequest | undefined
  /**
  MCP の要求の取り消し。ls-remote に渡す
  */
  readonly signal: Readonly<AbortSignal> | undefined
}

export type RestackReading
  = | { readonly kind: 'decided', readonly decision: RestackDecision, readonly lowerPullRequest: PullRequestReadout | undefined }
    | { readonly kind: 'remote-unreachable', readonly lowerPullRequest: PullRequestReadout | undefined }
    | { readonly kind: 'pull-request-unreadable', readonly error: GitHubAPIError }

/**
親 PR を読み、remote の先頭を尋ねて、スタックし直す先を決める。PR を読めないか remote に届かなければ、その種類を返す
*/
export async function readRestackDecision(target: Readonly<RestackTarget>): Promise<RestackReading> {
  const { reading, remote } = target
  let lowerPullRequest = target.lowerPullRequest?.pullRequest
  if (target.lowerPullRequest === undefined) {
    try {
      const found = await target.client().listPullRequestsByHead(target.owner, target.repository, reading.record.branch)
      lowerPullRequest = pickLowerPullRequest(found.pullRequests)
    }
    catch (error: unknown) {
      if (error instanceof GitHubAPIError) return { kind: 'pull-request-unreadable', error }
      throw error
    }
  }
  if (remote === undefined) return { kind: 'remote-unreachable', lowerPullRequest }
  const lowerHead = await remoteBranchHead(target.cwd, remote, reading.record.branch, target.signal)
  if (!lowerHead.isReachable) return { kind: 'remote-unreachable', lowerPullRequest }
  const decision = decideRestack({ reading, developBranch: target.developBranch, lowerPullRequest, lowerHead: lowerHead.sha })
  return { kind: 'decided', decision: withRebased(target.cwd, remote, reading, decision, lowerHead.sha), lowerPullRequest }
}

// 新しい base の上に載り終えていれば rebased に替える。記録の位置が HEAD にあれば、それが新しい base の祖先であることも求める。
// merge で base を取り込んだブランチと、親ブランチが古い位置へ戻されたブランチを、スタックし直し済みと見ないため
function withRebased(cwd: string, remote: string, reading: Readonly<Extract<BaseReading, { kind: 'stacked' }>>, decision: RestackDecision, lowerHead: string | undefined): RestackDecision {
  if (decision.kind !== 'moved' && decision.kind !== 'merged') return decision
  // moved は ls-remote の先頭を使う。fetch しない呼び出し元では、追跡参照が古い位置を指しうるため
  const newBase = decision.kind === 'moved' ? lowerHead : resolveCommit(cwd, `${remote}/${decision.base}`)
  if (newBase === undefined || !isAncestor(cwd, newBase, 'HEAD')) return decision
  const { sha } = reading.record
  const isRecordLeftBehind = isAncestor(cwd, sha, 'HEAD') && !isAncestor(cwd, sha, newBase)
  return isRecordLeftBehind ? decision : { kind: 'rebased', base: decision.base }
}
