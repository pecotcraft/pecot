// auto gate の判定を確かめる。表は specs/023-label-triggered-autofix/data-model.md の「自動処理の実行」「対象外の条件」と、CI を直した回数の数え方。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

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

function openPullRequest(): IssuePullRequest {
  return { repository: REPOSITORY, number: 11, state: 'open', headRefName: BRANCH, baseRefName: 'main', isDraft: false, isCrossRepository: false }
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
    actorType: 'Bot',
    createdAt: '2026-11-24T09:00:00Z',
    isFork: false,
    pullRequest: 11,
    comments: [result('pr-created')],
    branchSha: HEAD,
    hasFailedRun: false,
    maxCiAttempts: 3,
    ...values,
  }
}

describe('decideGate の issues', () => {
  it('計画のコメントとブランチが存在しない Ready の Issue は、kind を start にして処理を進め、何も書き込まない', async () => {
    await explains('自動処理を進めるか判定する関数（`decideGate`）の、ラベルを付けた Issue に対するテストです。計画のコメントとブランチが存在しない `Ready` の Issue の場合に、`kind` は `start` となり、`proceed` は `true` となって、結果のコメントは書き込まないことを確認します。')
    stepSync('`decideGate` を呼び、結果を比べる', () => {
      expect(decideGate(issues())).toEqual({
        run: { issue: 'acme/demo/7', number: 7, kind: 'start', proceed: true, reason: '', branch: '', pr: 0, ciAttempts: 0 },
        write: undefined,
      })
    })
  })

  it.for([
    { name: '計画のコメントがある場合は', values: { hasPlan: true } },
    { name: 'ブランチがある場合は', values: { branches: [BRANCH] } },
    { name: '開いた PR だけがある場合は', values: { pullRequests: [openPullRequest()] } },
  ])('$name、kind を resume にして処理を進める', async ({ name, values }) => {
    await explains(`Issue に対する自動処理の判定のテストです。${name}、\`kind\` が \`resume\` で \`proceed\` が \`true\` になり、結果のコメントは書き込まないことを確認します。`)
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(issues({}, values)))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ kind: 'resume', proceed: true })
      expect(decision.write).toBeUndefined()
    })
  })

  it('開いた PR を持つブランチを branch と pr として返し、そのブランチで CI を直した回数も返す', async () => {
    await explains('ブランチが複数あり、そのうち 1 つに開いた PR がある場合のテストです。開いた PR を持つブランチの名前と PR の番号を返し、そのブランチで CI を直した回数（`ciAttempts`）を数えることを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(issues({}, { branches: ['other/3', BRANCH], pullRequests: [openPullRequest()], comments: [result('ci-fix-pushed')] })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ branch: BRANCH, pr: 11, ciAttempts: 1 })
    })
  })

  it('ボードに追加されていない Issue は、kind を start にして処理を進める', async () => {
    await explains('ボードに追加されていない Issue のテストです。進行の欄が存在しなくても、`kind` が `start`、`proceed` が `true` になることを確認します。')
    stepSync('`decideGate` を呼び、結果を比べる', () => {
      expect(decideGate(issues({}, { column: undefined })).run).toMatchObject({ kind: 'start', proceed: true })
    })
  })

  it.for(['Active', 'In Review'])('進行の欄が %s で、自動処理の結果のコメントがある場合は、起動し直しとして処理を進める', async (column) => {
    await explains('進行の欄が `Active` か `In Review` で、自動処理の結果のコメントが存在する Issue のテストです。人が作業中ではなく起動し直しとみなし、`kind` が `resume`、`proceed` が `true` になることを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(issues({}, { column, branches: [BRANCH], comments: [result('question')] })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ kind: 'resume', proceed: true })
    })
  })

  it.for([
    { name: 'read', permission: 'read' },
    { name: 'none', permission: 'none' },
    { name: '取得できない', permission: undefined },
  ])('ラベルを付けた人の権限が $name の場合は、処理を進めず何も書き込まない', async ({ name, permission }) => {
    await explains(`ラベルを付けた人の権限に関するテストです。権限が ${name} の場合は、\`proceed\` が \`false\` になり、結果のコメントは書き込まないことを確認します。`)
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(issues({ permission })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ kind: '', proceed: false })
      expect(decision.write).toBeUndefined()
    })
  })

  it.for(['admin', 'write'])('ラベルを付けた人の権限が %s の場合は、処理を進める', async (permission) => {
    await explains('ラベルを付けた人の権限が書き込み以上の場合のテストです。`proceed` が `true` になることを確認します。')
    stepSync('`decideGate` を呼び、結果を比べる', () => {
      expect(decideGate(issues({ permission })).run.proceed).toBe(true)
    })
  })

  it('ラベルを付けた人が [bot] の場合は、権限が write でも処理を進めず、何も書き込まない', async () => {
    await explains('ラベルを付けた人が bot の場合のテストです。権限が `write` でも、`proceed` が `false` になり、理由に `the sender is a bot` を示し、結果のコメントは書き込まないことを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(issues({ sender: 'renovate[bot]' })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ proceed: false, reason: 'the sender is a bot' })
      expect(decision.write).toBeUndefined()
    })
  })

  it.for([
    { name: 'Issue が closed の場合は', input: issues({ state: 'closed' }), reason: 'the Issue is closed', next: 'reopen' },
    { name: 'ラベルが PR に付いた場合は', input: issues({ isPullRequest: true }), reason: 'the label is on a PR', next: 'issue-only' },
    { name: 'Issue Type が Epic の場合は', input: issues({}, { kind: 'epic' }), reason: 'the Issue is an Epic', next: 'subtask' },
    { name: 'タイトルが [Epic] で始まる場合は', input: issues({}, { title: '[Epic] 大きな話' }), reason: 'the Issue is an Epic', next: 'subtask' },
    { name: 'Issue Type が Tracker の場合は', input: issues({}, { kind: 'tracker' }), reason: 'the Issue is a Tracker', next: 'tracker' },
    { name: 'タイトルが [Tracker] で始まる場合は', input: issues({}, { title: '[Tracker] 改名の一覧' }), reason: 'the Issue is a Tracker', next: 'tracker' },
    { name: 'sub-issue を持つ場合は', input: issues({}, { subIssues: 2 }), reason: 'the Issue has sub-issues', next: 'subtask' },
    { name: '進行の欄が Backlog の場合は', input: issues({}, { column: 'Backlog' }), reason: 'the Issue is in Backlog', next: 'ready' },
    { name: '進行の欄が Pending の場合は', input: issues({}, { column: 'Pending' }), reason: 'the Issue is in Pending', next: 'ready' },
    { name: '進行の欄が Archived の場合は', input: issues({}, { column: 'Archived' }), reason: 'the Issue is in Archived', next: 'ready' },
    { name: '進行の欄が Active で結果のコメントが存在しない場合は', input: issues({}, { column: 'Active', comments: [result('question', BRANCH, undefined, 'User')] }), reason: 'a person is working on the Issue (Active)', next: 'hand-over' },
    { name: '進行の欄が In Review で結果のコメントが存在しない場合は', input: issues({}, { column: 'In Review' }), reason: 'a person is working on the Issue (In Review)', next: 'hand-over' },
  ])('$name、処理を進めず、対象外（out-of-scope）の結果を書き込む', async ({ name, input, reason, next }) => {
    await explains(`自動処理の対象外になる Issue のテストです。${name}、理由（\`${reason}\`）を示して \`proceed\` を \`false\` にし、次の案内に \`${next}\` を持つ \`out-of-scope\` の結果を書き込むことを確認します。`)
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(input))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ kind: '', proceed: false, reason })
      expect(decision.write).toMatchObject({ result: 'out-of-scope', next })
    })
  })

  it('進行の欄が Blocked の場合は、待っている前提を理由に含めて、out-of-scope の結果を書き込む', async () => {
    await explains('進行の欄が `Blocked` の Issue のテストです。待っている前提を理由の文と結果のコメントの本文に含め、次の案内を `prerequisites` にした `out-of-scope` の結果を書き込むことを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(issues({}, { column: 'Blocked', blockedText: 'blocked by #3 (not in review: #3 (not started))' })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ proceed: false, reason: 'the Issue is blocked: blocked by #3 (not in review: #3 (not started))' })
      expect(decision.write?.text).toContain('`blocked by #3 (not in review: #3 (not started))`')
      expect(decision.write?.next).toBe('prerequisites')
    })
  })

  it('進行の欄が Backlog の場合は、結果のコメントの本文に現在の進行の欄の値を含める', async () => {
    await explains('進行の欄が `Backlog` の Issue のテストです。結果のコメントの本文に、現在の進行の欄の値（`Backlog`）が含まれることを確認します。')
    stepSync('`decideGate` を呼び、結果を比べる', () => {
      expect(decideGate(issues({}, { column: 'Backlog' })).write?.text).toContain('`Backlog`')
    })
  })

  it('対象外の結果の目印に使うブランチは、Issue の Development に登録されたブランチから決める', async () => {
    await explains('進行の欄が `Backlog` で、Development にブランチが登録された Issue のテストです。対象外の結果の目印に含めるブランチが、登録されたブランチになることを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(issues({}, { column: 'Backlog', branches: [BRANCH] })))

    stepSync('結果を比べる', () => {
      expect(decision.write?.branch).toBe(BRANCH)
    })
  })

  it('権限は closed の状態より先に確認し、権限を持たない人が closed の Issue に付けた場合は何も書き込まない', async () => {
    await explains('権限を持たない人が、closed の Issue にラベルを付けた場合のテストです。権限の確認を先に行うため、結果のコメントは書き込まないことを確認します。')
    stepSync('`decideGate` を呼び、結果を比べる', () => {
      expect(decideGate(issues({ permission: 'read', state: 'closed' })).write).toBeUndefined()
    })
  })
})

