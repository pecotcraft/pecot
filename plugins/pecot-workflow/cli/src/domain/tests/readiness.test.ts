import { describe, expect, it } from 'vitest'

import type { IssuePrerequisitesReadout, IssueReadout, PullRequestReadout } from '../issue-readout.js'
import { createIssueReference } from '../reference-parser.js'
import type { IssueReference } from '../reference-parser.js'
import { readWaitsForMerge } from '../prerequisites.js'
import type { WaitsForMergeReadout } from '../prerequisites.js'
import { JSON_NULL } from '../json-null.js'
import {
  findCycle,
  hasStarted,
  isDone,
  isInReview,
  judgeReadiness,
  planProgression,
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
  it('PR の無い closed は済んでおらず、merged だけの open も済んでいない', () => {
    expect(isDone(issue(1, { state: 'closed' }))).toBe(false)
    const facts1 = issue(1, { pullRequests: [pullRequest(1, 'a', DEV, { state: 'merged' })] })
    expect(isDone(facts1)).toBe(false)
    expect(isDone(merged(1))).toBe(true)
  })

  it('open の PR がちょうど 1 本で fork からでなければ PR 中になる', () => {
    expect(isInReview(inReview(1))).toBe(true)
    expect(isInReview(issue(1))).toBe(false)
    expect(isInReview(inReview(1, DEV, { state: 'closed' }))).toBe(false)
    const facts2 = issue(1, { pullRequests: [pullRequest(1, 'a'), pullRequest(2, 'b')] })
    expect(isInReview(facts2)).toBe(false)
    const facts3 = issue(1, { pullRequests: [pullRequest(1, 'a', DEV, { isCrossRepository: true })] })
    expect(isInReview(facts3)).toBe(false)
  })

  it('ドラフトの PR も PR 中に数え、open と closed を 1 本ずつ持つ open も PR 中になる', () => {
    const facts4 = issue(1, { pullRequests: [pullRequest(1, 'a', DEV, { isDraft: true })] })
    expect(isInReview(facts4)).toBe(true)
    const facts5 = issue(1, { pullRequests: [pullRequest(1, 'a'), pullRequest(2, 'b', DEV, { state: 'closed' })] })
    expect(isInReview(facts5)).toBe(true)
  })

  it('ブランチか PR のどちらかがあれば着手の跡がある', () => {
    expect(hasStarted(issue(1))).toBe(false)
    expect(hasStarted(issue(1, { branches: ['a'] }))).toBe(true)
    const facts6 = issue(1, { pullRequests: [pullRequest(1, 'a')] })
    expect(hasStarted(facts6)).toBe(true)
  })
})

