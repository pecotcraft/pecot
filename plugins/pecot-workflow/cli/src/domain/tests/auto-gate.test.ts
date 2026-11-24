// auto gate の判定を確かめる。表は specs/023-label-triggered-autofix/data-model.md の「自動処理の実行」「対象外の条件」と、CI を直した回数の数え方。
import { describe, expect, it } from 'vitest'

import { decideGate, screenIssues, screenWorkflowRun } from '../auto-gate.js'
import type { IssueGateFacts, IssuesGateInput, WorkflowRunGateInput } from '../auto-gate.js'
import type { IssuePullRequest } from '../readiness.js'
import type { IssueCommentRecord } from '../review-finish.js'

const REPOSITORY = { owner: 'acme', repository: 'demo' }
const BRANCH = 'feat/fix-x/7'
const HEAD = 'sha-head'

function record(body: string, userType: 'Bot' | 'User' = 'Bot', createdAt = '2026-11-24T10:00:00Z'): IssueCommentRecord {
  return { body, userType, login: userType === 'Bot' ? 'pecot-agent[bot]' : 'alice', authorAssociation: userType === 'Bot' ? 'NONE' : 'MEMBER', createdAt, url: '' }
}

function result(value: string, branch = BRANCH, createdAt?: string, userType: 'Bot' | 'User' = 'Bot'): IssueCommentRecord {
  return record(`<!-- pecot-auto: result=${value} run=1 attempt=1 branch=${branch} -->\n## Auto result — 見本`, userType, createdAt)
}

function openPullRequest(head: string, number = 11): IssuePullRequest {
  return { repository: REPOSITORY, number, state: 'open', headRefName: head, baseRefName: 'main', isDraft: false, isCrossRepository: false }
}

function facts(values: Partial<IssueGateFacts> = {}): IssueGateFacts {
  return { title: '直す', kind: 'task', subIssues: 0, column: 'Ready', blockedText: undefined, branches: [], pullRequests: [], comments: [], hasPlan: false, ...values }
}

function issues(values: Partial<Omit<IssuesGateInput, 'facts'>> = {}, factValues: Partial<IssueGateFacts> = {}): IssuesGateInput {
  return { event: 'issues', repository: REPOSITORY, number: 7, sender: 'alice', permission: 'write', isPullRequest: false, state: 'open', facts: facts(factValues), ...values }
}

function run(values: Partial<WorkflowRunGateInput> = {}): WorkflowRunGateInput {
  return {
    event: 'workflow_run',
    repository: REPOSITORY,
    action: 'completed',
    conclusion: 'failure',
    headBranch: BRANCH,
    headSha: HEAD,
    headCommitTime: '2026-11-24T09:00:00Z',
    isFork: false,
    pullRequest: 11,
    comments: [result('pr-created')],
    branchSha: HEAD,
    maxCiAttempts: 3,
    ...values,
  }
}

