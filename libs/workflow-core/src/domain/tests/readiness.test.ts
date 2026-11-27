import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import type { IssuePrerequisitesReadout, IssueReadout, PullRequestReadout } from '../issue-readout.js'
import { createIssueReference } from '../reference-parser.js'
import type { IssueReference } from '../reference-parser.js'
import { readWaitsForMerge } from '../prerequisites.js'
import type { WaitsForMergeReadout } from '../prerequisites.js'
import { JSON_NULL } from '../json-null.js'
import {
  assumePullRequestState,
  cycleThrough,
  describePrerequisiteState,
  describeReadiness,
  describeReadinessChange,
  describeUnknown,
  findCycle,
  hasReadinessChanged,
  hasStarted,
  isDone,
  isInReview,
  isStackedOn,
  judgeReadiness,
  planProgression,
  progressionsFromReadiness,
  stackChains,
  toIssueFacts,
} from '../readiness.js'
import type { IssueFacts, IssuePullRequest, IssueWorkKind, PlannedPhase, Prerequisite, Progression, Readiness, Wait } from '../readiness.js'
import { createRepositoryReference } from '../repository-resolver.js'
import type { RepositoryReference } from '../repository-resolver.js'

const repository_ = createRepositoryReference('acme', 'app')
const otherRepository = createRepositoryReference('acme', 'other')
const DEV = 'main'

function reference(number: number, repository: RepositoryReference = repository_): IssueReference {
  return createIssueReference(repository, number)
}

function pullRequest(number: number, head: string, base: string = DEV, over: Partial<IssuePullRequest> = {}): IssuePullRequest {
  return { repository: repository_, number, state: 'open', headRefName: head, baseRefName: base, isDraft: false, isCrossRepository: false, ...over }
}

function issue(number: number, over: Partial<IssueFacts> = {}, repository: RepositoryReference = repository_): IssueFacts {
  return { ref: reference(number, repository), state: 'open', column: undefined, label: undefined, kind: 'task', branches: [], pullRequests: [], ...over }
}

// 番号 n の Issue が、head `b<n>` の PR を base に出している
function inReview(number: number, base: string = DEV, over: Partial<IssueFacts> = {}, repository: RepositoryReference = repository_): IssueFacts {
  return issue(number, { branches: [`b${String(number)}`], pullRequests: [pullRequest(number + 1000, `b${String(number)}`, base)], ...over }, repository)
}

function merged(number: number): IssueFacts {
  return issue(number, { state: 'closed', pullRequests: [pullRequest(number + 1000, `b${String(number)}`, DEV, { state: 'merged' })] })
}

function need(facts: IssueFacts, wait: Wait = 'stack', reason?: string): Prerequisite {
  return { issue: facts, wait, reason }
}

function reviewing(number: number, base: string = DEV, over: Partial<IssueFacts> = {}, repository: RepositoryReference = repository_): Prerequisite {
  return need(inReview(number, base, over, repository))
}

function reviewingMerge(number: number, reason: string): Prerequisite {
  return need(inReview(number), 'merge', reason)
}

function unstarted(number: number): Prerequisite {
  return need(issue(number))
}

function startedOnly(number: number): Prerequisite {
  return need(issue(number, { branches: ['x'] }))
}

function closedPrerequisite(): Prerequisite {
  return need(issue(1, { state: 'closed', pullRequests: [pullRequest(1001, 'b1', DEV, { state: 'closed' })] }))
}

function donePrerequisite(number: number): Prerequisite {
  return need(merged(number))
}

function judge(prerequisites: readonly Prerequisite[] | 'read-failed', over: { target?: IssueFacts, cycle?: readonly string[], byHead?: readonly IssuePullRequest[] } = {}): Readiness {
  const result = judgeReadiness({
    target: over.target ?? issue(100),
    prerequisites,
    cycle: over.cycle,
    pullRequestsByHead: new Map((over.byHead ?? []).map(value => [value.headRefName, value])),
    developmentBranch: DEV,
  })
  if (result === undefined) throw new Error('expected a readiness')
  return result
}

describe('isDone・isInReview・hasStarted', () => {
  it('PR を持たない closed の Issue と、merged の PR だけを持つ open の Issue は、済んだとみなさない', async () => {
    await explains('Issue が済んだ状態かどうかを判定する、`isDone` のテストです。PR を持たない closed の Issue や、merged の PR だけを持つ open の Issue が、済んだ状態にならないことを確認します。')
    expect(isDone(issue(1, { state: 'closed' }))).toBe(false)
    const facts1 = issue(1, { pullRequests: [pullRequest(1, 'a', DEV, { state: 'merged' })] })
    expect(isDone(facts1)).toBe(false)
    expect(isDone(merged(1))).toBe(true)
  })

  it('open の PR をちょうど 1 本持ち、fork からの PR でない Issue は、PR 中と判定する', async () => {
    await explains('Issue が PR 中かどうかを判定する、`isInReview` のテストです。open の PR が 1 本だけの Issue が PR 中になり、PR が存在しない場合や closed の場合などは PR 中にならないことを確認します。')
    expect(isInReview(inReview(1))).toBe(true)
    expect(isInReview(issue(1))).toBe(false)
    expect(isInReview(inReview(1, DEV, { state: 'closed' }))).toBe(false)
    const facts2 = issue(1, { pullRequests: [pullRequest(1, 'a'), pullRequest(2, 'b')] })
    expect(isInReview(facts2)).toBe(false)
    const facts3 = issue(1, { pullRequests: [pullRequest(1, 'a', DEV, { isCrossRepository: true })] })
    expect(isInReview(facts3)).toBe(false)
  })

  it('ドラフトの PR を持つ Issue と、open と closed の PR を 1 本ずつ持つ Issue は、PR 中と判定する', async () => {
    await explains('PR 中に数える境界の場合の、`isInReview` のテストです。ドラフトの PR を持つ Issue と、open と closed の PR を 1 本ずつ持つ Issue が、どちらも PR 中になることを確認します。')
    const facts4 = issue(1, { pullRequests: [pullRequest(1, 'a', DEV, { isDraft: true })] })
    expect(isInReview(facts4)).toBe(true)
    const facts5 = issue(1, { pullRequests: [pullRequest(1, 'a'), pullRequest(2, 'b', DEV, { state: 'closed' })] })
    expect(isInReview(facts5)).toBe(true)
  })

  it('ブランチか PR のどちらかが存在する Issue は、着手済みと判定する', async () => {
    await explains('Issue に着手した跡があるかを判定する、`hasStarted` のテストです。ブランチと PR の両方が存在しない場合は偽、どちらかが存在する場合は真になることを確認します。')
    expect(hasStarted(issue(1))).toBe(false)
    expect(hasStarted(issue(1, { branches: ['a'] }))).toBe(true)
    const facts6 = issue(1, { pullRequests: [pullRequest(1, 'a')] })
    expect(hasStarted(facts6)).toBe(true)
  })
})

