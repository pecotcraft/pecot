import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { JSON_NULL } from '../json-null.js'

describe('JSON_NULL', () => {
  it('JSON に変換すると、undefined のように落ちず null になる', async () => {
    await explains('JSON の `null` を表す定数 `JSON_NULL` のテストです。`JSON.stringify` で変換した場合に、`undefined` の値はキーごと省かれる一方、`JSON_NULL` は `null` として出力されることを確認します。')
    stepSync('JSON_NULL を呼び、結果を比べる', () => {
      expect(JSON.stringify({ a: JSON_NULL, b: undefined })).toBe('{"a":null}')
    })
  })
})