describe('judgeReadiness の順', () => {
  it('順 1: 前提の読み取りに失敗すると unreadable で blocked になる', () => {
    expect(judge('read-failed')).toEqual({ kind: 'blocked', stackOn: undefined, reason: { code: 'unreadable' }, needsReview: false, attention: [] })
  })

  it('順 2: 輪があると cycle で blocked になる', () => {
    expect(judge([reviewing(1)], { cycle: ['a', 'b', 'a'] }).reason).toEqual({ code: 'cycle', cycle: ['a', 'b', 'a'] })
  })

  it('順 3: 閉じて済んでいない前提があると closed-unmerged で blocked になる', () => {
    const result = judge([closedPrerequisite(), reviewing(2)])
    expect(result.kind).toBe('blocked')
    expect(result.reason).toEqual({ code: 'closed-unmerged', issues: [reference(1)] })
    expect(result.needsReview).toBe(true)
  })

  it('順 4: 済んでいない merge の前提があると waits-merge で blocked になり、理由を添える', () => {
    const result = judge([reviewingMerge(1, '理由'), reviewing(2)])
    expect(result.reason).toEqual({ code: 'waits-merge', issues: [{ issue: reference(1), reason: '理由' }] })
    expect(result.needsReview).toBe(false)
  })

  it('順 5: 前提が無ければ startable になる', () => {
    expect(judge([])).toEqual({ kind: 'startable', stackOn: undefined, reason: undefined, needsReview: false, attention: [] })
  })

  it('順 6: 別のリポの前提があると other-repository で blocked になる', () => {
    const result = judge([reviewing(1, DEV, {}, otherRepository), reviewing(2)])
    expect(result.reason).toEqual({ code: 'other-repository', issues: [reference(1, otherRepository)] })
  })

  it('順 6 の判定では、リポ名の大文字小文字を区別しない', () => {
    const upper = createRepositoryReference('ACME', 'App')
    expect(judge([reviewing(1, DEV, {}, upper)]).kind).toBe('stackable')
  })

  it.for([
    { name: '着手済みで PR が無い前提', facts: issue(1, { branches: ['x'] }), expected: 'started-without-pr' },
    { name: 'merged の PR だけの open の前提', facts: issue(1, { pullRequests: [pullRequest(1, 'x', DEV, { state: 'merged' })] }), expected: 'started-without-pr' },
    { name: '未着手の前提', facts: issue(1), expected: 'not-started' },
    { name: 'PR が 2 本の前提', facts: issue(1, { pullRequests: [pullRequest(1, 'x'), pullRequest(2, 'y')] }), expected: 'multiple-prs' },
    { name: 'fork からの PR の前提', facts: issue(1, { pullRequests: [pullRequest(1, 'x', DEV, { isCrossRepository: true })] }), expected: 'fork-pr' },
    { name: '列が Pending の前提', facts: inReview(1, DEV, { column: 'Pending' }), expected: 'pending' },
  ])('順 7: $name は $expected として not-in-review になる', ({ facts, expected }) => {
    expect(judge([need(facts)]).reason).toEqual({ code: 'not-in-review', issues: [{ issue: reference(1), state: expected }] })
  })

  it('順 7: 当てはまる前提をすべて一覧にする', () => {
    const result = judge([unstarted(1), reviewing(2), startedOnly(3)])
    expect(result.reason).toEqual({
      code: 'not-in-review',
      issues: [{ issue: reference(1), state: 'not-started' }, { issue: reference(3), state: 'started-without-pr' }],
    })
  })

  it('順 8: 前提が 1 件なら、その PR の head に積む', () => {
    const result = judge([reviewing(1)])
    expect(result).toEqual({ kind: 'stackable', stackOn: { branch: 'b1', issue: reference(1) }, reason: undefined, needsReview: false, attention: [] })
  })

  it('順 8: 3 件を逆の順で渡しても、鎖の最上段に積む', () => {
    const one = inReview(1)
    const two = inReview(2, 'b1')
    const three = inReview(3, 'b2')
    for (const order of [[one, two, three], [three, two, one]]) {
      expect(judge(order.map(value => need(value))).stackOn).toEqual({ branch: 'b3', issue: reference(3) })
    }
  })

  it('順 8: 間接の前提を挟む鎖にも積める', () => {
    const one = inReview(1)
    const three = inReview(3, 'b2')
    const indirect = pullRequest(1002, 'b2', 'b1')
    const result = judge([need(one), need(three)], { byHead: [indirect] })
    expect(result.stackOn).toEqual({ branch: 'b3', issue: reference(3) })
  })

  it('順 8: 間接の PR が無いと、鎖が切れて diverged になる', () => {
    expect(judge([reviewing(1), reviewing(3, 'b2')]).reason).toEqual({ code: 'diverged', issues: [reference(1), reference(3)] })
  })

  it('順 8: base がどちらも開発ブランチの 2 本は diverged になる', () => {
    const result = judge([reviewing(1), reviewing(2)])
    expect(result.kind).toBe('blocked')
    expect(result.reason).toEqual({ code: 'diverged', issues: [reference(1), reference(2)] })
  })

  it('順 8: base をたどる途中で輪になっても止まる', () => {
    const result = judge([reviewing(1, 'b2'), reviewing(2, 'b1')])
    expect(result.kind).toBe('stackable')
  })

  it('順 8: 開発ブランチを head に持つ PR は、積む先の途中として通らない', () => {
    const result = judge([reviewing(1), reviewing(2)], { byHead: [pullRequest(2000, DEV, 'x')] })
    expect(result.reason?.code).toBe('diverged')
  })

  it('済んだ merge の前提と済んだ別のリポの前提は見ない', () => {
    const doneMerge = need(merged(1), 'merge', '理由')
    const doneOther = need({ ...merged(2), ref: reference(2, otherRepository) })
    expect(judge([doneMerge, doneOther]).kind).toBe('startable')
    expect(judge([doneMerge, doneOther, reviewing(3)]).stackOn).toEqual({ branch: 'b3', issue: reference(3) })
  })

  it('前提がすべて済んでいれば startable になる', () => {
    expect(judge([donePrerequisite(1), donePrerequisite(2)]).kind).toBe('startable')
  })
})

