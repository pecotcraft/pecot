// auto gate の判定。決まりは specs/023-label-triggered-autofix/data-model.md の「自動処理の実行」「対象外の条件」。
// GitHub を読むのは commands/auto-gate.ts が受け持ち、読んだ値をここに渡す。
import { autoResultOf, countCiFixes, hasResultOn, inlineCode, lastResultOn, markerBranch, NO_BRANCH } from './auto-result.js'
import type { AutoNext, AutoResult } from './auto-result.js'
import { extractIssueNumberFromBranch } from './branch-name.js'
import type { IssuePullRequest, IssueWorkKind } from './readiness.js'
import type { RepositoryReference } from './repository-resolver.js'
import type { IssueCommentReading, IssueCommentRecord } from './review-finish.js'
import { isWritePermission } from './write-permission.js'

export type AutoKind = 'start' | 'resume' | 'ci-fix' | 'ci-passed'

/**
自動処理の実行。kind が決まらないとき（対象外・何も書かないとき）は空
*/
export interface AutoRun {
  readonly issue: string
  readonly number: number
  readonly kind: AutoKind | ''
  readonly proceed: boolean
  readonly reason: string
  readonly branch: string
  readonly pr: number
  readonly ciAttempts: number
}

/**
gate が書く結果のコメント。text は結果ごとの本文に入れる理由の文、branch は目印のブランチ
*/
export interface GateWrite {
  readonly result: AutoResult
  readonly text: string
  readonly next: AutoNext
  readonly branch: string
}

export interface GateDecision {
  readonly run: AutoRun
  readonly write: GateWrite | undefined
}

/**
issues のイベントと、ラベルを付けた人の権限。permission は読めないときに undefined
*/
export interface IssuesScreenInput {
  readonly repository: RepositoryReference
  readonly number: number
  readonly sender: string
  readonly permission: string | undefined
  readonly isPullRequest: boolean
  readonly state: 'open' | 'closed'
}

export interface IssueGateFacts {
  readonly title: string
  readonly kind: IssueWorkKind
  readonly subIssues: number
  /**
  進行の欄の値。ボードに無ければ undefined
  */
  readonly column: string | undefined
  /**
  進行の欄が Blocked のときの、待っている前提の文（describeReadiness）
  */
  readonly blockedText: string | undefined
  readonly branches: readonly string[]
  readonly pullRequests: readonly IssuePullRequest[]
  readonly comments: readonly IssueCommentReading[]
  /**
  読んでよい人の計画のコメントがある
  */
  readonly hasPlan: boolean
}

export interface IssuesGateInput extends IssuesScreenInput {
  readonly event: 'issues'
  readonly facts: IssueGateFacts
}

export interface WorkflowRunScreenInput {
  readonly repository: RepositoryReference
  readonly action: string
  readonly conclusion: string
  readonly headBranch: string
  readonly headSha: string
  /**
  run を起こした push の人の種類（`workflow_run.actor.type`）。無ければ undefined
  */
  readonly actorType: string | undefined
  /**
  run を作った時刻（`workflow_run.created_at`）。無ければ undefined
  */
  readonly createdAt: string | undefined
  readonly isFork: boolean
  readonly pullRequest: number
}

export interface WorkflowRunGateInput extends WorkflowRunScreenInput {
  readonly event: 'workflow_run'
  readonly comments: readonly IssueCommentRecord[]
  /**
  ブランチの先頭の commit。ブランチが無ければ undefined
  */
  readonly branchSha: string | undefined
  /**
  同じ head_sha のほかの run に、落ちたもの（failure・timed_out）がある。CI が通ったときだけ読む
  */
  readonly hasFailedRun: boolean
  readonly maxCiAttempts: number
}

export type GateInput = IssuesGateInput | WorkflowRunGateInput

const PROCEEDING_COLUMNS: ReadonlySet<string> = new Set(['Ready'])
const WORKING_COLUMNS: ReadonlySet<string> = new Set(['Active', 'In Review'])
const CI_FAILED: ReadonlySet<string> = new Set(['failure', 'timed_out'])
const EPIC_TITLE_PREFIX = '[Epic]'
const TRACKER_TITLE_PREFIX = '[Tracker]'

