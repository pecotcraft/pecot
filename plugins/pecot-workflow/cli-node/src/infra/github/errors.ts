// GitHub API 操作の例外。Python の cli/core/github/errors.py と同じ階層にする。

import { PecotError } from '../../domain/errors.js'
import { describeErrorBody } from '../../domain/api-error-detail.js'

export interface GitHubErrorDetail {
  /**
  HTTP の状態コード（該当する場合）
  */
  readonly statusCode?: number | undefined
  /**
  応答の本文（該当する場合）
  */
  readonly responseBody?: string | undefined
  /**
  元の例外
  */
  readonly cause?: unknown
}

/**
GitHub API 操作エラーの基底
*/
export class GitHubAPIError extends PecotError {
  readonly statusCode: number | undefined
  readonly responseBody: string | undefined

  constructor(message: string, detail: Readonly<GitHubErrorDetail> = {}) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause })
    this.statusCode = detail.statusCode
    this.responseBody = detail.responseBody
  }
}

/**
認証エラー（401 Unauthorized）。トークンが無効または期限切れのときに起きる
*/
export class GitHubAuthError extends GitHubAPIError {}

/**
リソースが見つからない（404 Not Found）。指定したリポジトリ・Issue・プロジェクトが無いときに起きる
*/
export class GitHubNotFoundError extends GitHubAPIError {}

/**
レート制限エラー（403 Forbidden で rate limit を超えたとき）
*/
export class GitHubRateLimitError extends GitHubAPIError {}

/**
GitHubAPIError の message に、応答本文 JSON の message と errors[].message を添える
*/
export function describeApiError(error: Readonly<GitHubAPIError>): string {
  return describeErrorBody(error.message, error.responseBody)
}
