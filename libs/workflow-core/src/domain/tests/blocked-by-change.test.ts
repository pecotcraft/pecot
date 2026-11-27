import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

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

  it('stack で新しく前提を付ける場合は、本文を変えずに add を返す', async () => {
    await explains('前提を付ける変更を決める関数（`decideBlock`）のテストです。前提がまだ付いていない Issue に、`stack` で付ける場合に、本文を変えず `add` を返すことを確認します。')
    expect(decideBlock({ ...base, body: '本文\n', wait: 'stack' })).toEqual({ kind: 'add', body: '本文\n' })
  })

  it('merge で新しく前提を付ける場合は、節に行を追加した本文で add を返す', async () => {
    await explains('前提がまだ付いていない Issue に、`merge` で理由を添えて付ける場合のテストです。本文に `Waits for merge` の節を作成して、前提と理由の行を追加した本文で `add` を返すことを確認します。')
    expect(decideBlock({ ...base, body: '本文\n', wait: 'merge', reason: '理由' })).toEqual({ kind: 'add', body: '本文\n\n## Waits for merge\n\n- #5: 理由\n' })
  })

  it('stack で前提を付ける場合は、節に残った同じ前提の行を取り除く', async () => {
    await explains('`Waits for merge` の節に、同じ前提の行が残っている場合のテストです。`stack` で付けるときは、節からその行を取り除いた本文で `add` を返すことを確認します。')
    expect(decideBlock({ ...base, body: `本文\n\n${SECTION}`, wait: 'stack' })).toEqual({ kind: 'add', body: '本文\n' })
  })

  it('前提が付いていて、種類と理由が同じ場合は、unchanged を返す', async () => {
    await explains('前提がすでに付いている Issue に、同じ種類と同じ理由で付けようとした場合のテストです。変更は不要なため、`merge` と `stack` のどちらでも `unchanged` を返すことを確認します。')
    expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: 'main の版が要る' })).toEqual({ kind: 'unchanged' })
    expect(decideBlock({ ...base, isLinked: true, body: '本文\n', wait: 'stack' })).toEqual({ kind: 'unchanged' })
  })

  it('前提が付いていて、理由が違う場合は、行の理由だけを書き換えて update を返す', async () => {
    await explains('`merge` の前提がすでに付いている Issue に、別の理由で付けようとした場合のテストです。節の行の理由だけを書き換えた本文で、`update` を返すことを確認します。')
    expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: '別の理由' })).toEqual({ kind: 'update', body: '本文\n\n## Waits for merge\n\n- #5: 別の理由\n' })
  })

  it('前提が付いていて、stack から merge に変える場合は、節に行を追加して update を返す', async () => {
    await explains('`stack` の前提がすでに付いている Issue を、`merge` に変える場合のテストです。節に前提と理由の行を追加した本文で、`update` を返すことを確認します。')
    expect(decideBlock({ ...base, isLinked: true, body: '本文\n', wait: 'merge', reason: '理由' })).toEqual({ kind: 'update', body: '本文\n\n## Waits for merge\n\n- #5: 理由\n' })
  })

  it('前提が付いていて、merge から stack に変える場合は、節から行を取り除いて update を返す', async () => {
    await explains('`merge` の前提がすでに付いている Issue を、`stack` に変える場合のテストです。節からその行を取り除いた本文で、`update` を返すことを確認します。')
    expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'stack' })).toEqual({ kind: 'update', body: '本文\n' })
  })

  it('前後の空白だけが違う理由は、同じ理由として扱う', async () => {
    await explains('指定した理由の前後に、空白が含まれる場合のテストです。空白を取り除いて比較し、同じ理由とみなして `unchanged` を返すことを確認します。')
    expect(decideBlock({ ...base, isLinked: true, body: `本文\n\n${SECTION}`, wait: 'merge', reason: '  main の版が要る ' })).toEqual({ kind: 'unchanged' })
  })

  it('節を解釈できない場合は、理由を添えて malformed を返す', async () => {
    await explains('`Waits for merge` の節に、リストの形ではない文章が含まれる場合のテストです。節を解釈できないため、理由（`not a list item`）を添えて `malformed` を返すことを確認します。')
    const result = decideBlock({ ...base, body: '## Waits for merge\n\nplain text\n', wait: 'stack' })
    expect(result).toEqual({ kind: 'malformed', reason: 'not a list item: plain text' })
  })
})

