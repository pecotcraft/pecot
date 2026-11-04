// slide create / sync / lint が共有する例外。
// usage error（CLI 引数の誤り、exit 2）と runtime error（実行時の失敗、exit 1）を分ける。

export class SlideCreateUsageError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'SlideCreateUsageError'
  }
}

export class SlideCreateRuntimeError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'SlideCreateRuntimeError'
  }
}
