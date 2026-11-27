import { describe, expect, it } from 'vitest'

import { isElementOffscreen } from '../prerender-capture.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('isElementOffscreen', () => {
  const viewport = { width: 100, height: 100 }

  it('要素が表示領域の左側に全体がはみ出している場合は、true を返す', async () => {
    await explains('要素が表示領域の外にあるかを判定する `isElementOffscreen` のテストです。要素の右端が表示領域の左端と重なるか、それより左にある場合は、`true` を返すことを確認します。')
    expect(isElementOffscreen({ x: -50, y: 10, width: 50, height: 10 }, viewport)).toBe(true)
  })

  it('要素が表示領域の右側に全体がはみ出している場合は、true を返す', async () => {
    await explains('要素が表示領域の外にあるかを判定する `isElementOffscreen` のテストです。要素の左端が表示領域の右端と重なるか、それより右にある場合は、`true` を返すことを確認します。')
    expect(isElementOffscreen({ x: 100, y: 10, width: 10, height: 10 }, viewport)).toBe(true)
  })

  it('要素が表示領域の上側に全体がはみ出している場合は、true を返す', async () => {
    await explains('要素が表示領域の外にあるかを判定する `isElementOffscreen` のテストです。要素の下端が表示領域の上端と重なるか、それより上にある場合は、`true` を返すことを確認します。')
    expect(isElementOffscreen({ x: 10, y: -10, width: 10, height: 10 }, viewport)).toBe(true)
  })

  it('要素が表示領域の下側に全体がはみ出している場合は、true を返す', async () => {
    await explains('要素が表示領域の外にあるかを判定する `isElementOffscreen` のテストです。要素の上端が表示領域の下端と重なるか、それより下にある場合は、`true` を返すことを確認します。')
    expect(isElementOffscreen({ x: 10, y: 100, width: 10, height: 10 }, viewport)).toBe(true)
  })

  it('要素が表示領域の内側にある場合は、false を返す', async () => {
    await explains('表示領域の内側に要素がある場合に、`isElementOffscreen` が `false` を返すことを確認します。')
    expect(isElementOffscreen({ x: 10, y: 10, width: 10, height: 10 }, viewport)).toBe(false)
  })

  it('要素が表示領域の端にちょうど接している場合は、表示領域の外として扱う', async () => {
    await explains('要素の端が表示領域の境界にちょうど接する場合のテストです。左側と上側で接している場合に、表示領域の外と判定して `true` を返すことを確認します。')
    expect(isElementOffscreen({ x: -10, y: 0, width: 10, height: 10 }, viewport)).toBe(true)
    expect(isElementOffscreen({ x: 0, y: -10, width: 10, height: 10 }, viewport)).toBe(true)
  })
})
