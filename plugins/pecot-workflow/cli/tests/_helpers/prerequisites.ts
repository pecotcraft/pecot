/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// GetIssuePrerequisites の偽の応答。interface のテストが、前提の読み取りを足すのに使う。
import { graphqlRule } from './command-harness.js'
import type { ResponseRule } from '../fake-github/server.js'

const PROJECT_ID = 'PVT_1'

export interface PullRequestSpec {
  readonly number: number
  readonly state?: 'OPEN' | 'MERGED' | 'CLOSED'
  readonly head?: string
  readonly base?: string
  readonly isFork?: boolean
}

export interface IssueSpec {
  readonly number: number
  readonly owner?: string
  readonly repo?: string
  readonly state?: 'OPEN' | 'CLOSED'
  readonly title?: string
  readonly column?: string
  readonly label?: string
  /**
  リンクしたブランチ（着手の跡）
  */
  readonly branch?: string
  /**
  ブランチを head に持つ PR。branch が無ければ、閉じる参照の PR
  */
  readonly pullRequests?: readonly PullRequestSpec[]
  readonly issueType?: string | null
  readonly subIssues?: number
}

export interface TargetSpec extends IssueSpec {
  readonly body?: string
  readonly parent?: { readonly number: number, readonly owner?: string, readonly repo?: string }
  readonly blockedBy?: readonly IssueSpec[]
}

const connection = (nodes: readonly unknown[]): Record<string, unknown> => ({ totalCount: nodes.length, nodes })
const select = (fieldId: string, name: string): Record<string, unknown> => ({ name, optionId: `opt_${name}`, field: { id: fieldId } })

function pullRequestNode(spec: PullRequestSpec, owner: string, repository: string): Record<string, unknown> {
  return {
    number: spec.number,
    state: spec.state ?? 'OPEN',
    headRefName: spec.head ?? `feat/${String(spec.number)}`,
    baseRefName: spec.base ?? 'main',
    isDraft: false,
    isCrossRepository: spec.isFork ?? false,
    repository: { owner: { login: owner }, name: repository },
  }
}

function issueNode(spec: IssueSpec): Record<string, unknown> {
  const { number, owner = 'acme', repo: repository = 'demo', state = 'OPEN', pullRequests = [] } = spec
  const nodes = pullRequests.map(pullRequest => pullRequestNode(pullRequest, owner, repository))
  const hasBranch = spec.branch !== undefined
  return {
    id: `I_${repository}_${String(number)}`,
    number,
    state,
    title: spec.title ?? `課題${String(number)}`,
    repository: { owner: { login: owner }, name: repository },
    issueType: spec.issueType === undefined ? { name: 'Task' } : (spec.issueType === null ? null : { name: spec.issueType }),
    subIssues: { totalCount: spec.subIssues ?? 0 },
    projectItems: connection(spec.column === undefined && spec.label === undefined
      ? []
      : [{ project: { id: PROJECT_ID }, column: spec.column === undefined ? null : select('FIELD_column', spec.column), label: spec.label === undefined ? null : select('FIELD_status', spec.label) }]),
    linkedBranches: connection(hasBranch ? [{ ref: { name: spec.branch, associatedPullRequests: connection(nodes) } }] : []),
    closedByPullRequestsReferences: connection(hasBranch ? [] : nodes),
    timelineItems: connection([]),
  }
}

/**
GetIssuePrerequisites の 200 の応答のデータ
*/
export function prerequisitesData(spec: TargetSpec): Record<string, unknown> {
  const { parent } = spec
  return {
    repository: {
      issue: {
        ...issueNode(spec),
        body: spec.body ?? '本文',
        parent: parent === undefined ? null : { number: parent.number, repository: { owner: { login: parent.owner ?? 'acme' }, name: parent.repo ?? 'demo' } },
        blockedBy: connection((spec.blockedBy ?? []).map(blocker => issueNode(blocker))),
      },
    },
  }
}

/**
spec の Issue 向けの GetIssuePrerequisites の応答の規則。変数の owner・repo・number で当てる
*/
export function prerequisitesRule(spec: TargetSpec): ResponseRule {
  return graphqlRule('GetIssuePrerequisites', prerequisitesData(spec), { owner: spec.owner ?? 'acme', repo: spec.repo ?? 'demo', number: spec.number })
}