describe('judgeReadiness の順', () => {
  it('順 1: 前提の読み取りに失敗すると unreadable で blocked になる', async () => {
    await explains('前提の Issue を読み取れなかった場合の判定のテストです。読み取りが失敗した場合に、理由を `unreadable` とする `blocked` を返すことを確認します。')
    expect(judge('read-failed')).toEqual({ kind: 'blocked', stackOn: undefined, reason: { code: 'unreadable' }, needsReview: false, attention: [] })
  })

  it('順 2: 輪があると cycle で blocked になる', async () => {
    await explains('前提の依存関係に循環がある場合の判定のテストです。循環を渡した場合に、理由を `cycle` とする `blocked` を返し、循環に含まれる Issue の並びを添えることを確認します。')
    expect(judge([reviewing(1)], { cycle: ['a', 'b', 'a'] }).reason).toEqual({ code: 'cycle', cycle: ['a', 'b', 'a'] })
  })

  it('順 3: 閉じて済んでいない前提があると closed-unmerged で blocked になる', async () => {
    await explains('閉じられたが merge されていない前提がある場合の判定のテストです。そのような前提が含まれる場合に、理由を `closed-unmerged` とする `blocked` を返し、見直しが必要になることを確認します。')
    const result = judge([closedPrerequisite(), reviewing(2)])
    expect(result.kind).toBe('blocked')
    expect(result.reason).toEqual({ code: 'closed-unmerged', issues: [reference(1)] })
    expect(result.needsReview).toBe(true)
  })

  it('順 4: 済んでいない merge の前提があると waits-merge で blocked になり、理由を添える', async () => {
    await explains('merge を待つ前提がある場合の判定のテストです。merge を待つ前提が済んでいない場合に、理由を `waits-merge` とする `blocked` を返し、添えた理由の文を含めることを確認します。')
    const result = judge([reviewingMerge(1, '理由'), reviewing(2)])
    expect(result.reason).toEqual({ code: 'waits-merge', issues: [{ issue: reference(1), reason: '理由' }] })
    expect(result.needsReview).toBe(false)
  })

  it('順 5: 前提が無ければ startable になる', async () => {
    await explains('前提が存在しない場合の判定のテストです。前提が 1 件もない場合に、`startable` を返すことを確認します。')
    expect(judge([])).toEqual({ kind: 'startable', stackOn: undefined, reason: undefined, needsReview: false, attention: [] })
  })

  it('順 6: 別のリポジトリの前提があると、other-repository で blocked になる', async () => {
    await explains('別のリポジトリの前提がある場合の判定のテストです。別のリポジトリの Issue が前提に含まれる場合、理由を `other-repository` とする `blocked` を返すことを確認します。')
    const result = judge([reviewing(1, DEV, {}, otherRepository), reviewing(2)])
    expect(result.reason).toEqual({ code: 'other-repository', issues: [reference(1, otherRepository)] })
  })

  it('順 6: 前提の Issue が同じリポジトリでも、その PR が別のリポジトリにあると other-repository で blocked になる', async () => {
    await explains('前提の PR だけが別のリポジトリにある場合の判定のテストです。前提の Issue が同じリポジトリでも、その PR が別のリポジトリにあれば、理由を `other-repository` とする `blocked` になることを確認します。')
    const facts = issue(1, { pullRequests: [pullRequest(1001, 'b1', DEV, { repository: otherRepository })] })
    const result = judge([need(facts)])
    expect(result.kind).toBe('blocked')
    expect(result.reason).toEqual({ code: 'other-repository', issues: [reference(1)] })
  })

  it('順 8: 別のリポジトリの PR は、base をたどる途中の PR として扱わない', async () => {
    await explains('スタック先を決めるために base のブランチをたどる処理のテストです。head が同じ PR が別のリポジトリにある場合は、その PR をたどらず `diverged` を返すことを確認します。')
    const prerequisites = [reviewing(1), reviewing(3, 'b2')]
    expect(judge(prerequisites, { byHead: [pullRequest(1002, 'b2', 'b1', { repository: otherRepository })] }).reason?.code).toBe('diverged')
  })

  it('順 6 の判定では、リポジトリ名の大文字と小文字を区別しない', async () => {
    await explains('リポジトリ名の大文字と小文字の扱いのテストです。前提のリポジトリ名が `ACME/App` のように大文字を含む場合でも、同じリポジトリとみなして `stackable` を返すことを確認します。')
    const upper = createRepositoryReference('ACME', 'App')
    expect(judge([reviewing(1, DEV, {}, upper)]).kind).toBe('stackable')
  })

  it.for([
    { name: '着手済みで PR が無い前提', facts: issue(1, { branches: ['x'] }), expected: 'started-without-pr' },
    { name: 'merged の PR だけの open の前提', facts: issue(1, { pullRequests: [pullRequest(1, 'x', DEV, { state: 'merged' })] }), expected: 'merged-open' },
    { name: 'merged の PR とブランチを持つ open の前提', facts: issue(1, { branches: ['x'], pullRequests: [pullRequest(1, 'x', DEV, { state: 'merged' })] }), expected: 'merged-open' },
    { name: '列が Pending で merged の PR を持つ前提', facts: issue(1, { column: 'Pending', pullRequests: [pullRequest(1, 'x', DEV, { state: 'merged' })] }), expected: 'pending' },
    { name: 'merged の PR と fork からの open の PR を持つ前提', facts: issue(1, { pullRequests: [pullRequest(1, 'x', DEV, { state: 'merged' }), pullRequest(2, 'y', DEV, { isCrossRepository: true })] }), expected: 'fork-pr' },
    { name: '未着手の前提', facts: issue(1), expected: 'not-started' },
    { name: 'PR が 2 本の前提', facts: issue(1, { pullRequests: [pullRequest(1, 'x'), pullRequest(2, 'y')] }), expected: 'multiple-prs' },
    { name: 'fork からの PR の前提', facts: issue(1, { pullRequests: [pullRequest(1, 'x', DEV, { isCrossRepository: true })] }), expected: 'fork-pr' },
    { name: '列が Pending の前提', facts: inReview(1, DEV, { column: 'Pending' }), expected: 'pending' },
  ])('順 7: $name は $expected として not-in-review になる', async ({ facts, expected }) => {
    await explains(`前提が PR 中でない場合の判定のテストです。前提の状態が \`${expected}\` と分類される場合、理由を \`not-in-review\` とする \`blocked\` を返すことを確認します。`)
    expect(judge([need(facts)]).reason).toEqual({ code: 'not-in-review', issues: [{ issue: reference(1), state: expected }] })
  })

  it('順 7: PR 中でない前提をすべて一覧に含め、PR 中の前提は含めない', async () => {
    await explains('PR 中でない前提が複数ある場合の判定のテストです。未着手の前提と PR が存在しない前提を一覧に含め、PR 中の前提は含めないことを確認します。')
    const result = judge([unstarted(1), reviewing(2), startedOnly(3)])
    expect(result.reason).toEqual({
      code: 'not-in-review',
      issues: [{ issue: reference(1), state: 'not-started' }, { issue: reference(3), state: 'started-without-pr' }],
    })
  })

  it('merge を待つ前提でも、PR が merged で Issue が open なら、waits-merge でなく merged-open として not-in-review になる', async () => {
    await explains('merge を待つ前提で、PR が merged のまま Issue が open の場合の判定のテストです。`waits-merge` ではなく、状態を `merged-open` とする `not-in-review` の理由で `blocked` になることを確認します。')
    const facts = issue(1, { pullRequests: [pullRequest(1001, 'b1', DEV, { state: 'merged' })] })
    expect(judge([need(facts, 'merge', '理由')]).reason).toEqual({ code: 'not-in-review', issues: [{ issue: reference(1), state: 'merged-open' }] })
  })

  it('merged の PR と open の PR を 1 本ずつ持つ前提は、open の PR にスタックする', async () => {
    await explains('前提が merged の PR と open の PR を 1 本ずつ持つ場合の判定のテストです。open の PR の head をスタック先とする `stackable` を返すことを確認します。')
    const facts = inReview(1, DEV, { pullRequests: [pullRequest(1000, 'old', DEV, { state: 'merged' }), pullRequest(1001, 'b1')] })
    expect(judge([need(facts)])).toMatchObject({ kind: 'stackable', stackOn: { branch: 'b1', issue: reference(1) } })
  })

  it('順 8: 前提が 1 件なら、その PR の head にスタックする', async () => {
    await explains('前提が 1 件の場合の判定のテストです。前提が PR 中の Issue 1 件だけなら、その PR の head をスタック先とする `stackable` を返すことを確認します。')
    const result = judge([reviewing(1)])
    expect(result).toEqual({ kind: 'stackable', stackOn: { branch: 'b1', issue: reference(1) }, reason: undefined, needsReview: false, attention: [] })
  })

  it('順 8: 3 件を逆の順で渡しても、鎖の一番上にスタックする', async () => {
    await explains('前提が鎖になっている場合の判定のテストです。3 件の前提を昇順と降順のどちらの順で渡しても、鎖の一番上の PR の head をスタック先にすることを確認します。')
    const one = inReview(1)
    const two = inReview(2, 'b1')
    const three = inReview(3, 'b2')
    for (const order of [[one, two, three], [three, two, one]]) {
      expect(judge(order.map(value => need(value))).stackOn).toEqual({ branch: 'b3', issue: reference(3) })
    }
  })

  it('順 8: 間接の前提を挟む鎖にもスタックできる', async () => {
    await explains('前提の間に、前提に含まれない Issue の PR が挟まる場合の判定のテストです。間接の PR を渡した場合に、鎖がつながっているとみなし、一番上の前提の head をスタック先にすることを確認します。')
    const one = inReview(1)
    const three = inReview(3, 'b2')
    const indirect = pullRequest(1002, 'b2', 'b1')
    const result = judge([need(one), need(three)], { byHead: [indirect] })
    expect(result.stackOn).toEqual({ branch: 'b3', issue: reference(3) })
  })

  it('順 8: 間接の PR が存在しないと、鎖が切れて diverged になる', async () => {
    await explains('前提の間をつなぐ PR が存在しない場合の判定のテストです。base をたどっても前提どうしがつながらないため、理由を `diverged` とする `blocked` を返すことを確認します。')
    expect(judge([reviewing(1), reviewing(3, 'b2')]).reason).toEqual({ code: 'diverged', issues: [reference(1), reference(3)] })
  })

  it('順 8: base がどちらも開発ブランチの 2 本は diverged になる', async () => {
    await explains('前提が 2 件とも開発ブランチを base にしている場合の判定のテストです。1 本の鎖にならないため、理由を `diverged` とする `blocked` を返すことを確認します。')
    const result = judge([reviewing(1), reviewing(2)])
    expect(result.kind).toBe('blocked')
    expect(result.reason).toEqual({ code: 'diverged', issues: [reference(1), reference(2)] })
  })

  it('順 8: base をたどる途中で輪になっても止まり、開発ブランチに届かない列は diverged になる', async () => {
    await explains('base をたどる途中で循環する場合の判定のテストです。たどる処理が止まり、開発ブランチに届かない前提について、理由を `diverged` とする `blocked` を返すことを確認します。')
    const result = judge([reviewing(1, 'b2'), reviewing(2, 'b1')])
    expect(result.kind).toBe('blocked')
    expect(result.reason).toEqual({ code: 'diverged', issues: [reference(1), reference(2)] })
  })

  const untraversed: readonly { readonly name: string, readonly over: Partial<IssuePullRequest> }[] = [
    { name: 'merged の PR', over: { state: 'merged' } },
    { name: 'closed の PR', over: { state: 'closed' } },
    { name: 'fork からの PR', over: { isCrossRepository: true } },
  ]
  it.for(untraversed)('順 8: head が同じ $name は、base をたどる先にしない', async ({ over }) => {
    await explains('base のブランチをたどる処理のテストです。head が同じ PR が merged や closed、fork からの PR なら、たどらず `diverged` になることを確認します。')
    const prerequisites = [reviewing(1), reviewing(3, 'b2')]
    expect(judge(prerequisites, { byHead: [pullRequest(1002, 'b2', 'b1', over)] }).reason?.code).toBe('diverged')
    expect(judge(prerequisites, { byHead: [pullRequest(1002, 'b2', 'b1')] }).kind).toBe('stackable')
  })

  it('順 8: 開発ブランチを head に持つ PR は、スタック先の途中として通らない', async () => {
    await explains('スタック先をたどる途中の PR のテストです。開発ブランチを head に持つ PR がある場合に、その PR をたどる先にせず、`diverged` を返すことを確認します。')
    const result = judge([reviewing(1), reviewing(2)], { byHead: [pullRequest(2000, DEV, 'x')] })
    expect(result.reason?.code).toBe('diverged')
  })

  it('済んだ merge の前提と、済んだ別のリポジトリの前提は、判定の対象にしない', async () => {
    await explains('済んだ前提を判定から除くことのテストです。済んだ merge の前提と別のリポジトリの前提だけなら `startable` になり、PR 中の前提が加わるとその head をスタック先にすることを確認します。')
    const doneMerge = need(merged(1), 'merge', '理由')
    const doneOther = need({ ...merged(2), ref: reference(2, otherRepository) })
    expect(judge([doneMerge, doneOther]).kind).toBe('startable')
    expect(judge([doneMerge, doneOther, reviewing(3)]).stackOn).toEqual({ branch: 'b3', issue: reference(3) })
  })

  it('前提がすべて済んでいれば startable になる', async () => {
    await explains('前提がすべて済んでいる場合の判定のテストです。済んだ前提だけを渡した場合に、`startable` を返すことを確認します。')
    expect(judge([donePrerequisite(1), donePrerequisite(2)]).kind).toBe('startable')
  })
})

