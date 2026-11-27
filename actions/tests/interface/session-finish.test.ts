/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// session-finish の action を、inputs を置いてプロセス内で呼んで確かめる。GitHub は偽サーバ、作業場所は一時リポにする。
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// 偽の時計は HTTP の待ちも進めてしまうので、読み直しの前の待ちだけを即座に終える
const { delay } = vi.hoisted(() => ({ delay: vi.fn(async (): Promise<void> => {
  await Promise.resolve()
}) }))
vi.mock('node:timers/promises', () => ({ setTimeout: delay }))

import { main } from '../../src/session-finish.js'
import { useIsolatedEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { gitForTest } from '../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { prerequisitesRule } from '../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import type { IssueSpec, TargetSpec } from '../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { runActionCase, setUpProject, startGithub } from '../_helpers/action-case.js'
import type { ActionResult, ProjectFixture, RunningGithub } from '../_helpers/action-case.js'
import { graphqlRule, requestLabels, restRule, STALE_OPTION_TEXT, staleOptionUpdate } from '../_helpers/github-rules.js'

useIsolatedEnvironment()

type Inputs = Readonly<Record<string, string | undefined>>

const HOST = 'github.com'
const BRANCH = 'feat/demo/12'
const PROJECTS_DIRECTORY = '.pecot/config/projects'
const SECOND_PROJECT = 'second'
const KIND_WARNING_NOT_CLOSED = /^warning: reading Issue #12 failed: GraphQL query error: Server error '500 Internal Server Error' for url '[^']+'\n {2}For more information check: [^\n]+\/500; not closed\n/mu
const MERGED = 'GetPullRequestForFinish'
const CLEANUP: Inputs = { pr: 'acme/demo/21' }
const KIND_FAILURE: ResponseRule = { match: { operation: 'GetIssueKind' }, respond: { status: 500, body: { message: 'Server Error' } }, times: 1 }
// eslint-disable-next-line unicorn/no-null -- 応答の形（PR が無いと null）
const NO_PULL_REQUEST = { repository: { pullRequest: null } }

interface FinishPullRequestSample {
  readonly state?: string
  readonly body?: string
  readonly head?: string
  readonly base?: string
  /**
  base のリポの既定ブランチ。null なら既定ブランチが無い（空のリポなど）
  */
  readonly defaultBranch?: string | null
  /**
  closing issues。リポは acme/demo。別のリポは [番号, 'owner/repo'] で書く
  */
  readonly closing?: readonly (number | readonly [number, string])[]
}

// GetPullRequestForFinish の data
function finishPullRequestData(sample: Readonly<FinishPullRequestSample> = {}): unknown {
  const closing = (sample.closing ?? [12]).map((entry) => {
    const [number, fullName] = typeof entry === 'number' ? [entry, 'acme/demo'] : entry
    const [login, name] = fullName.split('/', 2)
    return { number, repository: { name, owner: { login } } }
  })
  return { repository: { pullRequest: {
    number: 21,
    state: sample.state ?? 'MERGED',
    body: sample.body ?? 'Closes #12\n',
    headRefName: sample.head ?? BRANCH,
    baseRefName: sample.base ?? 'main',
    isDraft: false,
    closingIssuesReferences: { nodes: closing },
    baseRepository: { defaultBranchRef: sample.defaultBranch === null ? sample.defaultBranch : { name: sample.defaultBranch ?? 'main' } },
  } } }
}

function kindRule(number: number, options: Readonly<{ subIssues?: number, issueType?: string, state?: string }> = {}): ResponseRule {
  // eslint-disable-next-line unicorn/no-null -- 応答の形（Issue Type が無いと null）
  const issueType = options.issueType === undefined ? null : { name: options.issueType }
  return graphqlRule('GetIssueKind', { repository: { issue: { number, state: options.state ?? 'OPEN', issueType, subIssues: { totalCount: options.subIssues ?? 0 } } } }, { number })
}

function closeRule(number: number, status = 200): ResponseRule {
  return restRule('PATCH', `/repos/acme/demo/issues/${String(number)}`, status, status === 200 ? { number, state: 'closed' } : { message: 'Server Error' })
}

// number の Issue を待つ Issue（blocking）の読み取り
function waitingRule(waiting: readonly number[], number = 12): ResponseRule {
  const nodes = waiting.map(other => ({ id: `I_demo_${String(other)}`, number: other, state: 'OPEN', repository: { owner: { login: 'acme' }, name: 'demo' } }))
  return graphqlRule('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: nodes.length, nodes } } } }, { number })
}

// 種別を読み、close でき、待つ Issue の無い Issue
function closedRules(number: number): ResponseRule[] {
  return [kindRule(number), closeRule(number), waitingRule([], number)]
}

function mergedRules(sample: Readonly<FinishPullRequestSample> = {}, extra: readonly ResponseRule[] = closedRules(12)): ResponseRule[] {
  return [graphqlRule(MERGED, finishPullRequestData(sample)), ...extra]
}

// #12 を待つ Issue。#13 は未着手で Blocked、#14 は #12 の上にスタックして着手し In Review
const UPPER = 'feat/demo/14'
// PR #21 がマージされ、閉じた #12
const DONE_12: IssueSpec = { number: 12, state: 'CLOSED', branch: BRANCH, pullRequests: [{ number: 21, head: BRANCH, state: 'MERGED' }] }
// PR #21 はマージされたが、まだ開いている（GitHub に close が届く前の）#12
const MERGED_UNCLOSED_12: IssueSpec = { ...DONE_12, state: 'OPEN' }

function boardItemRule(number: number, column: string): ResponseRule {
  const projectItems = { nodes: [{ id: `PVTI_${String(number)}`, project: { id: 'PVT_1' }, fieldValues: { nodes: [{ field: { id: 'PVTSSF_workflow', name: 'pecot-status' }, name: column }] } }] }
  const issue = { number, title: `課題${String(number)}`, state: 'OPEN', url: `https://${HOST}/acme/demo/issues/${String(number)}`, repository: { owner: { login: 'acme' }, name: 'demo' }, projectItems }
  return graphqlRule('GetIssueBoardItem', { repository: { issue } }, { number })
}

function waitingTarget(number: number, blocker: IssueSpec = DONE_12, extra: Partial<TargetSpec> = {}): ResponseRule {
  return prerequisitesRule({ number, blockedBy: [blocker], ...extra })
}

const READY_WRITE_13 = graphqlRule('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_13' } } }, { itemId: 'PVTI_13', optionId: 'o3' })
const WAITING_RULES: readonly ResponseRule[] = [
  graphqlRule(MERGED, finishPullRequestData()),
  kindRule(12),
  closeRule(12),
  waitingRule([13, 14]),
  boardItemRule(13, 'Blocked'),
  boardItemRule(14, 'In Review'),
  waitingTarget(13),
  waitingTarget(14, DONE_12, { branch: UPPER }),
]

