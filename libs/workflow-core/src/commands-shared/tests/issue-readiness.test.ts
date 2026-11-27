// Issue の前提の読み取りと判定。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { botResult, commentsFailure, commentsRule, prerequisitesData, prerequisitesRule } from '../../../tests/_helpers/prerequisites.js'
import type { PullRequestSpec } from '../../../tests/_helpers/prerequisites.js'
import type { ResponseRule } from '../../../tests/_helpers/fake-github/server.js'
import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import { createIssueReference } from '../../domain/reference-parser.js'
import { createRepositoryReference } from '../../domain/repository-resolver.js'
import { graphqlError, rejection, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { DependenciesUnsupportedError } from '../../infra/github/errors.js'
import { DEPENDENCIES_UNSUPPORTED } from '../../infra/github/issues.js'
import {
  blockedByReadCount,
  createReadinessCache,
  judgeAssuming,
  judgeSnapshot,
  readinessJson,
  readIssueReadiness,
  readIssueReadinessIfSupported,
  readIssueSnapshot,
  readIssueSnapshotWithReadout,
  snapshotWithoutPrerequisites,
} from '../issue-readiness.js'
import type { IssueReadiness, IssueSnapshot, JudgedIssue, UnreadableIssue } from '../issue-readiness.js'

useFakeGithub()

const DEMO = createRepositoryReference('acme', 'demo')
const TARGET = createIssueReference(DEMO, 1)
const BOOM = 'GraphQL query error: {\'message\': \'boom\'}'

const UNSUPPORTED_RULE: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: 'Field \'blockedBy\' doesn\'t exist on type \'Issue\'' }] } }, times: 1 }

function config(developBranch = 'main'): ProjectConfig {
  return parseProjectConfig({
    host: 'github.com',
    owner: 'acme',
    project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: { ready: 'o3', blocked: 'ob' } } } },
    repositories: [{ owner: 'acme', name: 'demo', develop_branch: developBranch }],
  })
}

// head が feat/3 で base が main の PR
function pullRequestNode(number: number): unknown {
  return { number, state: 'OPEN', headRefName: 'feat/3', baseRefName: 'main', isDraft: false, isCrossRepository: false, repository: { owner: { login: 'acme' }, name: 'demo' } }
}

// head が feat/3 の PR を引く応答
function byHead(nodes: readonly unknown[], hasNextPage = false): ResponseRule {
  const data = { repository: { pullRequests: { pageInfo: { hasNextPage }, nodes } } }
  return { match: { operation: 'ListPullRequestsByHead', variables: { headRefName: 'feat/3' } }, respond: { status: 200, body: { data } }, times: 1 }
}

// 前提の #2 が、開発ブランチに届かない feat/3 を base に持つ PR を持つ
function stackedOnFeature(): ResponseRule {
  const pullRequests: PullRequestSpec[] = [{ number: 20, head: 'feat/2', base: 'feat/3' }]
  return prerequisitesRule({ number: 1, column: 'Blocked', blockedBy: [{ number: 2, column: 'Active', branch: 'feat/2', pullRequests }] })
}

function judgedOf(result: IssueReadiness): JudgedIssue {
  if (result.kind === 'unreadable') throw new Error(`not judged: ${result.reason}`)
  return result
}

function snapshotOf(result: IssueSnapshot | UnreadableIssue): IssueSnapshot {
  if (result.kind === 'unreadable') throw new Error(result.reason)
  return result
}

async function readSnapshot(rules: readonly ResponseRule[], shouldReadComments = false): Promise<IssueSnapshot | UnreadableIssue> {
  const { client } = await startClient(rules)
  return await readIssueSnapshot(client, config(), TARGET, undefined, shouldReadComments)
}

async function readJudged(rules: readonly ResponseRule[]): Promise<JudgedIssue> {
  const { client } = await startClient(rules)
  return judgedOf(await readIssueReadiness(client, config(), TARGET, createReadinessCache()))
}

describe('blockedByReadCount', () => {
  it.for([
    { name: '一覧の件数が不明', listed: undefined, expected: undefined },
    { name: '一覧の件数が下限より少ない', listed: 2, expected: 8 },
    { name: '一覧の件数が上限より多い', listed: 1000, expected: 50 },
  ])('$name の場合、前提の読み込み件数は $expected になる', async ({ name, listed, expected }) => {
    await explains(`前提の一覧から読み込む件数を決める関数（\`blockedByReadCount\`）のテストです。${name}の場合に、読み込む件数が \`${String(expected)}\` になることを確認します。`)
    expect(blockedByReadCount(listed)).toBe(expected)
  })
})