describe('judgeReadiness の順の優先', () => {
  it('順 2 と順 3 が同時に成り立つと、順 2 が勝つ', async () => {
    await explains('判定の順の優先のテストです。循環と、閉じて済んでいない前提が同時に成り立つ場合に、順 2 の `cycle` が優先されることを確認します。')
    expect(judge([closedPrerequisite()], { cycle: ['a', 'a'] }).reason?.code).toBe('cycle')
  })

  it('順 3 と順 4 が同時に成り立つと、順 3 が勝つ', async () => {
    await explains('判定の順の優先のテストです。閉じて済んでいない前提と、merge を待つ前提が同時に成り立つ場合に、順 3 の `closed-unmerged` が優先されることを確認します。')
    expect(judge([closedPrerequisite(), reviewingMerge(2, 'r')]).reason?.code).toBe('closed-unmerged')
  })

  it('順 4 と順 6 が同時に成り立つと、順 4 が勝つ', async () => {
    await explains('判定の順の優先のテストです。merge を待つ前提と、別のリポジトリの前提が同時に成り立つ場合に、順 4 の `waits-merge` が優先されることを確認します。')
    expect(judge([reviewing(1, DEV, {}, otherRepository), reviewingMerge(2, 'r')]).reason?.code).toBe('waits-merge')
  })

  it('順 6 と順 7 が同時に成り立つと、順 6 が勝つ', async () => {
    await explains('判定の順の優先のテストです。別のリポジトリの前提と、未着手の前提が同時に成り立つ場合に、順 6 の `other-repository` が優先されることを確認します。')
    expect(judge([reviewing(1, DEV, {}, otherRepository), unstarted(2)]).reason?.code).toBe('other-repository')
  })

  it('順 7 と順 8 が同時に成り立つと、順 7 が勝つ', async () => {
    await explains('判定の順の優先のテストです。PR 中でない前提と、スタック先が複数になる前提が同時に成り立つ場合に、順 7 の `not-in-review` が優先されることを確認します。')
    expect(judge([unstarted(1), reviewing(2), reviewing(3)]).reason?.code).toBe('not-in-review')
  })
})

describe('judgeReadiness の見直しと注記', () => {
  it('順 1 では見直しは要らず、順 2 で止まっても閉じて済んでいない前提があれば要る', async () => {
    await explains('見直しが必要かどうかの判定のテストです。前提の読み取りに失敗した場合は不要で、循環で止まった場合も、閉じて済んでいない前提があれば必要になることを確認します。')
    expect(judge('read-failed').needsReview).toBe(false)
    expect(judge([closedPrerequisite()], { cycle: ['a', 'a'] }).needsReview).toBe(true)
    expect(judge([reviewing(1)], { cycle: ['a', 'a'] }).needsReview).toBe(false)
  })

  it('前提がすべて済んでいれば、見直しは要らない', async () => {
    await explains('前提がすべて済んでいる場合の、見直しの要否のテストです。済んだ前提だけの場合に、見直しが不要になることを確認します。')
    expect(judge([donePrerequisite(1)]).needsReview).toBe(false)
  })

  it('ラベルが Needs Attention の前提は、注記に含め、判定の区分は変えない', async () => {
    await explains('前提のラベルが `Needs Attention` の場合の注記のテストです。済んでいない前提は注記に含め、済んだ前提と読み取りに失敗した場合は含めず、どの場合も判定の区分は変えないことを確認します。')
    const flagged = inReview(1, DEV, { label: 'Needs Attention' })
    const startable = judge([need({ ...merged(2), label: 'Needs Attention' }), donePrerequisite(3)])
    expect(startable.kind).toBe('startable')
    expect(startable.attention).toEqual([])
    const stackable = judge([need(flagged)])
    expect(stackable.kind).toBe('stackable')
    expect(stackable.attention).toEqual([reference(1)])
    expect(judge('read-failed').attention).toEqual([])
  })

  it('blocked の場合も、済んでいない前提のラベルが Needs Attention なら注記に含める', async () => {
    await explains('`blocked` の場合の注記のテストです。済んでいない前提のラベルが `Needs Attention` なら、`blocked` の理由とは別に、その前提を注記に含めることを確認します。')
    const flagged = need(issue(1, { label: 'Needs Attention' }))
    const result = judge([flagged, reviewing(2)])
    expect(result.kind).toBe('blocked')
    expect(result.reason?.code).toBe('not-in-review')
    expect(result.attention).toEqual([reference(1)])
  })
})

