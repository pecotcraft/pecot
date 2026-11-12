// security sync のテストが共有する準備。alert の応答・Tracker の Issue・ボードの応答を組み立てる。
import { vi } from 'vitest'

import type { JsonObject } from '../../src/domain/json.js'
import { renderTrackerBody } from '../../src/domain/security-tracker.js'
import type { TrackerEntry } from '../../src/domain/security-tracker.js'
import { gitForTest } from '../../src/tests/_helpers/git-repository.js'
import type { RecordedRequest, ResponseRule, ResponseSpec } from '../fake-github/server.js'
import { enterGitRepository, setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'

export const NOW = new Date('2026-11-09T12:00:00Z')
export const TODAY_TITLE = '[Tracker] security alert — 2026-11-09'
const REPOSITORY = '/repos/acme/demo'
const WORKFLOW_FIELD = 'PVTSSF_workflow'
const PRIORITY_FIELD = 'PVTSSF_priority'
const PRIORITY_OPTIONS = new Map([['high', 'p1'], ['medium', 'p2'], ['low', 'p3']])

export function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
}

// --- alert の応答 ---

export function dependabotAlert(number: number, severity = 'medium', summary?: string): JsonObject {
  const advisory = { ghsa_id: 'GHSA-aaaa-bbbb-cccc', ...(summary !== undefined && { summary }) }
  return {
    number,
    html_url: `https://ghes.example.com/acme/demo/security/dependabot/${String(number)}`,
    security_vulnerability: { severity },
    security_advisory: advisory,
    dependency: { package: { name: 'pkg' } },
  }
}

export function codeScanningAlert(number: number): JsonObject {
  return { number, rule: { id: 'js/xss', severity: 'error' } }
}

export function secretScanningAlert(number: number): JsonObject {
  return { number, secret_type: 'github_personal_access_token' }
}

export const ALERT_PATHS: Readonly<Record<'dependabot' | 'codeScanning' | 'secretScanning', string>> = {
  dependabot: `${REPOSITORY}/dependabot/alerts`,
  codeScanning: `${REPOSITORY}/code-scanning/alerts`,
  secretScanning: `${REPOSITORY}/secret-scanning/alerts`,
}

export interface AlertResponses {
  readonly dependabot?: readonly JsonObject[]
  readonly codeScanning?: readonly JsonObject[]
  readonly secretScanning?: readonly JsonObject[]
  /**
  取得が失敗する種類の応答。alert の配列より優先する
  */
  readonly dependabotFailure?: ResponseSpec
  readonly codeScanningFailure?: ResponseSpec
  readonly secretScanningFailure?: ResponseSpec
}

function alertRule(path: string, query: Readonly<Record<string, string>>, alerts: readonly JsonObject[] | undefined, failed: ResponseSpec | undefined): ResponseRule {
  return { match: { method: 'GET', path, query }, respond: failed ?? { status: 200, body: alerts ?? [] }, times: 1 }
}

/**
3 種類の一覧の応答（この順で要求される）。省いた種類は 0 件
*/
export function alertLists(responses: Readonly<AlertResponses>): ResponseRule[] {
  return [
    alertRule(ALERT_PATHS.dependabot, { state: 'open', per_page: '100' }, responses.dependabot, responses.dependabotFailure),
    alertRule(ALERT_PATHS.codeScanning, { state: 'open', per_page: '100' }, responses.codeScanning, responses.codeScanningFailure),
    alertRule(ALERT_PATHS.secretScanning, { state: 'open', hide_secret: 'true', per_page: '100' }, responses.secretScanning, responses.secretScanningFailure),
  ]
}

/**
失敗の応答。本文は message だけ
*/
export function failure(status: number, message: string): ResponseSpec {
  return { status, body: { message } }
}

/**
リポジトリの secret scanning の状態。404 の後に無効かどうかを確かめる要求への応答
*/
export function secretScanningStatus(status: string): ResponseRule {
  return { match: { method: 'GET', path: REPOSITORY }, respond: { status: 200, body: { security_and_analysis: { secret_scanning: { status } } } }, times: 1 }
}

export function vulnerabilityAlertsEnabled(): ResponseRule {
  return { match: { method: 'GET', path: `${REPOSITORY}/vulnerability-alerts` }, respond: { status: 204 }, times: 1 }
}

// --- Tracker の Issue ---

export function trackerEntry(kind: TrackerEntry['kind'], number: number, extra: Partial<TrackerEntry> = {}): TrackerEntry {
  return { kind, number, priority: 'medium', package: undefined, ghsa: undefined, summary: undefined, ...extra }
}

/**
dependabot の alert #number に対応する行（dependabotAlert の既定と同じ内容）
*/
export function dependabotEntry(number: number): TrackerEntry {
  return trackerEntry('dependabot', number, { package: 'pkg', ghsa: 'GHSA-aaaa-bbbb-cccc' })
}

export function trackerBody(...entries: readonly TrackerEntry[]): string {
  return renderTrackerBody(entries, 'ghes.example.com', 'acme', 'demo')
}

