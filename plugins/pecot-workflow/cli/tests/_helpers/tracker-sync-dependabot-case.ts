// tracker sync dependabot のテストが共有する準備。PR のノード・Tracker の Issue・偽の GitHub の応答を組み立てる。
// 時刻に頼る理由（30 分・24 時間）は、NOW を基準にした経過時間で PR を作って確かめる。
import type { JsonObject } from '../../src/domain/json.js'
import { JSON_NULL } from '../../src/domain/json-null.js'
import type { ResponseRule } from '../fake-github/server.js'
import { issueListRule, NOW } from './tracker-sync-case.js'

export const TODAY_TITLE = '[Tracker] dependabot PR — 2026-11-09'
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

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
  return issueListRule('dependabot-pr', issues)
}

/**
PR と Issue の一覧の応答（この順で要求される）
*/
export function listings(nodes: readonly JsonObject[], issues: readonly JsonObject[] = []): ResponseRule[] {
  return [pullRequestList(nodes), issueList(issues)]
}

export function patched(number: number, body?: unknown): ResponseRule {
  const match = { method: 'PATCH', path: `/repos/acme/demo/issues/${String(number)}`, ...(body !== undefined && { body }) }
  return { match, respond: { status: 200, body: { number } }, times: 1 }
}

export function failedRule(match: ResponseRule['match'], status = 500): ResponseRule {
  return { match, respond: { status, body: { message: 'failure' } }, times: 1 }
}
