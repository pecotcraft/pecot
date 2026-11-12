// API エラーの message に、応答本文 JSON の message と errors[].message を添える。GitHub API の失敗の説明の、唯一の実装。

import { isJsonObject, jsonField, tryParseJsonText } from './json.js'
import type { JsonValue } from './python-format.js'
import { pythonStrip } from './python-format.js'

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && pythonStrip(value) !== '' ? pythonStrip(value) : undefined
}

function errorMessages(errors: JsonValue | undefined): readonly (string | undefined)[] {
  if (!Array.isArray(errors)) return []
  const items: readonly JsonValue[] = errors
  return items.map(item => textOf(jsonField(item, 'message')))
}

/**
API の失敗の message に、応答本文の詳細を添える。GitHubAPIError と DependabotFailure をそのまま渡せる。
本文が JSON でない（HTML 等）か、添える文が無いときは message のまま返す。
422 では理由が errors[].message にだけ入ることがある
*/
export function describeApiError(failure: Readonly<{ message: string, responseBody?: string | undefined }>): string {
  const body = tryParseJsonText(failure.responseBody ?? '')
  if (!isJsonObject(body)) return failure.message
  const details = [textOf(body['message']), ...errorMessages(body['errors'])].filter(detail => detail !== undefined)
  return details.length === 0 ? failure.message : `${failure.message} ${details.join(' ')}`
}