describe('judgeReadiness の順の優先', () => {
  it('順 2 と順 3 が同時に成り立つと、順 2 が勝つ', () => {
    expect(judge([closedPrerequisite()], { cycle: ['a', 'a'] }).reason?.code).toBe('cycle')
  })

  it('順 3 と順 4 が同時に成り立つと、順 3 が勝つ', () => {
    expect(judge([closedPrerequisite(), reviewingMerge(2, 'r')]).reason?.code).toBe('closed-unmerged')
  })

  it('順 4 と順 6 が同時に成り立つと、順 4 が勝つ', () => {
    expect(judge([reviewing(1, DEV, {}, otherRepository), reviewingMerge(2, 'r')]).reason?.code).toBe('waits-merge')
  })

  it('順 6 と順 7 が同時に成り立つと、順 6 が勝つ', () => {
    expect(judge([reviewing(1, DEV, {}, otherRepository), unstarted(2)]).reason?.code).toBe('other-repository')
  })

  it('順 7 と順 8 が同時に成り立つと、順 7 が勝つ', () => {
    expect(judge([unstarted(1), reviewing(2), reviewing(3)]).reason?.code).toBe('not-in-review')
  })
})

describe('judgeReadiness の見直しと注記', () => {
  it('順 1 では見直しは要らず、順 2 で止まっても閉じて済んでいない前提があれば要る', () => {
    expect(judge('read-failed').needsReview).toBe(false)
    expect(judge([closedPrerequisite()], { cycle: ['a', 'a'] }).needsReview).toBe(true)
    expect(judge([reviewing(1)], { cycle: ['a', 'a'] }).needsReview).toBe(false)
  })

  it('閉じて済んでいない前提があっても、済んだ前提だけなら見直しは要らない', () => {
    expect(judge([donePrerequisite(1)]).needsReview).toBe(false)
  })

  it('札が Needs Attention の前提は注記に入り、区分を変えない', () => {
    const flagged = inReview(1, DEV, { label: 'Needs Attention' })
    const startable = judge([need({ ...merged(2), label: 'Needs Attention' }), donePrerequisite(3)])
    expect(startable.kind).toBe('startable')
    expect(startable.attention).toEqual([])
    const stackable = judge([need(flagged)])
    expect(stackable.kind).toBe('stackable')
    expect(stackable.attention).toEqual([reference(1)])
    expect(judge('read-failed').attention).toEqual([])
  })
})

const nonTaskKinds: readonly { readonly kind: IssueWorkKind }[] = [{ kind: 'epic' }, { kind: 'tracker' }]

