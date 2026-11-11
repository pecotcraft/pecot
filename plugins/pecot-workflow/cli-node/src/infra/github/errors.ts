// GitHub API 操作の例外。Python の cli/core/github/errors.py と同じ階層にする。

import { PecotError } from '../../domain/errors.js'
import { isJsonObject, jsonField, tryParseJsonText } from '../../domain/json.js'
import { isJsonArray, pythonStrip } from '../../domain/python-format.js'

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

// 文字列で、前後の空白を落として空でないものだけ返す
function nonBlankText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const stripped = pythonStrip(value)
  return stripped === '' ? undefined : stripped
}

/**
GitHubAPIError の message に、応答本文 JSON の message と errors[].message を添える。
本文が JSON でない（HTML など）・どちらも無いときは添えない。422 では理由が errors[].message にだけ入ることがある
*/
export function describeApiError(error: Readonly<GitHubAPIError>): string {
  const body = tryParseJsonText(error.responseBody ?? '')
  if (!isJsonObject(body)) return error.message
  const errors = jsonField(body, 'errors')
  const details = [
    nonBlankText(jsonField(body, 'message')),
    ...(isJsonArray(errors) ? errors.map(item => nonBlankText(jsonField(item, 'message'))) : []),
  ].filter(detail => detail !== undefined)
  return details.length === 0 ? error.message : `${error.message} ${details.join(' ')}`
}

/**
ブランチ（ref）がもう無いことを示すエラーか（404 か 422 で、本文に「Reference does not exist」）
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
