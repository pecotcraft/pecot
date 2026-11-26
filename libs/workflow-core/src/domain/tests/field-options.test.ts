import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { appendOptions, choosePlacement, copyOption, findOptionByName, insertOption } from '../field-options.js'

const existing = [
  { id: 'a', name: 'Pending', color: 'GRAY', description: 'p' },
  { id: 'b', name: 'Backlog', color: 'RED', description: 'b' },
  { id: 'c', name: 'Ready', color: 'GREEN', description: 'r' },
]
const blocked = { name: 'Blocked', color: 'ORANGE', description: 'x' }

describe('insertOption', () => {
  it('after で指定した名前の直後に挿入し、新しい選択肢は id を持たない', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。`after` に既存の名前を指定した場合に、その直後に挿入され、新しい選択肢には `id` が付かないことを確認します。')
    const result = insertOption(existing, blocked, { after: 'Backlog' })
    expect(result?.map(option => option.name)).toEqual(['Pending', 'Backlog', 'Blocked', 'Ready'])
    expect(result?.[2]).toEqual({ name: 'Blocked', color: 'ORANGE', description: 'x' })
    expect(result?.[2]).not.toHaveProperty('id')
  })

  it('既存の選択肢は、id・name・color・description をそのまま保持する', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。選択肢を挿入した場合に、既存の選択肢が `id`・`name`・`color`・`description` を含めて変更されないことを確認します。')
    const result = insertOption(existing, blocked, { after: 'Backlog' })
    expect(result?.[0]).toEqual(existing[0])
    expect(result?.[1]).toEqual(existing[1])
    expect(result?.[3]).toEqual(existing[2])
  })

  it('after で指定した名前が存在しない場合は、末尾に挿入する', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。`after` に存在しない名前を指定した場合に、新しい選択肢が末尾に挿入されることを確認します。')
    expect(insertOption(existing, blocked, { after: 'Nothing' })?.map(option => option.name)).toEqual(['Pending', 'Backlog', 'Ready', 'Blocked'])
  })

  it('before で指定した名前の直前に挿入する', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。`before` に既存の名前を指定した場合に、その直前に挿入されることを確認します。')
    expect(insertOption(existing, blocked, { before: 'Ready' })?.map(option => option.name)).toEqual(['Pending', 'Backlog', 'Blocked', 'Ready'])
  })

  it('before で指定した名前が存在しない場合は、末尾に挿入する', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。`before` に存在しない名前を指定した場合に、新しい選択肢が末尾に挿入されることを確認します。')
    expect(insertOption(existing, blocked, { before: 'Nothing' })?.at(-1)?.name).toBe('Blocked')
  })

  it('end を指定した場合は、末尾に挿入する', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。位置に `end` を指定した場合に、新しい選択肢が末尾に挿入されることを確認します。')
    expect(insertOption(existing, blocked, { end: true })?.at(-1)?.name).toBe('Blocked')
  })

  it('挿入位置の名前は、大文字と小文字を区別せずに探す', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。`after` に小文字の `backlog` を指定した場合でも、`Backlog` の直後に挿入されることを確認します。')
    expect(insertOption(existing, blocked, { after: 'backlog' })?.[2]?.name).toBe('Blocked')
  })

  it('大文字と小文字だけが異なる同じ名前の選択肢が既に存在する場合は、undefined を返す', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。既存の `Ready` に対して `ready` を挿入しようとした場合に、重複として `undefined` を返すことを確認します。')
    expect(insertOption(existing, { ...blocked, name: 'ready' }, { end: true })).toBeUndefined()
  })

  it('既存の選択肢が空の場合は、新しい選択肢だけの一覧を返す', async () => {
    await explains('ボードの選択肢の一覧へ、新しい選択肢を挿入する `insertOption` のテストです。既存の選択肢が空の場合に、新しい選択肢だけを含む一覧を返すことを確認します。')
    expect(insertOption([], blocked, { end: true })).toEqual([blocked])
  })
})