describe('readIssueSnapshot', () => {
  it('対象の Issue と前提を読み込み、親の Issue と開発ブランチの情報を付ける', async () => {
    await explains('Issue と前提を読み取る関数（`readIssueSnapshot`）のテストです。タイトル・前提のタイトルの対応・親の Issue・開発ブランチを取得でき、前提が 1 件読み込まれることを確認します。')
    const rule = prerequisitesRule({ number: 1, title: 'T', column: 'Ready', parent: { number: 9 }, blockedBy: [{ number: 2, title: '前提', state: 'CLOSED' }] })
    const { title, titles, parent, developmentBranch, malformedReason, labelWrittenByAutomation, prerequisites } = snapshotOf(await readSnapshot([rule]))
    expect({ title, titles, parent, developmentBranch, malformedReason, labelWrittenByAutomation, prerequisites: prerequisites.length }).toEqual({
      title: 'T',
      titles: new Map([['acme/demo#2', '前提']]),
      parent: { repository: DEMO, number: 9 },
      developmentBranch: 'main',
      malformedReason: undefined,
      labelWrittenByAutomation: false,
      prerequisites: 1,
    })
  })

  it('本文の Waits for merge の節を解釈できない場合は、その理由を持つ', async () => {
    await explains('本文の `## Waits for merge` の節が、箇条書きになっていない場合のテストです。読み取り結果が、解釈できない理由（`not a list item: なにか`）を持つことを確認します。')
    const snapshot = snapshotOf(await readSnapshot([prerequisitesRule({ number: 1, body: '## Waits for merge\n\nなにか\n' })]))
    expect(snapshot.malformedReason).toBe('not a list item: なにか')
  })

  it('API が失敗した場合は、読み取れなかった理由（unreadable）を返す', async () => {
    await explains('前提を取得する API が失敗した場合のテストです。`kind` が `unreadable` で、エラーの内容を理由に持つ結果を返すことを確認します。')
    expect(await readSnapshot([graphqlError('GetIssuePrerequisites', 'boom')])).toEqual({ kind: 'unreadable', reason: BOOM })
  })

  it('前提の一覧が部分的なエラーで取得できない場合は、その理由を返す', async () => {
    await explains('GraphQL の応答が、前提の一覧（`blockedBy`）についてだけエラーを含む場合のテストです。`blockedBy could not be read: denied` を理由に持つ `unreadable` を返すことを確認します。')
    const body = { data: prerequisitesData({ number: 1 }), errors: [{ message: 'denied', path: ['repository', 'issue', 'blockedBy'] }] }
    const rule: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body }, times: 1 }
    expect(await readSnapshot([rule])).toEqual({ kind: 'unreadable', reason: 'blockedBy could not be read: denied' })
  })

  it('ラベルが Needs Attention で着手の形跡が存在しない場合は、コメントから自動処理が付けたかどうかを判定する', async () => {
    await explains('ラベルが `Needs Attention` の Issue のテストです。コメントを読み込み、自動処理の失敗を示すコメントがあれば、自動処理が付けたラベルとして扱う（`labelWrittenByAutomation` が `true` になる）ことを確認します。')
    const comments = commentsRule(1, [botResult('failed')])
    const snapshot = snapshotOf(await readSnapshot([prerequisitesRule({ number: 1, label: 'Needs Attention' }), comments], true))
    expect(snapshot.labelWrittenByAutomation).toBe(true)
  })

  it('コメントの取得に失敗した場合は、取得できなかった理由（unreadable）を返す', async () => {
    await explains('ラベルが `Needs Attention` で、コメントの取得が HTTP 500 で失敗した場合のテストです。`GitHub API error: 500` を理由に持つ `unreadable` を返すことを確認します。')
    expect(await readSnapshot([prerequisitesRule({ number: 1, label: 'Needs Attention' }), commentsFailure(1)], true)).toEqual({ kind: 'unreadable', reason: 'GitHub API error: 500' })
  })

  it('依存関係に対応していない GHES の場合は、DependenciesUnsupportedError が発生する', async () => {
    await explains('GitHub Enterprise Server が `blockedBy` に対応していない場合のテストです。`DependenciesUnsupportedError` が発生することを確認します。')
    expect(await rejection(readSnapshot([UNSUPPORTED_RULE]))).toBeInstanceOf(DependenciesUnsupportedError)
  })

  it('readIssueSnapshotWithReadout は、判定用のデータに加えて、対象の Issue の本文と子 Issue の数も返す', async () => {
    await explains('`readIssueSnapshotWithReadout` のテストです。判定用のデータに加えて、対象の Issue の本文と子 Issue の数を返すことを確認します。')
    const { client } = await startClient([prerequisitesRule({ number: 1, body: '本文の中身', subIssues: 2 })])
    const read = await readIssueSnapshotWithReadout(client, config(), TARGET)
    expect(read.kind === 'read' ? { body: read.issue.body, subIssues: read.issue.subIssuesTotal } : read).toEqual({ body: '本文の中身', subIssues: 2 })
  })
})

