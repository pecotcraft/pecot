import { describe, expect, it } from 'vitest'

import { formatPlanTable, formatStackableChains, resolveBatch } from '../batch-plan.js'
import type { BatchEntry, BatchFile, PlanRow } from '../batch-plan.js'
import type { Progression } from '../readiness.js'
import { createRepositoryReference } from '../repository-resolver.js'

const HOME = createRepositoryReference('acme', 'demo')

function file(key: string, blockedBy: readonly (string | BatchEntry)[] = [], keys: readonly string[] = [key]): BatchFile {
  return {
    name: `${key}.md`,
    key,
    keys,
    blockedBy: blockedBy.map(entry => typeof entry === 'string' ? { issue: entry, wait: 'stack', reason: undefined } : entry),
  }
}

const merge = (issue: string): BatchEntry => ({ issue, wait: 'merge', reason: '既定のブランチから配られる' })

// quickstart.md の 1 の前提の表
const QUICKSTART = [
  file('phase1'),
  file('phase2', ['phase1']),
  file('phase3', ['phase2']),
  file('phase4', ['phase2']),
  file('phase5', ['phase3', merge('phase4')]),
]

describe('resolveBatch', () => {
  it('前提を解決し、ファイルごとの進め方を返す', () => {
    const result = resolveBatch(QUICKSTART)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.prerequisites.map(list => list.map(({ target, wait }) => [target.kind === 'file' ? target.index : -1, wait]))).toEqual([
      [],
      [[0, 'stack']],
      [[1, 'stack']],
      [[1, 'stack']],
      [[2, 'stack'], [3, 'merge']],
    ])
    expect([...result.progressions]).toEqual([
      ['phase1', { kind: 'alone' }],
      ['phase2', { kind: 'stack', on: 'phase1' }],
      ['phase3', { kind: 'stack', on: 'phase2' }],
      ['phase4', { kind: 'stack', on: 'phase2' }],
      ['phase5', { kind: 'wait-merge' }],
    ])
  })

  it('幹と suffix のどちらのキーでも、同じファイルを指せる', () => {
    const files = [file('phase1', [], ['issue-task-20261113-000000-phase1', 'phase1']), file('phase2', ['issue-task-20261113-000000-phase1'])]
    const result = resolveBatch(files)
    expect(result.kind === 'ok' && result.prerequisites.at(1)?.at(0)?.target).toEqual({ kind: 'file', index: 0 })
  })

  it('owner/repo/N は既存の Issue として解決する', () => {
    const result = resolveBatch([file('phase1', ['other/lib/12'])])
    expect(result.kind === 'ok' && result.prerequisites.at(0)?.at(0)?.target).toMatchObject({ kind: 'existing', reference: { number: 12, repository: { owner: 'other', repository: 'lib' } } })
  })

  it.for([
    { name: 'どのファイルにも無いキーを指す', files: [file('a'), file('b', ['c'])], expected: 'blocked_by in b.md refers to unknown key c' },
    { name: '番号が 0 の参照を指す', files: [file('a', ['acme/demo/0'])], expected: 'blocked_by in a.md refers to unknown key acme/demo/0' },
    { name: '後ろのファイルを指す', files: [file('a', ['b']), file('b')], expected: 'blocked_by in a.md refers to b, which comes later' },
    { name: '自分自身を指す', files: [file('a', ['a'])], expected: 'blocked_by forms a cycle: a -> a' },
    { name: '輪になる', files: [file('a', ['c']), file('b', ['a']), file('c', ['b'])], expected: 'blocked_by forms a cycle: a -> c -> b -> a' },
    { name: '同じファイルを 2 回指す', files: [file('a'), file('b', ['a', merge('a')])], expected: 'blocked_by in b.md refers to a more than once' },
    { name: '同じ既存の Issue を 2 回指す', files: [file('a', ['x/y/3', 'x/y/3'])], expected: 'blocked_by in a.md refers to x/y/3 more than once' },
  ])('$name とき、error にする', ({ files, expected }) => {
    expect(resolveBatch(files)).toEqual({ kind: 'error', message: expected })
  })

  it('数字だけのキーは、既存の Issue ではなくファイルのキーとして探す', () => {
    expect(resolveBatch([file('12'), file('b', ['12'])]).kind).toBe('ok')
  })

  it('知らないキーは、輪や後ろのファイルより先に止める', () => {
    expect(resolveBatch([file('a', ['b']), file('b', ['a', 'zzz'])])).toEqual({ kind: 'error', message: 'blocked_by in b.md refers to unknown key zzz' })
  })

  it('輪は、後ろのファイルを指す確認より先に止める', () => {
    expect(resolveBatch([file('a', ['b']), file('b', ['a'])])).toEqual({ kind: 'error', message: 'blocked_by forms a cycle: a -> b -> a' })
  })
})

