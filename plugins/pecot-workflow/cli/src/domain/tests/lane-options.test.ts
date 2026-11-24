import { describe, expect, it } from 'vitest'

import { LANE_COLORS, mergeLaneOptions } from '../lane-options.js'

const existing = [
  { id: 'a', name: 'alpha', color: 'PINK', description: 'first' },
  { id: 'b', name: 'beta', color: 'RED', description: '' },
]

describe('LANE_COLORS', () => {
  it('single select の 8 色を重ねずに持つ', () => {
    expect(LANE_COLORS).toHaveLength(8)
    expect(new Set(LANE_COLORS).size).toBe(8)
  })
})

describe('mergeLaneOptions', () => {
  it('無いフィールドには、値を入力の順に並べ、並びの位置で色を順に付け、説明を空にする', () => {
    expect(mergeLaneOptions([], ['alpha', 'beta'])).toEqual({
      options: [{ name: 'alpha', color: LANE_COLORS[0], description: '' }, { name: 'beta', color: LANE_COLORS[1], description: '' }],
      added: ['alpha', 'beta'],
    })
  })

  it('既存の選択肢を id・color・description ごと残し、足りない値だけを末尾に足す', () => {
    const result = mergeLaneOptions(existing, ['beta', 'gamma'])
    expect(result.options).toEqual([...existing, { name: 'gamma', color: LANE_COLORS[2], description: '' }])
    expect(result.added).toEqual(['gamma'])
  })

  it('入力の重なりを 1 つにまとめ、Alpha と alpha を別の値にする', () => {
    const result = mergeLaneOptions(existing, ['gamma', 'Alpha', 'gamma'])
    expect(result.added).toEqual(['gamma', 'Alpha'])
    expect(result.options.map(option => option.name)).toEqual(['alpha', 'beta', 'gamma', 'Alpha'])
  })

  it('8 色を使い切ると、先頭の色に戻る', () => {
    const lanes = Array.from({ length: 9 }, (_unused, index) => `lane${String(index)}`)
    expect(mergeLaneOptions([], lanes).options.at(8)?.color).toBe(LANE_COLORS[0])
  })

  it('足す値が無ければ、既存を消さずに空の added を返す', () => {
    expect(mergeLaneOptions(existing, ['alpha'])).toEqual({ options: existing, added: [] })
  })
})
