// テーマに関わる例外を、失敗の reason（`theme-<reason>`）に変換する。
// lint・theme・dev・convert・sync が、同じ変換を使う。手書きの写しを置かない。

import { ThemeDeclarationError } from './declaration.js'
import { ThemeFetchError } from './store-layout.js'
import { ThemeResolveError } from './talk-theme.js'
import { ThemeSpecError } from './theme-spec.js'

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
export function themeErrorReason(error: unknown): string | undefined {
  if (error instanceof ThemeResolveError) return error.reason
  if (error instanceof ThemeFetchError || error instanceof ThemeDeclarationError || error instanceof ThemeSpecError) {
    return `theme-${error.reason}`
  }
  return undefined
}
