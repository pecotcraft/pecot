// Issue の着手の可否の判定と、フェーズの進め方（specs/024 の data-model.md の 2〜4）。I/O を持たない純関数だけを置く。

import { isEpicIssue } from './issue-kind.js'
import type { IssuePrerequisitesReadout, IssueReadout, PullRequestReadout } from './issue-readout.js'
import type { WaitsForMergeReadout } from './prerequisites.js'
import { issueReferenceKey } from './reference-parser.js'
import type { IssueReference } from './reference-parser.js'
import { isSameRepository } from './repository-resolver.js'
import type { RepositoryReference } from './repository-resolver.js'

export type Wait = 'stack' | 'merge'

export type IssueWorkKind = 'task' | 'epic' | 'tracker'

export interface IssuePullRequest {
  readonly repository: RepositoryReference
  readonly number: number
  readonly state: 'open' | 'merged' | 'closed'
  readonly headRefName: string
  readonly baseRefName: string
  readonly isDraft: boolean
  readonly isCrossRepository: boolean
}

export interface IssueFacts {
  readonly ref: IssueReference
  readonly state: 'open' | 'closed'
  /**
  進行の欄の値。ボードに無ければ undefined
  */
  readonly column: string | undefined
  /**
  Status の値（札）。ボードに無ければ undefined
  */
  readonly label: string | undefined
  readonly kind: IssueWorkKind
  readonly branches: readonly string[]
  readonly pullRequests: readonly IssuePullRequest[]
}

export interface Prerequisite {
  readonly issue: IssueFacts
  readonly wait: Wait
  /**
  wait が merge のときの理由。本文の節が読めないときは undefined
  */
  readonly reason: string | undefined
}

export type PrerequisiteList = readonly Prerequisite[] | 'read-failed'

export type NotInReviewState = 'started-without-pr' | 'not-started' | 'multiple-prs' | 'fork-pr' | 'pending'

export type ReadinessReason
  = | { readonly code: 'unreadable' }
    | { readonly code: 'cycle', readonly cycle: readonly string[] }
    | { readonly code: 'closed-unmerged' | 'other-repository' | 'diverged', readonly issues: readonly IssueReference[] }
    | { readonly code: 'waits-merge', readonly issues: readonly { readonly issue: IssueReference, readonly reason: string | undefined }[] }
    | { readonly code: 'not-in-review', readonly issues: readonly { readonly issue: IssueReference, readonly state: NotInReviewState }[] }

export interface StackTarget {
  readonly branch: string
  readonly issue: IssueReference
}

export interface Readiness {
  readonly kind: 'startable' | 'stackable' | 'blocked'
  readonly stackOn: StackTarget | undefined
  /**
  blocked のときだけある
  */
  readonly reason: ReadinessReason | undefined
  /**
  閉じて済んでいない前提がある。当たった順とは独立に計算する
  */
  readonly needsReview: boolean
  /**
  札が Needs Attention の、済んでいない前提だけ。済んだ前提は含めず、blocked にも付く
  */
  readonly attention: readonly IssueReference[]
}

export interface JudgeReadinessInput {
  readonly target: IssueFacts
  readonly prerequisites: PrerequisiteList
  /**
  findCycle の結果
  */
  readonly cycle: readonly string[] | undefined
  /**
  head のブランチ名から PR を引く。順 8 で base をたどるのに使い、open で fork からでない PR だけを通る
  */
  readonly pullRequestsByHead: ReadonlyMap<string, IssuePullRequest>
  readonly developmentBranch: string
}

export const PENDING_COLUMN = 'Pending'
export const NEEDS_ATTENTION_LABEL = 'Needs Attention'
export const TRACKER_TITLE_PREFIX = '[Tracker]'

function openPullRequests(issue: IssueFacts): readonly IssuePullRequest[] {
  return issue.pullRequests.filter(pullRequest => pullRequest.state === 'open')
}

export function isDone(issue: IssueFacts): boolean {
  return issue.state === 'closed' && issue.pullRequests.some(pullRequest => pullRequest.state === 'merged')
}

/**
open で、open の PR がちょうど 1 本あり、fork からでない。ドラフトも含む
*/
export function isInReview(issue: IssueFacts): boolean {
  const open = openPullRequests(issue)
  return issue.state === 'open' && open.length === 1 && open[0]?.isCrossRepository === false
}

export function hasStarted(issue: IssueFacts): boolean {
  return issue.branches.length > 0 || issue.pullRequests.length > 0
}

