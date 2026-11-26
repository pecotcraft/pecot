// commands/slidev-project/lint.ts の errorToReason の unit test。
// テーマの解決・宣言の失敗は theme-<reason> の形で載る。

import { describe, expect, it } from 'vitest'

import { errorToReason } from '../../../src/commands/slidev-project/lint.js'
import { SlideCreateRuntimeError } from '../../../src/domain/slidev-project/errors.js'
import { SlideLintRuntimeError, SlideLintUsageError } from '../../../src/domain/slidev-project/lint.js'
import { ThemeDeclarationError } from '../../../src/domain/slidev-theme/declaration.js'
import { ThemeResolveError } from '../../../src/domain/slidev-theme/talk-theme.js'

describe('errorToReason', () => {
  it.each([
    [new SlideLintUsageError('x', 'relative-dir'), 'relative-dir'],
    [new SlideLintRuntimeError('x', 'eslint-failed'), 'eslint-failed'],
    [new SlideCreateRuntimeError('x', 'copy-failed'), 'copy-failed'],
    [new ThemeResolveError('x', 'theme-unlinked'), 'theme-unlinked'],
    [new ThemeResolveError('x', 'theme-none'), 'theme-none'],
    [new ThemeDeclarationError('x', 'invalid-shape'), 'theme-invalid-shape'],
    [new ThemeDeclarationError('x', 'unknown-rule'), 'theme-unknown-rule'],
    [new Error('x'), 'unknown'],
  ])('%s の reason に %s を返す', (error, reason) => {
    expect(errorToReason(error)).toBe(reason)
  })
})
