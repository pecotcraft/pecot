/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// 待たれている Issue を待つ Issue の列を、判定で動かす。GitHub は偽サーバにする。
import { describe, expect, it, vi } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { capture } from '../../../tests/_helpers/captured-io.js'
import type { CapturedIo } from '../../../tests/_helpers/captured-io.js'
import { prerequisitesRule } from '../../../tests/_helpers/prerequisites.js'
import type { IssueSpec, TargetSpec } from '../../../tests/_helpers/prerequisites.js'
import type { ResponseRule } from '../../../tests/_helpers/fake-github/server.js'
import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import { createIssueReference } from '../../domain/reference-parser.js'
import { createRepositoryReference } from '../../domain/repository-resolver.js'
import { graphqlRequests, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import type { StartedClient } from '../../infra/github/tests/fake-client.js'
import type { BoardContext } from '../board-judgment.js'
import { createReadinessCache } from '../issue-readiness.js'
import { createOutput } from '../output.js'
import { moveIssuesWaitingFor, moveWaitingIssues } from '../pr-waiting.js'
import type { CreatedPullRequest, WaitingCheck } from '../pr-waiting.js'
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
const CREATED: CreatedPullRequest = { repository: HOME, issueNumber: 12, pullRequest: 21 }
const MOVED_13 = 'moved: #13 Blocked -> Ready (stackable on #12)\n'
const BOOM = { status: 500, body: { message: 'boom' } }

function config(): ProjectConfig {
  return parseProjectConfig({
    host: 'github.com',
    owner: 'acme',
    project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: { ready: 'o3', blocked: 'ob', active: 'o4' } } } },
    repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'main' }],
  })
}

const graphql = (operation: string, data: unknown, variables?: Readonly<Record<string, unknown>>): ResponseRule => ({ match: { operation, ...variables !== undefined && { variables } }, respond: { status: 200, body: { data } }, times: 1 })
const failing = (operation: string): ResponseRule => ({ match: { operation }, respond: BOOM, times: 1 })

// number の Issue を待つ Issue（blocking）。total が nodes より多いと、読めなかった分がある
function blockingRule(waiting: readonly number[], options: Readonly<{ number?: number, total?: number, state?: string }> = {}): ResponseRule {
  const nodes = waiting.map(other => ({ id: `I_demo_${String(other)}`, number: other, state: options.state ?? 'OPEN', repository: { owner: { login: 'acme' }, name: 'demo' } }))
  return graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: options.total ?? nodes.length, nodes } } } }, { number: options.number ?? 12 })
}

// #13 のボードの項目。column が無ければボードに載っていない
function boardItemRule(column?: string): ResponseRule {
  const nodes = column === undefined ? [] : [{ id: 'PVTI_13', project: { id: 'PVT_1' }, fieldValues: { nodes: [{ field: { id: 'PVTSSF_workflow', name: 'pecot-status' }, name: column }] } }]
  const issue = { number: 13, title: '課題13', state: 'OPEN', url: 'https://github.com/acme/demo/issues/13', repository: { owner: { login: 'acme' }, name: 'demo' }, projectItems: { nodes } }
  return graphql('GetIssueBoardItem', { repository: { issue } }, { number: 13 })
}

// #13 の前提の読み取り。hasPullRequest なら、#12 のブランチに作った PR #21 が出る
function waitingTarget(hasPullRequest: boolean): TargetSpec {
  const blocker: IssueSpec = hasPullRequest ? { number: 12, branch: BRANCH, pullRequests: [{ number: 21, head: BRANCH }] } : { number: 12 }
  return { number: 13, blockedBy: [blocker] }
}

const READY_WRITE_13 = graphql('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_13' } } }, { itemId: 'PVTI_13', optionId: 'o3' })

interface Started extends StartedClient {
  readonly io: CapturedIo
  readonly context: BoardContext
}

async function start(rules: readonly ResponseRule[]): Promise<Started> {
  const started = await startClient(rules)
  const io = capture()
  const out = createOutput(false, io)
  return { ...started, io, context: { out, client: started.client, config: config(), home: HOME } }
}

const operationsOf = (started: Readonly<Started>): string[] => graphqlRequests(started.server).map(request => request.operation)

// 作った PR が判定に出ていれば確かめたことにする
const pullRequestCheck: WaitingCheck = {
  isReflected: judged => judged.prerequisites.some(({ issue }) => issue.pullRequests.some(pullRequest => pullRequest.number === 21)),
  unconfirmed: name => `unconfirmed ${name}`,
}

