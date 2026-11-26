// Issue の前提の読み取りと判定。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'

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
    { name: '件数が無い', listed: undefined, expected: undefined },
    { name: '下限より少ない', listed: 2, expected: 8 },
    { name: '上限より多い', listed: 1000, expected: 50 },
  ])('$name なら、$expected 件を読む', ({ listed, expected }) => {
    expect(blockedByReadCount(listed)).toBe(expected)
  })
})

describe('readIssueSnapshot', () => {
  it('対象の Issue と前提を読み、親と開発ブランチを添える', async () => {
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

  it('本文の Waits for merge の節が読めなければ、その理由を持つ', async () => {
    const snapshot = snapshotOf(await readSnapshot([prerequisitesRule({ number: 1, body: '## Waits for merge\n\nなにか\n' })]))
    expect(snapshot.malformedReason).toBe('not a list item: なにか')
  })

  it('API が失敗したら、読めない理由で返す', async () => {
    expect(await readSnapshot([graphqlError('GetIssuePrerequisites', 'boom')])).toEqual({ kind: 'unreadable', reason: BOOM })
  })

  it('前提の一覧が部分エラーで読めなければ、その理由で返す', async () => {
    const body = { data: prerequisitesData({ number: 1 }), errors: [{ message: 'denied', path: ['repository', 'issue', 'blockedBy'] }] }
    const rule: ResponseRule = { match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body }, times: 1 }
    expect(await readSnapshot([rule])).toEqual({ kind: 'unreadable', reason: 'blockedBy could not be read: denied' })
  })

  it('札が Needs Attention で着手の跡が無ければ、コメントから自動処理が書いたかを決める', async () => {
    const comments = commentsRule(1, [botResult('failed')])
    const snapshot = snapshotOf(await readSnapshot([prerequisitesRule({ number: 1, label: 'Needs Attention' }), comments], true))
    expect(snapshot.labelWrittenByAutomation).toBe(true)
  })

  it('コメントの読み取りが失敗したら、読めない理由で返す', async () => {
    expect(await readSnapshot([prerequisitesRule({ number: 1, label: 'Needs Attention' }), commentsFailure(1)], true)).toEqual({ kind: 'unreadable', reason: 'GitHub API error: 500' })
  })

  it('依存関係に対応しない GHES では、DependenciesUnsupportedError を投げる', async () => {
    expect(await rejection(readSnapshot([UNSUPPORTED_RULE]))).toBeInstanceOf(DependenciesUnsupportedError)
  })

  it('readIssueSnapshotWithReadout は、対象の Issue の読み取り結果も返す', async () => {
    const { client } = await startClient([prerequisitesRule({ number: 1, body: '本文の中身', subIssues: 2 })])
    const read = await readIssueSnapshotWithReadout(client, config(), TARGET)
    expect(read.kind === 'read' ? { body: read.issue.body, subIssues: read.issue.subIssuesTotal } : read).toEqual({ body: '本文の中身', subIssues: 2 })
  })
})

describe('snapshotWithoutPrerequisites', () => {
  it('一覧の値から、前提の無い読み取り結果を作る', async () => {
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
  it('前提が終わっていないのに開発ブランチが無ければ、読み取り結果を添えて読めないとする', async () => {
    const { client } = await startClient([prerequisitesRule({ number: 1, blockedBy: [{ number: 2 }] })])
    const snapshot = snapshotOf(await readIssueSnapshot(client, config(''), TARGET))
    expect(await judgeSnapshot(client, snapshot, createReadinessCache())).toEqual({ kind: 'unreadable', reason: 'develop_branch is not set for acme/demo', snapshot })
  })

  it('前提の PR の base を head に持つ PR を引き足して、開発ブランチまでたどる', async () => {
    const { readiness } = await readJudged([stackedOnFeature(), byHead([pullRequestNode(30)])])
    expect({ kind: readiness?.kind, stackOn: readiness?.stackOn }).toEqual({ kind: 'stackable', stackOn: { branch: 'feat/2', issue: createIssueReference(DEMO, 2) } })
  })

  it('引き足す PR が 1 本に決まらなければ、判定は diverged のままになる', async () => {
    const { readiness } = await readJudged([stackedOnFeature(), byHead([pullRequestNode(30), pullRequestNode(31)])])
    expect(readiness?.reason?.code).toBe('diverged')
  })

  it('続きのページがあれば、引き足さない', async () => {
    const { readiness } = await readJudged([stackedOnFeature(), byHead([pullRequestNode(30)], true)])
    expect(readiness?.reason?.code).toBe('diverged')
  })

  it('同じ head の引き足しは、キャッシュから使い回す', async () => {
    const { client } = await startClient([stackedOnFeature(), stackedOnFeature(), byHead([pullRequestNode(30)])])
    const cache = createReadinessCache()
    const first = judgedOf(await readIssueReadiness(client, config(), TARGET, cache))
    const second = judgedOf(await readIssueReadiness(client, config(), TARGET, cache))
    expect(second.readiness).toEqual(first.readiness)
  })

  it('引き足しの API が失敗したら、読み取り結果を添えて読めないとする', async () => {
    const { client } = await startClient([stackedOnFeature(), graphqlError('ListPullRequestsByHead', 'boom')])
    const result = await readIssueReadiness(client, config(), TARGET, createReadinessCache())
    expect(result.kind === 'unreadable' ? { reason: result.reason, hasSnapshot: result.snapshot !== undefined } : result).toEqual({ reason: BOOM, hasSnapshot: true })
  })

  it('読めない Issue は、判定せずにそのまま返す', async () => {
    const { client } = await startClient([graphqlError('GetIssuePrerequisites', 'boom')])
    expect(await readIssueReadiness(client, config(), TARGET, createReadinessCache())).toEqual({ kind: 'unreadable', reason: BOOM })
  })
})

describe('judgeAssuming', () => {
  it('前提を置き換えて判定し直す', async () => {
    const { client } = await startClient([prerequisitesRule({ number: 1, column: 'Blocked', blockedBy: [{ number: 2 }] })])
    const judged = judgedOf(await readIssueReadiness(client, config(), TARGET, createReadinessCache()))
    const assumed = judgedOf(await judgeAssuming(client, config(), judged, () => [], createReadinessCache()))
    expect({ before: judged.readiness?.kind, after: assumed.readiness?.kind, prerequisites: assumed.prerequisites }).toEqual({ before: 'blocked', after: 'startable', prerequisites: [] })
  })
})

describe('readinessJson', () => {
  it('スタック先と理由のコードを、無ければ null にして出す', () => {
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
  it('依存関係に対応しない GHES では、理由を渡して undefined を返す', async () => {
    const { client } = await startClient([UNSUPPORTED_RULE])
    const reasons: string[] = []
    const result = await readIssueReadinessIfSupported(client, config(), TARGET, createReadinessCache(), (reason) => {
      reasons.push(reason)
    })
    expect({ result, reasons }).toEqual({ result: undefined, reasons: [DEPENDENCIES_UNSUPPORTED] })
  })

  it('対応する GHES では、判定を返す', async () => {
    const { client } = await startClient([prerequisitesRule({ number: 1 })])
    const result = await readIssueReadinessIfSupported(client, config(), TARGET, createReadinessCache())
    expect(result?.kind === 'judged' ? result.readiness?.kind : result).toBe('startable')
  })
})
