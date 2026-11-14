// GitHub API 操作の例外。Python の cli/core/github/errors.py と同じ階層にする。

import { PecotError } from '../../domain/errors.js'

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
  GraphQL の errors[0] の type（NOT_FOUND など。該当する場合）
  */
  readonly errorType?: string | undefined
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
  readonly errorType: string | undefined

  constructor(message: string, detail: Readonly<GitHubErrorDetail> = {}) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause })
    this.statusCode = detail.statusCode
    this.responseBody = detail.responseBody
    this.errorType = detail.errorType
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
Issue の依存関係（blockedBy など）に対応しない GHES（3.19 より前）のエラー。スキーマの失敗を、ほかの GitHubAPIError と見分けるために使う
*/
export class DependenciesUnsupportedError extends GitHubAPIError {}

/**
GraphQL の errors の NOT_FOUND を GitHubNotFoundError にする。文は変えない。GitHub は無い Issue を data の null でなくこの形で返すことがある
*/
export function asNotFoundError(error: unknown): unknown {
  return error instanceof GitHubAPIError && !(error instanceof GitHubNotFoundError) && error.errorType === 'NOT_FOUND'
    ? new GitHubNotFoundError(error.message, { cause: error, errorType: error.errorType })
    : error
}

/**
このエラーが、ブランチ（ref）がもう無いことを表すか。`Reference does not exist` を含む 404・422 だけを「無い」と見なす
*/
export function isMissingReferenceError(error: Readonly<GitHubAPIError>): boolean {
  return (error.statusCode === 404 || error.statusCode === 422) && error.responseBody?.includes('Reference does not exist') === true
}

/**
別の要求が同時に閉じたことを示す 422 か（PR の Closes による自動 close など）
*/
export function isClosedByAnotherRequest(error: Readonly<GitHubAPIError>): boolean {
  return error.statusCode === 422 && error.responseBody?.includes('closed by another request') === true
}

const SCHEMA_ERROR_PHRASES = ['Cannot query field', 'doesn\'t exist', 'Unknown field']

/**
古い GHES が、対応しないフィールドに返すスキーマの失敗か
*/
export function isSchemaError(error: unknown): error is GitHubAPIError {
  return error instanceof GitHubAPIError && SCHEMA_ERROR_PHRASES.some(phrase => error.message.includes(phrase))
}
