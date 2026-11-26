// 偽の GitHub サーバの応答の規則と、受けた要求の読み方。board sync と session finish のテストが共有する。
import type { RecordedRequest, ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'

/**
GraphQL の応答の規則。operation は libs/workflow-core/tests/_helpers/fake-github/operations.ts の名前
*/
export function graphqlRule(operation: string, data: unknown, variables?: unknown): ResponseRule {
  return { match: { operation, ...(variables !== undefined && { variables }) }, respond: { status: 200, body: { data } }, times: 1 }
}

/**
REST の応答の規則。body が無ければ空の本文（204 は本文なし）
*/
export function restRule(method: string, requestPath: string, status: number, body?: unknown): ResponseRule {
  const payload = status === 204 ? { text: '' } : (body === undefined ? {} : { body })
  return { match: { method, path: requestPath }, respond: { status, ...payload }, times: 1 }
}

const STALE_OPTION_ERROR = { type: 'VALIDATION', message: 'The single select option Id does not belong to the field' }

/**
config の選択肢の ID が古いときの、ボードの欄の書き込みの応答（GitHub は VALIDATION を返す）
*/
export function staleOptionUpdate(times = 1): ResponseRule {
  return { match: { operation: 'UpdateProjectItemField' }, times, respond: { status: 200, body: { errors: [STALE_OPTION_ERROR] } } }
}

/**
STALE_OPTION_ERROR を受けたときの、warning の行の `GraphQL query error: …` の部分
*/
export const STALE_OPTION_TEXT = 'GraphQL query error: {\'type\': \'VALIDATION\', \'message\': \'The single select option Id does not belong to the field\'}'

/**
受けた要求の GraphQL の operation 名と REST の `METHOD path` を、受けた順に並べる
*/
export function requestLabels(requests: readonly RecordedRequest[]): string[] {
  return requests.map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}
