import { describe, expect, it } from 'vitest'

import { verifies } from '../../../src/vitest/verifies.js'

describe('結果', () => {
  it('通る', () => {
    expect(1).toBe(1)
  })

  it('落ちる', () => {
    expect(1).toBe(2)
  })

  it('本体で skip する', (context) => {
    context.skip()
  })

  it('COMMON の ID の後に項目の ID を持つ', async (context) => {
    await verifies(context, 'SM-COMMON-01')
    await verifies(context, 'SM-ONE-02')
  })
})