/**
CI の落ちた conclusion（failure・timed_out）か
*/
export function isFailedConclusion(conclusion: string): boolean {
  return CI_FAILED.has(conclusion)
}

function issueOf(repository: RepositoryReference, number: number): string {
  return `${repository.owner}/${repository.repository}/${String(number)}`
}

interface Target {
  readonly issue: string
  readonly number: number
}

function silent(target: Target, reason: string): GateDecision {
  return { run: { ...target, kind: '', proceed: false, reason, branch: '', pr: 0, ciAttempts: 0 }, write: undefined }
}

function outOfScope(target: Target, reason: string, text: string, next: AutoNext, branch: string): GateDecision {
  return { run: { ...target, kind: '', proceed: false, reason, branch: '', pr: 0, ciAttempts: 0 }, write: { result: 'out-of-scope', text, next, branch } }
}

/**
Issue を読まずに決まる判定。権限の無い人には何も書かないので、権限を最初に見る。決まらなければ undefined
*/
export function screenIssues(input: Readonly<IssuesScreenInput>): GateDecision | undefined {
  const target = { issue: issueOf(input.repository, input.number), number: input.number }
  // claude-code-action と同じく、名前が [bot] で終わる人は権限を読まずに止める
  if (input.sender.endsWith('[bot]')) return silent(target, 'the sender is a bot')
  if (input.permission === undefined) return silent(target, 'could not read the permission of the sender')
  if (!isWritePermission(input.permission)) return silent(target, 'the sender has no write permission')
  if (input.state === 'closed') return outOfScope(target, 'the Issue is closed', 'Issue が閉じているので、自動処理を始めなかった。', 'reopen', NO_BRANCH)
  if (input.isPullRequest) return outOfScope(target, 'the label is on a PR', 'PR に付いた起動ラベルでは、自動処理を始めない。', 'issue-only', NO_BRANCH)
  return undefined
}

function judgeColumn(target: Target, facts: Readonly<IssueGateFacts>, branch: string): GateDecision | undefined {
  const { column } = facts
  if (column === undefined || PROCEEDING_COLUMNS.has(column)) return undefined
  if (WORKING_COLUMNS.has(column)) {
    // 自動処理が結果を書いた後の Active・In Review は、人の作業でなく自動処理の続き
    const hasResult = facts.comments.some(comment => comment.userType === 'Bot' && autoResultOf(comment.body) !== undefined)
    return hasResult ? undefined : outOfScope(target, `a person is working on the Issue (${column})`, `進行の欄が ${inlineCode(column)} で、人が作業しているので、自動処理を始めなかった。`, 'hand-over', branch)
  }
  if (column === 'Blocked') {
    const waiting = facts.blockedText ?? 'blocked'
    return outOfScope(target, `the Issue is blocked: ${waiting}`, `進行の欄が ${inlineCode(column)} なので、自動処理を始めなかった。待っている前提は ${inlineCode(waiting)} だ。`, 'prerequisites', branch)
  }
  return outOfScope(target, `the Issue is in ${column}`, `進行の欄が ${inlineCode(column)} なので、自動処理を始めなかった。`, 'ready', branch)
}

function decideIssues(input: Readonly<IssuesGateInput>): GateDecision {
  const screened = screenIssues(input)
  if (screened !== undefined) return screened
  const { facts } = input
  const target = { issue: issueOf(input.repository, input.number), number: input.number }
  const branch = markerBranch(facts.branches, facts.pullRequests, input.number)
  if (facts.kind === 'epic' || facts.title.startsWith(EPIC_TITLE_PREFIX)) return outOfScope(target, 'the Issue is an Epic', 'Epic には、自動処理を始めない。', 'subtask', branch)
  if (facts.kind === 'tracker' || facts.title.startsWith(TRACKER_TITLE_PREFIX)) return outOfScope(target, 'the Issue is a Tracker', 'Tracker には、自動処理を始めない。', 'tracker', branch)
  if (facts.subIssues > 0) return outOfScope(target, 'the Issue has sub-issues', 'sub-issue を持つ Issue には、自動処理を始めない。', 'subtask', branch)
  const byColumn = judgeColumn(target, facts, branch)
  if (byColumn !== undefined) return byColumn
  const existing = branch === NO_BRANCH ? '' : branch
  const pullRequest = facts.pullRequests.find(candidate => candidate.state === 'open' && candidate.headRefName === existing)
  return {
    run: {
      ...target,
      kind: existing !== '' || facts.hasPlan || facts.branches.length > 0 ? 'resume' : 'start',
      proceed: true,
      reason: '',
      branch: existing,
      pr: pullRequest?.number ?? 0,
      ciAttempts: existing === '' ? 0 : countCiFixes(facts.comments, existing),
    },
    write: undefined,
  }
}