async function moveFor(started: Readonly<Started>, heads: readonly number[] = [12]): Promise<number> {
  const judged = await moveIssuesWaitingFor(started.context, { heads: heads.map(number => createIssueReference(HOME, number)), check: pullRequestCheck, isDryRun: false, cache: createReadinessCache() })
  return judged.length
}

describe('moveWaitingIssues', () => {
  it('作った PR が待つ Issue の判定に出ていると、列を動かし、moved の行と動かした列を返す', async () => {
    await explains('PR を作った後に、その PR を待つ Issue の列を動かす `moveWaitingIssues` のテストです。判定に作った PR が反映されている場合に、列を `Ready` へ動かし、`moved` の行を出力することを確認します。')
    const started = await start([blockingRule([13]), boardItemRule('Blocked'), prerequisitesRule(waitingTarget(true)), READY_WRITE_13])
    const moves = await moveWaitingIssues(started.context.out, started.client, config(), CREATED, { hasHinted: false })
    expect({ moves, stderr: started.io.err.join(''), operations: operationsOf(started) }).toEqual({
      moves: [{ issue: '#13', column: { from: 'Blocked', to: 'Ready' }, label: undefined, reason: 'stackable on #12' }],
      stderr: MOVED_13,
      operations: ['GetIssueBlockingReferences', 'GetIssueBoardItem', 'GetIssuePrerequisites', 'UpdateProjectItemField'],
    })
  })

  it('判定に作った PR が出ていなければ、1 回だけ読み直してから動かす', async () => {
    await explains('PR を作った後に、その PR を待つ Issue の列を動かす `moveWaitingIssues` のテストです。判定に作った PR が反映されていない場合に、1 回だけ待って読み直してから列を動かすことを確認します。')
    const started = await start([blockingRule([13]), boardItemRule('Blocked'), prerequisitesRule(waitingTarget(false)), prerequisitesRule(waitingTarget(true)), READY_WRITE_13])
    await moveWaitingIssues(started.context.out, started.client, config(), CREATED, { hasHinted: false })
    expect(started.io.err.join('')).toBe(MOVED_13)
    expect(operationsOf(started).filter(operation => operation === 'GetIssuePrerequisites')).toHaveLength(2)
    expect(delay).toHaveBeenCalledWith(1500)
  })

  it('読み直しても作った PR が判定に出なければ、pecot-board-sync のワークフローを案内する warning を出して列を動かさない', async () => {
    await explains('PR を作った後に、その PR を待つ Issue の列を動かす `moveWaitingIssues` のテストです。読み直しても反映されない場合に、列を動かさず、board sync のワークフローを案内する警告を出力することを確認します。')
    const started = await start([blockingRule([13]), boardItemRule('Blocked'), prerequisitesRule(waitingTarget(false)), prerequisitesRule(waitingTarget(false))])
    const moves = await moveWaitingIssues(started.context.out, started.client, config(), CREATED, { hasHinted: false })
    expect({ moves, stderr: started.io.err.join('') }).toEqual({
      moves: [],
      stderr: 'warning: could not confirm that GitHub reflects PR #21 in the readiness of #13; its column was not moved; run the pecot-board-sync workflow (Run workflow on its page in the Actions tab) later to move it\n',
    })
  })

  it('作った PR の番号が無ければ、判定を読み直さずに動かす', async () => {
    await explains('PR を作った後に、その PR を待つ Issue の列を動かす `moveWaitingIssues` のテストです。作った PR の番号が無い場合に、判定を読み直さずに列を動かすことを確認します。')
    const started = await start([blockingRule([13]), boardItemRule('Blocked'), prerequisitesRule(waitingTarget(true)), READY_WRITE_13])
    await moveWaitingIssues(started.context.out, started.client, config(), { ...CREATED, pullRequest: undefined }, { hasHinted: false })
    expect(started.io.err.join('')).toBe(MOVED_13)
  })
})

