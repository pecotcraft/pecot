import { describe, expect, it } from 'vitest'

import type { PullRequestReadout } from '../issue-readout.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'
import { decideRestack, describeGone, describeNeedsRestack, describeRestackCheck } from '../restack.js'
import type { RestackDecision, RestackInput } from '../restack.js'

const RECORDED = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const REPOSITORY = createRepositoryReference('acme', 'demo')
const LOWER_ISSUE = createIssueReference(REPOSITORY, 3)
const STACKED: RestackInput['reading'] = { kind: 'stacked', record: { branch: 'feat/lower/3', sha: RECORDED, stackedOn: LOWER_ISSUE }, stackedOn: LOWER_ISSUE }

function pullRequest(state: PullRequestReadout['state']): PullRequestReadout {
  return { repository: REPOSITORY, number: 21, state, headRefName: 'feat/lower/3', baseRefName: 'main', isDraft: false, isCrossRepository: false }
}

function input(overrides: Partial<RestackInput>): RestackInput {
  return { reading: STACKED, developBranch: 'main', lowerPullRequest: pullRequest('OPEN'), lowerHead: RECORDED, ...overrides }
}

describe('decideRestack', () => {
  it.for<{ readonly name: string, readonly given: Partial<RestackInput>, readonly expected: RestackDecision }>([
    { name: '記録が無い', given: { reading: { kind: 'development', record: undefined } }, expected: { kind: 'not-stacked', base: 'main' } },
    {
      name: '開発ブランチから着手した記録',
      given: { reading: { kind: 'development', record: { branch: 'main', sha: RECORDED, stackedOn: undefined } } },
      expected: { kind: 'not-stacked', base: 'main' },
    },
    { name: '下の段の先頭が記録と同じ', given: {}, expected: { kind: 'up-to-date', base: 'feat/lower/3' } },
    { name: '下の段の先頭が動いた', given: { lowerHead: MOVED }, expected: { kind: 'moved', base: 'feat/lower/3' } },
    { name: '下の段の PR が無く、先頭が動いた', given: { lowerPullRequest: undefined, lowerHead: MOVED }, expected: { kind: 'moved', base: 'feat/lower/3' } },
    { name: '下の段の PR がマージ済みで、ブランチが消えた', given: { lowerPullRequest: pullRequest('MERGED'), lowerHead: undefined }, expected: { kind: 'merged', base: 'main', pullRequest: 21 } },
    { name: '下の段の PR がマージ済みで、ブランチが残っている', given: { lowerPullRequest: pullRequest('MERGED') }, expected: { kind: 'merged', base: 'main', pullRequest: 21 } },
    { name: 'ブランチが消え、PR が閉じている', given: { lowerPullRequest: pullRequest('CLOSED'), lowerHead: undefined }, expected: { kind: 'gone', base: 'feat/lower/3', pullRequest: 21 } },
    { name: 'ブランチが消え、PR が開いている', given: { lowerHead: undefined }, expected: { kind: 'gone', base: 'feat/lower/3', pullRequest: 21 } },
    { name: 'ブランチが消え、PR が無い', given: { lowerPullRequest: undefined, lowerHead: undefined }, expected: { kind: 'gone', base: 'feat/lower/3', pullRequest: undefined } },
  ])('$name と、$expected.kind に決める', ({ given, expected }) => {
    expect(decideRestack(input(given))).toEqual(expected)
  })
})

describe('describeRestackCheck', () => {
  it.for<{ readonly decision: Exclude<RestackDecision, { kind: 'gone' }>, readonly expected: string }>([
    { decision: { kind: 'not-stacked', base: 'main' }, expected: 'up to date: feat/upper/4 on main' },
    { decision: { kind: 'up-to-date', base: 'feat/lower/3' }, expected: 'up to date: feat/upper/4 on feat/lower/3' },
    { decision: { kind: 'moved', base: 'feat/lower/3' }, expected: 'needs restack: feat/upper/4 on feat/lower/3 (base moved)' },
    { decision: { kind: 'merged', base: 'main', pullRequest: 21 }, expected: 'needs restack: feat/upper/4 onto main (base #21 merged)' },
    { decision: { kind: 'rebased', base: 'main' }, expected: 'up to date: feat/upper/4 on main' },
  ])('$decision.kind の判断を、$expected と出す', ({ decision, expected }) => {
    expect(describeRestackCheck('feat/upper/4', decision)).toBe(expected)
  })
})

describe('describeGone', () => {
  it('PR があれば、その番号を出す', () => {
    expect(describeGone({ kind: 'gone', base: 'feat/lower/3', pullRequest: 21 })).toBe('base branch feat/lower/3 is gone and PR #21 was not merged')
  })

  it('PR が無ければ、PR が無いと出す', () => {
    expect(describeGone({ kind: 'gone', base: 'feat/lower/3', pullRequest: undefined })).toBe('base branch feat/lower/3 is gone and it has no merged PR')
  })
})

describe('describeNeedsRestack', () => {
  it.for<{ readonly decision: RestackDecision, readonly expected: string | undefined }>([
    { decision: { kind: 'up-to-date', base: 'feat/lower/3' }, expected: '- needs restack: no' },
    { decision: { kind: 'not-stacked', base: 'main' }, expected: '- needs restack: no' },
    { decision: { kind: 'moved', base: 'feat/lower/3' }, expected: '- needs restack: yes' },
    { decision: { kind: 'merged', base: 'main', pullRequest: 21 }, expected: '- needs restack: yes' },
    { decision: { kind: 'rebased', base: 'feat/lower/3' }, expected: '- needs restack: no' },
    { decision: { kind: 'gone', base: 'feat/lower/3', pullRequest: 21 }, expected: undefined },
  ])('$decision.kind の判断では、$expected を返す', ({ decision, expected }) => {
    expect(describeNeedsRestack(decision)).toBe(expected)
  })
})
