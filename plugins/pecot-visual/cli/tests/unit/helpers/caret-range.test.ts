import { describe, expect, it } from 'vitest'

import { caretRangeOutside, caretRangeViolation } from '../../_helpers/caret-range.js'

describe('caretRangeOutside', () => {
  it.each(['^8.3.6', '^8.3.7', '^8.4.0'])('%s は ^8.3.6 の中', (inner) => {
    expect(caretRangeOutside(inner, '^8.3.6')).toBeUndefined()
  })

  it.each([
    ['^8.3.5', '下限未満'],
    ['^8.2.9', '下限未満'],
    ['^9.0.0', 'major 不一致'],
    ['^7.9.9', 'major 不一致'],
    ['8.3.7', 'caret range ではない'],
    ['~8.3.7', 'caret range ではない'],
  ])('%s は ^8.3.6 の外（%s）', (inner, reason) => {
    expect(caretRangeOutside(inner, '^8.3.6')).toContain(reason)
  })

  it('0.0.x の caret は patch が違えば外', () => {
    expect(caretRangeOutside('^0.0.4', '^0.0.3')).toContain('patch 不一致')
  })
})

describe('caretRangeViolation: 0.x', () => {
  it('0.21.0 は ^0.20.3 の外（minor が互換の単位）', () => {
    expect(caretRangeViolation('0.21.0', '^0.20.3')).toContain('minor 不一致')
  })

  it('0.0.4 は ^0.0.3 の外（patch が互換の単位）', () => {
    expect(caretRangeViolation('0.0.4', '^0.0.3')).toContain('patch 不一致')
  })

  it('0.20.4 は ^0.20.3 の中', () => {
    expect(caretRangeViolation('0.20.4', '^0.20.3')).toBeUndefined()
  })
})
