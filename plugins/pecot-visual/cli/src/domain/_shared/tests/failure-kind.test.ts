import { describe, expect, it } from 'vitest'

import { failureKindOf } from '../failure-kind.js'

describe('failureKindOf', () => {
  it('一覧にある名前は、そのまま返す', () => {
    expect(failureKindOf('theme-tag-required')).toBe('theme-tag-required')
  })

  it('CLI だけの名前は unknown にする', () => {
    expect(failureKindOf('missing-option')).toBe('unknown')
  })
})
