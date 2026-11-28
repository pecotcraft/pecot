// スタックしたブランチをスタックし直す先の判断を、読み取りの結果の親 PR と remote の先頭から求める。pr_restack・pr_check が共有する。
import type { PullRequestReadout } from '@pecot/workflow-core/domain/issue-readout.js'
import { decideRestack } from '@pecot/workflow-core/domain/restack.js'
import type { RestackDecision } from '@pecot/workflow-core/domain/restack.js'
import type { BaseReading } from '@pecot/workflow-core/domain/state.js'
import { isAncestor, remoteBranchHead, resolveCommit } from '@pecot/workflow-core/infra/git.js'

export interface RestackTarget {
  readonly cwd: string
  /**
  remote が無ければ undefined。そのときは remote に届かないのと同じに扱う
  */
  readonly remote: string | undefined
  readonly reading: Extract<BaseReading, { kind: 'stacked' }>
  readonly developBranch: string
  /**
  親ブランチを head に持つ PR（pickLowerPullRequest で選んだもの）。無ければ undefined
  */
  readonly lowerPullRequest: PullRequestReadout | undefined
  /**
  MCP の要求の取り消し。ls-remote に渡す
  */
  readonly signal: Readonly<AbortSignal> | undefined
}

export type RestackReading
  = | { readonly kind: 'decided', readonly decision: RestackDecision }
    | { readonly kind: 'remote-unreachable' }

/**
remote の先頭を尋ねて、スタックし直す先を決める。remote に届かなければ、その種類を返す
*/
export async function readRestackDecision(target: Readonly<RestackTarget>): Promise<RestackReading> {
  const { reading, remote, lowerPullRequest } = target
  if (remote === undefined) return { kind: 'remote-unreachable' }
  const lowerHead = await remoteBranchHead(target.cwd, remote, reading.record.branch, target.signal)
  if (!lowerHead.isReachable) return { kind: 'remote-unreachable' }
  const decision = decideRestack({ reading, developBranch: target.developBranch, lowerPullRequest, lowerHead: lowerHead.sha })
  return { kind: 'decided', decision: withRebased(target.cwd, remote, reading, decision, lowerHead.sha) }
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
