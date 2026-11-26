import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { LANE_COLORS, mergeLaneOptions } from '../lane-options.js'

const existing = [
  { id: 'a', name: 'alpha', color: 'PINK', description: 'first' },
  { id: 'b', name: 'beta', color: 'RED', description: '' },
]

describe('LANE_COLORS', () => {
  it('single select の色として、重複のない 8 色を持つ', async () => {
    await explains('レーンの選択肢に付ける色の一覧（`LANE_COLORS`）のテストです。GitHub Projects の single select で使える 8 色が、重複せずに定義されていることを確認します。')
    expect(LANE_COLORS).toHaveLength(8)
    expect(new Set(LANE_COLORS).size).toBe(8)
  })
})

describe('mergeLaneOptions', () => {
  it('フィールドが存在しない場合は、入力の順に選択肢を作成し、順に色を付け、説明を空にする', async () => {
    await explains('レーンの選択肢を既存の選択肢へ統合する、`mergeLaneOptions` のテストです。既存の選択肢が空の場合に、入力の順に選択肢を作成して `LANE_COLORS` の先頭から順に色を付け、説明を空にすることを確認します。')
    expect(mergeLaneOptions([], ['alpha', 'beta'])).toEqual({
      options: [{ name: 'alpha', color: LANE_COLORS[0], description: '' }, { name: 'beta', color: LANE_COLORS[1], description: '' }],
      added: ['alpha', 'beta'],
    })
  })

  it('既存の選択肢を id・color・description ごと保持し、不足している値だけを末尾に追加する', async () => {
    await explains('レーンの選択肢を既存の選択肢へ統合する、`mergeLaneOptions` のテストです。既存の選択肢と重なる値は変更せず、既存に存在しない値だけが末尾に追加され、`added` にその名前が入ることを確認します。')
    const result = mergeLaneOptions(existing, ['beta', 'gamma'])
    expect(result.options).toEqual([...existing, { name: 'gamma', color: LANE_COLORS[2], description: '' }])
    expect(result.added).toEqual(['gamma'])
  })

  it('入力の重複を 1 つにまとめ、Alpha と alpha を別の値として扱う', async () => {
    await explains('レーンの選択肢を既存の選択肢へ統合する、`mergeLaneOptions` のテストです。入力に同じ値が複数ある場合は 1 つにまとめ、大文字と小文字だけが違う `Alpha` と `alpha` は別の値として追加することを確認します。')
    const result = mergeLaneOptions(existing, ['gamma', 'Alpha', 'gamma'])
    expect(result.added).toEqual(['gamma', 'Alpha'])
    expect(result.options.map(option => option.name)).toEqual(['alpha', 'beta', 'gamma', 'Alpha'])
  })

  it('8 色を使い切った場合は、先頭の色に戻る', async () => {
    await explains('レーンの選択肢を既存の選択肢へ統合する、`mergeLaneOptions` のテストです。選択肢が 9 件ある場合に、9 件目の選択肢の色が `LANE_COLORS` の先頭の色に戻ることを確認します。')
    const lanes = Array.from({ length: 9 }, (_unused, index) => `lane${String(index)}`)
    expect(mergeLaneOptions([], lanes).options.at(8)?.color).toBe(LANE_COLORS[0])
  })

  it('追加する値が存在しない場合は、既存の選択肢を削除せず、空の added を返す', async () => {
    await explains('レーンの選択肢を既存の選択肢へ統合する、`mergeLaneOptions` のテストです。入力の値がすべて既存の選択肢と重なる場合に、既存の選択肢をそのまま返し、`added` が空になることを確認します。')
    expect(mergeLaneOptions(existing, ['alpha'])).toEqual({ options: existing, added: [] })
  })
})