const nonTaskKinds: readonly { readonly kind: IssueWorkKind }[] = [{ kind: 'epic' }, { kind: 'tracker' }]

describe('Epic と Tracker', () => {
  it.for(nonTaskKinds)('$kind には判定を返さない', async ({ kind }) => {
    await explains('Epic と Tracker の判定のテストです。対象の種別が `epic` または `tracker` の場合に、判定の結果を返さず `undefined` になることを確認します。')
    const result = judgeReadiness({ target: issue(1, { kind }), prerequisites: [], cycle: undefined, pullRequestsByHead: new Map(), developmentBranch: DEV })
    expect(result).toBeUndefined()
  })
})

function phase(key: string, ...prerequisites: readonly (readonly [string, Wait?])[]): PlannedPhase {
  return { key, prerequisites: prerequisites.map(([name, wait = 'stack']) => ({ key: name, wait })) }
}

function planned(phases: readonly PlannedPhase[]): ReadonlyMap<string, Progression> {
  const plan = planProgression(phases)
  if (plan.kind === 'cycle') throw new Error('unexpected cycle')
  return plan.progressions
}

const quickstart = [
  phase('phase1'),
  phase('phase2', ['phase1']),
  phase('phase3', ['phase2']),
  phase('phase4', ['phase2']),
  phase('phase5', ['phase3'], ['phase4', 'merge']),
]

describe('planProgression', () => {
  it('前提が存在しなければ alone になり、merge の前提があれば他の前提の形を問わず wait-merge になる', async () => {
    await explains('フェーズの進め方を決める `planProgression` のテストです。前提を持たないフェーズは `alone`、merge を待つ前提を持つフェーズは `wait-merge` になることを確認します。')
    const progressions = planned([phase('a'), phase('b', ['a'], ['c', 'merge']), phase('c'), phase('d', ['a', 'merge'])])
    expect(progressions.get('a')).toEqual({ kind: 'alone' })
    expect(progressions.get('b')).toEqual({ kind: 'wait-merge' })
    expect(progressions.get('d')).toEqual({ kind: 'wait-merge' })
  })

  it('前提が 1 つなら、その前提にスタックする', async () => {
    await explains('前提が 1 つのフェーズのテストです。前提が 1 つだけの場合に、その前提の上にスタックする進め方（`stack`）になることを確認します。')
    expect(planned([phase('a'), phase('b', ['a'])]).get('b')).toEqual({ kind: 'stack', on: 'a' })
  })

  it('互いに依存しない 2 件の前提は join になる', async () => {
    await explains('前提が 2 つで、互いに依存しない場合のテストです。どちらの前提からも他方へ届かない場合に、進め方が `join` になることを確認します。')
    expect(planned([phase('a'), phase('b'), phase('c', ['a'], ['b'])]).get('c')).toEqual({ kind: 'join' })
  })

  it('前提の一方がもう一方に依存している場合は、依存している側の前提にスタックする', async () => {
    await explains('前提どうしに依存関係がある場合のテストです。一方の前提が他方に依存している場合、依存している側の前提の上へスタックする進め方になることを確認します。')
    const progressions = planned([phase('a'), phase('b', ['a']), phase('c', ['a'], ['b'])])
    expect(progressions.get('c')).toEqual({ kind: 'stack', on: 'b' })
  })

  it('既存の Issue を経由して依存している前提にも、スタックする', async () => {
    await explains('前提の依存が既存の Issue を経由する場合のテストです。フェーズ `b` が `a` と既存の Issue の両方を前提にし、`a` が既存の Issue に依存しているときに、`a` の上にスタックすることを確認します。')
    const progressions = planned([phase('a', ['acme/app/9']), phase('b', ['a'], ['acme/app/9'])])
    expect(progressions.get('b')).toEqual({ kind: 'stack', on: 'a' })
  })

  it('merge を待つ依存は、前提どうしの依存関係の判定に使わない', async () => {
    await explains('merge を待つ依存の扱いのテストです。merge を待つ依存は、前提どうしが届くかどうかの判定に使わず、進め方が `join` になることを確認します。')
    const progressions = planned([phase('a'), phase('b', ['a', 'merge']), phase('c', ['a'], ['b'])])
    expect(progressions.get('c')).toEqual({ kind: 'join' })
  })

  it('循環があれば、進め方を返さずに循環を返す', async () => {
    await explains('依存関係に循環がある場合のテストです。進め方を返さず、`cycle` の種別と、循環に含まれるフェーズの並びを返すことを確認します。')
    expect(planProgression([phase('a', ['b']), phase('b', ['a'])])).toEqual({ kind: 'cycle', cycle: ['a', 'b', 'a'] })
  })

  it('quickstart の 5 フェーズの進め方を出す', async () => {
    await explains('5 つのフェーズからなる例（quickstart）の進め方のテストです。最初のフェーズが `alone`、途中の 3 つがそれぞれの前提へのスタック、最後のフェーズが `wait-merge` になることを確認します。')
    const progressions = planned(quickstart)
    expect([...progressions]).toEqual([
      ['phase1', { kind: 'alone' }],
      ['phase2', { kind: 'stack', on: 'phase1' }],
      ['phase3', { kind: 'stack', on: 'phase2' }],
      ['phase4', { kind: 'stack', on: 'phase2' }],
      ['phase5', { kind: 'wait-merge' }],
    ])
  })
})

describe('stackChains', () => {
  it('quickstart の 5 フェーズは、枝分かれして 2 本のスタックの並びになる', async () => {
    await explains('スタックの並びを求める `stackChains` のテストです。5 つのフェーズの例で、枝分かれした 2 本の並び（`phase1 -> phase2 -> phase3` と `phase1 -> phase2 -> phase4`）を返すことを確認します。')
    expect(stackChains(planned(quickstart)).map(chain => chain.join(' -> '))).toEqual([
      'phase1 -> phase2 -> phase3',
      'phase1 -> phase2 -> phase4',
    ])
  })

  it('stack の循環があっても処理が止まり、循環の外の並びだけを返す', async () => {
    await explains('スタックの並びに循環がある場合のテストです。循環に含まれるフェーズを除き、循環の外の並びだけを返して、処理が止まらないことを確認します。')
    const progressions = new Map<string, Progression>([
      ['x', { kind: 'stack', on: 'y' }],
      ['y', { kind: 'stack', on: 'x' }],
      ['b', { kind: 'stack', on: 'a' }],
    ])
    expect(stackChains(progressions)).toEqual([['a', 'b']])
  })

  it('スタック先を持つフェーズが存在しなければ、並びを返さない', async () => {
    await explains('スタック先を持たないフェーズだけの場合のテストです。スタックするフェーズが存在しない場合に、空の配列を返すことを確認します。')
    const progressions = planned([phase('a'), phase('b', ['a', 'merge']), phase('c', ['a'], ['b'])])
    expect(stackChains(progressions)).toEqual([])
  })

  it('スタック先が既存の Issue なら、その Issue から始まる並びを返す', async () => {
    await explains('スタック先が既存の Issue の場合のテストです。既存の Issue を先頭にした並びを返すことを確認します。')
    const progressions = planned([phase('a', ['acme/app/9']), phase('b', ['a'])])
    expect(stackChains(progressions)).toEqual([['acme/app/9', 'a', 'b']])
  })
})

