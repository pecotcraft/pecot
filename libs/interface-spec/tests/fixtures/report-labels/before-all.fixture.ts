import { beforeAll, expect, it } from 'vitest'

beforeAll(() => {
  throw new Error('beforeAll で落とす')
})

it('beforeAll の後に動く', () => {
  expect(1).toBe(1)
})
