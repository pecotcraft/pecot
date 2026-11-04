import { describe, expect, it } from 'vitest'

import { isElementOffscreen } from '../prerender-capture.js'

describe('isElementOffscreen', () => {
  const viewport = { width: 100, height: 100 }

  it('左方向に全体が外', () => {
    expect(isElementOffscreen({ x: -50, y: 10, width: 50, height: 10 }, viewport)).toBe(true)
  })

  it('右方向に全体が外', () => {
    expect(isElementOffscreen({ x: 100, y: 10, width: 10, height: 10 }, viewport)).toBe(true)
  })

  it('上方向に全体が外', () => {
    expect(isElementOffscreen({ x: 10, y: -10, width: 10, height: 10 }, viewport)).toBe(true)
  })

  it('下方向に全体が外', () => {
    expect(isElementOffscreen({ x: 10, y: 100, width: 10, height: 10 }, viewport)).toBe(true)
  })

  it('viewport 内にあれば false', () => {
    expect(isElementOffscreen({ x: 10, y: 10, width: 10, height: 10 }, viewport)).toBe(false)
  })

  it('境界にちょうど接する場合は外扱い (<=, >= の境界)', () => {
    expect(isElementOffscreen({ x: -10, y: 0, width: 10, height: 10 }, viewport)).toBe(true)
    expect(isElementOffscreen({ x: 0, y: -10, width: 10, height: 10 }, viewport)).toBe(true)
  })
})
