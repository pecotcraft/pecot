import { afterEach, describe, expect, it } from 'vitest'

import { childStdin, setChildStdin } from '../child-stdin.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

afterEach(() => {
  setChildStdin('inherit')
})

describe('childStdin', () => {
  it('設定を変更していない場合は、子プロセスの標準入力を親から継承する', async () => {
    await explains('子プロセスの標準入力の設定（`childStdin`）を変更していない場合に、既定値が `inherit` であることを確認します。')
    const value = stepSync('設定を読む', () => childStdin())
    stepSync('設定を比べる', () => {
      expect(value).toBe('inherit')
    })
  })

  it('切り替えると、切り替えた値を返す', async () => {
    await explains('子プロセスの標準入力の設定を `setChildStdin` で切り替えた場合に、`childStdin` が切り替えた値（`ignore`）を返すことを確認します。')
    stepSync('設定を切り替える', () => {
      setChildStdin('ignore')
    })
    const value = stepSync('設定を読む', () => childStdin())
    stepSync('設定を比べる', () => {
      expect(value).toBe('ignore')
    })
  })
})