function isPending(issue: IssueFacts): boolean {
  return issue.column === PENDING_COLUMN
}

// 列が Pending の前提は、人が後回しにしたものなので、PR があっても積む先にしない
function isStackable(issue: IssueFacts): boolean {
  return isInReview(issue) && !isPending(issue)
}

function isStackBase(pullRequest: IssuePullRequest): boolean {
  return pullRequest.state === 'open' && !pullRequest.isCrossRepository
}

function notInReviewState(issue: IssueFacts): NotInReviewState {
  if (isPending(issue)) return 'pending'
  const open = openPullRequests(issue)
  if (open.length > 1) return 'multiple-prs'
  if (open.length === 1) return 'fork-pr'
  return hasStarted(issue) ? 'started-without-pr' : 'not-started'
}

// 開発ブランチに届かない（途切れる・輪になる）列は undefined
function headsToDevelopment(start: IssuePullRequest, byHead: ReadonlyMap<string, IssuePullRequest>, developmentBranch: string): ReadonlySet<string> | undefined {
  const reached = new Set([start.headRefName])
  let current = start
  while (current.baseRefName !== developmentBranch) {
    const next = byHead.get(current.baseRefName)
    if (next === undefined || reached.has(next.headRefName)) return undefined
    reached.add(next.headRefName)
    current = next
  }
  return reached
}

// 済んでいない前提はすべて PR 中なので、open の PR がちょうど 1 本ある
function findStackTarget(unfinished: readonly Prerequisite[], input: JudgeReadinessInput): StackTarget | undefined {
  const entries = unfinished.flatMap(({ issue }) => {
    const [pullRequest] = openPullRequests(issue)
    return pullRequest === undefined ? [] : { issue: issue.ref, pullRequest }
  })
  const byHead = new Map([...input.pullRequestsByHead].filter(([, pullRequest]) => isStackBase(pullRequest)))
  for (const { pullRequest } of entries) byHead.set(pullRequest.headRefName, pullRequest)
  for (const start of entries) {
    const reached = headsToDevelopment(start.pullRequest, byHead, input.developmentBranch)
    if (reached !== undefined && entries.every(other => reached.has(other.pullRequest.headRefName))) {
      return { branch: start.pullRequest.headRefName, issue: start.issue }
    }
  }
  return undefined
}

function result(
  kind: Readiness['kind'],
  fields: Pick<Readiness, 'needsReview' | 'attention'> & { readonly reason?: ReadinessReason, readonly stackOn?: StackTarget },
): Readiness {
  return { kind, stackOn: fields.stackOn, reason: fields.reason, needsReview: fields.needsReview, attention: fields.attention }
}

/**
data-model.md の 3 の表を上から当てはめる。Epic と Tracker には判定を出さず undefined を返す
*/
export function judgeReadiness(input: JudgeReadinessInput): Readiness | undefined {
  const { target, prerequisites, cycle } = input
  if (target.kind !== 'task') return undefined
  if (prerequisites === 'read-failed') {
    return result('blocked', { reason: { code: 'unreadable' }, needsReview: false, attention: [] })
  }

  const unfinished = prerequisites.filter(({ issue }) => !isDone(issue))
  const closedUnmerged = unfinished.filter(({ issue }) => issue.state === 'closed')
  const isNeedsReview = closedUnmerged.length > 0
  const attention = unfinished.filter(({ issue }) => issue.label === NEEDS_ATTENTION_LABEL).map(({ issue }) => issue.ref)
  const blocked = (reason: ReadinessReason): Readiness => result('blocked', { reason, needsReview: isNeedsReview, attention })

  if (cycle !== undefined) return blocked({ code: 'cycle', cycle })
  if (isNeedsReview) return blocked({ code: 'closed-unmerged', issues: closedUnmerged.map(({ issue }) => issue.ref) })
  const waitsMerge = unfinished.filter(({ wait }) => wait === 'merge')
  if (waitsMerge.length > 0) {
    return blocked({ code: 'waits-merge', issues: waitsMerge.map(({ issue, reason }) => ({ issue: issue.ref, reason })) })
  }
  if (unfinished.length === 0) return result('startable', { needsReview: isNeedsReview, attention })

  const otherRepository = unfinished.filter(({ issue }) => !isSameRepository(issue.ref.repository, target.ref.repository))
  if (otherRepository.length > 0) return blocked({ code: 'other-repository', issues: otherRepository.map(({ issue }) => issue.ref) })
  const notInReview = unfinished.filter(({ issue }) => !isStackable(issue))
  if (notInReview.length > 0) {
    return blocked({ code: 'not-in-review', issues: notInReview.map(({ issue }) => ({ issue: issue.ref, state: notInReviewState(issue) })) })
  }

  const stackOn = findStackTarget(unfinished, input)
  return stackOn === undefined
    ? blocked({ code: 'diverged', issues: unfinished.map(({ issue }) => issue.ref) })
    : result('stackable', { stackOn, needsReview: isNeedsReview, attention })
}

