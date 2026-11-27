/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// マージの後の GitHub 側の片付け。GitHub は偽サーバにする。
import { describe, expect, it, vi } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { capture } from '../../../tests/_helpers/captured-io.js'
import type { CapturedIo } from '../../../tests/_helpers/captured-io.js'
import { setEnvironment } from '../../../tests/_helpers/environment.js'
import { prerequisitesRule } from '../../../tests/_helpers/prerequisites.js'
import type { IssueSpec } from '../../../tests/_helpers/prerequisites.js'
import type { ResponseRule } from '../../../tests/_helpers/fake-github/server.js'
import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import { createRepositoryReference } from '../../domain/repository-resolver.js'
import type { PullRequestForFinish } from '../../infra/github/pulls.js'
import { graphqlRequests, rejection, restRequests, startClient, startServer, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { CommandExit } from '../command-definition.js'
import { createOutput } from '../output.js'
import type { Output } from '../output.js'
import { collectClosingIssueNumbers, finishOnGithub, requireMergedPullRequest } from '../session-finish-remote.js'
import type { RemoteFinishRecord } from '../session-finish-remote.js'
// 案内のコマンドの形を登録する
import '../../../tests/_helpers/hint-commands.js'

// 偽の時計は HTTP の待ちも進めてしまうので、読み直しの前の待ちだけを即座に終える
const { delay } = vi.hoisted(() => ({ delay: vi.fn(async (): Promise<void> => {
  await Promise.resolve()
}) }))
vi.mock('node:timers/promises', () => ({ setTimeout: delay }))

useFakeGithub()

const HOME = createRepositoryReference('acme', 'demo')
const BRANCH = 'feat/demo/12'
const LOCATION = { ...HOME, number: 21 }
const BOOM = { status: 500, body: { message: 'Server Error' } }
// PR #21 がマージされ、閉じた #12
const DONE_12: IssueSpec = { number: 12, state: 'CLOSED', branch: BRANCH, pullRequests: [{ number: 21, head: BRANCH, state: 'MERGED' }] }

function config(): ProjectConfig {
  return parseProjectConfig({
    host: 'github.com',
    owner: 'acme',
    project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: { ready: 'o3', blocked: 'ob', active: 'o4' } } } },
    repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'main' }],
  })
}

const graphql = (operation: string, data: unknown, variables?: Readonly<Record<string, unknown>>): ResponseRule => ({ match: { operation, ...variables !== undefined && { variables } }, respond: { status: 200, body: { data } }, times: 1 })
const rest = (method: string, path: string, status: number, body: unknown): ResponseRule => ({ match: { method, path }, respond: { status, body }, times: 1 })

function pullRequest(sample: Partial<PullRequestForFinish> = {}): PullRequestForFinish {
  return { state: 'MERGED', body: '', head_ref: BRANCH, base_ref: 'main', is_draft: false, closing_issues: [], default_branch: 'main', ...sample }
}

function pullRequestData(state = 'MERGED'): unknown {
  return { repository: { pullRequest: { number: 21, state, body: '', headRefName: BRANCH, baseRefName: 'main', isDraft: false, closingIssuesReferences: { nodes: [] }, baseRepository: { defaultBranchRef: { name: 'main' } } } } }
}

function kindRule(number: number, options: Readonly<{ subIssues?: number, issueType?: string, state?: string }> = {}): ResponseRule {
  const issueType = options.issueType === undefined ? null : { name: options.issueType }
  return graphql('GetIssueKind', { repository: { issue: { number, state: options.state ?? 'OPEN', issueType, subIssues: { totalCount: options.subIssues ?? 0 } } } }, { number })
}

const closeRule = (number: number, status = 200, body?: unknown): ResponseRule => rest('PATCH', `/repos/acme/demo/issues/${String(number)}`, status, body ?? { number, state: 'closed' })

function blockingRule(waiting: readonly number[], number = 12): ResponseRule {
  const nodes = waiting.map(other => ({ id: `I_demo_${String(other)}`, number: other, state: 'OPEN', repository: { owner: { login: 'acme' }, name: 'demo' } }))
  return graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: nodes.length, nodes } } } }, { number })
}

