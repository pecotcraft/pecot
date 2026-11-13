// CLI の例外の基底。
//
// 階層は 2 系統ある。どちらも BaseError を共通の基底にする。
// - PecotError 系は、利用者に見せる独自の例外。
//   Python の core/errors.py の PecotError と同じ階層で、各モジュールの独自例外が継承する。
// - Python の組み込み例外に当たる系は、PecotError を継承せず BaseError を直接継承する。
//   InvalidValueError は ValueError、OsError は OSError、GitCommandError は CalledProcessError に当たる。
//   TransportFailure、GraphqlFailure、UsageError などもこの系統。
//   最上位で拾う側（commands/failure.ts）が、この 2 系統を区別して扱う。

/**
name をクラス名にし、cause を受け取る共通の基底
*/
export class BaseError extends Error {
  constructor(message: string, options?: Readonly<ErrorOptions>) {
    super(message, options)
    this.name = new.target.name
  }
}

export class PecotError extends BaseError {}

/**
プロジェクトルートが見つからない
*/
export class ProjectRootNotFoundError extends PecotError {}

/**
値の形式が不正（Python の ValueError に当たる）。PecotError ではない
*/
export class InvalidValueError extends BaseError {}

/**
起きないはずの分岐に入った。実装の誤りで、利用者の入力のせいではない
*/
export class InternalError extends BaseError {}
