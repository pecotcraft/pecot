import { afterEach, describe, expect, it } from 'vitest'

import { childStdin, setChildStdin } from '../child-stdin.js'

afterEach(() => {
  setChildStdin('inherit')
})

describe('childStdin', () => {
  it('既定は継承する', () => {
    expect(childStdin()).toBe('inherit')
  })

  it('切り替えると、切り替えた値を返す', () => {
    setChildStdin('ignore')
    expect(childStdin()).toBe('ignore')
  })
})