function boardItemRule(number: number): ResponseRule {
  const projectItems = { nodes: [{ id: `PVTI_${String(number)}`, project: { id: 'PVT_1' }, fieldValues: { nodes: [{ field: { id: 'PVTSSF_workflow', name: 'pecot-status' }, name: 'Blocked' }] } }] }
  const issue = { number, title: `課題${String(number)}`, state: 'OPEN', url: `https://github.com/acme/demo/issues/${String(number)}`, repository: { owner: { login: 'acme' }, name: 'demo' }, projectItems }
  return graphql('GetIssueBoardItem', { repository: { issue } }, { number })
}

const readyWrite = (number: number): ResponseRule => graphql('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: `PVTI_${String(number)}` } } }, { itemId: `PVTI_${String(number)}`, optionId: 'o3' })

interface Finished {
  readonly io: CapturedIo
  readonly record: RemoteFinishRecord
  readonly closing: readonly number[]
  readonly server: Awaited<ReturnType<typeof startClient>>['server']
}

function emptyRecord(): RemoteFinishRecord {
  return { closedIssues: [], skippedIssues: [], readinessChanges: [], restack: [] }
}

async function finish(rules: readonly ResponseRule[], sample: Partial<PullRequestForFinish> = {}, isDryRun = false): Promise<Finished> {
  const { client, server } = await startClient(rules)
  const io = capture()
  const out = createOutput(isDryRun, io)
  const record = emptyRecord()
  const closing = await finishOnGithub({ out, isDryRun, record }, config(), { client, pr: pullRequest(sample), location: HOME, number: 21 })
  return { io, record, closing: [...closing].toSorted((a, b) => a - b), server }
}

function captured(): { readonly io: CapturedIo, readonly out: Output } {
  const io = capture()
  return { io, out: createOutput(false, io) }
}

describe('requireMergedPullRequest', () => {
  it('マージ済みの PR を読むと、PR と場所を返す', async () => {
    await explains('マージ済みの PR を読み取る `requireMergedPullRequest` のテストです。マージ済みの PR の場合に、PR の内容とリポジトリの場所、PR の番号を返すことを確認します。')
    await startServer([graphql('GetPullRequestForFinish', pullRequestData())])
    setEnvironment({ PECOT_GITHUB_COM_TOKEN: 'test_token' })
    const merged = await requireMergedPullRequest(captured().out, config(), LOCATION)
    expect({ pr: merged.pr, location: merged.location, number: merged.number }).toEqual({ pr: pullRequest(), location: HOME, number: 21 })
  })

  it.for([
    { name: 'マージされていない', rule: graphql('GetPullRequestForFinish', pullRequestData('OPEN')), expected: /^error: PR #21 is not merged yet \(state: OPEN\); merge it on GitHub first\n$/u, kind: 'pr-state' },
    { name: 'PR が無い', rule: graphql('GetPullRequestForFinish', { repository: { pullRequest: null } }), expected: /^error: PR not found: acme\/demo\/21\n$/u, kind: 'github-not-found' },
    { name: 'PR を読めない', rule: { match: { operation: 'GetPullRequestForFinish' }, respond: BOOM, times: 1 }, expected: /^error: GraphQL query error: /u, kind: 'github-api' },
  ])('PR が次のとき（$name）、error の行を出して止める', async (row) => {
    await explains(`マージ済みの PR を読み取る \`requireMergedPullRequest\` のテストです。PR が使えない場合（\`${row.name}\`）に、\`error\` の行を出力して止めることを確認します。`)
    await startServer([row.rule])
    setEnvironment({ PECOT_GITHUB_COM_TOKEN: 'test_token' })
    const { io, out } = captured()
    const error = await rejection(requireMergedPullRequest(out, config(), LOCATION))
    expect(error).toBeInstanceOf(CommandExit)
    expect(error).toMatchObject({ exitCode: 1, kind: row.kind })
    expect(io.err.join('')).toMatch(row.expected)
  })
})

describe('collectClosingIssueNumbers', () => {
  it.for([
    { name: '既定ブランチ宛て', sample: { base_ref: 'main' }, expected: [10, 12] },
    { name: '既定ブランチでない base', sample: { base_ref: 'develop' }, expected: [10, 11, 12] },
    { name: '既定ブランチが無い', sample: { default_branch: undefined }, expected: [10, 11, 12] },
    { name: 'head の末尾が番号でない', sample: { head_ref: 'feat/demo/x' }, expected: [10] },
  ])('PR が次のとき（$name）、閉じる Issue の番号を集める', async (row) => {
    await explains(`閉じる Issue の番号を集める \`collectClosingIssueNumbers\` のテストです。PR の宛先とブランチ名の場合（\`${row.name}\`）に、閉じる対象の Issue の番号を返すことを確認します。`)
    const sample: Partial<PullRequestForFinish> = { body: 'Closes #11\n', closing_issues: [{ owner: 'acme', repository: 'demo', number: 10 }, { owner: 'acme', repository: 'other', number: 13 }], ...row.sample }
    expect([...collectClosingIssueNumbers(pullRequest(sample), HOME)].toSorted((a, b) => a - b)).toEqual(row.expected)
  })
})

describe('finishOnGithub', () => {
  it('Issue を種別で分け、開いた Issue を閉じ、Epic・閉じた Issue・読めない Issue を飛ばした理由を記録する', async () => {
    await explains('マージ後の GitHub 側の片付けを行う `finishOnGithub` のテストです。Issue を種別で分けて開いた Issue を閉じ、Epic や閉じた Issue を飛ばした理由を記録することを確認します。')
    const closing = [10, 11, 12, 13].map(number => ({ owner: 'acme', repository: 'demo', number }))
    const finished = await finish([
      kindRule(10, { issueType: 'Epic' }),
      kindRule(11, { state: 'CLOSED' }),
      { match: { operation: 'GetIssueKind', variables: { number: 12 } }, respond: BOOM, times: 1 },
      kindRule(13),
      closeRule(13),
      blockingRule([], 11),
      blockingRule([], 13),
    ], { closing_issues: closing, head_ref: 'feat/demo/13' })
    expect(finished.record).toEqual({
      closedIssues: [13],
      skippedIssues: [{ number: 10, reason: 'epic' }, { number: 12, reason: 'failed' }, { number: 11, reason: 'already-closed' }],
      readinessChanges: [],
      restack: [],
    })
    expect(finished.closing).toEqual([10, 11, 12, 13])
    const stderr = finished.io.err.join('')
    expect(stderr).toMatch(/^warning: reading Issue #12 failed: GraphQL query error: .*; not closed\n/su)
    expect(stderr).toContain('count: Issues to close: 1\nskipped: closing Issue #10 (Epic)\nunchanged: Issue #11 (already closed)\nclosed: Issue #13\n')
  })

  it.for([
    { name: '404', rule: closeRule(12, 404, { message: 'Not Found' }), line: 'warning: Issue #12 not found; skipped\n', reason: 'not-found' },
    { name: '別の要求に先を越された', rule: closeRule(12, 422, { message: 'Validation Failed: closed by another request' }), line: 'unchanged: Issue #12 (already closed)\n', reason: 'already-closed' },
    { name: '500', rule: closeRule(12, 500, { message: 'Server Error' }), line: 'warning: closing Issue #12 failed: ', reason: 'failed' },
  ])('close が次の失敗のとき（$name）、その理由で記録して続ける', async (row) => {
    await explains(`マージ後の GitHub 側の片付けを行う \`finishOnGithub\` のテストです。Issue を閉じる要求が失敗した場合（\`${row.name}\`）に、その理由を記録して続けることを確認します。`)
    const waiting = row.reason === 'already-closed' ? [blockingRule([])] : []
    const finished = await finish([kindRule(12), row.rule, ...waiting])
    expect(finished.record.skippedIssues).toEqual([{ number: 12, reason: row.reason }])
    expect(finished.io.err.join('')).toContain(row.line)
  })

  it('種別の読み取りが 404 の Issue は、閉じる対象に入れ、close の 404 で not-found として記録する', async () => {
    await explains('マージ後の GitHub 側の片付けを行う `finishOnGithub` のテストです。種別の読み取りで存在しない Issue を閉じる対象に入れ、close の 404 で `not-found` と記録することを確認します。')
    const finished = await finish([graphql('GetIssueKind', { repository: { issue: null } }, { number: 12 }), closeRule(12, 404, { message: 'Not Found' })])
    expect(finished.record.skippedIssues).toEqual([{ number: 12, reason: 'not-found' }])
  })

  it('閉じる Issue が無ければ、待つ Issue を読まない', async () => {
    await explains('マージ後の GitHub 側の片付けを行う `finishOnGithub` のテストです。閉じる Issue が無い場合に、待つ Issue を読まないことを確認します。')
    const finished = await finish([kindRule(12, { subIssues: 2 })])
    expect(graphqlRequests(finished.server).map(request => request.operation)).toEqual(['GetIssueKind'])
  })

  it('閉じた Issue を待つ Issue の列を動かし、判定の変化を data に出し、スタックした Issue を記録して案内する', async () => {
    await explains('マージ後の GitHub 側の片付けを行う `finishOnGithub` のテストです。閉じた Issue を待つ Issue の列を動かし、判定の変化とスタックした Issue を記録することを確認します。')
    const finished = await finish([
      kindRule(12),
      closeRule(12),
      blockingRule([13, 14]),
      boardItemRule(13),
      boardItemRule(14),
      prerequisitesRule({ number: 13, blockedBy: [DONE_12] }),
      prerequisitesRule({ number: 14, blockedBy: [DONE_12], branch: 'feat/demo/14' }),
      readyWrite(13),
    ])
    expect(finished.record).toEqual({
      closedIssues: [12],
      skippedIssues: [],
      readinessChanges: [{ issue: '#13', from: 'stackable on #12', to: 'startable' }, { issue: '#14', from: 'stackable on #12', to: 'startable' }],
      restack: [{ issue: '#14', branch: 'feat/demo/14' }],
    })
    expect(finished.io.out.join('')).toBe('Readiness changed:\n- #13 stackable on #12 -> startable\n- #14 stackable on #12 -> startable\n')
    expect(finished.io.err.join('')).toContain('warning: #14 is stacked on #12; run pecot pr restack in the working directory of feat/demo/14\n')
  })

  it('読み直しても、閉じた Issue が済んだ前提として判定に出なければ、pecot-board-sync のワークフローを案内して列を動かさない', async () => {
    await explains('マージ後の GitHub 側の片付けを行う `finishOnGithub` のテストです。読み直しても閉じた Issue が判定へ反映されない場合は、列を動かさず、board sync のワークフローを案内することを確認します。')
    const open12: IssueSpec = { ...DONE_12, state: 'OPEN' }
    const finished = await finish([kindRule(12), closeRule(12), blockingRule([13]), boardItemRule(13), prerequisitesRule({ number: 13, blockedBy: [open12] }), prerequisitesRule({ number: 13, blockedBy: [open12] })])
    expect(delay).toHaveBeenCalledWith(1500)
    expect(finished.io.err.join('')).toBe('count: Issues to close: 1\nclosed: Issue #12\nwarning: could not confirm that GitHub reflects the close of #12 in the readiness of #13; its column was not moved; run the pecot-board-sync workflow (Run workflow on its page in the Actions tab) later to move it\n')
  })

  it('dry-run では、閉じずに閉じる予定として記録し、閉じた後を置き換えた判定で予定の行と判定の変化を出す', async () => {
    await explains('マージ後の GitHub 側の片付けを行う `finishOnGithub` のテストです。`dry-run` の場合に、Issue を閉じずに予定として記録し、閉じた後の判定の変化を出力することを確認します。')
    const open12: IssueSpec = { ...DONE_12, state: 'OPEN' }
    const finished = await finish([kindRule(12), blockingRule([13]), boardItemRule(13), prerequisitesRule({ number: 13, blockedBy: [open12] })], {}, true)
    expect({ record: finished.record, stdout: finished.io.out.join(''), stderr: finished.io.err.join(''), writes: restRequests(finished.server) }).toEqual({
      record: { closedIssues: [12], skippedIssues: [], readinessChanges: [{ issue: '#13', from: 'stackable on #12', to: 'startable' }], restack: [] },
      stdout: 'Readiness changed:\n- #13 stackable on #12 -> startable\n',
      stderr: 'count: Issues to close: 1\ndry-run: would close Issue #12\ndry-run: would move #13 Blocked -> Ready (startable)\n',
      writes: [],
    })
  })
})
