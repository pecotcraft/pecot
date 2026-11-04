/* eslint-disable unicorn/name-replacements -- 対象実体名の踏襲 */
import { describe, expect, it } from 'vitest'

import { slideVisibleFunctionSource, slidevReadyFunctionSource, readSlidevHasNextFn } from '../visibility.js'

describe('slideVisibleFunctionSource', () => {
  it('arrow function 形式の文字列定数', () => {
    expect(typeof slideVisibleFunctionSource).toBe('string')
    expect(slideVisibleFunctionSource.startsWith('(el) => {')).toBe(true)
    expect(slideVisibleFunctionSource).toContain('getComputedStyle')
  })
})

describe('slidevReadyFunctionSource', () => {
  it('arrow function 形式の文字列定数', () => {
    expect(typeof slidevReadyFunctionSource).toBe('string')
    expect(slidevReadyFunctionSource.startsWith('() => {')).toBe(true)
    expect(slidevReadyFunctionSource).toContain('.slidev-page')
  })
})

describe('readSlidevHasNextFn', () => {
  it('arrow function 形式の文字列定数', () => {
    expect(typeof readSlidevHasNextFn).toBe('string')
    expect(readSlidevHasNextFn.startsWith('() => {')).toBe(true)
    expect(readSlidevHasNextFn).toContain('$$slidev-context')
  })
})
/* eslint-enable unicorn/name-replacements */