describe('screenIssues', () => {
  it('Issue の内容を取得しなければ判定できない場合は、undefined を返す', async () => {
    await explains('Issue の事前の判定（`screenIssues`）のテストです。送信者の権限や状態だけでは判定できない場合に、`undefined` を返すことを確認します。')
    stepSync('`screenIssues` を呼び、結果を比べる', () => {
      expect(screenIssues({ repository: REPOSITORY, number: 7, sender: 'alice', permission: 'write', isPullRequest: false, state: 'open' })).toBeUndefined()
    })
  })

  it('PR に付いたラベルの結果の目印には、ブランチとして - を使う', async () => {
    await explains('ラベルが PR に付いた場合の、事前の判定（`screenIssues`）のテストです。書き込む結果の目印のブランチが `-` になることを確認します。')
    stepSync('`screenIssues` を呼び、結果を比べる', () => {
      expect(screenIssues({ repository: REPOSITORY, number: 7, sender: 'alice', permission: 'write', isPullRequest: true, state: 'open' })?.write?.branch).toBe('-')
    })
  })
})

describe('decideGate の workflow_run', () => {
  it('CI が失敗し、直した回数が上限より少ない場合は、kind を ci-fix にして処理を進め、何も書き込まない', async () => {
    await explains('CI の結果を判定する関数（`decideGate`）の、ワークフローの実行に対するテストです。上限より少ない回数だけ直した後に CI が失敗した場合は、`kind` を `ci-fix`、`proceed` を `true` とし、結果のコメントは書き込まないことを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(run({ comments: [result('pr-created'), result('ci-fix-pushed'), result('ci-fix-pushed')] })))

    stepSync('結果を比べる', () => {
      expect(decision).toEqual({
        run: { issue: 'acme/demo/7', number: 7, kind: 'ci-fix', proceed: true, reason: '', branch: BRANCH, pr: 11, ciAttempts: 2 },
        write: undefined,
      })
    })
  })

  it('conclusion が timed_out の場合も、kind を ci-fix にして処理を進める', async () => {
    await explains('CI の `conclusion` が `timed_out` の場合のテストです。失敗と同じように、`kind` が `ci-fix`、`proceed` が `true` になることを確認します。')
    stepSync('`decideGate` を呼び、結果を比べる', () => {
      expect(decideGate(run({ conclusion: 'timed_out' })).run).toMatchObject({ kind: 'ci-fix', proceed: true })
    })
  })

  it('CI が失敗し、直した回数が上限に達した場合は、処理を進めず、limit の結果を書き込む', async () => {
    await explains('CI が失敗し、直した回数が上限（2 回）に達した場合のテストです。`kind` は `ci-fix` のまま `proceed` が `false` になり、上限に達した理由を示した `limit` の結果を書き込むことを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(run({ maxCiAttempts: 2, comments: [result('pr-created'), result('ci-fix-pushed'), result('ci-fix-pushed')] })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ kind: 'ci-fix', proceed: false, reason: 'the CI fixes reached the limit (2 of 2)', ciAttempts: 2 })
      expect(decision.write).toMatchObject({ result: 'limit', branch: BRANCH })
    })
  })

  it('CI が成功した場合は、処理を進めず、ci-passed の結果を書き込む', async () => {
    await explains('CI が成功した場合のテストです。`kind` が `ci-passed`、`proceed` が `false` になり、`ci-passed` の結果を書き込むことを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(run({ conclusion: 'success' })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ kind: 'ci-passed', proceed: false, reason: 'the CI passed' })
      expect(decision.write).toMatchObject({ result: 'ci-passed', branch: BRANCH })
    })
  })

  it.for([
    { name: '目印が存在しない', comments: [] },
    { name: '別のブランチの pr-created しか存在しない', comments: [result('pr-created', 'feat/other/7')] },
    { name: '人が書いた pr-created しか存在しない', comments: [result('pr-created', BRANCH, undefined, 'User')] },
  ])('同じブランチの pr-created の目印が存在しない場合（$name）は、処理を進めず何も書き込まない', async ({ name, comments }) => {
    await explains(`CI の失敗を、自動処理の PR に結び付けるテストです。Issue に同じブランチの \`pr-created\` の目印が存在しない場合（${name}）に、理由を示して \`proceed\` を \`false\` にし、結果のコメントは書き込まないことを確認します。`)
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(run({ comments })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ kind: '', proceed: false, reason: `no PR was created by the automation on ${BRANCH}` })
      expect(decision.write).toBeUndefined()
    })
  })

  it('CI を直した回数は、同じブランチで最後の limit より後の ci-fix-pushed だけを数える', async () => {
    await explains('`limit` の結果の後に、`ci-fix-pushed` の結果がある場合のテストです。最後の `limit` より後の分だけを直した回数（1）として数え、処理を進めることを確認します。')
    const comments = stepSync('入力を用意する', () => [result('pr-created'), result('ci-fix-pushed'), result('ci-fix-pushed'), result('limit'), result('ci-fix-pushed')])

    stepSync('結果を比べる', () => {
      expect(decideGate(run({ maxCiAttempts: 2, comments })).run).toMatchObject({ kind: 'ci-fix', proceed: true, ciAttempts: 1 })
    })
  })

  it('CI を直した回数には、別のブランチの目印と、人が書いた目印を含めない', async () => {
    await explains('別のブランチの `ci-fix-pushed` と、人の書いた `ci-fix-pushed` がある場合のテストです。どちらも直した回数には数えず、0 回として処理を進めることを確認します。')
    const comments = stepSync('入力を用意する', () => [result('pr-created'), result('ci-fix-pushed', 'feat/other/7'), result('ci-fix-pushed', BRANCH, undefined, 'User')])

    stepSync('結果を比べる', () => {
      expect(decideGate(run({ maxCiAttempts: 1, comments })).run).toMatchObject({ proceed: true, ciAttempts: 0 })
    })
  })

  it.for([
    { name: 'head_sha がブランチの先頭と違う場合は', branchSha: 'sha-new' },
    { name: 'ブランチの先頭を取得できない場合は', branchSha: undefined },
  ])('$name、処理を進めず何も書き込まない', async ({ name, branchSha }) => {
    await explains(`CI の実行がブランチの最新のコミットのものか確認するテストです。${name}、ブランチの最新の実行ではないことを理由に示して \`proceed\` を \`false\` にし、結果のコメントは書き込まないことを確認します。`)
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(run({ branchSha })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ proceed: false, reason: `the run is not for the head of ${BRANCH}` })
      expect(decision.write).toBeUndefined()
    })
  })

  it('最後の結果が ci-passed でも、自動処理が push した CI が失敗した場合は、新たな CI の失敗として判定する', async () => {
    await explains('最後の結果が `ci-passed` で、その後に自動処理が push した CI が失敗した場合のテストです。以前の成功とは別の CI の失敗として、`kind` が `ci-fix`、`proceed` が `true` になることを確認します。')
    const comments = stepSync('入力を用意する', () => [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z')])

    stepSync('結果を比べる', () => {
      expect(decideGate(run({ comments })).run).toMatchObject({ kind: 'ci-fix', proceed: true })
    })
  })

  it.for([
    { name: 'push した人が人（User）の場合は', actorType: 'User' },
    { name: 'push した人を判別できない場合は', actorType: undefined },
  ])('最後の結果が ci-passed で、$name、commit の時刻にかかわらず何も書き込まない', async ({ name, actorType }) => {
    await explains(`最後の結果が \`ci-passed\` の後に、CI が失敗した場合のテストです。${name}、人が push した後の CI として、\`proceed\` が \`false\` になり、結果のコメントは書き込まないことを確認します。`)
    const { decision } = stepSync('`decideGate` を呼ぶ', () => {
      const comments = [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z')]
      const decision = decideGate(run({ comments, actorType, createdAt: '2026-11-24T11:00:00Z' }))
      return { decision }
    })

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ proceed: false, reason: `${BRANCH} was pushed by a person after the CI passed` })
      expect(decision.write).toBeUndefined()
    })
  })

  it.for([
    { name: '通った run の作成時刻が ci-passed より前の場合は', createdAt: '2026-11-24T09:00:00Z' },
    { name: '通った run の作成時刻を取得できない場合は', createdAt: undefined },
  ])('最後の結果が ci-passed で、$name、ci-passed を重ねて書き込まない', async ({ name, createdAt }) => {
    await explains(`最後の結果が \`ci-passed\` の後に、CI が成功した場合のテストです。${name}、同じ push の CI として扱い、\`proceed\` が \`false\` になり、結果のコメントは書き込まないことを確認します。`)
    const { decision } = stepSync('`decideGate` を呼ぶ', () => {
      const comments = [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z')]
      const decision = decideGate(run({ conclusion: 'success', comments, createdAt }))
      return { decision }
    })

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ proceed: false, reason: `the CI already passed for this push of ${BRANCH}` })
      expect(decision.write).toBeUndefined()
    })
  })

  it('最後の結果が ci-passed でも、その後に自動処理が push した CI が成功した場合は、ci-passed を書き込む', async () => {
    await explains('最後の結果が `ci-passed` で、その後に自動処理が push した CI が成功した場合のテストです。新たな push の CI として、`ci-passed` の結果を書き込むことを確認します。')
    const comments = stepSync('入力を用意する', () => [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z')])

    stepSync('結果を比べる', () => {
      expect(decideGate(run({ conclusion: 'success', comments, createdAt: '2026-11-24T11:00:00Z' })).write).toMatchObject({ result: 'ci-passed' })
    })
  })

  it('CI が成功しても、同じ head_sha のほかの run が失敗している場合は、ci-passed を書き込まない', async () => {
    await explains('CI が成功し、同じ `head_sha` のほかの run が失敗している場合のテストです。`proceed` が `false` になり、ほかの run の失敗を理由に示し、結果のコメントは書き込まないことを確認します。')
    const decision = stepSync('`decideGate` を呼ぶ', () => decideGate(run({ conclusion: 'success', hasFailedRun: true })))

    stepSync('結果を比べる', () => {
      expect(decision.run).toMatchObject({ proceed: false, reason: `another CI run of ${HEAD} failed` })
      expect(decision.write).toBeUndefined()
    })
  })

  it('ci-passed の後に自動処理が直して push した場合は、その CI の失敗を判定する', async () => {
    await explains('`ci-passed` の後に、自動処理が `ci-fix-pushed` で修正を push した場合のテストです。人が push した場合の除外の対象にならず、`kind` が `ci-fix`、直した回数が 1 になることを確認します。')
    const comments = stepSync('入力を用意する', () => [result('pr-created'), result('ci-passed', BRANCH, '2026-11-24T10:00:00Z'), result('ci-fix-pushed', BRANCH, '2026-11-24T12:00:00Z')])

    stepSync('結果を比べる', () => {
      expect(decideGate(run({ comments, actorType: 'User' })).run).toMatchObject({ kind: 'ci-fix', proceed: true, ciAttempts: 1 })
    })
  })
})