function expectedOutcome(progression: Progression | undefined, heads: ReadonlyMap<string, string>): string {
  switch (progression?.kind) {
    case 'alone': { return 'startable'
    }
    case 'wait-merge': { return 'waits-merge'
    }
    case 'join': { return 'diverged'
    }
    case 'stack': { return `stackable:${heads.get(progression.on) ?? ''}`
    }
    case undefined: { return 'missing'
    }
  }
}

describe('進め方と判定の一致', () => {
  // 同じリポの入力だけで、すべての前提を PR 中と置いて判定する。PR の base は、スタック先の head にそろえる
  const cases: readonly { readonly name: string, readonly phases: readonly PlannedPhase[] }[] = [
    { name: 'quickstart の 5 フェーズ', phases: quickstart },
    { name: 'join を含む並び', phases: [phase('a'), phase('b'), phase('c', ['a'], ['b']), phase('d', ['a'])] },
    { name: '間接の前提を付けた並び', phases: [phase('a'), phase('b', ['a']), phase('c', ['a'], ['b'])] },
    { name: 'merge の辺を届くかの判定に使わない並び', phases: [phase('a'), phase('b', ['a', 'merge']), phase('c', ['a'], ['b'])] },
    { name: '既存の Issue を経由して届く並び', phases: [phase('a', ['acme/app/9']), phase('b', ['a'], ['acme/app/9'])] },
  ]

  it.for(cases)('$name では、判定の結果が進め方と一致する', async ({ phases }) => {
    await explains('進め方と判定の結果が一致することのテストです。すべての前提を PR 中として判定した結果が、フェーズの進め方から期待する結果と、複数の並びで一致することを確認します。')
    const progressions = planned(phases)
    // フェーズに無いキー（既存の Issue、`acme/app/9`）は、末尾の数字を番号にして PR 中に置く
    const numbers = new Map(phases.map((value, index) => [value.key, index + 1]))
    const prerequisiteKeys = phases.flatMap(value => value.prerequisites)
    for (const { key } of prerequisiteKeys) {
      if (!numbers.has(key)) numbers.set(key, Number(key.split('/').at(-1)))
    }
    const heads = new Map([...numbers].map(([key, number]) => [key, `b${String(number)}`]))
    const facts = new Map([...numbers].map(([key, number]) => {
      const progression = progressions.get(key)
      return [key, inReview(number, progression?.kind === 'stack' ? heads.get(progression.on) : DEV)]
    }))
    const byHead = [...numbers].flatMap(([key]) => facts.get(key)?.pullRequests ?? [])

    const actual = phases.map((value) => {
      const prerequisites = value.prerequisites.map(({ key, wait }) => need(facts.get(key) ?? issue(0), wait, 'r'))
      const result = judge(prerequisites, { target: facts.get(value.key) ?? issue(0), byHead })
      return result.kind === 'stackable' ? `stackable:${result.stackOn?.branch ?? ''}` : (result.reason?.code ?? result.kind)
    })
    expect(actual).toEqual(phases.map(value => expectedOutcome(progressions.get(value.key), heads)))
  })
})

function edges(entries: readonly (readonly [string, readonly string[]])[]): ReadonlyMap<string, readonly string[]> {
  return new Map(entries)
}

