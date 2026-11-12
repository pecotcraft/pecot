// API エラーの message に、応答本文 JSON の message と errors[].message を添える。infra の describeApiError と dependabot.ts が共有する。

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
本文が JSON でない（HTML 等）か、添える文が無いときは message のまま返す。
422 では理由が errors[].message にだけ入ることがある
*/
export function describeErrorBody(message: string, responseBody = ''): string {
  const body = tryParseJsonText(responseBody)
  if (!isJsonObject(body)) return message
  const details = [textOf(body['message']), ...errorMessages(body['errors'])].filter(detail => detail !== undefined)
  return details.length === 0 ? message : `${message} ${details.join(' ')}`
}
