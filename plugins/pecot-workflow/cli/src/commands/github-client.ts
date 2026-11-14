// 各コマンドが、診断の出力先 out を渡す形をそろえて GitHub クライアントを作る。
import type { ProjectConfig } from '../domain/config.js'
import { TransportFailure } from '../infra/github/client.js'
import { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { Output } from './output.js'

/**
host 向けのクライアントを作る。host が undefined なら既定のホスト。トークンが無いときは GitHubAuthError を投げる
*/
export function createGitHubClient(out: Readonly<Output>, host: string | undefined): GitHubClient {
  return new GitHubClient({ host, diagnostics: out })
}

/**
GitHub の失敗（GitHubAPIError と、接続の失敗の TransportFailure）なら、その文を返す。それ以外は投げ直す
*/
export function apiFailureMessage(error: unknown): string {
  if (error instanceof GitHubAPIError || error instanceof TransportFailure) return error.message
  throw error
}

/**
クライアントを作る。認証などの失敗は error の行にして undefined を返すので、呼び出し側は終了コード 1 で終わる
*/
export function makeClient(out: Readonly<Output>, config: Readonly<ProjectConfig>): GitHubClient | undefined {
  try {
    return createGitHubClient(out, config.host)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.error(error.message)
    return undefined
  }
}