describe('findCycle', () => {
  it('3 つのノードがつながる循環を、始点を末尾にも置いて返す', async () => {
    await explains('循環を探す `findCycle` のテストです。3 つのノードがつながる循環を、始点を末尾にも置いた並びで返すことを確認します。')
    expect(findCycle(edges([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual(['a', 'b', 'c', 'a'])
  })

  it('自分自身への依存は、長さ 1 の循環になる', async () => {
    await explains('自分自身へ依存する場合の、`findCycle` のテストです。自分自身を指すノードが、同じキーを 2 回並べた循環になることを確認します。')
    expect(findCycle(edges([['a', ['a']]]))).toEqual(['a', 'a'])
  })

  it('循環が存在しなければ undefined を返す', async () => {
    await explains('循環が存在しない場合の、`findCycle` のテストです。循環を持たない入力と空の入力で、`undefined` を返すことを確認します。')
    expect(findCycle(edges([['a', ['b', 'c']], ['b', ['c']], ['c', []]]))).toBeUndefined()
    expect(findCycle(edges([]))).toBeUndefined()
  })

  it('循環の外から入る依存でも、その循環を見つける', async () => {
    await explains('循環の途中から入る場合の、`findCycle` のテストです。始点が循環に含まれず、途中から循環に入る依存でも、その循環を返すことを確認します。')
    expect(findCycle(edges([['a', ['b']], ['b', ['c']], ['c', ['d']], ['d', ['b']]]))).toEqual(['b', 'c', 'd', 'b'])
  })

  it('入力の順を変えても、始点がキーの最小の同じ輪を返す', async () => {
    await explains('入力の順が異なる場合の、`findCycle` のテストです。同じ循環を入力の順を入れ替えて渡しても、キーが最小のノードを始点にした同じ並びを返すことを確認します。')
    const forward = edges([['c', ['a']], ['a', ['b']], ['b', ['c']]])
    const backward = edges([['b', ['c']], ['a', ['b']], ['c', ['a']]])
    expect(findCycle(forward)).toEqual(['a', 'b', 'c', 'a'])
    expect(findCycle(backward)).toEqual(['a', 'b', 'c', 'a'])
  })

  it('依存先のキーが表に存在しなくても、処理できる', async () => {
    await explains('依存先が入力の表に存在しない場合の、`findCycle` のテストです。依存先のキーが表に含まれなくても、例外を発生させず `undefined` を返すことを確認します。')
    expect(findCycle(edges([['a', ['x']]]))).toBeUndefined()
  })
})

function prReadout(number: number, head: string, over: Partial<PullRequestReadout> = {}, repository: RepositoryReference = repository_): PullRequestReadout {
  return { repository, number, state: 'OPEN', headRefName: head, baseRefName: DEV, isDraft: false, isCrossRepository: false, ...over }
}

function issueReadout(number: number, over: Partial<IssueReadout> = {}): IssueReadout {
  return {
    id: `id${String(number)}`,
    repository: repository_,
    number,
    state: 'OPEN',
    title: `Issue ${String(number)}`,
    issueType: 'Task',
    subIssuesTotal: 0,
    projectFieldValues: [],
    linkedBranches: [],
    closingPullRequests: [],
    ...over,
  }
}

function readout(blockers: IssuePrerequisitesReadout['blockedBy'], target: Partial<IssueReadout> = {}): IssuePrerequisitesReadout {
  return { issue: { ...issueReadout(100, target), body: '', parent: JSON_NULL }, blockedBy: blockers }
}

const options = { columnFieldId: 'f1', labelFieldName: 'Status' }
const absent: WaitsForMergeReadout = { kind: 'absent' }

function kindOf(over: Partial<IssueReadout>): string {
  return toIssueFacts(readout({ kind: 'ok', issues: [] }, over), absent, options).target.kind
}

describe('toIssueFacts', () => {
  it('読み取った Issue と PR の状態から、済んだ・PR 中・着手済みの判定に使う値を作成する', async () => {
    await explains('読み取った前提の Issue を、判定用の値に変換する `toIssueFacts` のテストです。merged の PR を持つ closed の Issue、ドラフトの PR を持つ Issue、closed の PR を持つ Issue が、それぞれ期待どおりの状態になることを確認します。')
    const blocker = issueReadout(1, {
      state: 'CLOSED',
      linkedBranches: [{ name: 'b1', pullRequests: [prReadout(11, 'b1', { state: 'MERGED' })] }],
    })
    const open = issueReadout(2, { closingPullRequests: [prReadout(12, 'b2', { isDraft: true })] })
    const dropped = issueReadout(3, { closingPullRequests: [prReadout(13, 'b3', { state: 'CLOSED' })] })
    const { prerequisites } = toIssueFacts(readout({ kind: 'ok', issues: [blocker, open, dropped] }), absent, options)
    if (prerequisites === 'read-failed') throw new Error('unexpected')
    const [first, second, third] = prerequisites.map(value => value.issue)
    expect(first && isDone(first)).toBe(true)
    expect(first?.branches).toEqual(['b1'])
    expect(second && isInReview(second)).toBe(true)
    expect(second?.pullRequests[0]?.isDraft).toBe(true)
    expect(third?.pullRequests[0]?.state).toBe('closed')
    expect(third && hasStarted(third)).toBe(true)
  })

  it('ボードの列・ラベル・種別と、Issue 自身の状態を、判定用の値に変換する', async () => {
    await explains('`toIssueFacts` が、ボードの列・ラベル・種別と Issue の状態を変換することのテストです。列とラベルの値が設定されている場合は `Ready` と `Todo` になり、設定されていない場合は `undefined` になることを確認します。')
    const facts = toIssueFacts(readout({ kind: 'ok', issues: [] }, {
      state: 'CLOSED',
      projectFieldValues: [
        { fieldId: 'f1', fieldName: 'pecot-workflow-x', optionId: 'o1', optionName: 'Ready' },
        { fieldId: 'f2', fieldName: 'Status', optionId: 'o2', optionName: 'Todo' },
        { fieldId: 'f3', fieldName: 'Other', optionId: 'o3', optionName: 'Ignored' },
      ],
    }), absent, options).target
    expect(facts).toMatchObject({ ref: reference(100), state: 'closed', column: 'Ready', label: 'Todo', kind: 'task' })
    const unset = toIssueFacts(readout({ kind: 'ok', issues: [] }), absent, options).target
    expect(unset).toMatchObject({ column: undefined, label: undefined })
  })

  it('Issue の種別から、Epic と Tracker を判別する', async () => {
    await explains('`toIssueFacts` が Issue の種別を判別することのテストです。Epic の型またはサブ Issue を持つ Issue は `epic`、タイトルが `[Tracker]` で始まる Issue は `tracker`、それ以外は `task` になることを確認します。')
    expect(kindOf({ issueType: 'Epic' })).toBe('epic')
    expect(kindOf({ issueType: JSON_NULL, subIssuesTotal: 2 })).toBe('epic')
    expect(kindOf({ title: '[Tracker] security' })).toBe('tracker')
    expect(kindOf({ title: 'about [Tracker]' })).toBe('task')
  })

  it('リンクしたブランチと閉じる参照の両方に現れる同じ PR は、1 本として数える', async () => {
    await explains('`toIssueFacts` が PR の重複を除くことのテストです。リンクしたブランチと閉じる参照の両方に同じ PR があり、リポジトリ名の大文字と小文字だけが異なる場合に、PR を 1 本として数えることを確認します。')
    const blocker = issueReadout(1, {
      linkedBranches: [{ name: 'b1', pullRequests: [prReadout(11, 'b1')] }],
      closingPullRequests: [prReadout(11, 'b1', { repository: createRepositoryReference('ACME', 'App') })],
    })
    const { prerequisites } = toIssueFacts(readout({ kind: 'ok', issues: [blocker] }), absent, options)
    expect(prerequisites === 'read-failed' ? [] : prerequisites[0]?.issue.pullRequests).toHaveLength(1)
  })

  it('別のリポジトリにある同じ番号の PR は、別の PR として数える', async () => {
    await explains('`toIssueFacts` が PR の重複を除くときの境界のテストです。番号と head が同じでも別のリポジトリの PR は同じ PR とみなさず、2 本として数えることを確認します。')
    const blocker = issueReadout(1, {
      closingPullRequests: [prReadout(11, 'b1')],
      linkedBranches: [{ name: 'b1', pullRequests: [prReadout(11, 'b1', {}, otherRepository)] }],
    })
    const { prerequisites } = toIssueFacts(readout({ kind: 'ok', issues: [blocker] }), absent, options)
    expect(prerequisites === 'read-failed' ? [] : prerequisites[0]?.issue.pullRequests).toHaveLength(2)
  })

  it('リンクしたブランチの fork からの PR は捨て、閉じる参照の fork からの PR は残す', async () => {
    await explains('`toIssueFacts` が fork からの PR を扱うことのテストです。リンクしたブランチ経由の fork からの PR は結果に含めず、閉じる参照経由の fork からの PR は含めることを確認します。')
    const fork = prReadout(11, 'b1', { isCrossRepository: true })
    const fromBranch = issueReadout(1, { linkedBranches: [{ name: 'b1', pullRequests: [fork] }] })
    const fromClosing = issueReadout(2, { closingPullRequests: [fork] })
    const { prerequisites } = toIssueFacts(readout({ kind: 'ok', issues: [fromBranch, fromClosing] }), absent, options)
    if (prerequisites === 'read-failed') throw new Error('unexpected')
    expect(prerequisites[0]?.issue.pullRequests).toEqual([])
    expect(prerequisites[1]?.issue.pullRequests).toHaveLength(1)
    expect(prerequisites[1]?.issue.pullRequests[0]?.isCrossRepository).toBe(true)
  })

  it('Waits for merge の節に存在しない前提は stack、存在する前提は merge と理由を持つ', async () => {
    await explains('`toIssueFacts` が前提の待ち方を決めることのテストです。本文の `Waits for merge` の節に書かれていない前提は `stack`、書かれている前提は `merge` となり、節に書かれた理由も持つことを確認します。')
    const body = '## Waits for merge\n\n- #2: 理由 2\n- acme/other#5: 理由 5\n'
    const blockers = [issueReadout(1), issueReadout(2), issueReadout(5, { repository: otherRepository })]
    const result = toIssueFacts(readout({ kind: 'ok', issues: blockers }), readWaitsForMerge(body, repository_), options)
    if (result.prerequisites === 'read-failed') throw new Error('unexpected')
    expect(result.prerequisites.map(({ wait, reason }) => [wait, reason])).toEqual([['stack', undefined], ['merge', '理由 2'], ['merge', '理由 5']])
    expect(result.mismatches).toEqual([])
  })

  it('Waits for merge の節が不正な形式のときは、前提をすべて merge にし、判定は順 4 になる', async () => {
    await explains('`Waits for merge` の節が不正な形式の場合のテストです。前提をすべて `merge` として扱い、判定が理由を `waits-merge` とする `blocked` になることを確認します。')
    const blocker = issueReadout(1, { closingPullRequests: [prReadout(11, 'b1')] })
    const malformed = readWaitsForMerge('## Waits for merge\n\nbroken', repository_)
    const result = toIssueFacts(readout({ kind: 'ok', issues: [blocker] }), malformed, options)
    if (result.prerequisites === 'read-failed') throw new Error('unexpected')
    expect(result.prerequisites.map(({ wait, reason }) => [wait, reason])).toEqual([['merge', undefined]])
    const judged = judgeReadiness({ target: result.target, prerequisites: result.prerequisites, cycle: undefined, pullRequestsByHead: new Map(), developmentBranch: DEV })
    expect(judged?.reason?.code).toBe('waits-merge')
  })

  it('Waits for merge の節にあって blocked by に存在しない組は、判定の入力から外し、食い違いとして返す', async () => {
    await explains('`Waits for merge` の節と `blocked by` の食い違いのテストです。節に書かれていても `blocked by` に存在しない Issue は、判定の入力から除き、食い違いとして返すことを確認します。')
    const body = '## Waits for merge\n\n- #2: 理由 2\n- #3: 理由 3\n'
    const result = toIssueFacts(readout({ kind: 'ok', issues: [issueReadout(2)] }), readWaitsForMerge(body, repository_), options)
    expect(result.mismatches).toEqual([{ ref: reference(3), reason: '理由 3' }])
    expect(result.prerequisites).toHaveLength(1)
  })

  it('前提の読み取りに失敗した場合は、read-failed を返す', async () => {
    await explains('前提の読み取りに失敗した場合のテストです。読み取りの結果が失敗のとき、`prerequisites` が `read-failed` になり、食い違いは空になることを確認します。')
    const result = toIssueFacts(readout({ kind: 'read-failed', reason: 'null node' }), absent, options)
    expect(result.prerequisites).toBe('read-failed')
    expect(result.mismatches).toEqual([])
  })
})

function describeFor(prerequisites: readonly Prerequisite[], over: Parameters<typeof judge>[1] = {}): string {
  return describeReadiness(judge(prerequisites, over), prerequisites, repository_)
}

describe('describeReadiness', () => {
  it('前提が存在しなければ startable を返す', async () => {
    await explains('判定の結果を文字列にする `describeReadiness` のテストです。前提が存在しない場合に、`startable` を返すことを確認します。')
    expect(describeFor([])).toBe('startable')
  })

  it('スタックできる前提には、stackable on #N を返す', async () => {
    await explains('スタックできる場合の、`describeReadiness` の文字列のテストです。PR 中の前提が 1 件ある場合に、スタック先を示す `stackable on #1` を返すことを確認します。')
    expect(describeFor([reviewing(1)])).toBe('stackable on #1')
  })

  it('済んでいない前提をすべて並べ、済んだ前提は除く', async () => {
    await explains('済んでいない前提の、`describeReadiness` の文字列のテストです。済んでいない前提だけを `blocked by` に並べ、済んだ前提は含めないことを確認します。')
    expect(describeFor([donePrerequisite(9), reviewingMerge(1, '理由'), reviewing(2)])).toBe('blocked by #1, #2 (waits for merge)')
  })

  it('closed-unmerged は、閉じて済んでいない前提を括弧の中に示す', async () => {
    await explains('閉じて済んでいない前提の、`describeReadiness` の文字列のテストです。`blocked by` に続く括弧の中に、`closed without merge` と該当の前提を示すことを確認します。')
    expect(describeFor([closedPrerequisite(), reviewing(2)])).toBe('blocked by #1, #2 (closed without merge: #1)')
  })

  it('not-in-review は前提ごとの状態を示す', async () => {
    await explains('PR 中でない前提の、`describeReadiness` の文字列のテストです。未着手や PR が存在しない場合など、前提ごとの状態を括弧の中に示すことを確認します。')
    const forked = need(issue(4, { pullRequests: [pullRequest(1004, 'b4', DEV, { isCrossRepository: true })] }))
    const multiple = need(issue(5, { pullRequests: [pullRequest(1005, 'a'), pullRequest(1006, 'b')] }))
    const pending = need(inReview(6, DEV, { column: 'Pending' }))
    const mergedOpen = need(issue(7, { pullRequests: [pullRequest(1007, 'b7', DEV, { state: 'merged' })] }))
    expect(describeFor([unstarted(1), startedOnly(2), forked, multiple, pending, mergedOpen])).toBe(
      'blocked by #1, #2, #4, #5, #6, #7 (not in review: #1 (not started), #2 (no PR), #4 (PR from fork), #5 (multiple PRs), #6 (in Pending), #7 (PR merged, Issue open))',
    )
  })

  it('別のリポジトリの前提は owner/repo#N で示す', async () => {
    await explains('別のリポジトリの前提の、`describeReadiness` の文字列のテストです。別のリポジトリの前提を `owner/repo#N` の形で示すことを確認します。')
    const other = reviewing(5, DEV, {}, otherRepository)
    expect(describeFor([other, reviewing(1)])).toBe('blocked by acme/other#5, #1 (other repository: acme/other#5)')
  })

  it('diverged は、1 本の鎖でないことを示す', async () => {
    await explains('前提が 1 本の鎖にならない場合の、`describeReadiness` の文字列のテストです。括弧の中に `not in one chain` を示すことを確認します。')
    const prerequisites = [reviewing(1), reviewing(2)]
    expect(describeFor(prerequisites)).toBe('blocked by #1, #2 (not in one chain)')
  })

  it('cycle は、循環を #N の並びで示す', async () => {
    await explains('循環がある場合の、`describeReadiness` の文字列のテストです。循環を `#100 -> #1 -> #100` のように `#N` の並びで、括弧の中に示すことを確認します。')
    expect(describeFor([reviewing(1)], { cycle: ['acme/app#100', 'acme/app#1', 'acme/app#100'] })).toBe('blocked by #1 (cycle: #100 -> #1 -> #100)')
  })

  it('unreadable は、括弧の中に unreadable を示す', async () => {
    await explains('前提を読み取れない場合の、`describeReadiness` の文字列のテストです。読み取りが失敗した場合、`blocked (unreadable)` を返すことを確認します。')
    expect(describeReadiness(judge('read-failed'), [], repository_)).toBe('blocked (unreadable)')
  })

  it('describeUnknown は、理由を括弧の中に入れる', async () => {
    await explains('`describeUnknown` のテストです。理由を渡した場合に、理由を括弧の中に入れた `unknown (…)` の形の文字列を返すことを確認します。')
    expect(describeUnknown('no dependencies api')).toBe('unknown (no dependencies api)')
  })
})

describe('cycleThrough', () => {
  it('指定した Issue を含む循環だけを返す', async () => {
    await explains('指定した Issue を含む循環を求める `cycleThrough` のテストです。2 つの Issue が互いに依存する場合に、指定した Issue を始点と終点にした循環を返すことを確認します。')
    const edges = new Map([['a', ['b']], ['b', ['a']]])
    expect(cycleThrough('a', edges)).toEqual(['a', 'b', 'a'])
  })

  it('循環に行き当たるだけの Issue には、循環を返さない', async () => {
    await explains('循環に途中から入るだけの Issue の、`cycleThrough` のテストです。指定した Issue が循環に含まれず、前提をたどった先で循環に入るだけの場合は、`undefined` を返すことを確認します。')
    const edges = new Map([['t', ['a']], ['a', ['b']], ['b', ['a']]])
    expect(cycleThrough('t', edges)).toBeUndefined()
  })

  it('指定した Issue から到達できない循環は、対象にしない', async () => {
    await explains('指定した Issue から到達できない循環の、`cycleThrough` のテストです。別の場所に循環があっても、指定した Issue から届かなければ `undefined` を返すことを確認します。')
    const edges = new Map([['t', ['a']], ['a', []], ['x', ['y']], ['y', ['x']]])
    expect(cycleThrough('t', edges)).toBeUndefined()
  })

  it('自分自身への依存は、長さ 1 の循環になる', async () => {
    await explains('自分自身へ依存する Issue の、`cycleThrough` のテストです。指定した Issue が自分自身を前提にしている場合、同じ Issue を 2 回並べた循環を返すことを確認します。')
    expect(cycleThrough('a', new Map([['a', ['a']]]))).toEqual(['a', 'a'])
  })
})

describe('progressionsFromReadiness', () => {
  it('stackable は前提の上にスタックし、ほかの区分は単独にする', async () => {
    await explains('判定の結果から進め方を作る `progressionsFromReadiness` のテストです。`stackable` はスタック先の上にスタックする進め方、`startable` と `blocked` は `alone` になることを確認します。')
    const stackable = judge([reviewing(1)])
    const startable = judge([])
    const blocked = judge([unstarted(1)])
    const progressions = progressionsFromReadiness(new Map([
      ['acme/app#2', stackable],
      ['acme/app#3', startable],
      ['acme/app#4', blocked],
    ]))
    expect(progressions.get('acme/app#2')).toEqual({ kind: 'stack', on: 'acme/app#1' })
    expect(progressions.get('acme/app#3')).toEqual({ kind: 'alone' })
    expect(progressions.get('acme/app#4')).toEqual({ kind: 'alone' })
    expect(stackChains(progressions)).toEqual([['acme/app#1', 'acme/app#2']])
  })
})

describe('describePrerequisiteState', () => {
  it('merge されて閉じた前提は、done と示す', async () => {
    await explains('前提の状態を文字列にする `describePrerequisiteState` のテストです。merge されて閉じた前提について、`done` を返すことを確認します。')
    const prerequisite = need(merged(3))
    expect(describePrerequisiteState(prerequisite)).toBe('done')
  })

  it('merge されずに閉じた前提は、待ち方が stack でも merge でも closed without merge と示す', async () => {
    await explains('merge されずに閉じた前提の、`describePrerequisiteState` のテストです。待ち方が `stack` でも `merge` でも、`closed without merge` を返すことを確認します。')
    const closed = issue(3, { state: 'closed' })
    const stacked = need(closed)
    const waiting = need(closed, 'merge', '理由')
    expect(describePrerequisiteState(stacked)).toBe('closed without merge')
    expect(describePrerequisiteState(waiting)).toBe('closed without merge')
  })

  it('open の前提は、PR が存在すれば in review、存在しなければ not started と示す', async () => {
    await explains('open の前提の、`describePrerequisiteState` のテストです。PR が存在する前提は `in review`、PR が存在しない前提は `not started` を返すことを確認します。')
    const inReviewed = reviewing(3)
    const notStarted = need(issue(3))
    expect(describePrerequisiteState(inReviewed)).toBe('in review')
    expect(describePrerequisiteState(notStarted)).toBe('not started')
  })

  it('merged の PR を持つ open の前提は、待ち方が stack でも merge でも PR merged, Issue open と示す', async () => {
    await explains('PR が merged のまま Issue が open の前提の、`describePrerequisiteState` のテストです。待ち方が `stack` でも `merge` でも、`PR merged, Issue open` を返すことを確認します。')
    const mergedOpen = issue(3, { pullRequests: [pullRequest(1003, 'b3', DEV, { state: 'merged' })] })
    expect(describePrerequisiteState(need(mergedOpen))).toBe('PR merged, Issue open')
    expect(describePrerequisiteState(need(mergedOpen, 'merge', '理由'))).toBe('PR merged, Issue open')
  })

  it('merged の PR を持つ open の前提は、列が Pending なら、待ち方によらず in Pending と示す', async () => {
    await explains('列が `Pending` の前提の、`describePrerequisiteState` のテストです。merged の PR を持つ open の前提でも、列が `Pending` なら、待ち方によらず `in Pending` を返すことを確認します。')
    const pending = issue(3, { column: 'Pending', pullRequests: [pullRequest(1003, 'b3', DEV, { state: 'merged' })] })
    expect(describePrerequisiteState(need(pending))).toBe('in Pending')
    expect(describePrerequisiteState(need(pending, 'merge', '理由'))).toBe('in Pending')
  })
})

describe('assumePullRequestState', () => {
  const mergedPullRequest = pullRequest(1001, 'b1', DEV, { state: 'merged' })
  const openPullRequest = pullRequest(1001, 'b1')
  const heads = [reference(1)]
  const reopened = need(issue(1, { pullRequests: [openPullRequest] }))

  it('open と仮定すると、前提の Issue と該当の PR を open にし、判定は merge 前の stackable に戻る', async () => {
    await explains('PR の状態を仮定して前提を作り直す `assumePullRequestState` のテストです。merged の PR を `open` と仮定した場合に、前提の Issue と該当の PR を open に直し、判定が merge 前の `stackable` に戻ることを確認します。')
    const prerequisites = [donePrerequisite(1)]
    const assumed = assumePullRequestState(prerequisites, heads, mergedPullRequest, 'open')
    expect(assumed).toEqual([reopened])
    expect(judge(assumed)).toMatchObject({ kind: 'stackable', stackOn: { branch: 'b1', issue: heads[0] } })
    expect(judge(prerequisites).kind).toBe('startable')
  })

  it('merged と仮定すると、閉じる前の前提を済んだ前提にする', async () => {
    await explains('`assumePullRequestState` で PR を `merged` と仮定する場合のテストです。open の PR を merged と仮定すると、閉じる前の前提が済んだ前提に変わり、判定が `startable` になることを確認します。')
    const unclosed = issue(1, { pullRequests: [mergedPullRequest] })
    const assumed = assumePullRequestState([need(unclosed)], heads, openPullRequest, 'merged')
    expect(assumed).toEqual([donePrerequisite(1)])
    expect(judge(assumed).kind).toBe('startable')
  })

  it('前提の PR の一覧に該当の PR が存在しなければ、仮定した状態で追加する', async () => {
    await explains('前提の PR の一覧に該当の PR が存在しない場合の、`assumePullRequestState` のテストです。仮定した状態の PR を、一覧に追加することを確認します。')
    const closed = issue(1, { state: 'closed' })
    const assumed = assumePullRequestState([need(closed)], heads, mergedPullRequest, 'open')
    expect(assumed).toEqual([reopened])
  })

  it('対象でない前提と、ほかの PR は変えない', async () => {
    await explains('`assumePullRequestState` が変更しない対象のテストです。仮定の対象でない前提と、同じ Issue のほかの PR は、変更せずにそのまま残すことを確認します。')
    const other = pullRequest(2001, 'old', DEV, { state: 'closed' })
    const closed = issue(1, { state: 'closed', pullRequests: [other, mergedPullRequest] })
    const assumed = assumePullRequestState([need(closed), donePrerequisite(2)], heads, mergedPullRequest, 'open')
    const expected = issue(1, { pullRequests: [other, openPullRequest] })
    expect(assumed).toEqual([need(expected), donePrerequisite(2)])
  })
})

describe('hasReadinessChanged・describeReadinessChange', () => {
  const stackable = judge([reviewing(1)])
  const startable = judge([])
  const blocked = judge([unstarted(1)])

  it('区分かスタック先のブランチが違えば変化とし、理由だけの違いは変化としない', async () => {
    await explains('判定の変化を見分ける `hasReadinessChanged` のテストです。区分またはスタック先のブランチが異なる場合は変化あり、理由だけが異なる場合は変化なしと判定することを確認します。')
    const otherBase = { ...stackable, stackOn: { branch: 'b9', issue: reference(9) } }
    const blockedOtherReason = judge([startedOnly(1)])
    expect(hasReadinessChanged(stackable, startable)).toBe(true)
    expect(hasReadinessChanged(stackable, { ...stackable })).toBe(false)
    expect(hasReadinessChanged(stackable, otherBase)).toBe(true)
    expect(hasReadinessChanged(blocked, blockedOtherReason)).toBe(false)
  })

  it('変化を示す文字列は、blocked では理由を付けず、stackable ではスタック先を付ける', async () => {
    await explains('判定の変化を文字列にする `describeReadinessChange` のテストです。`blocked` は理由を付けず、`stackable` はスタック先を付けて返し、別のリポジトリではリポジトリ名も含めることを確認します。')
    expect(describeReadinessChange(blocked, repository_)).toBe('blocked')
    expect(describeReadinessChange(stackable, repository_)).toBe('stackable on #1')
    expect(describeReadinessChange(stackable, otherRepository)).toBe('stackable on acme/app#1')
    expect(describeReadinessChange(startable, repository_)).toBe('startable')
  })
})

describe('isStackedOn', () => {
  it('着手済みで、指定した Issue を stack で待つ Issue だけを、スタック済みと判定する', async () => {
    await explains('指定した Issue の上にスタックしているかを判定する `isStackedOn` のテストです。着手した跡があり、指定した Issue を `stack` で待つ Issue だけが真になることを確認します。')
    const started = issue(100, { branches: ['b100'] })
    const heads = [reference(1)]
    const done = [donePrerequisite(1)]
    const waitsMerge = [need(merged(1), 'merge', '理由')]
    expect(isStackedOn(started, done, heads)).toBe(true)
    expect(isStackedOn(issue(100), done, heads)).toBe(false)
    expect(isStackedOn(started, waitsMerge, heads)).toBe(false)
    expect(isStackedOn(started, [donePrerequisite(2)], heads)).toBe(false)
  })
})