export function trackerIssue(number: number, body: string, state = 'open'): JsonObject {
  return { number, state, body, labels: [{ name: 'security-alert' }] }
}

export function issueList(issues: readonly JsonObject[], status = 200): ResponseRule {
  const body = status === 200 ? issues : { message: 'failure' }
  return { match: { method: 'GET', path: `${REPOSITORY}/issues`, query: { state: 'all', labels: 'security-alert', per_page: '100' } }, respond: { status, body }, times: 1 }
}

/**
alert の 3 種の一覧と Issue の一覧（この順で要求される）
*/
export function listings(responses: Readonly<AlertResponses>, issues: readonly JsonObject[]): ResponseRule[] {
  return [...alertLists(responses), issueList(issues)]
}

// --- 書き込みの応答 ---

export function createdTracker(number: number, status = 201): ResponseRule {
  const body = status === 201 ? { number, title: TODAY_TITLE } : { message: 'boom' }
  return { match: { method: 'POST', path: `${REPOSITORY}/issues` }, respond: { status, body }, times: 1 }
}

export function patchedTracker(number: number, status = 200): ResponseRule {
  const body = status === 200 ? { number } : { message: 'too long' }
  return { match: { method: 'PATCH', path: `${REPOSITORY}/issues/${String(number)}` }, respond: { status, body }, times: 1 }
}

export interface BoardOptions {
  /**
  真なら、空の欄だけに入れる（作った後でない Tracker）
  */
  readonly onlyIfEmpty: boolean
  /**
  Priority の名前（high・medium・low）。行が無いときは undefined で、Priority を入れない
  */
  readonly priority: string | undefined
  /**
  既に値が入っている欄の ID
  */
  readonly filled?: readonly string[]
  /**
  真なら、ボードへの追加が 502 で失敗する
  */
  readonly failsToAdd?: boolean
}

export const FILLED_WORKFLOW = WORKFLOW_FIELD
export const FILLED_PRIORITY = PRIORITY_FIELD

/**
Tracker をボードに載せ、Status を Backlog、Priority を options.priority にする応答
*/
export function boardRules(number: number, options: Readonly<BoardOptions>): ResponseRule[] {
  const { onlyIfEmpty, priority, filled = [], failsToAdd = false } = options
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
    rules.push({ match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: items } } } } }, times: priority === undefined ? 1 : 2 })
  }
  const priorityOption = priority === undefined ? undefined : PRIORITY_OPTIONS.get(priority)
  const fields: (readonly [string, string])[] = [[WORKFLOW_FIELD, 'o1']]
  if (priorityOption !== undefined) fields.push([PRIORITY_FIELD, priorityOption])
  for (const [fieldId, optionId] of fields) {
    if (filled.includes(fieldId)) continue
    const variables = { projectId: 'PVT_1', itemId, fieldId, optionId }
    rules.push({ match: { operation: 'UpdateProjectItemField', variables }, respond: { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } } } }, times: 1 })
  }
  return rules
}

// --- 受けた要求の読み取り ---

export function restWrites(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter(request => request.type === 'rest' && request.method !== 'GET')
}

export function graphqlOperations(requests: readonly RecordedRequest[]): string[] {
  return requests.filter(request => request.type === 'graphql').map(request => request.operation)
}

/**
指定の REST の書き込みの本文（JSON のオブジェクト）
*/
export function writtenBody(requests: readonly RecordedRequest[], method: string, path: string): Record<string, unknown> | undefined {
  for (const request of requests) {
    if (request.type === 'rest' && request.method === method && request.path === path && typeof request.body === 'object' && request.body !== null) {
      return Object.fromEntries(Object.entries(request.body))
    }
  }
  return undefined
}

export function bodyText(requests: readonly RecordedRequest[], method: string, path: string): string {
  const body = writtenBody(requests, method, path)?.['body']
  return typeof body === 'string' ? body : ''
}

export function createdBody(requests: readonly RecordedRequest[]): Record<string, unknown> | undefined {
  return writtenBody(requests, 'POST', `${REPOSITORY}/issues`)
}

export function updatedBody(requests: readonly RecordedRequest[], number: number): string {
  return bodyText(requests, 'PATCH', `${REPOSITORY}/issues/${String(number)}`)
}

export interface SyncSetup {
  readonly hasConfig?: boolean
  readonly hasRemote?: boolean
}

/**
設定と origin（acme/demo）を持つ一時 git リポジトリへ移る
*/
export function prepareSync(setup: Readonly<SyncSetup> = {}): ProjectFixture {
  const { hasConfig = true, hasRemote = true } = setup
  const project = setUpProject(hasConfig ? {} : { files: { '.pecot/config/projects/.active': '' } })
  const repository = enterGitRepository()
  if (hasRemote) gitForTest(repository, ['remote', 'add', 'origin', 'https://ghes.example.com/acme/demo.git'])
  return project
}
