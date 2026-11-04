// drawio url の失敗の型。url.ts と theme.ts が共有する。url.ts から再 export する。

import type { TextViolation } from '../../domain/_shared/text-check.js'

export class DrawioUrlUsageError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'DrawioUrlUsageError'
  }
}

export class DrawioUrlRuntimeError extends Error {
  /**
  reason が text-violation のときの違反の全件。
  */
  constructor(message: string, readonly reason: string, readonly violations?: readonly TextViolation[]) {
    super(message)
    this.name = 'DrawioUrlRuntimeError'
  }
}