describe('snapshotWithoutPrerequisites', () => {
  it('一覧から得た値だけで、前提を持たない読み取り結果を作成する', async () => {
    await explains('ボードの一覧から得たタイトルと対象の情報だけで、読み取り結果を作成する関数（`snapshotWithoutPrerequisites`）のテストです。前提・不一致・理由がすべて空で、親は未設定の結果を作成することを確認します。')
    const { target } = snapshotOf(await readSnapshot([prerequisitesRule({ number: 1 })]))
    expect(snapshotWithoutPrerequisites(config(), { title: 'T', target, parent: undefined })).toEqual({
      kind: 'snapshot',
      ref: TARGET,
      title: 'T',
      target,
      prerequisites: [],
      titles: new Map(),
      mismatches: [],
      malformedReason: undefined,
      parent: undefined,
      developmentBranch: 'main',
      labelWrittenByAutomation: false,
    })
  })
})

describe('judgeSnapshot', () => {
  it('前提が完了していないのに開発ブランチが設定されていない場合は、読み取り結果を添えて判定不能（unreadable）にする', async () => {
    await explains('前提が完了していない Issue で、リポジトリに `develop_branch` が設定されていない場合のテストです。`develop_branch is not set for acme/demo` を理由に持ち、読み取り結果を含む `unreadable` を返すことを確認します。')
    const { client } = await startClient([prerequisitesRule({ number: 1, blockedBy: [{ number: 2 }] })])
    const snapshot = snapshotOf(await readIssueSnapshot(client, config(''), TARGET))
    expect(await judgeSnapshot(client, snapshot, createReadinessCache())).toEqual({ kind: 'unreadable', reason: 'develop_branch is not set for acme/demo', snapshot })
  })

  it('前提の PR の base ブランチを head に持つ PR を追加で取得し、開発ブランチまでたどる', async () => {
    await explains('前提の PR が、開発ブランチに届かないブランチを base に持つ場合のテストです。その base を head に持つ PR を追加で取得し、スタック可（`stackable`）と判定して、スタック先を返すことを確認します。')
    const { readiness } = await readJudged([stackedOnFeature(), byHead([pullRequestNode(30)])])
    expect({ kind: readiness?.kind, stackOn: readiness?.stackOn }).toEqual({ kind: 'stackable', stackOn: { branch: 'feat/2', issue: createIssueReference(DEMO, 2) } })
  })

  it('追加で取得した PR が 1 本に決まらない場合は、判定が diverged のままになる', async () => {
    await explains('base を head に持つ PR が 2 本ある場合のテストです。スタック先を 1 本に決められず、判定の理由が `diverged` のままになることを確認します。')
    const { readiness } = await readJudged([stackedOnFeature(), byHead([pullRequestNode(30), pullRequestNode(31)])])
    expect(readiness?.reason?.code).toBe('diverged')
  })

  it('PR の一覧に次のページがある場合は、スタック先を決めず、判定が diverged のままになる', async () => {
    await explains('base を head に持つ PR の一覧に、次のページがある場合のテストです。一覧の PR を使わず、判定の理由が `diverged` のままになることを確認します。')
    const { readiness } = await readJudged([stackedOnFeature(), byHead([pullRequestNode(30)], true)])
    expect(readiness?.reason?.code).toBe('diverged')
  })

  it('同じ head の PR の取得結果は、キャッシュを再利用する', async () => {
    await explains('同じ Issue を 2 回判定する場合のテストです。2 回目は、PR の取得結果を保存したキャッシュを再利用し、1 回目と同じ判定になることを確認します。')
    const { client } = await startClient([stackedOnFeature(), stackedOnFeature(), byHead([pullRequestNode(30)])])
    const cache = createReadinessCache()
    const first = judgedOf(await readIssueReadiness(client, config(), TARGET, cache))
    const second = judgedOf(await readIssueReadiness(client, config(), TARGET, cache))
    expect(second.readiness).toEqual(first.readiness)
  })

  it('PR の追加取得に失敗した場合は、読み取り結果を添えて判定不能（unreadable）にする', async () => {
    await explains('前提の PR の追加取得が失敗した場合のテストです。エラーの内容を理由に持ち、読み取り結果を含む `unreadable` を返すことを確認します。')
    const { client } = await startClient([stackedOnFeature(), graphqlError('ListPullRequestsByHead', 'boom')])
    const result = await readIssueReadiness(client, config(), TARGET, createReadinessCache())
    expect(result.kind === 'unreadable' ? { reason: result.reason, hasSnapshot: result.snapshot !== undefined } : result).toEqual({ reason: BOOM, hasSnapshot: true })
  })

  it('取得に失敗した Issue は、判定せずに unreadable のまま返す', async () => {
    await explains('Issue の取得に失敗した場合のテストです。判定は行わず、取得の失敗を示す `unreadable` をそのまま返すことを確認します。')
    const { client } = await startClient([graphqlError('GetIssuePrerequisites', 'boom')])
    expect(await readIssueReadiness(client, config(), TARGET, createReadinessCache())).toEqual({ kind: 'unreadable', reason: BOOM })
  })
})

