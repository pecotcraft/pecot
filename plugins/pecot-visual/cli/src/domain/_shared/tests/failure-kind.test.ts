import { describe, expect, it } from 'vitest'

import { failureKindOf } from '../failure-kind.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('failureKindOf', () => {
  it('失敗の種類の一覧に存在する名前は、そのまま返す', async () => {
    await explains('失敗の名前を、記録する失敗の種類へ変換する `failureKindOf` のテストです。一覧に存在する名前（`theme-tag-required`）を渡した場合に、同じ名前を返すことを確認します。')
    expect(failureKindOf('theme-tag-required')).toBe('theme-tag-required')
  })

  it('CLI だけが使う名前は、unknown に変換する', async () => {
    await explains('失敗の名前を、記録する失敗の種類へ変換する `failureKindOf` のテストです。一覧に存在しない、CLI だけが使う名前（`missing-option`）を渡した場合に、`unknown` を返すことを確認します。')
    expect(failureKindOf('missing-option')).toBe('unknown')
  })
})
