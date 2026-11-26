// slide_create / slide_sync / slide_lint が共有する例外。
// usage error（引数の誤り）と runtime error（実行時の失敗）を分ける。

import type { FailureReason } from '../_shared/failure-kind.js'

export class SlideCreateUsageError extends Error {
  constructor(message: string, readonly reason: FailureReason) {
    super(message)
    this.name = 'SlideCreateUsageError'
  }
}

export class SlideCreateRuntimeError extends Error {
  constructor(message: string, readonly reason: FailureReason) {
    super(message)
    this.name = 'SlideCreateRuntimeError'
  }
}
