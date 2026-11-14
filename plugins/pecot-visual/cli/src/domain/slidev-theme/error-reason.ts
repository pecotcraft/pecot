// テーマに関わる例外を、失敗の reason（`theme-<reason>`）に変換する。
// lint・theme・dev・convert・sync が、同じ変換を使う。手書きの写しを置かない。

import { ThemeDeclarationError, type ThemeDeclarationErrorReason } from './declaration.js'
import { ThemeFetchError, type ThemeFetchErrorReason } from './store-layout.js'
import { ThemeResolveError, type ThemeResolveErrorReason } from './talk-theme.js'
import { ThemeSpecError, type ThemeSpecErrorReason } from './theme-spec.js'

/**
テーマの失敗の reason。`ThemeResolveError` の reason は最初から `theme-` を含む。
*/
export type ThemeErrorReason
  = | ThemeResolveErrorReason
    | `theme-${ThemeFetchErrorReason | ThemeDeclarationErrorReason | ThemeSpecErrorReason}`

export type ThemeError = ThemeResolveError | ThemeDeclarationError | ThemeFetchError | ThemeSpecError

/**
テーマの解決・宣言・取得・指定のどれかの例外か。
*/
export function isThemeError(error: unknown): error is ThemeError {
  return error instanceof ThemeResolveError
    || error instanceof ThemeDeclarationError
    || error instanceof ThemeFetchError
    || error instanceof ThemeSpecError
}

/**
失敗の reason。テーマに関わる例外だけ `theme-<reason>` の形で返し、それ以外は undefined。
`ThemeResolveError` の reason は最初から `theme-` を含むので、そのまま返す。
*/
export function themeErrorReason(error: unknown): ThemeErrorReason | undefined {
  if (error instanceof ThemeResolveError) return error.reason
  if (error instanceof ThemeFetchError || error instanceof ThemeDeclarationError || error instanceof ThemeSpecError) {
    return `theme-${error.reason}`
  }
  return undefined
}