describe('decideGate の issues', () => {
  it('計画のコメントとブランチの無い Ready の Issue は、kind が start で proceed が真になり、何も書かない', () => {
    expect(decideGate(issues())).toEqual({
      run: { issue: 'acme/demo/7', number: 7, kind: 'start', proceed: true, reason: '', branch: '', pr: 0, ciAttempts: 0 },
      write: undefined,
    })
  })

  it.for([
    { name: '計画のコメントがある', values: { hasPlan: true } },
    { name: 'ブランチがある', values: { branches: [BRANCH] } },
  ])('$name Issue は、kind が resume で proceed が真になる', ({ values }) => {
    const decision = decideGate(issues({}, values))

    expect(decision.run).toMatchObject({ kind: 'resume', proceed: true })
    expect(decision.write).toBeUndefined()
  })

  it('開いた PR があるブランチを branch と pr に出し、そのブランチの CI を直した回数を出す', () => {
    const decision = decideGate(issues({}, { branches: ['other/3', BRANCH], pullRequests: [openPullRequest(BRANCH)], comments: [result('ci-fix-pushed')] }))

    expect(decision.run).toMatchObject({ branch: BRANCH, pr: 11, ciAttempts: 1 })
  })

  it('ボードに無い Issue は、kind が start で proceed が真になる', () => {
    expect(decideGate(issues({}, { column: undefined })).run).toMatchObject({ kind: 'start', proceed: true })
  })

  it.for(['Active', 'In Review'])('進行の欄が %s で、自動処理の結果のコメントがあれば、起動し直しとして proceed が真になる', (column) => {
    const decision = decideGate(issues({}, { column, branches: [BRANCH], comments: [result('question')] }))

    expect(decision.run).toMatchObject({ kind: 'resume', proceed: true })
  })

  it.for([
    { name: 'read', permission: 'read' },
    { name: 'none', permission: 'none' },
    { name: '読めない', permission: undefined },
  ])('ラベルを付けた人の権限が $name なら、proceed が偽で、何も書かない', ({ permission }) => {
    const decision = decideGate(issues({ permission }))

    expect(decision.run).toMatchObject({ kind: '', proceed: false })
    expect(decision.write).toBeUndefined()
  })

  it.for(['admin', 'write'])('ラベルを付けた人の権限が %s なら、進める', (permission) => {
    expect(decideGate(issues({ permission })).run.proceed).toBe(true)
  })

  it('ラベルを付けた人が [bot] なら、権限が write でも、proceed が偽で、何も書かない', () => {
    const decision = decideGate(issues({ sender: 'renovate[bot]' }))

    expect(decision.run).toMatchObject({ proceed: false, reason: 'the sender is a bot' })
    expect(decision.write).toBeUndefined()
  })

  it.for([
    { name: 'Issue が closed', input: issues({ state: 'closed' }), reason: 'the Issue is closed', next: 'reopen' },
    { name: 'PR に付いたラベル', input: issues({ isPullRequest: true }), reason: 'the label is on a PR', next: 'issue-only' },
    { name: 'Issue Type が Epic', input: issues({}, { kind: 'epic' }), reason: 'the Issue is an Epic', next: 'subtask' },
    { name: 'タイトルが [Epic] で始まる', input: issues({}, { title: '[Epic] 大きな話' }), reason: 'the Issue is an Epic', next: 'subtask' },
    { name: 'Tracker', input: issues({}, { kind: 'tracker' }), reason: 'the Issue is a Tracker', next: 'tracker' },
    { name: 'タイトルが [Tracker] で始まる', input: issues({}, { title: '[Tracker] 改名の一覧' }), reason: 'the Issue is a Tracker', next: 'tracker' },
    { name: 'sub-issue を持つ', input: issues({}, { subIssues: 2 }), reason: 'the Issue has sub-issues', next: 'subtask' },
    { name: '進行の欄が Backlog', input: issues({}, { column: 'Backlog' }), reason: 'the Issue is in Backlog', next: 'ready' },
    { name: '進行の欄が Pending', input: issues({}, { column: 'Pending' }), reason: 'the Issue is in Pending', next: 'ready' },
    { name: '進行の欄が Archived', input: issues({}, { column: 'Archived' }), reason: 'the Issue is in Archived', next: 'ready' },
    { name: '進行の欄が Active で結果のコメントが無い', input: issues({}, { column: 'Active', comments: [result('question', BRANCH, undefined, 'User')] }), reason: 'a person is working on the Issue (Active)', next: 'hand-over' },
    { name: '進行の欄が In Review で結果のコメントが無い', input: issues({}, { column: 'In Review' }), reason: 'a person is working on the Issue (In Review)', next: 'hand-over' },
  ])('$name なら、proceed が偽で、out-of-scope の結果を書く', ({ input, reason, next }) => {
    const decision = decideGate(input)

    expect(decision.run).toMatchObject({ kind: '', proceed: false, reason })
    expect(decision.write).toMatchObject({ result: 'out-of-scope', next })
  })

  it('進行の欄が Blocked なら、待っている前提を理由の文に書いて、out-of-scope の結果を書く', () => {
    const decision = decideGate(issues({}, { column: 'Blocked', blockedText: 'blocked by #3 (not in review: #3 (not started))' }))

    expect(decision.run).toMatchObject({ proceed: false, reason: 'the Issue is blocked: blocked by #3 (not in review: #3 (not started))' })
    expect(decision.write?.text).toContain('`blocked by #3 (not in review: #3 (not started))`')
    expect(decision.write?.next).toBe('prerequisites')
  })

  it('進行の欄が Backlog なら、理由の文に今の進行の欄の値を書く', () => {
    expect(decideGate(issues({}, { column: 'Backlog' })).write?.text).toContain('`Backlog`')
  })

  it('対象外の結果の目印のブランチは、Issue の Development のブランチから決める', () => {
    const decision = decideGate(issues({}, { column: 'Backlog', branches: [BRANCH] }))

    expect(decision.write?.branch).toBe(BRANCH)
  })

  it('権限は closed より先に見て、権限の無い人の closed の Issue には何も書かない', () => {
    expect(decideGate(issues({ permission: 'read', state: 'closed' })).write).toBeUndefined()
  })
})