describe('decideUnblock', () => {
  const base = { home: HOME, by: issueOf(5), isLinked: true }

  it('前提が付いていない場合は、unchanged を返し、節の古い行は書き換えない', async () => {
    await explains('前提を外す変更を決める関数（`decideUnblock`）のテストです。前提が付いていない Issue では、節に古い行が残っていても、本文は書き換えず `unchanged` を返すことを確認します。')
    expect(decideUnblock({ ...base, isLinked: false, body: `本文\n\n${SECTION}` })).toEqual({ kind: 'unchanged' })
  })

  it('前提が付いていて、節に行がある場合は、行を取り除いた本文で remove を返す', async () => {
    await explains('前提が付いていて、`Waits for merge` の節にその行がある場合のテストです。節からその行を取り除いた本文で、`remove` を返すことを確認します。')
    expect(decideUnblock({ ...base, body: `本文\n\n${SECTION}` })).toEqual({ kind: 'remove', body: '本文\n', malformedReason: undefined })
  })

  it('前提が付いていて、節に行が存在しない場合は、本文を変えずに remove を返す', async () => {
    await explains('前提が付いていて、`Waits for merge` の節が存在しない場合のテストです。取り除く行がないため、本文は変えず `remove` を返すことを確認します。')
    expect(decideUnblock({ ...base, body: '本文\n' })).toEqual({ kind: 'remove', body: '本文\n', malformedReason: undefined })
  })

  it('節を解釈できなくても remove を返し、本文は変えずに理由を添える', async () => {
    await explains('前提が付いていて、`Waits for merge` の節を解釈できない場合のテストです。本文は変えず、解釈できなかった理由を添えて `remove` を返すことを確認します。')
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
  it('by の前提をたどって待つ側に戻る場合は、待つ側から待つ側までの道筋を返す', async () => {
    await explains('前提の循環を探す関数（`searchCycle`）のテストです。追加しようとする前提（`by`）の前提をたどると、待つ側の Issue へ戻る場合は、`cycle` として道筋を返すことを確認します。')
    const read = graph({ I3: ok(reference('I2', 2)), I2: ok(reference('I1', 1)) })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'cycle', path: [issueOf(1), issueOf(3), issueOf(2), issueOf(1)] })
  })

  it('別のリポジトリを通る循環の道筋は、リポジトリを含む参照で返す', async () => {
    await explains('循環の道筋に、別のリポジトリの Issue が含まれる場合のテストです。その Issue は、リポジトリを含む参照で返すことを確認します。')
    const read = graph({ I3: ok(reference('X9', 9, OTHER)), X9: ok(reference('I1', 1)) })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'cycle', path: [issueOf(1), issueOf(3), issueOf(9, OTHER), issueOf(1)] })
  })

  it('循環にならない場合は none を返し、同じ Issue に複数の道筋で着いても 1 回だけ読む', async () => {
    await explains('前提をたどっても、待つ側の Issue に戻らない場合のテストです。`none` を返し、同じ Issue に複数の道筋で着いても、読み取るのは 1 回だけであることを確認します。')
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

  it('取得できない Issue がある場合は、確認できないものとして理由を返す', async () => {
    await explains('前提を取得できない Issue が途中にある場合のテストです。循環の有無を確認できないため、`unverifiable` として、取得できなかった理由を返すことを確認します。')
    const read = graph({ I3: { kind: 'read-failed', reason: 'blockedBy is null' } })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'unverifiable', reason: 'could not read blocked-by of #3: blockedBy is null' })
  })

  it('前提の件数が取得できた件数より多い場合は、確認できないものとして返す', async () => {
    await explains('前提の件数（51 件）が、取得できた件数より多い場合のテストです。一部しか確認できないため、`unverifiable` として件数を示した理由を返すことを確認します。')
    const read = graph({ I3: { kind: 'ok', total: 51, issues: [reference('I4', 4)] } })

    const result = await searchCycle({ target: issueOf(1), by: issueOf(3), byId: 'I3', read, limit: 200 })

    expect(result).toEqual({ kind: 'unverifiable', reason: 'blocked-by of #3 has 51 issues, more than can be read' })
  })

  it('たどった Issue の数が上限に達した場合は、確認できないものとして返す', async () => {
    await explains('たどる Issue の数に上限（2 件）を指定した場合のテストです。上限に達すると、`unverifiable` として上限を示した理由を返すことを確認します。')
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
  it('前提の集合が期待と同じ場合は、true を返す', async () => {
    await explains('前提が期待どおりに付いているか判定する関数（`hasExpectedPrerequisites`）のテストです。前提の集合が期待と一致する場合に、`true` を返すことを確認します。')
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack'), prerequisite(6, 'stack')], { keys: keys(5, 6), by: issueOf(5), wait: undefined })).toBe(true)
  })

  it('前提が不足している場合や、多すぎる場合は、false を返す', async () => {
    await explains('前提の集合が、期待と一致しない場合のテストです。期待より不足している場合も、多すぎる場合も、`false` を返すことを確認します。')
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack')], { keys: keys(5, 6), by: issueOf(6), wait: undefined })).toBe(false)
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack'), prerequisite(6, 'stack')], { keys: keys(5), by: issueOf(6), wait: undefined })).toBe(false)
  })

  it('種類と理由が期待と同じ場合は true、違う場合は false を返す', async () => {
    await explains('期待する前提に、種類（`merge`）と理由を指定した場合のテストです。種類と理由が同じなら `true`、理由か種類が違えば `false` を返すことを確認します。')
    const expected: ExpectedPrerequisites = { keys: keys(5), by: issueOf(5), wait: { wait: 'merge', reason: '理由' } }
    expect(hasExpectedPrerequisites([prerequisite(5, 'merge', '理由')], expected)).toBe(true)
    expect(hasExpectedPrerequisites([prerequisite(5, 'merge', '別')], expected)).toBe(false)
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack')], expected)).toBe(false)
  })

  it('stack を期待する場合は、理由を比較しない', async () => {
    await explains('期待する前提の種類が `stack` の場合のテストです。`stack` には理由がないため、理由を比較せず `true` を返すことを確認します。')
    expect(hasExpectedPrerequisites([prerequisite(5, 'stack')], { keys: keys(5), by: issueOf(5), wait: { wait: 'stack', reason: undefined } })).toBe(true)
  })
})