interface FinishRun extends ActionResult {
  readonly github: RunningGithub
  readonly project: ProjectFixture
}

interface FinishSetup {
  /**
  真なら、同じリポを含む 2 つ目の設定（second）を足す。対象のリポで選ぶ設定が 1 つに決まらない
  */
  readonly ambiguous?: boolean
  /**
  偽なら、設定を置かない
  */
  readonly hasConfig?: boolean
  readonly files?: Readonly<Record<string, string>>
}

function prepare(setup: Readonly<FinishSetup>): ProjectFixture {
  const { ambiguous = false, hasConfig = true, files = {} } = setup
  const project = setUpProject({ files })
  const directory = path.join(project.root, PROJECTS_DIRECTORY)
  if (ambiguous) copyFileSync(path.join(directory, project.configFile), path.join(directory, `${SECOND_PROJECT}.json`))
  if (!hasConfig) rmSync(path.join(directory, project.configFile))
  return project
}

async function finish(rules: readonly ResponseRule[], inputs: Inputs = CLEANUP, setup: Readonly<FinishSetup> = {}): Promise<FinishRun> {
  const project = prepare(setup)
  const github = await startGithub(rules)
  return { ...await runActionCase(main, { token: 'dummy-token', ...inputs }), github, project }
}

function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
}

function restRequests(run: Readonly<FinishRun>, method: string): RecordedRequest[] {
  return run.github.requests().filter(request => request.type === 'rest' && request.method === method)
}

const operationsOf = (run: Readonly<FinishRun>): string[] => requestLabels(run.github.requests())
const writesOf = (run: Readonly<FinishRun>): RecordedRequest[] => run.github.requests().filter(request => request.type === 'graphql' && request.operation === 'UpdateProjectItemField')