describe('screenIssues', () => {
  it('Issue を読まずに決まらなければ、undefined を返す', () => {
    expect(screenIssues({ repository: REPOSITORY, number: 7, sender: 'alice', permission: 'write', isPullRequest: false, state: 'open' })).toBeUndefined()
  })

  it('PR に付いたラベルの目印のブランチは - にする', () => {
    expect(screenIssues({ repository: REPOSITORY, number: 7, sender: 'alice', permission: 'write', isPullRequest: true, state: 'open' })?.write?.branch).toBe('-')
  })
})

describe('decideGate の workflow_run', () => {
  it('CI が落ち、直した回数が上限より少ないと、kind が ci-fix で proceed が真になり、何も書かない', () => {
    const decision = decideGate(run({ comments: [result('pr-created'), result('ci-fix-pushed'), result('ci-fix-pushed')] }))

    expect(decision).toEqual({
      run: { issue: 'acme/demo/7', number: 7, kind: 'ci-fix', proceed: true, reason: '', branch: BRANCH, pr: 11, ciAttempts: 2 },
      write: undefined,
    })
  })

  it('conclusion が timed_out でも、ci-fix にする', () => {
    expect(decideGate(run({ conclusion: 'timed_out' })).run).toMatchObject({ kind: 'ci-fix', proceed: true })
  })

  it('CI が落ち、直した回数が上限に達すると、kind が ci-fix で proceed が偽になり、limit の結果を書く', () => {
    const decision = decideGate(run({ maxCiAttempts: 2, comments: [result('pr-created'), result('ci-fix-pushed'), result('ci-fix-pushed')] }))

    expect(decision.run).toMatchObject({ kind: 'ci-fix', proceed: false, reason: 'the CI fixes reached the limit (2 of 2)', ciAttempts: 2 })
    expect(decision.write).toMatchObject({ result: 'limit', branch: BRANCH })
  })

  it('CI が通ると、kind が ci-passed で proceed が偽になり、ci-passed の結果を書く', () => {
    const decision = decideGate(run({ conclusion: 'success' }))

    expect(decision.run).toMatchObject({ kind: 'ci-passed', proceed: false, reason: 'the CI passed' })
    expect(decision.write).toMatchObject({ result: 'ci-passed', branch: BRANCH })
  })

  it.for([
    { name: '目印が無い', comments: [] },
    { name: '別のブランチの pr-created しか無い', comments: [result('pr-created', 'feat/other/7')] },
    { name: '人が書いた pr-created しか無い', comments: [result('pr-created', BRANCH, undefined, 'User')] },
  ])('Issue に同じブランチの pr-created の目印が無いと（$name）、proceed が偽で、何も書かない', ({ comments }) => {
    const decision = decideGate(run({ comments }))

    expect(decision.run).toMatchObject({ kind: '', proceed: false, reason: `no PR was created by the automation on ${BRANCH}` })
    expect(decision.write).toBeUndefined()
  })

  it('CI を直した回数は、同じブランチの最後の limit の後の ci-fix-pushed だけを数える', () => {
    const comments = [result('pr-created'), result('ci-fix-pushed'), result('ci-fix-pushed'), result('limit'), result('ci-fix-pushed')]

    expect(decideGate(run({ maxCiAttempts: 2, comments })).run).toMatchObject({ kind: 'ci-fix', proceed: true, ciAttempts: 1 })
  })

  it('CI を直した回数に、別のブランチの目印と、人が書いた目印を数えない', () => {
    const comments = [result('pr-created'), result('ci-fix-pushed', 'feat/other/7'), result('ci-fix-pushed', BRANCH, undefined, 'User')]

    expect(decideGate(run({ maxCiAttempts: 1, comments })).run).toMatchObject({ proceed: true, ciAttempts: 0 })
  })

  it.for([
    { name: '先頭と違う', branchSha: 'sha-new' },
    { name: '読めない', branchSha: undefined },
  ])('head_sha がブランチの先頭と$name と、proceed が偽で、何も書かない', ({ branchSha }) => {
    const decision = decideGate(run({ branchSha }))

    expect(decision.run).toMatchObject({ proceed: false, reason: `the run is not for the head of ${BRANCH}` })
    expect(decision.write).toBeUndefined()
  })

  it('最後の結果が ci-passed でも、head の commit がその前なら、同じ push の別の CI として判定する', () => {
    const comments = [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z')]

    expect(decideGate(run({ comments, headCommitTime: '2026-11-24T09:00:00Z' })).run).toMatchObject({ kind: 'ci-fix', proceed: true })
  })

  it('最後の結果が ci-passed で、head の commit がその時刻と同じなら、判定する', () => {
    const comments = [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z')]

    expect(decideGate(run({ comments, headCommitTime: '2026-11-24T10:00:00Z' })).run.proceed).toBe(true)
  })

  it.for([
    { name: 'その後', time: '2026-11-24T11:00:00Z' },
    { name: '分からない', time: undefined },
    { name: '時刻として読めない', time: 'yesterday' },
  ])('最後の結果が ci-passed で、head の commit の時刻が$name なら、人の push として、何も書かない', ({ time }) => {
    const comments = [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z')]
    const decision = decideGate(run({ comments, headCommitTime: time }))

    expect(decision.run).toMatchObject({ proceed: false, reason: `${BRANCH} was pushed after the CI passed` })
    expect(decision.write).toBeUndefined()
  })

  it('ci-passed の後に自動処理が直して push していれば、時刻を比べずに判定する', () => {
    const comments = [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z'), result('ci-fix-pushed', BRANCH, '2026-11-24T12:00:00Z')]

    expect(decideGate(run({ comments, headCommitTime: '2026-11-24T11:30:00Z' })).run).toMatchObject({ kind: 'ci-fix', proceed: true, ciAttempts: 1 })
  })
})

describe('screenWorkflowRun', () => {
  it.for(['cancelled', 'skipped', 'neutral', 'action_required', 'stale'])('conclusion が %s なら、proceed が偽で、何も書かない', (conclusion) => {
    const decision = screenWorkflowRun(run({ conclusion }))

    expect(decision?.run).toMatchObject({ issue: 'acme/demo/7', kind: '', proceed: false, reason: `the CI conclusion is ${conclusion}` })
    expect(decision?.write).toBeUndefined()
  })

  it('action が completed でなければ、proceed が偽で、何も書かない', () => {
    const decision = screenWorkflowRun(run({ action: 'requested' }))

    expect(decision?.run).toMatchObject({ proceed: false, reason: 'the workflow run is not completed (requested)' })
    expect(decision?.write).toBeUndefined()
  })

  it.for(['main', 'feat/fix-x', 'feat/fix-x/0'])('ブランチ %s の末尾が Issue の番号でなければ、Issue を決めず、何も書かない', (headBranch) => {
    const decision = screenWorkflowRun(run({ headBranch }))

    expect(decision?.run).toMatchObject({ issue: '', number: 0, proceed: false, reason: `the branch ${headBranch} does not end with an Issue number` })
    expect(decision?.write).toBeUndefined()
  })

  it('fork の PR の CI なら、proceed が偽で、何も書かない', () => {
    const decision = screenWorkflowRun(run({ isFork: true }))

    expect(decision?.run).toMatchObject({ proceed: false, reason: 'the run is from a fork' })
    expect(decision?.write).toBeUndefined()
  })

  it('Issue のコメントを読まずに決まらなければ、undefined を返す', () => {
    expect(screenWorkflowRun(run())).toBeUndefined()
  })
})
