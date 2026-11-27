import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import '../../../tests/_helpers/hint-commands.js'
import { formatHinted } from '../command-hint.js'
import { describeReadiness, judgeReadiness } from '../readiness.js'
import type { IssueFacts, IssuePullRequest, Prerequisite, Readiness } from '../readiness.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'
import { decideStart, inferStackedBase } from '../work-start.js'
import type { LowerProbe } from '../work-start.js'

const repository = createRepositoryReference('acme', 'demo')
const target = createIssueReference(repository, 7)
const lower = createIssueReference(repository, 3)
const SHA = '0123456789abcdef0123456789abcdef01234567'

function readiness(kind: Readiness['kind'], over: Partial<Readiness> = {}): Readiness {
  return { kind, stackOn: undefined, reason: undefined, needsReview: false, attention: [], ...over }
}

const stackable = readiness('stackable', { stackOn: { branch: 'feat/3', issue: lower } })

function probeOf(result: LowerProbe): () => LowerProbe {
  return () => result
}

function unexpectedProbe(): LowerProbe {
  throw new Error('probe must not be called')
}

describe('inferStackedBase', () => {
  it('判定が stackable で、HEAD が親ブランチの変更を持つと、親ブランチにスタックした記録を返す', async () => {
    await explains('スタックの推定のテストです。判定が `stackable` で HEAD が親ブランチの変更を持つ場合に、親ブランチにスタックした記録を返すことを確認します。')
    const inferred = inferStackedBase(stackable, [], target, probeOf({ kind: 'probed', isShared: true, sha: SHA }))
    expect(inferred).toEqual({ kind: 'stacked', record: { branch: 'feat/3', sha: SHA, stackedOn: lower }, stackedOn: lower })
  })

  it('判定が stackable でも、HEAD が親ブランチの変更を持たないと、開発ブランチからの着手として返す', async () => {
    await explains('スタックの推定のテストです。判定が `stackable` でも HEAD が親ブランチの変更を持たない場合に、開発ブランチからの着手として返すことを確認します。')
    expect(inferStackedBase(stackable, [], target, probeOf({ kind: 'probed', isShared: false, sha: SHA }))).toEqual({ kind: 'development' })
  })

  it('親ブランチの追跡参照が手元に無いと、git fetch の案内を添えた理由を返す', async () => {
    await explains('スタックの推定のテストです。親ブランチの追跡参照が手元に存在しない場合は、`git fetch` を案内する理由を返すことを確認します。')
    expect(inferStackedBase(stackable, [], target, probeOf({ kind: 'untracked', reference: 'origin/feat/3' }))).toEqual({ kind: 'unknown', reason: 'origin/feat/3 is not found; fetch it with: git fetch' })
  })

  it('親ブランチから分かれた点を求められないと、その理由を返す', async () => {
    await explains('スタックの推定のテストです。親ブランチから分かれた位置を求められない場合に、その理由を返すことを確認します。')
    expect(inferStackedBase(stackable, [], target, probeOf({ kind: 'probed', isShared: true, sha: undefined }))).toEqual({ kind: 'unknown', reason: 'cannot find where HEAD forked from feat/3' })
  })

  it.for([
    { name: 'startable', value: readiness('startable') },
    { name: '判定が無い Epic・Tracker', value: undefined },
  ])('判定が $name のときは、git を調べずに開発ブランチからの着手として返す', async ({ value }) => {
    await explains('スタックの推定のテストです。判定が `startable` の場合と、判定が存在しない Epic・Tracker の場合に、git を調べずに開発ブランチからの着手として返すことを確認します。')
    expect(inferStackedBase(value, [], target, unexpectedProbe)).toEqual({ kind: 'development' })
  })

  it('判定が blocked のときは、判定の文を理由に返す', async () => {
    await explains('スタックの推定のテストです。判定が `blocked` の場合に、判定の文を理由として返すことを確認します。')
    const blocked = readiness('blocked', { reason: { code: 'unreadable' } })
    expect(inferStackedBase(blocked, [], target, probeOf({ kind: 'probed', isShared: true, sha: SHA }))).toEqual({ kind: 'unknown', reason: describeReadiness(blocked, [], repository) })
  })
})

describe('decideStart', () => {
  const targetFacts: IssueFacts = { ref: target, state: 'open', column: undefined, label: undefined, kind: 'task', branches: [], pullRequests: [] }
  const mergedPullRequest: IssuePullRequest = { repository, number: 1003, state: 'merged', headRefName: 'feat/3', baseRefName: 'main', isDraft: false, isCrossRepository: false }
  const mergedOpen: Prerequisite = { issue: { ...targetFacts, ref: lower, pullRequests: [mergedPullRequest] }, wait: 'stack', reason: undefined }
  const unblockHint = 'to remove the prerequisite: issue_unblock with issue_ref: "acme/demo/7", by: "acme/demo/3"'

  function blockedText(prerequisite: Prerequisite): string {
    const judged = judgeReadiness({ target: targetFacts, prerequisites: [prerequisite], cycle: undefined, pullRequestsByHead: new Map(), developmentBranch: 'main' })
    const decision = decideStart(judged, [prerequisite], target)
    return decision.kind === 'blocked' ? formatHinted(decision.message, 'mcp') : decision.kind
  }

  it('マージ済みの PR を持つ open の前提で止める場合は、Issue を close するか再実行するよう案内する', async () => {
    await explains('着手の可否を決める関数のテストです。マージ済みの PR を持つ open の前提で止める場合に、Issue を close するか再実行するよう案内する文を表示することを確認します。')
    expect(blockedText(mergedOpen)).toBe([
      '#7 is blocked by #3 (not in review: #3 (PR merged, Issue open))',
      '- #3: PR merged, Issue open',
      '#3 has a merged PR: close #3, or retry once it closes',
      unblockHint,
    ].join('\n'))
  })

  it('スタックできない前提でも PR がマージ済みの場合は、マージ済みと表示し、スタックへ切り替える案内を表示しない', async () => {
    await explains('着手の可否を決める関数のテストです。スタックできない前提でも PR がマージ済みの場合に、マージ済みと表示し、スタックへ切り替える案内を表示しないことを確認します。')
    expect(blockedText({ ...mergedOpen, wait: 'merge', reason: '理由' })).toBe([
      '#7 is blocked by #3 (not in review: #3 (PR merged, Issue open))',
      '- #3: PR merged, Issue open',
      '#3 has a merged PR: close #3, or retry once it closes',
      unblockHint,
    ].join('\n'))
  })

  it('マージ済みの PR を持つ前提でも列が Pending の場合は、in Pending と表示し、マージ済みの案内の行を表示しない', async () => {
    await explains('着手の可否を決める関数のテストです。マージ済みの PR を持つ前提でも列が `Pending` の場合に、`in Pending` と表示し、マージ済みの案内の行を表示しないことを確認します。')
    const pending: Prerequisite = { ...mergedOpen, issue: { ...mergedOpen.issue, column: 'Pending' } }
    expect(blockedText(pending)).toBe([
      '#7 is blocked by #3 (not in review: #3 (in Pending))',
      '- #3: in Pending',
      unblockHint,
    ].join('\n'))
  })
})