export interface PlannedPhase {
  readonly key: string
  readonly prerequisites: readonly { readonly key: string, readonly wait: Wait }[]
}

export type Progression
  = | { readonly kind: 'alone' }
    | { readonly kind: 'wait-merge' }
    | { readonly kind: 'stack', readonly on: string }
    | { readonly kind: 'join' }

export type ProgressionPlan
  = | { readonly kind: 'cycle', readonly cycle: readonly string[] }
    | { readonly kind: 'planned', readonly progressions: ReadonlyMap<string, Progression> }

// localeCompare は環境で順が変わるので、コード単位の順にする
function compareKeys(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
キーから前提のキーへの辺の表から、輪を 1 つ返す。始点を末尾にも置き、始点は輪のキーの最小にする。
キーと辺をソートして探すので、入力の順に依らない。自分自身への辺は長さ 1 の輪になる
*/
export function findCycle(edges: ReadonlyMap<string, readonly string[]>): readonly string[] | undefined {
  const states = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []

  const visit = (key: string): readonly string[] | undefined => {
    states.set(key, 'visiting')
    path.push(key)
    const neighbors = (edges.get(key) ?? []).toSorted(compareKeys)
    for (const next of neighbors) {
      const state = states.get(next)
      if (state === 'visiting') {
        const loop = path.slice(path.indexOf(next))
        const smallest = loop.indexOf(loop.toSorted(compareKeys).at(0) ?? next)
        return [...loop.slice(smallest), ...loop.slice(0, smallest), loop.at(smallest) ?? next]
      }
      const found = state === undefined ? visit(next) : undefined
      if (found !== undefined) return found
    }
    path.pop()
    states.set(key, 'done')
    return undefined
  }

  const roots = [...edges].map(([key]) => key).toSorted(compareKeys)
  for (const key of roots) {
    const found = states.has(key) ? undefined : visit(key)
    if (found !== undefined) return found
  }
  return undefined
}

function reachableThrough(start: string, stackEdges: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const reached = new Set<string>()
  const pending = [start]
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    const nextKeys = stackEdges.get(key) ?? []
    for (const next of nextKeys) {
      if (reached.has(next)) continue
      reached.add(next)
      pending.push(next)
    }
  }
  return reached
}

/**
フェーズごとの進め方を、Issue の状態を見ずに前提の形と種類だけで決める。輪があれば進め方を出さず輪を返す
*/
export function planProgression(phases: readonly PlannedPhase[]): ProgressionPlan {
  const cycle = findCycle(new Map(phases.map(phase => [phase.key, phase.prerequisites.map(({ key }) => key)])))
  if (cycle !== undefined) return { kind: 'cycle', cycle }

  const stackEdges = new Map(phases.map(phase => [phase.key, phase.prerequisites.filter(({ wait }) => wait === 'stack').map(({ key }) => key)]))
  const progressions = new Map<string, Progression>()
  for (const phase of phases) {
    const keys = phase.prerequisites.map(({ key }) => key)
    if (keys.length === 0) {
      progressions.set(phase.key, { kind: 'alone' })
    }
    else if (phase.prerequisites.some(({ wait }) => wait === 'merge')) {
      progressions.set(phase.key, { kind: 'wait-merge' })
    }
    else {
      const top = keys.find((key) => {
        const reached = reachableThrough(key, stackEdges)
        return keys.every(other => other === key || reached.has(other))
      })
      progressions.set(phase.key, top === undefined ? { kind: 'join' } : { kind: 'stack', on: top })
    }
  }
  return { kind: 'planned', progressions }
}

