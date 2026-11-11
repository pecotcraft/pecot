/* eslint-disable unicorn/name-replacements -- 対象実体名の踏襲 */
import { describe, expect, it } from 'vitest'

import { slideVisibleFunctionSource, slidevReadyFunctionSource, readSlidevHasNextFn } from '../visibility.js'

describe('slideVisibleFunctionSource', () => {
  it('定数の値は、引数 el を取るアロー関数の文字列で、getComputedStyle を含む', () => {
    expect(typeof slideVisibleFunctionSource).toBe('string')
    expect(slideVisibleFunctionSource.startsWith('(el) => {')).toBe(true)
    expect(slideVisibleFunctionSource).toContain('getComputedStyle')
  })
})

describe('slidevReadyFunctionSource', () => {
  it('定数の値は、引数の無いアロー関数の文字列で、.slidev-page を含む', () => {
    expect(typeof slidevReadyFunctionSource).toBe('string')
    expect(slidevReadyFunctionSource.startsWith('() => {')).toBe(true)
    expect(slidevReadyFunctionSource).toContain('.slidev-page')
  })
})

describe('readSlidevHasNextFn', () => {
  it('定数の値は、引数の無いアロー関数の文字列で、$$slidev-context を含む', () => {
    expect(typeof readSlidevHasNextFn).toBe('string')
    expect(readSlidevHasNextFn.startsWith('() => {')).toBe(true)
    expect(readSlidevHasNextFn).toContain('$$slidev-context')
  })
})
/* eslint-enable unicorn/name-replacements */