describe('session finish', () => {
  it('既定ブランチ宛ての PR の参照を渡すと、PR のリポの closing issues と head ブランチ名の末尾の番号の Issue を close し、本文は読まない', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-01')
    await explains('`session-finish` の action のテストです。既定ブランチ宛ての PR の場合に、closing issues と head ブランチ名の末尾の番号の Issue を close し、本文は参照しないことを確認します。')
    const result = await finish(mergedRules({ closing: [10, [11, 'acme/other']], body: 'Fixes #13\n' }, [10, 12].flatMap(number => closedRules(number))))
    expect(result.code).toBe(0)
    expect(restRequests(result, 'PATCH')).toMatchObject([10, 12].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}`, body: { state: 'closed' } })))
  })

  it('既定ブランチでない base の PR の参照を渡すと、本文のコードと HTML コメントの外の Closes / Fixes / Resolves の Issue も close する', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-01')
    await explains('`session-finish` の action のテストです。既定ブランチ以外が base の PR の場合に、本文の `Closes`・`Fixes`・`Resolves` で指定した Issue も close することを確認します。')
    const body = 'Fixes #11\n\nResolves #13\n\n```console\nCloses #15\n```\n\n`Closes #16` <!-- Closes #17 -->\n\nCloses acme/other#18\n\nCloses #14\n'
    const result = await finish(mergedRules({ base: 'develop', closing: [], body }, [11, 12, 13, 14].flatMap(number => closedRules(number))))
    expect(result.code).toBe(0)
    expect(restRequests(result, 'PATCH')).toMatchObject([11, 12, 13, 14].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}`, body: { state: 'closed' } })))
  })

  it('base のリポに既定ブランチが無いと、本文の Closes の Issue も close する', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-01')
    await explains('`session-finish` の action のテストです。base のリポジトリの既定ブランチが取得できない場合に、本文の `Closes` で指定した Issue も close することを確認します。')
    // eslint-disable-next-line unicorn/no-null -- 応答の形（既定ブランチが無いと null）
    const result = await finish(mergedRules({ defaultBranch: null, closing: [], body: 'Closes #13\n' }, [12, 13].flatMap(number => closedRules(number))))
    expect(result.code).toBe(0)
    expect(restRequests(result, 'PATCH')).toMatchObject([12, 13].map(number => ({ path: `/repos/acme/demo/issues/${String(number)}` })))
  })

  it('pr に番号だけを渡すと、ワークフローが動くリポの PR として片付ける', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-49')
    await explains('`session-finish` の action のテストです。input の `pr` に番号だけを渡した場合に、ワークフローが動くリポジトリの PR として後始末することを確認します。')
    const result = await finish(mergedRules(), { pr: '21' })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('count: Issues to close: 1\nclosed: Issue #12\n')
  })

  it('閉じた Issue があると、close を送らず、unchanged の行を出す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-41')
    await explains('`session-finish` の action のテストです。対象の Issue がすでに閉じている場合に、close の要求を送信せず、`unchanged` の行を出力することを確認します。')
    const result = await finish(mergedRules({ closing: [10] }, [kindRule(10, { state: 'CLOSED' }), waitingRule([], 10), ...closedRules(12)]))
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/^count: Issues to close: 1\nunchanged: Issue #10 \(already closed\)\nclosed: Issue #12\n$/u)
    expect(restRequests(result, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12' }])
  })

  it('種別の読み取りと close が 404 の Issue は、warning を出して飛ばす', async () => {
    await explains('`session-finish` の action のテストです。Issue の種別の取得と close の応答が 404 の場合に、`warning` の行を出力して処理を続けることを確認します。')
    // eslint-disable-next-line unicorn/no-null -- 応答の形（Issue が無いと null）
    const missing = graphqlRule('GetIssueKind', { repository: { issue: null } }, { number: 10 })
    const result = await finish(mergedRules({ closing: [10] }, [missing, restRule('PATCH', '/repos/acme/demo/issues/10', 404, { message: 'Not Found' }), ...closedRules(12)]))
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: Issue #10 not found; skipped\n')
    expect(result.stderr).toContain('closed: Issue #12\n')
  })

  it('close が別の要求に先を越されたなら、unchanged の行を出す', async () => {
    await explains('`session-finish` の action のテストです。close の要求が別の要求に先を越されて 422 が返った場合は、`unchanged` の行を出力し、`warning` は出力しないことを確認します。')
    const raced = restRule('PATCH', '/repos/acme/demo/issues/10', 422, { message: 'Validation Failed: closed by another request' })
    const result = await finish(mergedRules({ closing: [10] }, [kindRule(10), raced, waitingRule([], 10), ...closedRules(12)]))
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('unchanged: Issue #10 (already closed)\n')
    expect(result.stderr).not.toContain('warning: closing Issue #10')
  })

  it('閉じた Issue があると、dry-run でも close の予定に入れず、unchanged の予定の行を出す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-41')
    await explains('`session-finish` の action のテストです。input の `dry-run` が `true` で、対象の Issue がすでに閉じている場合は、close の予定に含めず、`unchanged` の予定の行を出力することを確認します。')
    const result = await finish(mergedRules({}, [kindRule(12, { state: 'CLOSED' }), waitingRule([])]), { ...CLEANUP, 'dry-run': 'true' })
    expect(lines(result.stderr)).toStrictEqual(['count: Issues to close: 0', 'dry-run: would leave Issue #12 (already closed) unchanged'])
  })

  it('閉じた Epic があると、Epic として skipped の行を出す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-03')
    await explains('`session-finish` の action のテストです。閉じた Epic の場合に、Issue を close せず、Epic として `skipped` の行を出力することを確認します。')
    const result = await finish(mergedRules({}, [kindRule(12, { issueType: 'Epic', state: 'CLOSED' })]))
    expect(result.stderr).toBe('count: Issues to close: 0\nskipped: closing Issue #12 (Epic)\n')
  })

  it.for([
    { title: 'Issue Type が Epic', options: { issueType: 'Epic' } },
    { title: 'sub-issue を持つ Issue', options: { subIssues: 3 } },
  ])('次の Issue があると（$title）、その Issue を close しない', async (row, context) => {
    await verifies(context, 'PA-SESSION-FINISH-02')
    await explains('`session-finish` の action のテストです。Issue Type が Epic の場合と、sub-issue を持つ場合に、その Issue は close せず、PR の Issue だけを close することを確認します。')
    const result = await finish(mergedRules({ closing: [10] }, [kindRule(10, row.options), ...closedRules(12)]))
    expect(result.code).toBe(0)
    expect(restRequests(result, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
    expect(result.stderr).toContain('count: Issues to close: 1\n')
    expect(result.stderr).toContain('closed: Issue #12\n')
  })

  it('もし Issue の種別と状態を読めないなら、warning の行を出し、その Issue を close しない', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-42')
    await explains('`session-finish` の action のテストです。Issue の種別と状態を取得できなかった場合に、`warning` の行を出力し、その Issue は close しないことを確認します。')
    const result = await finish(mergedRules({}, [KIND_FAILURE]))
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(KIND_WARNING_NOT_CLOSED)
    expect(result.stderr).toMatch(/\ncount: Issues to close: 0\n$/u)
    expect(restRequests(result, 'PATCH')).toStrictEqual([])
  })

  it('Epic か sub-issue を持つ Issue があると、skipped の行を出す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-03')
    await explains('`session-finish` の action のテストです。sub-issue を持つ Issue の場合に、close せず、Epic として `skipped` の行を出力することを確認します。')
    const result = await finish(mergedRules({}, [kindRule(12, { subIssues: 1 })]))
    expect(result.stderr).toBe('count: Issues to close: 0\nskipped: closing Issue #12 (Epic)\n')
  })

  it('実行すると、close する Issue の件数を count の行で出す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-13')
    await explains('`session-finish` の action のテストです。実行した場合に、close する Issue の件数を `count` の行として出力することを確認します。')
    const result = await finish(mergedRules({ closing: [10] }, [...closedRules(10), ...closedRules(12)]))
    expect(result.stderr.startsWith('count: Issues to close: 2\n')).toBe(true)
  })

  it('Issue を close すると、closed の行を出す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-14')
    await explains('`session-finish` の action のテストです。Issue を close した場合に、`closed` の行を出力することを確認します。')
    const result = await finish(mergedRules())
    expect(result.stderr).toBe('count: Issues to close: 1\nclosed: Issue #12\n')
  })

  it('ブランチを消す要求を送らず、手元のブランチとフラグのファイルに触れない', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-10')
    await explains('`session-finish` の action のテストです。リモートのブランチを削除する要求を送信せず、手元のブランチとフラグのファイルも変更しないことを確認します。')
    const flags = ['.pecot/state/.pecot-base', '.pecot/state/.pecot-session-title']
    const result = await finish(mergedRules(), CLEANUP, { files: Object.fromEntries(flags.map(file => [file, 'x\n'])) })
    expect(result.code).toBe(0)
    expect(restRequests(result, 'DELETE')).toStrictEqual([])
    expect(gitForTest(result.project.root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
    expect(flags.map(file => existsSync(path.join(result.project.root, file)))).toStrictEqual([true, true])
    expect(result.stderr).not.toContain('branch')
  })

  it('dry-run を true にすると、何も変えずに dry-run: would の行を出す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-12')
    await explains('`session-finish` の action のテストです。input の `dry-run` が `true` の場合に、何も変更せず、close の予定を `dry-run` の行として出力することを確認します。')
    const result = await finish(mergedRules({}, [kindRule(12), waitingRule([])]), { ...CLEANUP, 'dry-run': 'true' })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('count: Issues to close: 1\ndry-run: would close Issue #12\n')
    expect(restRequests(result, 'PATCH')).toStrictEqual([])
  })

  it('dry-run に true・false 以外を渡すと、GitHub を読まず、入力の誤りとして終了コード 2 を返す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-48')
    await explains('`session-finish` の action のテストです。input の `dry-run` に `true` と `false` 以外の値を渡した場合に、GitHub を読まず、入力の誤りとして終了コード 2 を返すことを確認します。')
    const result = await finish([], { ...CLEANUP, 'dry-run': 'yes' })
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid input: .*dry_run/su)
    expect(result.github.requests()).toStrictEqual([])
  })

  it('Issue の close に失敗したなら、warning の行を出す', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-20')
    await explains('`session-finish` の action のテストです。Issue の close が失敗した場合に、`warning` の行を出力し、step は成功のまま終えることを確認します。')
    const result = await finish(mergedRules({}, [kindRule(12), closeRule(12, 500)]))
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/\nwarning: closing Issue #12 failed: /u)
  })

  it('Issue の close に失敗したなら、ほかの Issue と後の処理を続ける', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-21')
    await explains('`session-finish` の action のテストです。Issue の close が失敗した場合に、ほかの Issue の close と後続の処理を継続することを確認します。')
    const result = await finish(mergedRules({ closing: [10] }, [kindRule(10), closeRule(10, 500), ...closedRules(12)]))
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('closed: Issue #12\n')
  })

  it('PR がマージされていないなら、GitHub の画面でマージするよう案内し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-24')
    await explains('`session-finish` の action のテストです。PR がマージされていない場合に、GitHub の画面でマージするよう案内し、step を失敗にすることを確認します。')
    const result = await finish(mergedRules({ state: 'OPEN' }, []))
    expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toStrictEqual({ code: 1, stdout: '', stderr: 'error: PR #21 is not merged yet (state: OPEN); merge it on GitHub first\n' })
  })

  it('PR がマージされていないなら、何も変えない', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-25')
    await explains('`session-finish` の action のテストです。PR がマージされていない場合に、PR を読む以外の要求を送信せず、何も変更しないことを確認します。')
    const result = await finish(mergedRules({ state: 'OPEN' }, []))
    expect(operationsOf(result)).toStrictEqual([MERGED])
  })

  it('対象のリポを含む設定が 2 つあり、project を渡さないと、候補と project の案内を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-26')
    await explains('`session-finish` の action のテストです。対象のリポジトリを含む設定が 2 つあり、input の `project` が無い場合に、候補を出力して step を失敗にすることを確認します。')
    const result = await finish([], CLEANUP, { ambiguous: true })
    expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toStrictEqual({ code: 1, stdout: '', stderr: `error: acme/demo is in 2 project configs\n  choose one with project: <NAME>\n  available: ${HOST}_acme_board_acme, ${SECOND_PROJECT}\n` })
    expect(result.github.requests()).toStrictEqual([])
  })

  it('対象のリポを含む設定が無いなら、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-43')
    await explains('`session-finish` の action のテストです。対象のリポジトリを含む設定が存在しない場合に、GitHub を読まず、エラーを出力して step を失敗にすることを確認します。')
    const result = await finish([], CLEANUP, { hasConfig: false })
    expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toStrictEqual({ code: 1, stdout: '', stderr: 'error: acme/demo is not in any project config\n  available: (none)\n' })
    expect(result.github.requests()).toStrictEqual([])
  })

  it('project を渡すと、対象のリポを含む設定が 2 つあってもその設定で片付ける', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-44')
    await explains('`session-finish` の action のテストです。対象のリポジトリを含む設定が 2 つあっても、input の `project` で指定した設定で後始末することを確認します。')
    const result = await finish(mergedRules(), { ...CLEANUP, project: SECOND_PROJECT }, { ambiguous: true })
    expect(result.code).toBe(0)
    expect(restRequests(result, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12' }])
  })

  it.for([
    { title: 'PR が無い', rules: [graphqlRule(MERGED, NO_PULL_REQUEST)], expected: 'error: PR not found: acme/demo/21\n' },
    { title: 'PR を取得できない', rules: [{ match: { operation: MERGED }, respond: { status: 502, body: { message: 'Bad Gateway' } }, times: 1 }], expected: 'error: GraphQL query error: ' },
  ])('次の場合は（$title）、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PA-SESSION-FINISH-27')
    await explains('`session-finish` の action のテストです。PR が存在しない場合と取得が失敗した場合は、標準出力へ何も出力せず、step を失敗にすることを確認します。')
    const result = await finish(row.rules)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.startsWith(row.expected)).toBe(true)
  })

  it('PR の参照の形が誤っているなら、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PA-SESSION-FINISH-28')
    await explains('`session-finish` の action のテストです。input の `pr` の形式が誤っている場合に、GitHub へ要求を送信せず、入力の誤りとして終了コード 2 を返すことを確認します。')
    const result = await finish([], { pr: 'not-a-ref' })
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^error: invalid reference: not-a-ref\n/u)
    expect(result.github.requests()).toStrictEqual([])
  })

  describe('待っている Issue', () => {
    it('片付けると、閉じた Issue を待つ Issue の列を動かし、着手の跡がある Issue は動かさない', async (context) => {
      await verifies(context, 'PA-SESSION-FINISH-31')
      await verifies(context, 'PA-SESSION-FINISH-32')
      await verifies(context, 'PA-SESSION-FINISH-35')
      await explains('`session-finish` の action のテストです。Issue を閉じた場合に、それを待つ Issue の列を移動し、着手の跡がある Issue は移動せずに warning を出力することを確認します。')
      const result = await finish([...WAITING_RULES, READY_WRITE_13])
      expect(result.code).toBe(0)
      expect(lines(result.stderr)).toStrictEqual([
        'count: Issues to close: 1',
        'closed: Issue #12',
        'moved: #13 Blocked -> Ready (startable)',
        `warning: #14 is stacked on #12; call pr_restack in the working directory of ${UPPER}`,
      ])
      expect(writesOf(result)).toMatchObject([{ variables: { itemId: 'PVTI_13', optionId: 'o3' } }])
      expect(restRequests(result, 'DELETE')).toStrictEqual([])
    })

    it('待つ Issue の列が古い ID で書けないと、warning と project_activate の案内を出して続け、終了コード 0 で終わる', async (context) => {
      await verifies(context, 'PA-SESSION-FINISH-40')
      await explains('`session-finish` の action のテストです。待機中の Issue の列を古い ID で更新できない場合に、`warning` と `project_activate` の案内を出力し、成功することを確認します。')
      const result = await finish([...WAITING_RULES, staleOptionUpdate()])
      expect(result.code).toBe(0)
      const stderr = lines(result.stderr)
      expect(stderr.slice(0, 3)).toStrictEqual([
        'count: Issues to close: 1',
        'closed: Issue #12',
        `warning: could not move #13: ${STALE_OPTION_TEXT}`,
      ])
      expect(stderr[3]).toMatch(/^ {2}hint: if the board options were recreated, call project_activate with project: "\S+" to read their IDs again$/u)
      expect(stderr.slice(4)).toStrictEqual([`warning: #14 is stacked on #12; call pr_restack in the working directory of ${UPPER}`])
    })

    it('判定が変わった Issue を、stdout の Readiness changed の節に出す', async (context) => {
      await verifies(context, 'PA-SESSION-FINISH-33')
      await explains('`session-finish` の action のテストです。判定の変わった Issue がある場合に、標準出力の `Readiness changed` の節へ出力することを確認します。')
      const result = await finish([...WAITING_RULES, READY_WRITE_13])
      expect(result.stdout).toBe('Readiness changed:\n- #13 stackable on #12 -> startable\n- #14 stackable on #12 -> startable\n')
    })

    it('判定が変わらない待つ Issue は、Readiness changed の節に出さない', async (context) => {
      await verifies(context, 'PA-SESSION-FINISH-34')
      await explains('`session-finish` の action のテストです。判定が変わらない待機中の Issue を、`Readiness changed` の節に出力しないことを確認します。')
      // #13 は別の未着手の前提 #15 も待つので、#12 の前後で blocked のまま
      const result = await finish([...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), prerequisitesRule({ number: 13, blockedBy: [DONE_12, { number: 15 }] })])
      expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toStrictEqual({ code: 0, stdout: '', stderr: 'count: Issues to close: 1\nclosed: Issue #12\n' })
    })

    it('base が開発ブランチでない PR を片付けても、その PR の Issue を閉じる', async (context) => {
      await verifies(context, 'PA-SESSION-FINISH-38')
      await explains('`session-finish` の action のテストです。base が開発ブランチでない PR を後始末する場合でも、その PR の Issue を閉じることを確認します。')
      const result = await finish(mergedRules({ base: 'feat/demo/11' }))
      expect(result.code).toBe(0)
      expect(restRequests(result, 'PATCH')).toMatchObject([{ path: '/repos/acme/demo/issues/12', body: { state: 'closed' } }])
    })

    it('待つ Issue の判定に閉じた Issue が済んだ前提として出なければ、1 回だけ読み直してから動かす', async (context) => {
      await verifies(context, 'PA-SESSION-FINISH-31')
      await explains('`session-finish` の action のテストです。閉じた Issue が済んだ前提として判定に現れない場合は、1 回だけ取得し直してから列を移動することを確認します。')
      const result = await finish([...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12), waitingTarget(13), READY_WRITE_13])
      expect(result.stderr).toContain('moved: #13 Blocked -> Ready (startable)\n')
      expect(operationsOf(result).filter(operation => operation === 'GetIssuePrerequisites')).toHaveLength(2)
      expect(delay).toHaveBeenCalledWith(1500)
    })

    it('読み直しても閉じた Issue が済んだ前提として出なければ、pecot-board-sync のワークフローで後から直せる旨の warning の行を出して列を動かさない', async (context) => {
      await verifies(context, 'PA-SESSION-FINISH-36')
      await explains('`session-finish` の action のテストです。再取得しても、閉じた Issue が済んだ前提として現れない場合は、`pecot-board-sync` を案内する warning を出力し、列は移動しないことを確認します。')
      const result = await finish([...mergedRules({}, [kindRule(12), closeRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12), waitingTarget(13, MERGED_UNCLOSED_12)])
      expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toStrictEqual({
        code: 0,
        stdout: '',
        stderr: 'count: Issues to close: 1\nclosed: Issue #12\nwarning: could not confirm that GitHub reflects the close of #12 in the readiness of #13; its column was not moved; run the pecot-board-sync workflow (Run workflow on its page in the Actions tab) later to move it\n',
      })
      expect(operationsOf(result)).not.toContain('UpdateProjectItemField')
    })

    it('dry-run では、閉じる前の Issue を済んだものとして判定し、列を書かずに予定の行と判定の変化を出す', async (context) => {
      await verifies(context, 'PA-SESSION-FINISH-37')
      await explains('`session-finish` の action のテストです。input の `dry-run` が `true` の場合に、閉じる予定の Issue を済んだものとして判定し、列は更新せずに判定の変化を出力することを確認します。')
      const result = await finish([...mergedRules({}, [kindRule(12), waitingRule([13])]), boardItemRule(13, 'Blocked'), waitingTarget(13, MERGED_UNCLOSED_12)], { ...CLEANUP, 'dry-run': 'true' })
      expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toStrictEqual({
        code: 0,
        stdout: 'Readiness changed:\n- #13 stackable on #12 -> startable\n',
        stderr: 'count: Issues to close: 1\ndry-run: would close Issue #12\ndry-run: would move #13 Blocked -> Ready (startable)\n',
      })
      expect(writesOf(result)).toStrictEqual([])
    })
  })
})
