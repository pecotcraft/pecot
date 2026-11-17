import { describe, expect, it } from 'vitest'

import '../../commands/registry.js'
import { formatHinted } from '../command-hint.js'
import { describeReadiness } from '../readiness.js'
import type { Prerequisite, Readiness, ReadinessReason } from '../readiness.js'
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
  it('判定が stackable で、HEAD が下の段の変更を持つと、下の段に積んだ記録を返す', () => {
    const inferred = inferStackedBase(stackable, [], target, probeOf({ kind: 'probed', isShared: true, sha: SHA }))
    expect(inferred).toEqual({ kind: 'stacked', record: { branch: 'feat/3', sha: SHA, stackedOn: lower }, stackedOn: lower })
  })

  it('判定が stackable でも、HEAD が下の段の変更を持たないと、開発ブランチからの着手として返す', () => {
    expect(inferStackedBase(stackable, [], target, probeOf({ kind: 'probed', isShared: false, sha: SHA }))).toEqual({ kind: 'development' })
  })

  it('下の段の追跡参照が手元に無いと、git fetch の案内を添えた理由を返す', () => {
    expect(inferStackedBase(stackable, [], target, probeOf({ kind: 'untracked', reference: 'origin/feat/3' }))).toEqual({ kind: 'unknown', reason: 'origin/feat/3 is not found; fetch it with: git fetch' })
  })

  it('下の段から分かれた点を求められないと、その理由を返す', () => {
    expect(inferStackedBase(stackable, [], target, probeOf({ kind: 'probed', isShared: true, sha: undefined }))).toEqual({ kind: 'unknown', reason: 'cannot find where HEAD forked from feat/3' })
  })

  it.for([
    { name: 'startable', value: readiness('startable') },
    { name: '判定が無い Epic・Tracker', value: undefined },
  ])('判定が $name のときは、git を調べずに開発ブランチからの着手として返す', ({ value }) => {
    expect(inferStackedBase(value, [], target, unexpectedProbe)).toEqual({ kind: 'development' })
  })

  it('判定が blocked のときは、判定の文を理由に返す', () => {
    const blocked = readiness('blocked', { reason: { code: 'unreadable' } })
    expect(inferStackedBase(blocked, [], target, probeOf({ kind: 'probed', isShared: true, sha: SHA }))).toEqual({ kind: 'unknown', reason: describeReadiness(blocked, [], repository) })
  })
})

describe('decideStart', () => {
  const mergedOpen: Prerequisite = {
    issue: { ref: lower, state: 'open', column: undefined, label: undefined, kind: 'task', branches: [], pullRequests: [{ repository, number: 1003, state: 'merged', headRefName: 'feat/3', baseRefName: 'main', isDraft: false, isCrossRepository: false }] },
    wait: 'stack',
    reason: undefined,
  }

  function blockedText(prerequisite: Prerequisite, reason: ReadinessReason): string {
    const decision = decideStart(readiness('blocked', { reason }), [prerequisite], target)
    return decision.kind === 'blocked' ? formatHinted(decision.message, 'mcp') : ''
  }

  it('マージ済みの PR を持つ開いた前提で止めると、Issue を閉じるか打ち直す手当てを示す', () => {
    const text = blockedText(mergedOpen, { code: 'not-in-review', issues: [{ issue: lower, state: 'merged-open' }] })
    expect(text).toContain('#7 is blocked by #3 (not in review: #3 (PR merged, Issue open))\n- #3: PR merged, Issue open\n#3 has a merged PR: close #3, or retry once it closes\n')
  })

  it('マージを待つ前提でも PR がマージ済みなら、積むよう切り替える案内を出さない', () => {
    const text = blockedText({ ...mergedOpen, wait: 'merge', reason: '理由' }, { code: 'waits-merge', issues: [{ issue: lower, reason: '理由' }] })
    expect(text).toContain('- #3: PR merged, Issue open\n#3 has a merged PR')
    expect(text).not.toContain('to stack on it instead of waiting for merge')
  })
})
