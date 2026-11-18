import { describe, expect, it } from 'vitest'

describe('読む', () => {
  it.for([{ name: 'a' }, { name: 'a' }])('$name を読む', (row) => {
    expect(row.name).toBe('a')
  })
})
