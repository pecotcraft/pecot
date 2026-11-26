import { describe, expect, it } from 'vitest'

import { decideBlock, decideUnblock, hasExpectedPrerequisites, searchCycle } from '../blocked-by-change.js'
import type { ExpectedPrerequisites } from '../blocked-by-change.js'
import type { BlockedByReference, BlockedByReferences } from '../issue-readout.js'
import type { Prerequisite } from '../readiness.js'
import { createIssueReference } from '../reference-parser.js'
import type { IssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'

const HOME = createRepositoryReference('acme', 'demo')
const OTHER = createRepositoryReference('acme', 'other')

function issueOf(number: number, repository = HOME): IssueReference {
  return createIssueReference(repository, number)
}

const SECTION = '## Waits for merge\n\n- #5: main の版が要る\n'

describe('decideBlock', () => {
  const base = { home: HOME, by: issueOf(5), reason: undefined, isLinked: false }

  it('stack で新しく付けるときは、本文を変えずに add を返す', () => {
    expect(decideBlock({ ...base, body: '本文\n', wait: 'stack' })).toEqual({ kind: 'add', body: '本文\n' })
  })

  it('merge で新しく付けるときは、節に行を足した本文で add を返す', () => {
    expect(decideBlock({ ...base, body: '本文\n', wait: 'merge', reason: '理由' })).toEqual({ kind: 'add', body: '本文\n\n## Waits for merge\n\n- #5: 理由\n' })
  })

  it('stack で付けるとき、節に残った同じ前提の行は外す', () => {
    expect(decideBlock({ ...base, body: `本文\n\n${SECTION}`, wait: 'stack' })).toEqual({ kind: 'add', body: '本文\n' })
  })

  it('付いていて種類と理由が同じなら、unchanged を返す', () => {
    expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: 'main の版が要る' })).toEqual({ kind: 'unchanged' })
    expect(decideBlock({ ...base, isLinked: true, body: '本文\n', wait: 'stack' })).toEqual({ kind: 'unchanged' })
  })

  it('付いていて理由が違えば、行の理由だけ書き換えて update を返す', () => {
    expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: '別の理由' })).toEqual({ kind: 'update', body: '本文\n\n## Waits for merge\n\n- #5: 別の理由\n' })
  })

  it('付いていて stack → merge なら、節に行を足して update を返す', () => {
    expect(decideBlock({ ...base, isLinked: true, body: '本文\n', wait: 'merge', reason: '理由' })).toEqual({ kind: 'update', body: '本文\n\n## Waits for merge\n\n- #5: 理由\n' })
  })

  it('付いていて merge → stack なら、節から行を外して update を返す', () => {
    expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'stack' })).toEqual({ kind: 'update', body: '本文\n' })
  })

  it('前後の空白だけが違う理由は同じものとして扱う', () => {
    expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: '  main の版が要る ' })).toEqual({ kind: 'unchanged' })
  })

  it('節が読めないときは、理由を添えて malformed を返す', () => {
    const result = decideBlock({ ...base, body: '## Waits for merge\n\nplain text\n', wait: 'stack' })
    expect(result).toEqual({ kind: 'malformed', reason: 'not a list item: plain text' })
  })
})

describe('decideUnblock', () => {
  const base = { home: HOME, by: issueOf(5), isLinked: true }

  it('付いていなければ unchanged を返し、節の古い行は書き換えない', () => {
    expect(decideUnblock({ ...base, isLinked: false, body: `本文\n\n${SECTION}` })).toEqual({ kind: 'unchanged' })
  })

  it('付いていて節に行があれば、行を外した本文で remove を返す', () => {
    expect(decideUnblock({ ...base, body: `本文\n\n${SECTION}` })).toEqual({ kind: 'remove', body: '本文\n', malformedReason: undefined })
  })

  it('付いていて節に行が無ければ、本文はそのままの remove を返す', () => {
    expect(decideUnblock({ ...base, body: '本文\n' })).toEqual({ kind: 'remove', body: '本文\n', malformedReason: undefined })
  })

  it('節が読めなくても remove を返し、本文は変えず理由を添える', () => {
    const body = '## Waits for merge\n\nplain text\n'
    expect(decideUnblock({ ...base, body })).toEqual({ kind: 'remove', body, malformedReason: 'not a list item: plain text' })
  })
})

function reference(id: string, number: number, repository = HOME): BlockedByReference {
  return { id, number, repository, state: 'OPEN' }
}