function rowsOf(files: readonly BatchFile[], orders: readonly (number | undefined)[]): { readonly rows: readonly PlanRow[], readonly progressions: ReadonlyMap<string, Progression> } {
  const result = resolveBatch(files)
  if (result.kind !== 'ok') throw new Error(result.message)
  const rows = files.map((entry, index): PlanRow => ({
    file: entry.key,
    order: orders.at(index),
    prerequisites: result.prerequisites.at(index) ?? [],
    progression: result.progressions.get(entry.key),
  }))
  return { rows, progressions: result.progressions }
}

describe('formatPlanTable', () => {
  it('契約の形の表にする', () => {
    const files = [file('phase3'), file('phase4', ['phase3']), file('phase5', [merge('phase4')]), file('phase6', ['phase4', 'phase5'])]
    const { rows } = rowsOf(files, [19, 20, 21, 22])
    expect(formatPlanTable(rows, HOME)).toBe([
      '| File | Number | Blocked by | Approach |',
      '|---|---|---|---|',
      '| phase3 | 19 | - | alone |',
      '| phase4 | 20 | phase3 | stack on phase3 |',
      '| phase5 | 21 | phase4 (merge) | wait for merge of phase4 |',
      '| phase6 | 22 | phase4, phase5 | join (wait for phase4, phase5) |',
    ].join('\n'))
  })

  it('マージを待つ前提と積める前提の両方があると、Blocked by には両方を出し、Approach にはマージを待つ前提だけを出す', () => {
    const { rows } = rowsOf(QUICKSTART, [1, 2, 3, 4, 5])
    expect(formatPlanTable(rows, HOME).split('\n').at(-1)).toBe('| phase5 | 5 | phase3, phase4 (merge) | wait for merge of phase4 |')
  })

  it('親 Epic の無いファイルの Number は - にし、既存の Issue は home と同じリポなら #N、別のリポなら owner/repo#N で出す', () => {
    const files = [file('a', ['acme/demo/12']), file('b', ['other/lib/7'])]
    const { rows } = rowsOf(files, [undefined, undefined])
    expect(formatPlanTable(rows, HOME).split('\n').slice(2)).toEqual([
      '| a | - | #12 | stack on #12 |',
      '| b | - | other/lib#7 | stack on other/lib#7 |',
    ])
  })
})

describe('formatStackableChains', () => {
  it('積める並びを、見出しと 1 本 1 行で出す', () => {
    const { progressions } = rowsOf(QUICKSTART, [])
    expect(formatStackableChains(progressions, key => key)).toBe('Stackable chains:\n- phase1 -> phase2 -> phase3\n- phase1 -> phase2 -> phase4')
  })

  it('積める並びが無いとき、undefined を返す', () => {
    const files = [file('a'), file('b', [merge('a')])]
    expect(formatStackableChains(rowsOf(files, []).progressions, key => key)).toBeUndefined()
  })

  it('キーを label で表記に直す', () => {
    const { progressions } = rowsOf([file('a'), file('b', ['a'])], [])
    expect(formatStackableChains(progressions, key => `#${key.toUpperCase()}`)).toBe('Stackable chains:\n- #A -> #B')
  })
})
