import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { JSON_NULL } from '../json-null.js'
import { summarizeLanes } from '../lanes.js'

const issue = (lane: string | null, isStartable = false): { lane: string | null, isStartable: boolean } => ({ lane, isStartable })

describe('summarizeLanes', () => {
  it('選択肢の順に並べ、レーンごとの Issue の件数と着手できる件数を集計する', async () => {
    await explains('レーンごとの Issue の件数を集計する、`summarizeLanes` のテストです。選択肢の並びの順に、Issue の件数（`count`）と着手できる Issue の件数（`startable`）を集計することを確認します。')
    stepSync('summarizeLanes を呼び、結果を比べる', () => {
      expect(summarizeLanes(['beta', 'alpha'], [issue('alpha', true), issue('beta'), issue('alpha')])).toEqual([
        { name: 'beta', count: 1, startable: 0 },
        { name: 'alpha', count: 2, startable: 1 },
      ])
    })
  })

  it('Issue が存在しない選択肢も、0 件として表示する', async () => {
    await explains('レーンごとの Issue の件数を集計する、`summarizeLanes` のテストです。Issue が 1 件もない選択肢についても、件数が 0 の行として結果に含まれることを確認します。')
    stepSync('summarizeLanes を呼び、結果を比べる', () => {
      expect(summarizeLanes(['alpha', 'beta'], [issue('alpha')])).toEqual([
        { name: 'alpha', count: 1, startable: 0 },
        { name: 'beta', count: 0, startable: 0 },
      ])
    })
  })

  it('レーンが未設定の Issue がある場合は、name が null の行を末尾に追加する', async () => {
    await explains('レーンごとの Issue の件数を集計する、`summarizeLanes` のテストです。レーンが未設定の Issue がある場合に、`name` が `null` の行が末尾に追加され、その件数が集計されることを確認します。')
    stepSync('summarizeLanes を呼び、結果を比べる', () => {
      expect(summarizeLanes(['alpha'], [issue(JSON_NULL, true), issue('alpha'), issue(JSON_NULL)])).toEqual([
        { name: 'alpha', count: 1, startable: 0 },
        { name: JSON_NULL, count: 2, startable: 1 },
      ])
    })
  })

  it('レーンが未設定の Issue が存在しない場合は、name が null の行を表示しない', async () => {
    await explains('レーンごとの Issue の件数を集計する、`summarizeLanes` のテストです。レーンが未設定の Issue が存在しない場合に、`name` が `null` の行が結果に含まれないことを確認します。')
    stepSync('summarizeLanes を呼び、結果を比べる', () => {
      expect(summarizeLanes(['alpha'], [])).toEqual([{ name: 'alpha', count: 0, startable: 0 }])
    })
  })

  it('選択肢に存在しない値は、選択肢の後ろ、name が null の行の前に出現順で追加する', async () => {
    await explains('レーンごとの Issue の件数を集計する、`summarizeLanes` のテストです。選択肢に存在しない値のレーンを持つ Issue がある場合に、選択肢の行の後ろ、`name` が `null` の行の前に、出現した順で行が追加されることを確認します。')
    stepSync('summarizeLanes を呼び、結果を比べる', () => {
      expect(summarizeLanes(['alpha'], [issue(JSON_NULL), issue('gone'), issue('old', true), issue('gone')])).toEqual([
        { name: 'alpha', count: 0, startable: 0 },
        { name: 'gone', count: 2, startable: 0 },
        { name: 'old', count: 1, startable: 1 },
        { name: JSON_NULL, count: 1, startable: 0 },
      ])
    })
  })

  it('選択肢が undefined の場合は、Issue があっても空の配列を返す', async () => {
    await explains('レーンごとの Issue の件数を集計する、`summarizeLanes` のテストです。選択肢の一覧が `undefined`（フィールドが存在しない場合）のときに、Issue があっても空の配列を返すことを確認します。')
    stepSync('summarizeLanes を呼び、結果を比べる', () => {
      expect(summarizeLanes(undefined, [issue('alpha'), issue(JSON_NULL)])).toEqual([])
    })
  })

  it('レーンの名前は、大文字と小文字を区別して集計する', async () => {
    await explains('レーンごとの Issue の件数を集計する、`summarizeLanes` のテストです。選択肢が `Alpha` で Issue のレーンが `alpha` の場合に、別のレーンとして集計されることを確認します。')
    stepSync('summarizeLanes を呼び、結果を比べる', () => {
      expect(summarizeLanes(['Alpha'], [issue('alpha')])).toEqual([
        { name: 'Alpha', count: 0, startable: 0 },
        { name: 'alpha', count: 1, startable: 0 },
      ])
    })
  })
})
