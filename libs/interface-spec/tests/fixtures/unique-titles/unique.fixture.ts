import { describe, expect, it } from 'vitest'

describe('読む', () => {
  it.for([{ name: 'a' }, { name: 'b' }])('$name を読む', (row) => {
    expect(row.name).not.toBe('')
  })
})

describe('書く', () => {
  it('a を読む', () => {
    expect(1).toBe(1)
  })
})
