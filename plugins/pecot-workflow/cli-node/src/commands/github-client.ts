// 各コマンドが、診断の出力先 out を渡す形をそろえて GitHub クライアントを作る。
import type { ProjectConfig } from '../domain/config.js'
import { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import type { Output } from './output.js'

/**
アクティブなプロジェクトのホスト向けのクライアントを作る。トークンが無いときは GitHubAuthError を投げる
*/
export function createGitHubClient(out: Readonly<Output>, config: Readonly<ProjectConfig>): GitHubClient {
  return new GitHubClient({ host: config.host, diagnostics: out })
}

/**
クライアントを作る。認証などの失敗は error の行にして undefined を返すので、呼び出し側は終了コード 1 で終わる
*/
export function makeClient(out: Readonly<Output>, config: Readonly<ProjectConfig>): GitHubClient | undefined {
  try {
    return createGitHubClient(out, config)
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.error(error.message)
    return undefined
  }
}
