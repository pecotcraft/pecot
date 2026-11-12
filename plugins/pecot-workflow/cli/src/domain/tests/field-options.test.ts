import { describe, expect, it } from 'vitest'

import { insertOption } from '../field-options.js'

const existing = [
  { id: 'a', name: 'Pending', color: 'GRAY', description: 'p' },
  { id: 'b', name: 'Backlog', color: 'RED', description: 'b' },
  { id: 'c', name: 'Ready', color: 'GREEN', description: 'r' },
]
const blocked = { name: 'Blocked', color: 'ORANGE', description: 'x' }

describe('insertOption', () => {
  it('after の名前の直後に差し込み、新しい選択肢は id を持たない', () => {
    const result = insertOption(existing, blocked, { after: 'Backlog' })
    expect(result?.map(option => option.name)).toEqual(['Pending', 'Backlog', 'Blocked', 'Ready'])
    expect(result?.[2]).toEqual({ name: 'Blocked', color: 'ORANGE', description: 'x' })
    expect(result?.[2]).not.toHaveProperty('id')
  })

  it('既存の選択肢は id・name・color・description をそのまま写す', () => {
    const result = insertOption(existing, blocked, { after: 'Backlog' })
    expect(result?.[0]).toEqual(existing[0])
    expect(result?.[1]).toEqual(existing[1])
    expect(result?.[3]).toEqual(existing[2])
  })

  it('after の名前が無ければ末尾に置く', () => {
    expect(insertOption(existing, blocked, { after: 'Nothing' })?.map(option => option.name)).toEqual(['Pending', 'Backlog', 'Ready', 'Blocked'])
  })

  it('before の名前の直前に差し込む', () => {
    expect(insertOption(existing, blocked, { before: 'Ready' })?.map(option => option.name)).toEqual(['Pending', 'Backlog', 'Blocked', 'Ready'])
  })

  it('before の名前が無ければ末尾に置く', () => {
    expect(insertOption(existing, blocked, { before: 'Nothing' })?.at(-1)?.name).toBe('Blocked')
  })

  it('end は末尾に置く', () => {
    expect(insertOption(existing, blocked, { end: true })?.at(-1)?.name).toBe('Blocked')
  })

  it('名前の位置は大文字と小文字を区別せずに探す', () => {
    expect(insertOption(existing, blocked, { after: 'backlog' })?.[2]?.name).toBe('Blocked')
  })

  it('同じ名前が大文字と小文字違いで既にあれば undefined', () => {
    expect(insertOption(existing, { ...blocked, name: 'ready' }, { end: true })).toBeUndefined()
  })

  it('既存が空なら新しい選択肢だけの一覧になる', () => {
    expect(insertOption([], blocked, { end: true })).toEqual([blocked])
  })
})
