import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { resolveBatch } from '../batch-plan.js'
import type { BatchEntry, BatchFile } from '../batch-plan.js'

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
    const result = stepSync('`resolveBatch` を呼ぶ', () => resolveBatch(QUICKSTART))
    stepSync('解決できたことを確かめる', () => {
      expect(result.kind).toBe('ok')
    })
    if (result.kind !== 'ok') return
    stepSync('前提の対象と待ち方を比べる', () => {
      expect(result.prerequisites.map(list => list.map(({ target, wait }) => [target.kind === 'file' ? target.index : -1, wait]))).toEqual([
        [],
        [[0, 'stack']],
        [[1, 'stack']],
        [[1, 'stack']],
        [[2, 'stack'], [3, 'merge']],
      ])
    })
    stepSync('進め方を比べる', () => {
      expect([...result.progressions]).toEqual([
        ['phase1', { kind: 'alone' }],
        ['phase2', { kind: 'stack', on: 'phase1' }],
        ['phase3', { kind: 'stack', on: 'phase2' }],
        ['phase4', { kind: 'stack', on: 'phase2' }],
        ['phase5', { kind: 'wait-merge' }],
      ])
    })
  })

  it('短いキー（phase1）と日時付きの長いキーのどちらでも、同じファイルを指せる', async () => {
    await explains('1 つのファイルが複数のキーを持つ場合のテストです。短いキーと日時を含む長いキーのどちらで前提を指定しても、同じファイル（先頭のファイル）に解決されることを確認します。')
    const { result } = stepSync('`resolveBatch` を呼ぶ', () => {
      const files = [file('phase1', [], ['issue-task-20261113-000000-phase1', 'phase1']), file('phase2', ['issue-task-20261113-000000-phase1'])]
      const result = resolveBatch(files)
      return { result }
    })

    stepSync('結果を比べる', () => {
      expect(result.kind === 'ok' && result.prerequisites.at(1)?.at(0)?.target).toEqual({ kind: 'file', index: 0 })
    })
  })

  it('owner/repo/N の形の前提は、既存の Issue として解決する', async () => {
    await explains('`owner/repo/N` の形で前提を指定した場合のテストです。ファイルではなく、既存の Issue（`other/lib` の 12 番）として解決されることを確認します。')
    const result = stepSync('`resolveBatch` を呼ぶ', () => resolveBatch([file('phase1', ['other/lib/12'])]))

    stepSync('結果を比べる', () => {
      expect(result.kind === 'ok' && result.prerequisites.at(0)?.at(0)?.target).toMatchObject({ kind: 'existing', reference: { number: 12, repository: { owner: 'other', repository: 'lib' } } })
    })
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
    stepSync('`resolveBatch` を呼び、結果を比べる', () => {
      expect(resolveBatch(files)).toEqual({ kind: 'error', message: expected })
    })
  })

  it('数字だけのキーは、既存の Issue ではなく、ファイルのキーとして探す', async () => {
    await explains('数字だけのキー（`12`）を前提に指定した場合のテストです。既存の Issue の番号ではなくファイルのキーとして解決され、エラーにならないことを確認します。')
    stepSync('`resolveBatch` を呼び、結果を比べる', () => {
      expect(resolveBatch([file('12'), file('b', ['12'])]).kind).toBe('ok')
    })
  })

  it('存在しないキーの指定は、循環や後ろのファイルの指定より先にエラーとする', async () => {
    await explains('存在しないキーと循環が同時にある場合のテストです。循環より先に、存在しないキー（`zzz`）のエラーを返すことを確認します。')
    stepSync('`resolveBatch` を呼び、結果を比べる', () => {
      expect(resolveBatch([file('a', ['b']), file('b', ['a', 'zzz'])])).toEqual({ kind: 'error', message: 'blocked_by in b.md refers to unknown key zzz' })
    })
  })

  it('循環の指定は、後ろのファイルを指す確認より先にエラーとする', async () => {
    await explains('循環と、後ろのファイルを指す前提が同時にある場合のテストです。後ろのファイルを指す確認より先に、循環のエラーを返すことを確認します。')
    stepSync('`resolveBatch` を呼び、結果を比べる', () => {
      expect(resolveBatch([file('a', ['b']), file('b', ['a'])])).toEqual({ kind: 'error', message: 'blocked_by forms a cycle: a -> b -> a' })
    })
  })
})