describe('judgeAssuming', () => {
  it('前提を置き換えて、判定をやり直す', async () => {
    await explains('前提を仮定して判定する関数（`judgeAssuming`）のテストです。未完了の前提によって `blocked` だった Issue が、前提を空に置き換えると `startable` になることを確認します。')
    const { client } = await startClient([prerequisitesRule({ number: 1, column: 'Blocked', blockedBy: [{ number: 2 }] })])
    const judged = judgedOf(await readIssueReadiness(client, config(), TARGET, createReadinessCache()))
    const assumed = judgedOf(await judgeAssuming(client, config(), judged, () => [], createReadinessCache()))
    expect({ before: judged.readiness?.kind, after: assumed.readiness?.kind, prerequisites: assumed.prerequisites }).toEqual({ before: 'blocked', after: 'startable', prerequisites: [] })
  })
})

describe('readinessJson', () => {
  it('スタック先と理由のコードが存在しない場合は、null として JSON に出力する', async () => {
    await explains('判定を JSON の形に変換する関数（`readinessJson`）のテストです。スタック先が存在しない場合は `null`、存在する場合は番号・リポジトリ・ブランチの形になり、理由のコードは `null` になることを確認します。')
    const stackOn = { issue: createIssueReference(DEMO, 2), branch: 'feat/2' }
    expect([
      readinessJson({ kind: 'startable', stackOn: undefined, reason: undefined, needsReview: false, attention: [] }, '着手できる'),
      readinessJson({ kind: 'stackable', stackOn, reason: undefined, needsReview: false, attention: [] }, 'スタック'),
    ]).toEqual([
      // eslint-disable-next-line unicorn/no-null -- JSON の出力の null
      { kind: 'startable', stackOn: null, reason: null, text: '着手できる' },
      // eslint-disable-next-line unicorn/no-null -- JSON の出力の null
      { kind: 'stackable', stackOn: { number: 2, repository: 'acme/demo', branch: 'feat/2' }, reason: null, text: 'スタック' },
    ])
  })
})

describe('readIssueReadinessIfSupported', () => {
  it('依存関係に対応していない GHES の場合は、理由を通知して undefined を返す', async () => {
    await explains('依存関係に対応していない GHES での、読み取り関数（`readIssueReadinessIfSupported`）のテストです。理由を受け取る関数へ `DEPENDENCIES_UNSUPPORTED` を渡し、`undefined` を返すことを確認します。')
    const { client } = await startClient([UNSUPPORTED_RULE])
    const reasons: string[] = []
    const result = await readIssueReadinessIfSupported(client, config(), TARGET, createReadinessCache(), (reason) => {
      reasons.push(reason)
    })
    expect({ result, reasons }).toEqual({ result: undefined, reasons: [DEPENDENCIES_UNSUPPORTED] })
  })

  it('依存関係に対応している場合は、判定の結果を返す', async () => {
    await explains('依存関係に対応している環境のテストです。`startable` と判定された結果が返ることを確認します。')
    const { client } = await startClient([prerequisitesRule({ number: 1 })])
    const result = await readIssueReadinessIfSupported(client, config(), TARGET, createReadinessCache())
    expect(result?.kind === 'judged' ? result.readiness?.kind : result).toBe('startable')
  })
})
