// Tracker を書き直す処理のテスト（actions の tracker-sync と、cli の issue-surface-drift）が共有する、偽の GitHub の応答。
import type { JsonObject } from '../../src/domain/json.js'
import type { ResponseRule } from './fake-github/server.js'

export const WORKFLOW_FIELD = 'PVTSSF_workflow'

/**
label で引いた Issue の一覧の応答。status が 200 以外なら失敗の応答
*/
export function issueListRule(label: string, issues: readonly JsonObject[], status = 200): ResponseRule {
  const body = status === 200 ? issues : { message: 'failure' }
  return { match: { method: 'GET', path: '/repos/acme/demo/issues', query: { state: 'all', labels: label, per_page: '100' } }, respond: { status, body }, times: 1 }
}

/**
Tracker の Issue の作成の応答。status が 201 以外なら失敗の応答
*/
export function createdTracker(number: number, status = 201): ResponseRule {
  const body = status === 201 ? { number } : { message: 'boom' }
  return { match: { method: 'POST', path: '/repos/acme/demo/issues' }, respond: { status, body }, times: 1 }
}

export interface BoardOptions {
  /**
  真なら、空の欄だけに入れる（作った後でない Tracker）
  */
  readonly onlyIfEmpty: boolean
  /**
  既に値が入っている欄の ID
  */
  readonly filled?: readonly string[]
  /**
  真なら、ボードへの追加が 502 で失敗する
  */
  readonly failsToAdd?: boolean
}

/**
Tracker をボードに載せ、Status を Backlog にする応答。Status のほかの欄は書かない（書けば表に無い要求としてテストが落ちる）
*/
export function boardRules(number: number, options: Readonly<BoardOptions>): ResponseRule[] {
  const { onlyIfEmpty, filled = [], failsToAdd = false } = options
  const itemId = `PVTI_${String(number)}`
  const nodeId = `I_${String(number)}`
  const rules: ResponseRule[] = [
    { match: { operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number } }, respond: { status: 200, body: { data: { repository: { issue: { id: nodeId, title: 'Tracker' } } } } }, times: 1 },
  ]
  if (failsToAdd) {
    rules.push({ match: { operation: 'AddToProject' }, respond: { status: 502, body: { message: 'boom' } }, times: 1 })
    return rules
  }
  rules.push({ match: { operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: nodeId } }, respond: { status: 200, body: { data: { addProjectV2ItemById: { item: { id: itemId } } } } }, times: 1 })
  if (onlyIfEmpty) {
    const fieldValues = { nodes: filled.map(id => ({ field: { id } })) }
    const items = { nodes: [{ id: itemId, project: { id: 'PVT_1' }, fieldValues }] }
    rules.push({ match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: items } } } } }, times: 1 })
  }
  if (!filled.includes(WORKFLOW_FIELD)) {
    const variables = { projectId: 'PVT_1', itemId, fieldId: WORKFLOW_FIELD, optionId: 'o1' }
    rules.push({ match: { operation: 'UpdateProjectItemField', variables }, respond: { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } } } }, times: 1 })
  }
  return rules
}