/**
stack の積む先をたどった木の、根から葉までの道を、下から並べて返す。stack の無い根は道を作らないので、1 段だけの道は出ない
*/
export function stackChains(progressions: ReadonlyMap<string, Progression>): readonly (readonly string[])[] {
  const children = new Map<string, string[]>()
  for (const [key, progression] of progressions) {
    if (progression.kind === 'stack') children.set(progression.on, [...children.get(progression.on) ?? [], key])
  }
  const roots = [...children].map(([key]) => key).filter(key => progressions.get(key)?.kind !== 'stack')

  const walk = (key: string, path: readonly string[]): (readonly string[])[] => {
    const next = (children.get(key) ?? []).filter(child => !path.includes(child))
    return next.length === 0 ? [path] : next.flatMap(child => walk(child, [...path, child]))
  }
  return roots.flatMap(root => walk(root, [root]))
}

export interface FactsMismatch {
  readonly ref: IssueReference
  readonly reason: string
}

export interface ToIssueFactsResult {
  readonly target: IssueFacts
  readonly prerequisites: PrerequisiteList
  /**
  本文の節にあって blocked by に無い組。判定には使わない
  */
  readonly mismatches: readonly FactsMismatch[]
}

export interface ToIssueFactsOptions {
  /**
  進行の欄のフィールド名（`pecot-workflow-<suffix>`）
  */
  readonly columnFieldName: string
  /**
  札のフィールド名。このフェーズでは `Status`
  */
  readonly labelFieldName: string
}

const LOWER_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } satisfies Record<PullRequestReadout['state'], IssuePullRequest['state']>

function toPullRequest(readout: PullRequestReadout): IssuePullRequest {
  return {
    repository: readout.repository,
    number: readout.number,
    state: LOWER_STATE[readout.state],
    headRefName: readout.headRefName,
    baseRefName: readout.baseRefName,
    isDraft: readout.isDraft,
    isCrossRepository: readout.isCrossRepository,
  }
}

// 3 つの読み口で同じ PR を 1 本に数える。fork からの PR は、リンクしたブランチの読み口だけ捨てる
function collectPullRequests(readout: IssueReadout): readonly IssuePullRequest[] {
  const sources = [
    ...readout.linkedBranches.flatMap(branch => branch.pullRequests).filter(pullRequest => !pullRequest.isCrossRepository),
    ...readout.closingPullRequests,
    ...readout.timelinePullRequests,
  ]
  const seen = new Set<string>()
  return sources
    .filter((source) => {
      const key = issueReferenceKey({ repository: source.repository, number: source.number })
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(source => toPullRequest(source))
}

function workKind(readout: IssueReadout): IssueWorkKind {
  if (isEpicIssue({ issue_type: readout.issueType, sub_issues_total: readout.subIssuesTotal })) return 'epic'
  return readout.title.startsWith(TRACKER_TITLE_PREFIX) ? 'tracker' : 'task'
}

function toFacts(readout: IssueReadout, options: ToIssueFactsOptions): IssueFacts {
  const valueOf = (fieldName: string): string | undefined => readout.projectFieldValues.find(value => value.fieldName === fieldName)?.optionName
  return {
    ref: { repository: readout.repository, number: readout.number },
    state: LOWER_STATE[readout.state],
    column: valueOf(options.columnFieldName),
    label: valueOf(options.labelFieldName),
    kind: workKind(readout),
    branches: readout.linkedBranches.map(branch => branch.name),
    pullRequests: collectPullRequests(readout),
  }
}

/**
infra の読み取り結果を、判定の入力（Issue の実態）にまとめる。
本文の節が malformed なら前提をすべて merge にし、節にあって blocked by に無い組は mismatches に返す
*/
export function toIssueFacts(readout: IssuePrerequisitesReadout, section: WaitsForMergeReadout, options: ToIssueFactsOptions): ToIssueFactsResult {
  const target = toFacts(readout.issue, options)
  if (readout.blockedBy.kind === 'read-failed') return { target, prerequisites: 'read-failed', mismatches: [] }

  const lines = section.kind === 'ok' ? section.lines : []
  const reasons = new Map(lines.map(line => [issueReferenceKey(line.ref), line.reason]))
  const prerequisites = readout.blockedBy.issues.map((blocker): Prerequisite => {
    const issue = toFacts(blocker, options)
    const reason = reasons.get(issueReferenceKey(issue.ref))
    const wait: Wait = reason !== undefined || section.kind === 'malformed' ? 'merge' : 'stack'
    return { issue, wait, reason }
  })

  const present = new Set(prerequisites.map(({ issue }) => issueReferenceKey(issue.ref)))
  const mismatches = lines
    .filter(line => !present.has(issueReferenceKey(line.ref)))
    .map(line => ({ ref: line.ref, reason: line.reason }))
  return { target, prerequisites, mismatches }
}