function graph(edges: Readonly<Record<string, BlockedByReferences>>): (ids: readonly string[]) => Promise<ReadonlyMap<string, BlockedByReferences>> {
  const known = new Map(Object.entries(edges))
  return ids => Promise.resolve(new Map(ids.map(id => [id, known.get(id) ?? { kind: 'ok', total: 0, issues: [] }])))
}

function ok(...issues: readonly BlockedByReference[]): BlockedByReferences {
  return { kind: 'ok', total: issues.length, issues }
}

describe('searchCycle', () => {
  it('by の前提をたどって待つ側に戻れば、待つ側から待つ側までの道を返す', async () => {
    const read = graph({ I3: ok(reference('I2', 2)), I2: ok(reference('I1', 1)) })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'cycle', path: [issueOf(1), issueOf(3), issueOf(2), issueOf(1)] })
  })

  it('別のリポジトリを通る輪の道は、リポジトリ付きの参照で返す', async () => {
    const read = graph({ I3: ok(reference('X9', 9, OTHER)), X9: ok(reference('I1', 1)) })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'cycle', path: [issueOf(1), issueOf(3), issueOf(9, OTHER), issueOf(1)] })
  })

  it('輪にならなければ none を返す。同じ Issue に複数の道から着いても 1 回だけ読む', async () => {
    const asked: string[] = []
    const edges = { I3: ok(reference('I4', 4), reference('I5', 5)), I4: ok(reference('I6', 6)), I5: ok(reference('I6', 6)) }
    const read = async (ids: readonly string[]): Promise<ReadonlyMap<string, BlockedByReferences>> => {
      asked.push(...ids)
      return await graph(edges)(ids)
    }

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'none' })
    expect(asked).toEqual(['I3', 'I4', 'I5', 'I6'])
  })

  it('読めない Issue があれば、確かめられないものとして理由を返す', async () => {
    const read = graph({ I3: { kind: 'read-failed', reason: 'blockedBy is null' } })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'unverifiable', reason: 'could not read blocked-by of #3: blockedBy is null' })
  })

  it('前提の件数が読めた分より多ければ、確かめられないものとして返す', async () => {
    const read = graph({ I3: { kind: 'ok', total: 51, issues: [reference('I4', 4)] } })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'unverifiable', reason: 'blocked-by of #3 has 51 issues, more than can be read' })
  })

  it('たどった Issue が上限に達したら、確かめられないものとして返す', async () => {
    const read = graph({ I3: ok(reference('I4', 4), reference('I5', 5)) })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 2 })

    expect(result).toEqual({ kind: 'unverifiable', reason: 'more than 2 issues in the blocked-by chain' })
  })
})

function prerequisite(number: number, wait: Prerequisite['wait'], reason?: string): Prerequisite {
  const issue: Prerequisite['issue'] = { ref: issueOf(number), state: 'open', column: undefined, label: undefined, kind: 'task', branches: [], pullRequests: [] }
  return { issue, wait, reason }
}

function keys(...numbers: readonly number[]): ReadonlySet<string> {
  return new Set(numbers.map(number => `acme/demo#${String(number)}`))
}

describe('hasExpectedPrerequisites', () => {
  it('前提の集合が期待と同じなら真', () => {
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack'), prerequisite(6, 'stack')], { keys: keys(5, 6), by: issueOf(5), wait: undefined })).toBe(true)
  })

  it('前提が足りない・多いなら偽', () => {
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack')], { keys: keys(5, 6), by: issueOf(6), wait: undefined })).toBe(false)
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack'), prerequisite(6, 'stack')], { keys: keys(5), by: issueOf(6), wait: undefined })).toBe(false)
  })

  it('種類と理由が期待と同じなら真、違えば偽', () => {
    const expected: ExpectedPrerequisites = { keys: keys(5), by: issueOf(5), wait: { wait: 'merge', reason: '理由' } }
    expect(hasExpectedPrerequisites([prerequisite(5, 'merge', '理由')], expected)).toBe(true)
    expect(hasExpectedPrerequisites([prerequisite(5, 'merge', '別')], expected)).toBe(false)
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack')], expected)).toBe(false)
  })

  it('stack の期待は理由を見ない', () => {
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack')], { keys: keys(5), by: issueOf(5), wait: { wait: 'stack', reason: undefined } })).toBe(true)
  })
})
