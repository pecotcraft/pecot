// スタックしたブランチをスタックし直す先の判断と、その表示。git と GitHub の読み取りは commands が行う。

import type { PullRequestReadout } from './issue-readout.js'
import type { BaseReading } from './state.js'

/**
pr restack のコマンドの path。案内（commandHint）とコマンドの定義が共有する
*/
export const RESTACK_PATH: readonly string[] = ['pr', 'restack']

export interface RestackInput {
  /**
  base の記録。形の誤りは呼び出し側が先に止める
  */
  readonly reading: Exclude<BaseReading, { kind: 'malformed' }>
  readonly developBranch: string
  /**
  親ブランチを head に持つ PR（pickLowerPullRequest で選んだもの）
  */
  readonly lowerPullRequest: Readonly<PullRequestReadout> | undefined
  /**
  親ブランチの、remote の先頭の SHA。remote に無ければ undefined
  */
  readonly lowerHead: string | undefined
}

export type RestackDecision
  = | { readonly kind: 'not-stacked', readonly base: string }
    | { readonly kind: 'up-to-date', readonly base: string }
    | { readonly kind: 'moved', readonly base: string }
    | { readonly kind: 'merged', readonly base: string, readonly pullRequest: number }
    | { readonly kind: 'gone', readonly base: string, readonly pullRequest: number | undefined }
    /**
    ブランチは新しい base の上に載り終えていて、記録だけが古い。rebase は要らず、push と記録の書き直しだけが残る
    */
    | { readonly kind: 'rebased', readonly base: string }

/**
スタックし直す先を決める。base は、スタックし直した後の base のブランチ（merged なら開発ブランチ）
*/
export function decideRestack(input: Readonly<RestackInput>): RestackDecision {
  const { reading, developBranch, lowerPullRequest, lowerHead } = input
  if (reading.kind === 'development') return { kind: 'not-stacked', base: developBranch }
  const { branch, sha } = reading.record
  if (lowerPullRequest?.state === 'MERGED') return { kind: 'merged', base: developBranch, pullRequest: lowerPullRequest.number }
  if (lowerHead === undefined) return { kind: 'gone', base: branch, pullRequest: lowerPullRequest?.number }
  return { kind: lowerHead === sha ? 'up-to-date' : 'moved', base: branch }
}

/**
`pr restack --check` の行
*/
export function describeRestackCheck(branch: string, decision: Exclude<RestackDecision, { kind: 'gone' }>): string {
  switch (decision.kind) {
    case 'not-stacked':
    case 'up-to-date':
    case 'rebased': {
      return `up to date: ${branch} on ${decision.base}`
    }
    case 'moved': {
      return `needs restack: ${branch} on ${decision.base} (base moved)`
    }
    case 'merged': {
      return `needs restack: ${branch} onto ${decision.base} (base #${String(decision.pullRequest)} merged)`
    }
  }
}

/**
親ブランチが消えていて、マージもされていないときの文（`error: ` の前置きを含まない）
*/
export function describeGone(decision: Extract<RestackDecision, { kind: 'gone' }>): string {
  const pullRequest = decision.pullRequest === undefined ? 'it has no merged PR' : `PR #${String(decision.pullRequest)} was not merged`
  return `base branch ${decision.base} is gone and ${pullRequest}`
}

/**
スタックし直しが要るか。親ブランチが消えていて決められないときは undefined
*/
export function needsRestack(decision: Readonly<RestackDecision>): boolean | undefined {
  return decision.kind === 'gone' ? undefined : decision.kind === 'moved' || decision.kind === 'merged'
}

/**
session show の `- needs restack:` の行。決められないときは undefined
*/
export function describeNeedsRestack(decision: Readonly<RestackDecision>): string | undefined {
  const needed = needsRestack(decision)
  return needed === undefined ? undefined : `- needs restack: ${needed ? 'yes' : 'no'}`
}
