import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

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
  it('前提を解決し、ファイルごとの進め方（progression）を返す', async () => {
    await explains('Issue を一括登録するファイルの前提を解決する関数（`resolveBatch`）のテストです。前提の対象と待ち方がファイルごとに解決され、`alone`・`stack`・`wait-merge` の進め方が決まることを確認します。')
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

  it('短いキー（phase1）と日時付きの長いキーのどちらでも、同じファイルを指せる', async () => {
    await explains('1 つのファイルが複数のキーを持つ場合のテストです。短いキーと日時を含む長いキーのどちらで前提を指定しても、同じファイル（先頭のファイル）に解決されることを確認します。')
    const files = [file('phase1', [], ['issue-task-20261113-000000-phase1', 'phase1']), file('phase2', ['issue-task-20261113-000000-phase1'])]
    const result = resolveBatch(files)
    expect(result.kind === 'ok' && result.prerequisites.at(1)?.at(0)?.target).toEqual({ kind: 'file', index: 0 })
  })

  it('owner/repo/N の形の前提は、既存の Issue として解決する', async () => {
    await explains('`owner/repo/N` の形で前提を指定した場合のテストです。ファイルではなく、既存の Issue（`other/lib` の 12 番）として解決されることを確認します。')
    const result = resolveBatch([file('phase1', ['other/lib/12'])])
    expect(result.kind === 'ok' && result.prerequisites.at(0)?.at(0)?.target).toMatchObject({ kind: 'existing', reference: { number: 12, repository: { owner: 'other', repository: 'lib' } } })
  })

  it.for([
    { name: '前提が存在しないキーを指す場合は', files: [file('a'), file('b', ['c'])], expected: 'blocked_by in b.md refers to unknown key c' },
    { name: '前提が番号 0 の参照を指す場合は', files: [file('a', ['acme/demo/0'])], expected: 'blocked_by in a.md refers to unknown key acme/demo/0' },
    { name: '前提が後ろのファイルを指す場合は', files: [file('a', ['b']), file('b')], expected: 'blocked_by in a.md refers to b, which comes later' },
    { name: '前提が自分自身を指す場合は', files: [file('a', ['a'])], expected: 'blocked_by forms a cycle: a -> a' },
    { name: '前提が循環している場合は', files: [file('a', ['c']), file('b', ['a']), file('c', ['b'])], expected: 'blocked_by forms a cycle: a -> c -> b -> a' },
    { name: '前提が同じファイルを 2 回指す場合は', files: [file('a'), file('b', ['a', merge('a')])], expected: 'blocked_by in b.md refers to a more than once' },
    { name: '前提が同じ既存の Issue を 2 回指す場合は', files: [file('a', ['x/y/3', 'x/y/3'])], expected: 'blocked_by in a.md refers to x/y/3 more than once' },
  ])('$name、エラーを返す', async ({ name, files, expected }) => {
    await explains(`一括登録するファイルの前提に誤りがある場合のテストです。${name}、原因を示すメッセージを持つエラーを返すことを確認します。`)
    expect(resolveBatch(files)).toEqual({ kind: 'error', message: expected })
  })

  it('数字だけのキーは、既存の Issue ではなく、ファイルのキーとして探す', async () => {
    await explains('数字だけのキー（`12`）を前提に指定した場合のテストです。既存の Issue の番号ではなくファイルのキーとして解決され、エラーにならないことを確認します。')
    expect(resolveBatch([file('12'), file('b', ['12'])]).kind).toBe('ok')
  })

  it('存在しないキーの指定は、循環や後ろのファイルの指定より先にエラーとする', async () => {
    await explains('存在しないキーと循環が同時にある場合のテストです。循環より先に、存在しないキー（`zzz`）のエラーを返すことを確認します。')
    expect(resolveBatch([file('a', ['b']), file('b', ['a', 'zzz'])])).toEqual({ kind: 'error', message: 'blocked_by in b.md refers to unknown key zzz' })
  })

  it('循環の指定は、後ろのファイルを指す確認より先にエラーとする', async () => {
    await explains('循環と、後ろのファイルを指す前提が同時にある場合のテストです。後ろのファイルを指す確認より先に、循環のエラーを返すことを確認します。')
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
  it('計画を、契約で決めた形の表にする', async () => {
    await explains('登録計画の表を作成する関数（`formatPlanTable`）のテストです。ファイル・番号・前提・進め方の 4 列を持つ Markdown の表になり、`alone` や `stack on` などの進め方が表示されることを確認します。')
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

  it('スタック不可の前提とスタック可の前提の両方があると、Blocked by には両方を出し、Approach にはスタック不可の前提だけを出す', async () => {
    await explains('スタック不可の前提とスタック可の前提を両方持つファイルのテストです。`Blocked by` の列には両方の前提が表示され、`Approach` の列にはスタック不可の前提だけが表示されることを確認します。')
    const { rows } = rowsOf(QUICKSTART, [1, 2, 3, 4, 5])
    expect(formatPlanTable(rows, HOME).split('\n').at(-1)).toBe('| phase5 | 5 | phase3, phase4 (merge) | wait for merge of phase4 |')
  })

  it('親 Epic がないファイルの Number は - にし、既存の Issue は home と同じリポジトリなら #N、別のリポジトリなら owner/repo#N で表示する', async () => {
    await explains('親 Epic を持たず、既存の Issue を前提に持つファイルのテストです。`Number` の列は `-` になり、前提の Issue は同じリポジトリなら `#12`、別のリポジトリなら `other/lib#7` の形で表示されることを確認します。')
    const files = [file('a', ['acme/demo/12']), file('b', ['other/lib/7'])]
    const { rows } = rowsOf(files, [undefined, undefined])
    expect(formatPlanTable(rows, HOME).split('\n').slice(2)).toEqual([
      '| a | - | #12 | stack on #12 |',
      '| b | - | other/lib#7 | stack on other/lib#7 |',
    ])
  })
})

describe('formatStackableChains', () => {
  it('スタック可の並びを、見出しと 1 本 1 行で表示する', async () => {
    await explains('スタック可の前提の並びを表示する関数（`formatStackableChains`）のテストです。`Stackable chains:` の見出しの後に、並びが 1 本ごとに 1 行で表示されることを確認します。')
    const { progressions } = rowsOf(QUICKSTART, [])
    expect(formatStackableChains(progressions, key => key)).toBe('Stackable chains:\n- phase1 -> phase2 -> phase3\n- phase1 -> phase2 -> phase4')
  })

  it('スタック可の並びが存在しない場合は、undefined を返す', async () => {
    await explains('スタック不可の前提（`merge`）だけを持つファイルのテストです。スタック可の並びが存在しないため、`undefined` を返すことを確認します。')
    const files = [file('a'), file('b', [merge('a')])]
    expect(formatStackableChains(rowsOf(files, []).progressions, key => key)).toBeUndefined()
  })

  it('キーを label 関数で表示用の名前に変換する', async () => {
    await explains('表示用の名前に変換する関数を渡した場合のテストです。並びの各キーが、渡した関数で変換された名前（`#A` など）で表示されることを確認します。')
    const { progressions } = rowsOf([file('a'), file('b', ['a'])], [])
    expect(formatStackableChains(progressions, key => `#${key.toUpperCase()}`)).toBe('Stackable chains:\n- #A -> #B')
  })
})