describe('moveIssuesWaitingFor', () => {
  it.for([
    { name: 'Issue が無い', rules: [graphql('GetIssueBlockingReferences', { repository: { issue: null } })], expected: '' },
    { name: '依存関係に対応しない', rules: [{ match: { operation: 'GetIssueBlockingReferences' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blocking\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }], expected: '' },
    { name: 'blocking が null', rules: [graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: null } } })], expected: 'warning: could not read the Issues waiting for #12: blocking is null\n' },
  ])('待つ Issue の読み取りが次のとき（$name）、ボードを読まずに終える', async (row) => {
    await explains(`Issue を待つ Issue の列を動かす \`moveIssuesWaitingFor\` のテストです。待つ Issue を読み取れない場合（\`${row.name}\`）に、ボードを読まずに終えることを確認します。`)
    const started = await start(row.rules)
    expect(await moveFor(started)).toBe(0)
    expect(started.io.err.join('')).toBe(row.expected)
  })

  it('待つ Issue の読み取りが API エラーなら、warning を出してボードを読まない', async () => {
    await explains('Issue を待つ Issue の列を動かす `moveIssuesWaitingFor` のテストです。待つ Issue の読み取りが API エラーの場合に、警告を出力し、ボードを読まないことを確認します。')
    const started = await start([failing('GetIssueBlockingReferences')])
    expect(await moveFor(started)).toBe(0)
    expect(started.io.err.join('')).toMatch(/^warning: could not read the Issues waiting for #12: GraphQL query error: /u)
  })

  it('待つ Issue を全件読めなければ、読めた分を動かしてから warning の行を出す', async () => {
    await explains('Issue を待つ Issue の列を動かす `moveIssuesWaitingFor` のテストです。待つ Issue を全件読めない場合に、読めた分の列を動かしてから警告を出力することを確認します。')
    const started = await start([blockingRule([13], { total: 2 }), boardItemRule('Blocked'), prerequisitesRule(waitingTarget(true)), READY_WRITE_13])
    expect(await moveFor(started)).toBe(1)
    expect(started.io.err.join('')).toBe(`${MOVED_13}warning: read 1 of 2 Issues waiting for #12; the rest were not moved\n`)
  })

  it('閉じた待つ Issue とボードに載っていない待つ Issue は、判定を読まずに飛ばす', async () => {
    await explains('Issue を待つ Issue の列を動かす `moveIssuesWaitingFor` のテストです。閉じた Issue とボードに載っていない Issue の場合に、判定を読まずに飛ばすことを確認します。')
    const started = await start([blockingRule([13]), blockingRule([14], { number: 15, state: 'CLOSED' }), boardItemRule()])
    expect(await moveFor(started, [12, 15])).toBe(0)
    expect({ stderr: started.io.err.join(''), operations: operationsOf(started) }).toEqual({ stderr: '', operations: ['GetIssueBlockingReferences', 'GetIssueBlockingReferences', 'GetIssueBoardItem'] })
  })

  it('2 つの Issue が同じ Issue に待たれていると、その Issue を 1 回だけ読んで動かす', async () => {
    await explains('Issue を待つ Issue の列を動かす `moveIssuesWaitingFor` のテストです。2 つの Issue が同じ Issue に待たれている場合に、その Issue を 1 回だけ読んで動かすことを確認します。')
    const started = await start([blockingRule([13]), blockingRule([13], { number: 15 }), boardItemRule('Blocked'), prerequisitesRule(waitingTarget(true)), READY_WRITE_13])
    expect(await moveFor(started, [12, 15])).toBe(1)
    expect(operationsOf(started).filter(operation => operation === 'GetIssueBoardItem')).toHaveLength(1)
  })

  it('ボードの読み取りに失敗したなら、待たれている Issue を並べた warning を出して続ける', async () => {
    await explains('Issue を待つ Issue の列を動かす `moveIssuesWaitingFor` のテストです。ボードの読み取りが失敗したときは、待たれている Issue を並べた警告を出力して続けることを確認します。')
    const started = await start([blockingRule([13]), failing('GetIssueBoardItem')])
    expect(await moveFor(started)).toBe(0)
    expect(started.io.err.join('')).toMatch(/^warning: could not move the Issues waiting for #12: GraphQL query error: /u)
  })

  it('待つ Issue の判定を読めなければ、列を動かさない', async () => {
    await explains('Issue を待つ Issue の列を動かす `moveIssuesWaitingFor` のテストです。待つ Issue の判定を読み取れない場合に、列を書き換えないことを確認します。')
    const started = await start([blockingRule([13]), boardItemRule('Blocked'), failing('GetIssuePrerequisites')])
    expect(await moveFor(started)).toBe(1)
    expect(operationsOf(started)).not.toContain('UpdateProjectItemField')
  })
})