describe('screenWorkflowRun', () => {
  it.for(['cancelled', 'skipped', 'neutral', 'action_required', 'stale'])('conclusion が %s の場合は、処理を進めず何も書き込まない', async (conclusion) => {
    await explains('CI の事前の判定（`screenWorkflowRun`）のテストです。`conclusion` が成功と失敗のどちらでもない値の場合に、理由を示して `proceed` を `false` とし、結果のコメントは書き込まないことを確認します。')
    const decision = stepSync('`screenWorkflowRun` を呼ぶ', () => screenWorkflowRun(run({ conclusion })))

    stepSync('結果を比べる', () => {
      expect(decision?.run).toMatchObject({ issue: 'acme/demo/7', kind: '', proceed: false, reason: `the CI conclusion is ${conclusion}` })
      expect(decision?.write).toBeUndefined()
    })
  })

  it('action が completed ではない場合は、処理を進めず何も書き込まない', async () => {
    await explains('ワークフローの実行がまだ完了していない場合のテストです。`action` が `requested` のとき、`proceed` が `false` になり、完了していないことを理由に示して、結果のコメントは書き込まないことを確認します。')
    const decision = stepSync('`screenWorkflowRun` を呼ぶ', () => screenWorkflowRun(run({ action: 'requested' })))

    stepSync('結果を比べる', () => {
      expect(decision?.run).toMatchObject({ proceed: false, reason: 'the workflow run is not completed (requested)' })
      expect(decision?.write).toBeUndefined()
    })
  })

  it.for(['main', 'feat/fix-x', 'feat/fix-x/0'])('ブランチ %s の末尾が Issue の番号ではない場合は、Issue を決めず、何も書き込まない', async (headBranch) => {
    await explains('ブランチ名の末尾が Issue の番号ではない場合のテストです。Issue を決められないため、Issue の指定を空にして `proceed` を `false` にし、結果のコメントは書き込まないことを確認します。')
    const decision = stepSync('`screenWorkflowRun` を呼ぶ', () => screenWorkflowRun(run({ headBranch })))

    stepSync('結果を比べる', () => {
      expect(decision?.run).toMatchObject({ issue: '', number: 0, proceed: false, reason: `the branch ${headBranch} does not end with an Issue number` })
      expect(decision?.write).toBeUndefined()
    })
  })

  it('fork の PR の CI の場合は、処理を進めず何も書き込まない', async () => {
    await explains('fork からの PR の CI のテストです。`proceed` が `false` になり、fork からの実行であることを理由に示して、結果のコメントは書き込まないことを確認します。')
    const decision = stepSync('`screenWorkflowRun` を呼ぶ', () => screenWorkflowRun(run({ isFork: true })))

    stepSync('結果を比べる', () => {
      expect(decision?.run).toMatchObject({ proceed: false, reason: 'the run is from a fork' })
      expect(decision?.write).toBeUndefined()
    })
  })

  it('Issue のコメントを取得しなければ判定できない場合は、undefined を返す', async () => {
    await explains('CI の事前の判定（`screenWorkflowRun`）のテストです。成功か失敗かを判定する条件がそろい、Issue のコメントを取得しなければ決まらない場合に、`undefined` を返すことを確認します。')
    stepSync('`screenWorkflowRun` を呼び、結果を比べる', () => {
      expect(screenWorkflowRun(run())).toBeUndefined()
    })
  })
})
