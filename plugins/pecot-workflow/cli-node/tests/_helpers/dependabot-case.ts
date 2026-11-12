// dependabot sync のテストが共有する準備。PR のノード・Tracker の Issue・偽の GitHub の応答を組み立てる。
// 時刻に頼る理由（30 分・24 時間）は、NOW を基準にした経過時間で PR を作って確かめる。
import { vi } from 'vitest'

import type { JsonObject } from '../../src/domain/json.js'
import { JSON_NULL } from '../../src/domain/json-null.js'
import { gitForTest } from '../../src/tests/_helpers/git-repository.js'
import type { ResponseRule } from '../fake-github/server.js'
import { enterGitRepository, setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'

export const NOW = new Date('2026-11-09T12:00:00Z')
export const TODAY_TITLE = '[Tracker] dependabot PR — 2026-11-09'
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
}

function iso(ageMilliseconds: number): string {
  return new Date(NOW.getTime() - ageMilliseconds).toISOString().replace('.000Z', 'Z')
}

export interface PrOptions {
  readonly number?: number
  readonly name?: string
  readonly kind?: string
  readonly title?: string
  readonly isSigned?: boolean
  readonly commitAuthor?: string
  readonly age?: number
  readonly hasAutoMerge?: boolean
  readonly rollup?: string | typeof JSON_NULL
  readonly mergeable?: string
  readonly baseAge?: number
  readonly dequeuedAge?: number
  readonly author?: JsonObject
}

/**
dependabot の PR のノード。既定は、3 時間前に作られ、auto-merge が入り、検証が通った minor の PR（表に載せない）
*/
export function pullRequest(options: Readonly<PrOptions> = {}): JsonObject {
  const { number = 2, name = 'left-pad', kind = 'minor', age = 3 * HOUR, rollup = 'SUCCESS' } = options
  const lines = ['Bump x', '', '---', 'updated-dependencies:', `- dependency-name: "${name}"`, '  dependency-type: direct:development']
  if (kind !== 'none') lines.push(`  update-type: version-update:semver-${kind}`)
  return {
    number,
    title: options.title ?? `Bump ${name}`,
    url: `https://ghes.example.com/acme/demo/pull/${String(number)}`,
    createdAt: iso(age),
    author: options.author ?? { __typename: 'Bot', login: 'dependabot' },
    isInMergeQueue: false,
    autoMergeRequest: options.hasAutoMerge === false ? JSON_NULL : { enabledAt: iso(age) },
    mergeable: options.mergeable ?? 'MERGEABLE',
    baseRef: { target: { committedDate: iso(options.baseAge ?? 72 * HOUR) } },
    firstCommits: {
      nodes: [{
        commit: {
          message: [...lines, '...', ''].join('\n'),
          signature: { isValid: options.isSigned ?? true },
          author: { user: { login: options.commitAuthor ?? 'dependabot[bot]' } },
        },
      }],
    },
    headCommits: { nodes: [{ commit: { statusCheckRollup: rollup === JSON_NULL ? JSON_NULL : { state: rollup } } }] },
    lastForcePush: { nodes: [] },
    lastDequeue: { nodes: options.dequeuedAge === undefined ? [] : [{ createdAt: iso(options.dequeuedAge) }] },
  }
}

/**
open の Tracker の Issue。ラベルでの絞り込みは偽サーバが見ないので、応答にそのまま載せる
*/
export function trackerIssue(number: number, body: string, state = 'open'): JsonObject {
  return { number, state, body, labels: [{ name: 'dependabot-pr' }] }
}

/**
Tracker の本文の表。rows は [番号, 題, 検証の結果]
*/
export function trackerBody(rows: readonly (readonly [number, string, string])[], outside = ''): string {
  const table = rows.length === 0
    ? 'none'
    : ['| title | PR | checks |', '|---|---|---|', ...rows.map(([number, title, checks]) => `| <!-- pecot-dependabot-pr: pr/${String(number)} --> \`${title}\` | [#${String(number)}](https://ghes.example.com/acme/demo/pull/${String(number)}) | ${checks} |`)].join('\n')
  return `<!-- pecot-dependabot-pr: tracker -->\n\n<!-- pecot-dependabot-pr: list-begin -->\n## dependabot PR\n\n${table}\n<!-- pecot-dependabot-pr: list-end -->\n${outside}`
}

// --- 偽の GitHub の応答 ---

export function pullRequestList(nodes: readonly JsonObject[]): ResponseRule {
  const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: JSON_NULL }, nodes } } }
  return { match: { operation: 'ListOpenPullRequests' }, respond: { status: 200, body: { data } }, times: 1 }
}

export function issueList(issues: readonly JsonObject[]): ResponseRule {
  return { match: { method: 'GET', path: '/repos/acme/demo/issues' }, respond: { status: 200, body: issues }, times: 1 }
}

/**
PR と Issue の一覧の応答（この順で要求される）
*/
export function listings(nodes: readonly JsonObject[], issues: readonly JsonObject[] = []): ResponseRule[] {
  return [pullRequestList(nodes), issueList(issues)]
}

export function createdTracker(number: number): ResponseRule {
  return { match: { method: 'POST', path: '/repos/acme/demo/issues' }, respond: { status: 201, body: { number, title: TODAY_TITLE } }, times: 1 }
}

export function patched(number: number, body?: unknown): ResponseRule {
  const match = { method: 'PATCH', path: `/repos/acme/demo/issues/${String(number)}`, ...(body !== undefined && { body }) }
  return { match, respond: { status: 200, body: { number } }, times: 1 }
}

export function failedRule(match: ResponseRule['match'], status = 500): ResponseRule {
  return { match, respond: { status, body: { message: 'failure' } }, times: 1 }
}

export const WORKFLOW_FIELD = 'PVTSSF_workflow'
export const PRIORITY_FIELD = 'PVTSSF_priority'

export interface BoardOptions {
  /**
  真なら、空の欄だけに入れる（作った後でない Tracker）
  */
  readonly onlyIfEmpty: boolean
  /**
  既に値が入っている欄の ID
  */
  readonly filled?: readonly string[]
}

/**
Tracker をボードに載せ、Status を Backlog、Priority を medium にする応答
*/
export function boardRules(number: number, options: Readonly<BoardOptions>): ResponseRule[] {
  const { onlyIfEmpty, filled = [] } = options
  const itemId = `PVTI_${String(number)}`
  const nodeId = `I_${String(number)}`
  const rules: ResponseRule[] = [
    { match: { operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number } }, respond: { status: 200, body: { data: { repository: { issue: { id: nodeId, title: 'Tracker' } } } } }, times: 1 },
    { match: { operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: nodeId } }, respond: { status: 200, body: { data: { addProjectV2ItemById: { item: { id: itemId } } } } }, times: 1 },
  ]
  if (onlyIfEmpty) {
    const fieldValues = { nodes: filled.map(id => ({ field: { id } })) }
    const items = { nodes: [{ id: itemId, project: { id: 'PVT_1' }, fieldValues }] }
    rules.push({ match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number } }, respond: { status: 200, body: { data: { repository: { issue: { projectItems: items } } } } }, times: 2 })
  }
  const defaults: readonly (readonly [string, string])[] = [[WORKFLOW_FIELD, 'o1'], [PRIORITY_FIELD, 'p2']]
  for (const [fieldId, optionId] of defaults) {
    if (filled.includes(fieldId)) continue
    const variables = { projectId: 'PVT_1', itemId, fieldId, optionId }
    rules.push({ match: { operation: 'UpdateProjectItemField', variables }, respond: { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } } } }, times: 1 })
  }
  return rules
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
