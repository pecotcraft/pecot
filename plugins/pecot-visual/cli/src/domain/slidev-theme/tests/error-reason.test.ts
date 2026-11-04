import { describe, expect, it } from 'vitest'

import { ThemeDeclarationError } from '../declaration.js'
import { isThemeError, themeErrorReason } from '../error-reason.js'
import { ThemeFetchError } from '../store-layout.js'
import { ThemeResolveError } from '../talk-theme.js'
import { ThemeSpecError } from '../theme-spec.js'

describe('themeErrorReason', () => {
  it.each([
    [new ThemeResolveError('x', 'theme-unlinked'), 'theme-unlinked'],
    [new ThemeResolveError('x', 'theme-none'), 'theme-none'],
    [new ThemeDeclarationError('x', 'invalid-shape'), 'theme-invalid-shape'],
    [new ThemeDeclarationError('x', 'unknown-rule'), 'theme-unknown-rule'],
    [new ThemeFetchError('x', 'tag'), 'theme-tag'],
    [new ThemeSpecError('x', 'tag-required'), 'theme-tag-required'],
  ])('%s の reason は theme-<reason>', (error, reason) => {
    expect(themeErrorReason(error)).toBe(reason)
    expect(isThemeError(error)).toBe(true)
  })

  it('テーマに関わらない例外は undefined', () => {
    expect(themeErrorReason(new Error('x'))).toBeUndefined()
    expect(isThemeError(new Error('x'))).toBe(false)
    expect(isThemeError('x')).toBe(false)
  })
})
