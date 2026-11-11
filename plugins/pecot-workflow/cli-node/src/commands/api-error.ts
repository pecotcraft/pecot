// GitHub API の失敗から、利用者が読む文を作る。コマンドの `could not ...: <文>` の行が使う。
import type { GitHubAPIError } from '../infra/github/errors.js'
import type { TransportFailure } from '../infra/github/client.js'

/**
API の失敗で見せる文。送信の失敗（接続できない・時間切れ）は PecotError ではないが、文は同じく message
*/
export function apiErrorDetail(error: Readonly<GitHubAPIError | TransportFailure>): string {
  return error.message
}