describe('choosePlacement', () => {
  it('基準の名前が既存の選択肢に存在する最初の候補を選ぶ（大文字と小文字は区別しない）', async () => {
    await explains('挿入位置の候補から、使う位置を選ぶ `choosePlacement` のテストです。複数の候補がある場合に、基準の名前が既存の選択肢に存在する最初の候補を、大文字と小文字を区別せずに選ぶことを確認します。')
    expect(choosePlacement(existing, [{ after: 'backlog' }, { before: 'Ready' }])).toEqual({ after: 'backlog' })
  })

  it('先の候補の基準が存在しない場合は、次の候補を選ぶ', async () => {
    await explains('挿入位置の候補から、使う位置を選ぶ `choosePlacement` のテストです。先頭の候補の基準が存在しない場合に、次の候補を選ぶことを確認します。')
    expect(choosePlacement(existing, [{ after: 'Nothing' }, { before: 'Ready' }])).toEqual({ before: 'Ready' })
  })

  it('どの候補の基準も存在しない場合は、末尾を選ぶ', async () => {
    await explains('挿入位置の候補から、使う位置を選ぶ `choosePlacement` のテストです。どの候補の基準も存在しない場合と、候補が空の場合に、末尾（`end`）を選ぶことを確認します。')
    expect(choosePlacement(existing, [{ after: 'Nothing' }, { before: 'Nothing' }])).toEqual({ end: true })
    expect(choosePlacement(existing, [])).toEqual({ end: true })
  })
})

describe('copyOption', () => {
  it('id を持つ選択肢は id ごと複製し、id を持たない選択肢には id を追加しない', async () => {
    await explains('選択肢を複製する `copyOption` のテストです。`id` を持つ選択肢は `id` を含めて複製し、`id` を持たない選択肢には `id` を追加しないことを確認します。')
    expect(copyOption({ id: 'a', name: 'Pending', color: 'GRAY', description: 'p' })).toEqual({ id: 'a', name: 'Pending', color: 'GRAY', description: 'p' })
    expect(copyOption(blocked)).toEqual(blocked)
    expect(copyOption(blocked)).not.toHaveProperty('id')
  })
})

describe('appendOptions', () => {
  it('既存の選択肢を id・color・description ごと保持し、存在しない名前の選択肢だけを末尾に追加する', async () => {
    await explains('既存の選択肢の末尾へ、選択肢を追加する `appendOptions` のテストです。既存と同じ名前の選択肢は追加せず、存在しない名前の選択肢だけを末尾に追加し、`added` にその名前を返すことを確認します。')
    const result = appendOptions(existing, [{ name: 'Ready', color: 'BLUE', description: '' }, blocked])
    expect(result.options).toEqual([...existing, blocked])
    expect(result.added).toEqual(['Blocked'])
  })

  it('名前は、大文字と小文字を区別して比較する', async () => {
    await explains('既存の選択肢の末尾へ、選択肢を追加する `appendOptions` のテストです。既存の `Ready` に対して小文字の `ready` を渡した場合に、別の名前として末尾に追加されることを確認します。')
    const lower = { name: 'ready', color: 'BLUE', description: '' }
    expect(appendOptions(existing, [lower])).toEqual({ options: [...existing, lower], added: ['ready'] })
  })

  it('追加分の中で名前が重複した場合は、先の選択肢だけを追加する', async () => {
    await explains('既存の選択肢の末尾へ、選択肢を追加する `appendOptions` のテストです。追加する選択肢の中に同じ名前が 2 つある場合に、先に指定した選択肢だけが追加されることを確認します。')
    const later = { ...blocked, color: 'RED' }
    expect(appendOptions(existing, [blocked, later])).toEqual({ options: [...existing, blocked], added: ['Blocked'] })
  })

  it('追加する選択肢が存在しない場合は、既存の選択肢の複製と空の added を返す', async () => {
    await explains('既存の選択肢の末尾へ、選択肢を追加する `appendOptions` のテストです。渡した選択肢がすべて既存の名前と重なる場合に、既存の選択肢をそのまま返し、`added` が空になることを確認します。')
    expect(appendOptions(existing, [{ name: 'Pending', color: 'BLUE', description: '' }])).toEqual({ options: existing, added: [] })
  })
})

describe('findOptionByName', () => {
  it('名前が大文字と小文字まで一致する選択肢を返し、一致しない場合は undefined を返す', async () => {
    await explains('名前で選択肢を探す `findOptionByName` のテストです。大文字と小文字まで一致する名前の場合に、その選択肢を返し、大文字と小文字だけが異なる名前の場合は `undefined` を返すことを確認します。')
    expect(findOptionByName(existing, 'Backlog')).toEqual(existing[1])
    expect(findOptionByName(existing, 'backlog')).toBeUndefined()
  })
})