describe('Epic と Tracker', () => {
  it.for(nonTaskKinds)('$kind には判定を出さない', ({ kind }) => {
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
  it('前提が無ければ alone になり、merge の前提があれば他の前提の形を問わず wait-merge になる', () => {
    const progressions = planned([phase('a'), phase('b', ['a'], ['c', 'merge']), phase('c'), phase('d', ['a', 'merge'])])
    expect(progressions.get('a')).toEqual({ kind: 'alone' })
    expect(progressions.get('b')).toEqual({ kind: 'wait-merge' })
    expect(progressions.get('d')).toEqual({ kind: 'wait-merge' })
  })

  it('前提が 1 つなら、その前提に積む', () => {
    expect(planned([phase('a'), phase('b', ['a'])]).get('b')).toEqual({ kind: 'stack', on: 'a' })
  })

  it('互いに届かない 2 件の前提は join になる', () => {
    expect(planned([phase('a'), phase('b'), phase('c', ['a'], ['b'])]).get('c')).toEqual({ kind: 'join' })
  })

  it('1 つの前提からほかの前提へ届くなら、届く元の前提に積む', () => {
    const progressions = planned([phase('a'), phase('b', ['a']), phase('c', ['a'], ['b'])])
    expect(progressions.get('c')).toEqual({ kind: 'stack', on: 'b' })
  })

  it('既存の Issue を経由して届く前提にも積む', () => {
    const progressions = planned([phase('a', ['acme/app/9']), phase('b', ['a'], ['acme/app/9'])])
    expect(progressions.get('b')).toEqual({ kind: 'stack', on: 'a' })
  })

  it('merge の辺は、届くかどうかの判定に使わない', () => {
    const progressions = planned([phase('a'), phase('b', ['a', 'merge']), phase('c', ['a'], ['b'])])
    expect(progressions.get('c')).toEqual({ kind: 'join' })
  })

  it('輪があれば進め方を出さずに輪を返す', () => {
    expect(planProgression([phase('a', ['b']), phase('b', ['a'])])).toEqual({ kind: 'cycle', cycle: ['a', 'b', 'a'] })
  })

  it('quickstart の 5 フェーズの進め方を出す', () => {
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
  it('quickstart の 5 フェーズは、枝分かれで 2 本の道になる', () => {
    expect(stackChains(planned(quickstart)).map(chain => chain.join(' -> '))).toEqual([
      'phase1 -> phase2 -> phase3',
      'phase1 -> phase2 -> phase4',
    ])
  })

  it('積む先の無いフェーズだけなら道を出さない', () => {
    const progressions = planned([phase('a'), phase('b', ['a', 'merge']), phase('c', ['a'], ['b'])])
    expect(stackChains(progressions)).toEqual([])
  })

  it('積む先が既存の Issue なら、その Issue から始まる道を出す', () => {
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
  // 同じリポの入力だけで、すべての前提を PR 中と置いて判定する。PR の base は、積む先の head にそろえる
  const cases: readonly { readonly name: string, readonly phases: readonly PlannedPhase[] }[] = [
    { name: 'quickstart の 5 フェーズ', phases: quickstart },
    { name: 'join を含む並び', phases: [phase('a'), phase('b'), phase('c', ['a'], ['b']), phase('d', ['a'])] },
    { name: '間接の前提を付けた並び', phases: [phase('a'), phase('b', ['a']), phase('c', ['a'], ['b'])] },
  ]

  it.for(cases)('$name では、判定の結果が進め方と一致する', ({ phases }) => {
    const progressions = planned(phases)
    const heads = new Map(phases.map((value, index) => [value.key, `b${String(index + 1)}`]))
    const facts = new Map(phases.map((value, index) => {
      const progression = progressions.get(value.key)
      return [value.key, inReview(index + 1, progression?.kind === 'stack' ? heads.get(progression.on) : DEV)]
    }))
    const byHead = phases.flatMap(value => facts.get(value.key)?.pullRequests ?? [])

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
  it('3 つの輪を、始点を末尾にも置いて返す', () => {
    expect(findCycle(edges([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual(['a', 'b', 'c', 'a'])
  })

  it('自分自身への辺は長さ 1 の輪になる', () => {
    expect(findCycle(edges([['a', ['a']]]))).toEqual(['a', 'a'])
  })

  it('輪が無ければ undefined を返す', () => {
    expect(findCycle(edges([['a', ['b', 'c']], ['b', ['c']], ['c', []]]))).toBeUndefined()
    expect(findCycle(edges([]))).toBeUndefined()
  })

  it('始点を含まない場所の輪も見つける', () => {
    expect(findCycle(edges([['a', ['b']], ['b', ['c']], ['c', ['d']], ['d', ['b']]]))).toEqual(['b', 'c', 'd', 'b'])
  })

  it('入力の順を変えても、始点がキーの最小の同じ輪を返す', () => {
    const forward = edges([['c', ['a']], ['a', ['b']], ['b', ['c']]])
    const backward = edges([['b', ['c']], ['a', ['b']], ['c', ['a']]])
    expect(findCycle(forward)).toEqual(['a', 'b', 'c', 'a'])
    expect(findCycle(backward)).toEqual(['a', 'b', 'c', 'a'])
  })

  it('辺の先が表に無いキーでも扱える', () => {
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
    timelinePullRequests: [],
    ...over,
  }
}

function readout(blockers: IssuePrerequisitesReadout['blockedBy'], target: Partial<IssueReadout> = {}): IssuePrerequisitesReadout {
  return { issue: { ...issueReadout(100, target), body: '' }, blockedBy: blockers }
}

const options = { columnFieldName: 'pecot-workflow-x', labelFieldName: 'Status' }
const absent: WaitsForMergeReadout = { kind: 'absent' }

function kindOf(over: Partial<IssueReadout>): string {
  return toIssueFacts(readout({ kind: 'ok', issues: [] }, over), absent, options).target.kind
}

describe('toIssueFacts', () => {
  it('済んだ・PR 中・着手の跡の 3 つの値の元になる状態を写す', () => {
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

  it('列・札・種別と Issue 自身の値を写す', () => {
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

  it('Epic と Tracker を種別に写す', () => {
    expect(kindOf({ issueType: 'Epic' })).toBe('epic')
    expect(kindOf({ issueType: JSON_NULL, subIssuesTotal: 2 })).toBe('epic')
    expect(kindOf({ title: '[Tracker] security' })).toBe('tracker')
    expect(kindOf({ title: 'about [Tracker]' })).toBe('task')
  })

  it('3 つの読み口で同じ PR を 1 本に数える', () => {
    const same = prReadout(11, 'b1')
    const blocker = issueReadout(1, {
      linkedBranches: [{ name: 'b1', pullRequests: [same] }],
      closingPullRequests: [prReadout(11, 'b1', { repository: createRepositoryReference('ACME', 'App') })],
      timelinePullRequests: [same],
    })
    const { prerequisites } = toIssueFacts(readout({ kind: 'ok', issues: [blocker] }), absent, options)
    expect(prerequisites === 'read-failed' ? [] : prerequisites[0]?.issue.pullRequests).toHaveLength(1)
  })

  it('別のリポの同じ番号の PR は分ける', () => {
    const blocker = issueReadout(1, {
      closingPullRequests: [prReadout(11, 'b1')],
      timelinePullRequests: [prReadout(11, 'b1', {}, otherRepository)],
    })
    const { prerequisites } = toIssueFacts(readout({ kind: 'ok', issues: [blocker] }), absent, options)
    expect(prerequisites === 'read-failed' ? [] : prerequisites[0]?.issue.pullRequests).toHaveLength(2)
  })

  it('リンクしたブランチの fork からの PR は捨て、閉じる参照の fork からの PR は残す', () => {
    const fork = prReadout(11, 'b1', { isCrossRepository: true })
    const fromBranch = issueReadout(1, { linkedBranches: [{ name: 'b1', pullRequests: [fork] }] })
    const fromClosing = issueReadout(2, { closingPullRequests: [fork] })
    const { prerequisites } = toIssueFacts(readout({ kind: 'ok', issues: [fromBranch, fromClosing] }), absent, options)
    if (prerequisites === 'read-failed') throw new Error('unexpected')
    expect(prerequisites[0]?.issue.pullRequests).toEqual([])
    expect(prerequisites[1]?.issue.pullRequests).toHaveLength(1)
    expect(prerequisites[1]?.issue.pullRequests[0]?.isCrossRepository).toBe(true)
  })

  it('節に無い前提は stack、節にある前提は merge と理由を持つ', () => {
    const body = '## Waits for merge\n\n- #2: 理由 2\n- acme/other#5: 理由 5\n'
    const blockers = [issueReadout(1), issueReadout(2), issueReadout(5, { repository: otherRepository })]
    const result = toIssueFacts(readout({ kind: 'ok', issues: blockers }), readWaitsForMerge(body, repository_), options)
    if (result.prerequisites === 'read-failed') throw new Error('unexpected')
    expect(result.prerequisites.map(({ wait, reason }) => [wait, reason])).toEqual([['stack', undefined], ['merge', '理由 2'], ['merge', '理由 5']])
    expect(result.mismatches).toEqual([])
  })

  it('節が malformed のとき前提をすべて merge にし、判定は順 4 になる', () => {
    const blocker = issueReadout(1, { closingPullRequests: [prReadout(11, 'b1')] })
    const malformed = readWaitsForMerge('## Waits for merge\n\nbroken', repository_)
    const result = toIssueFacts(readout({ kind: 'ok', issues: [blocker] }), malformed, options)
    if (result.prerequisites === 'read-failed') throw new Error('unexpected')
    expect(result.prerequisites.map(({ wait, reason }) => [wait, reason])).toEqual([['merge', undefined]])
    const judged = judgeReadiness({ target: result.target, prerequisites: result.prerequisites, cycle: undefined, pullRequestsByHead: new Map(), developmentBranch: DEV })
    expect(judged?.reason?.code).toBe('waits-merge')
  })

  it('節にあって blocked by に無い組は、判定の入力から外して食い違いに返す', () => {
    const body = '## Waits for merge\n\n- #2: 理由 2\n- #3: 理由 3\n'
    const result = toIssueFacts(readout({ kind: 'ok', issues: [issueReadout(2)] }), readWaitsForMerge(body, repository_), options)
    expect(result.mismatches).toEqual([{ ref: reference(3), reason: '理由 3' }])
    expect(result.prerequisites).toHaveLength(1)
  })

  it('前提の読み取りに失敗していれば read-failed を返す', () => {
    const result = toIssueFacts(readout({ kind: 'read-failed', reason: 'null node' }), absent, options)
    expect(result.prerequisites).toBe('read-failed')
    expect(result.mismatches).toEqual([])
  })
})
