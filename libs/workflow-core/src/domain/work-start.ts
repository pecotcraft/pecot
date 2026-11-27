// 着手の判定から、base の選び方・止める文・スタック先の表示を決める。I/O を持たない。

import { commandHint, hinted, inputHint, joinHinted } from './command-hint.js'
import type { HintedText, HintValue } from './command-hint.js'
import type { PullRequestReadout } from './issue-readout.js'
import { isAwaitingCloseAfterMerge, describePrerequisiteState, describeReadiness, displayReference, isDone } from './readiness.js'
import type { Prerequisite, Readiness, StackTarget } from './readiness.js'
import { issueReferenceToCliReference } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'
import type { BaseRecord } from './state.js'

export type StartDecision
  = | { readonly kind: 'start' }
    | { readonly kind: 'stack', readonly branch: string, readonly issue: IssueReference }
    | { readonly kind: 'blocked', readonly message: HintedText }

function blockedMessage(target: IssueReference, readiness: Readiness, prerequisites: readonly Prerequisite[]): HintedText {
  const home = target.repository
  const unfinished = prerequisites.filter(({ issue }) => !isDone(issue))
  const subject = issueReferenceToCliReference(target)
  const mergedOpen = unfinished.filter(({ issue }) => isAwaitingCloseAfterMerge(issue)).map(({ issue }) => issue.ref)
  const waitsMerge = readiness.reason?.code === 'waits-merge' ? readiness.reason.issues : []
  return joinHinted([
    `${displayReference(target, home)} is ${describeReadiness(readiness, prerequisites, home)}`,
    ...unfinished.map(prerequisite => `- ${displayReference(prerequisite.issue.ref, home)}: ${describePrerequisiteState(prerequisite)}`),
    ...mergedOpen.map(issue => displayReference(issue, home)).map(shown => `${shown} has a merged PR: close ${shown}, or retry once it closes`),
    ...unfinished.map(({ issue }) => hinted`to remove the prerequisite: ${commandHint(['issue', 'dependency', 'check'], removalArguments(target, issue.ref))}, then issue_dependency_write with the same arguments`),
    ...waitsMerge.map(({ issue }) => hinted`to stack on it instead of waiting for merge: remove ${displayReference(issue, home)} from the Waits for merge section of the body of ${subject}, then ${commandHint(['issue', 'check'], { method: 'update' })} and issue_write`),
  ])
}

function removalArguments(target: IssueReference, prerequisite: IssueReference): Readonly<Record<string, HintValue>> {
  return {
    method: 'remove',
    owner: target.repository.owner,
    repo: target.repository.repository,
    issue_number: target.number,
    type: 'blocked_by',
    related_owner: prerequisite.repository.owner,
    related_repo: prerequisite.repository.repository,
    related_issue_number: prerequisite.number,
  }
}

/**
判定から着手の仕方を決める。stackable はスタック先のブランチから、blocked は止める。
startable と、判定を持たない Epic・Tracker（undefined）は、今までどおり
*/
export function decideStart(readiness: Readiness | undefined, prerequisites: readonly Prerequisite[], target: IssueReference): StartDecision {
  if (readiness?.kind === 'blocked') return { kind: 'blocked', message: blockedMessage(target, readiness, prerequisites) }
  if (readiness?.kind === 'stackable' && readiness.stackOn !== undefined) return { kind: 'stack', branch: readiness.stackOn.branch, issue: readiness.stackOn.issue }
  return { kind: 'start' }
}

/**
--base が、判定で選んだスタック先と違うときの文。stackable のときだけ比べる
*/
export function describeBaseMismatch(base: string | undefined, decision: Exclude<StartDecision, { kind: 'blocked' }>, target: IssueReference): HintedText | undefined {
  const isDifferent = base !== undefined && base !== '' && decision.kind === 'stack' && base !== decision.branch
  return isDifferent ? hinted`${inputHint(['session', 'start'], 'base', base)} differs from the base chosen by readiness: ${decision.branch} (stacked on ${displayReference(decision.issue, target.repository)})` : undefined
}

/**
スタック先の親ブランチを git で調べた結果。追跡参照が手元に無ければ untracked
*/
export type LowerProbe
  = | { readonly kind: 'untracked', readonly reference: string }
    | { readonly kind: 'probed', readonly isShared: boolean, readonly sha: string | undefined }

export type StackInference
  = | { readonly kind: 'stacked', readonly record: BaseRecord, readonly stackedOn: IssueReference }
    | { readonly kind: 'development' }
    | { readonly kind: 'unknown', readonly reason: string }

/**
.pecot-base が無いときに、判定と親ブランチの git の様子からスタック先を求める。
判定が stackable でも親ブランチの変更を持たないのは、開発ブランチから着手した後に前提を足したとき
*/
export function inferStackedBase(readiness: Readiness | undefined, prerequisites: readonly Prerequisite[], target: IssueReference, probe: (stackOn: Readonly<StackTarget>) => LowerProbe): StackInference {
  if (readiness?.kind === 'blocked') return { kind: 'unknown', reason: describeReadiness(readiness, prerequisites, target.repository) }
  if (readiness?.kind !== 'stackable' || readiness.stackOn === undefined) return { kind: 'development' }
  const { branch, issue } = readiness.stackOn
  const probed = probe(readiness.stackOn)
  if (probed.kind === 'untracked') return { kind: 'unknown', reason: `${probed.reference} is not found; fetch it with: git fetch` }
  if (!probed.isShared) return { kind: 'development' }
  if (probed.sha === undefined) return { kind: 'unknown', reason: `cannot find where HEAD forked from ${branch}` }
  return { kind: 'stacked', record: { branch, sha: probed.sha, stackedOn: issue }, stackedOn: issue }
}

/**
session show の `- base:` の行。PR が無ければ `no PR`、読めなければ `PR unknown`
*/
export function describeStackBase(branch: string, issue: IssueReference, pullRequest: Readonly<PullRequestReadout> | undefined | 'unknown'): string {
  const pr = pullRequest === 'unknown' ? 'PR unknown' : (pullRequest === undefined ? 'no PR' : `PR #${String(pullRequest.number)} ${pullRequest.state}`)
  return `- base: ${branch} (#${String(issue.number)}, ${pr})`
}