/**
Issue のコメントを読まずに決まる workflow_run の判定。ここで決まるときはコメントを書かない。決まらなければ undefined
*/
export function screenWorkflowRun(input: Readonly<WorkflowRunScreenInput>): GateDecision | undefined {
  const number = extractIssueNumberFromBranch(input.headBranch) ?? 0
  const target = number > 0 ? { issue: issueOf(input.repository, number), number } : { issue: '', number: 0 }
  if (input.action !== 'completed') return silent(target, `the workflow run is not completed (${input.action})`)
  if (input.conclusion !== 'success' && !isFailedConclusion(input.conclusion)) return silent(target, `the CI conclusion is ${input.conclusion}`)
  if (number <= 0) return silent(target, `the branch ${input.headBranch} does not end with an Issue number`)
  if (input.isFork) return silent(target, 'the run is from a fork')
  return undefined
}

// ci-passed の後の run を、何も書かずに止める理由。止めなければ undefined
// 人の push の後の CI は直さない。同じ push の CI がもう通っていれば、ci-passed を重ねて書かない。時刻が分からなければ書かない側に倒す
function afterPassReason(input: Readonly<WorkflowRunGateInput>): string | undefined {
  const last = lastResultOn(input.comments, input.headBranch)
  if (last?.result !== 'ci-passed') return undefined
  if (input.actorType !== 'Bot') return `${input.headBranch} was pushed by a person after the CI passed`
  if (input.conclusion !== 'success') return undefined
  const createdTime = Date.parse(input.createdAt ?? '')
  const passedTime = Date.parse(last.comment.createdAt)
  return Number.isNaN(createdTime) || Number.isNaN(passedTime) || createdTime < passedTime ? `the CI already passed for this push of ${input.headBranch}` : undefined
}

function decideWorkflowRun(input: Readonly<WorkflowRunGateInput>): GateDecision {
  const screened = screenWorkflowRun(input)
  if (screened !== undefined) return screened
  const number = extractIssueNumberFromBranch(input.headBranch) ?? 0
  const target = { issue: issueOf(input.repository, number), number }
  const branch = input.headBranch
  if (!hasResultOn(input.comments, branch, 'pr-created')) return silent(target, `no PR was created by the automation on ${branch}`)
  if (input.branchSha !== input.headSha) return silent(target, `the run is not for the head of ${branch}`)
  const afterPass = afterPassReason(input)
  if (afterPass !== undefined) return silent(target, afterPass)
  const ciAttempts = countCiFixes(input.comments, branch)
  const base = { ...target, branch, pr: input.pullRequest, ciAttempts }
  if (input.conclusion === 'success') {
    return input.hasFailedRun
      ? silent(target, `another CI run of ${input.headSha} failed`)
      : { run: { ...base, kind: 'ci-passed', proceed: false, reason: 'the CI passed' }, write: { result: 'ci-passed', text: '', next: 'default', branch } }
  }
  if (ciAttempts < input.maxCiAttempts) return { run: { ...base, kind: 'ci-fix', proceed: true, reason: '' }, write: undefined }
  const limit = `${String(ciAttempts)} of ${String(input.maxCiAttempts)}`
  return {
    run: { ...base, kind: 'ci-fix', proceed: false, reason: `the CI fixes reached the limit (${limit})` },
    write: { result: 'limit', text: `CI を直す回数が上限（${String(input.maxCiAttempts)} 回）に達したので、落ちた CI を直さなかった。`, next: 'default', branch },
  }
}

export function decideGate(input: Readonly<GateInput>): GateDecision {
  return input.event === 'issues' ? decideIssues(input) : decideWorkflowRun(input)
}
