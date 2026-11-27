import { describe, expect, it } from 'vitest'

import { ThemeDeclarationError } from '../declaration.js'
import { isThemeError, themeErrorReason } from '../error-reason.js'
import { ThemeFetchError } from '../store-layout.js'
import { ThemeResolveError } from '../talk-theme.js'
import { ThemeSpecError } from '../theme-spec.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('themeErrorReason', () => {
  it.each([
    [new ThemeResolveError('x', 'theme-unlinked'), 'theme-unlinked'],
    [new ThemeResolveError('x', 'theme-none'), 'theme-none'],
    [new ThemeDeclarationError('x', 'invalid-shape'), 'theme-invalid-shape'],
    [new ThemeDeclarationError('x', 'unknown-rule'), 'theme-unknown-rule'],
    [new ThemeFetchError('x', 'tag'), 'theme-tag'],
    [new ThemeSpecError('x', 'tag-required'), 'theme-tag-required'],
  ])('テーマのエラー %s は、reason %s に対応づけられる', async (error, reason) => {
    await explains(`テーマのエラーから reason を取り出す \`themeErrorReason\` のテストです。\`${error.name}\` を渡した場合に、\`theme-\` から始まる reason の \`${reason}\` を返し、テーマのエラーと判定することを確認します。`)
    expect(themeErrorReason(error)).toBe(reason)
    expect(isThemeError(error)).toBe(true)
  })

  it('テーマに関係しない例外は、reason が存在せず、テーマのエラーとして扱わない', async () => {
    await explains('テーマのエラーから reason を取り出す `themeErrorReason` のテストです。通常の `Error` や文字列を渡した場合に、`undefined` を返し、`isThemeError` が `false` になることを確認します。')
    expect(themeErrorReason(new Error('x'))).toBeUndefined()
    expect(isThemeError(new Error('x'))).toBe(false)
    expect(isThemeError('x')).toBe(false)
  })
})
