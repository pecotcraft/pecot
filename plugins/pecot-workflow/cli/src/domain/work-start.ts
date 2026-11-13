// 着手の判定から、base の選び方・止める文・積んだ先の表示を決める。I/O を持たない。

import type { PullRequestReadout } from './issue-readout.js'
import { describePrerequisiteState, describeReadiness, displayReference, isDone } from './readiness.js'
import type { Prerequisite, Readiness } from './readiness.js'
import { issueReferenceToCliReference } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'

export type StartDecision
  = | { readonly kind: 'start' }
    | { readonly kind: 'stack', readonly branch: string, readonly issue: IssueReference }
    | { readonly kind: 'blocked', readonly message: string }

// 2 件以上のときは、どれを指すか決められないので、形だけ出す
function byReference(unfinished: readonly Prerequisite[]): string {
  const [only, ...others] = unfinished
  return only === undefined || others.length > 0 ? '<owner/repo/N>' : issueReferenceToCliReference(only.issue.ref)
}

function blockedMessage(target: IssueReference, readiness: Readiness, prerequisites: readonly Prerequisite[]): string {
  const home = target.repository
  const unfinished = prerequisites.filter(({ issue }) => !isDone(issue))
  const subject = issueReferenceToCliReference(target)
  const by = byReference(unfinished)
  return [
    `${displayReference(target, home)} is ${describeReadiness(readiness, prerequisites, home)}`,
    ...unfinished.map(prerequisite => `- ${displayReference(prerequisite.issue.ref, home)}: ${describePrerequisiteState(prerequisite)}`),
    `to remove the prerequisite: pecot issue unblock ${subject} --by ${by}`,
    ...readiness.reason?.code === 'waits-merge' ? [`to stack on it instead of waiting for merge: pecot issue block ${subject} --by ${by} --wait stack`] : [],
  ].join('\n')
}

/**
判定から着手の仕方を決める。stackable は積む先のブランチから、blocked は止める。
startable と、判定を持たない Epic・Tracker（undefined）は、今までどおり
*/
export function decideStart(readiness: Readiness | undefined, prerequisites: readonly Prerequisite[], target: IssueReference): StartDecision {
  if (readiness?.kind === 'blocked') return { kind: 'blocked', message: blockedMessage(target, readiness, prerequisites) }
  if (readiness?.kind === 'stackable' && readiness.stackOn !== undefined) return { kind: 'stack', branch: readiness.stackOn.branch, issue: readiness.stackOn.issue }
  return { kind: 'start' }
}

/**
--base が、判定で選んだ積む先と違うときの文。stackable のときだけ比べる
*/
export function describeBaseMismatch(base: string | undefined, decision: Readonly<StartDecision>, target: IssueReference): string | undefined {
  const isDifferent = base !== undefined && base !== '' && decision.kind === 'stack' && base !== decision.branch
  return isDifferent ? `--base ${base} differs from the base chosen by readiness: ${decision.branch} (stacked on ${displayReference(decision.issue, target.repository)})` : undefined
}

/**
base のブランチを head に持つ PR のうち、表に出す 1 本。fork でない open のもの、無ければ fork でない最新のもの（新しい順に渡す）
*/
export function pickBasePullRequest(pullRequests: readonly PullRequestReadout[]): PullRequestReadout | undefined {
  const own = pullRequests.filter(pullRequest => !pullRequest.isCrossRepository)
  return own.find(pullRequest => pullRequest.state === 'OPEN') ?? own[0]
}

/**
session status の `- base:` の行。PR が無ければ `no PR`、読めなければ `PR unknown`
*/
export function describeStackBase(branch: string, issue: IssueReference, pullRequest: Readonly<PullRequestReadout> | undefined | 'unknown'): string {
  const pr = pullRequest === 'unknown' ? 'PR unknown' : (pullRequest === undefined ? 'no PR' : `PR #${String(pullRequest.number)} ${pullRequest.state}`)
  return `- base: ${branch} (#${String(issue.number)}, ${pr})`
}
