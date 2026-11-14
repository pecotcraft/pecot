/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// issue block / unblock のテストが共有する準備と、偽の GitHub の応答。
import { gitForTest } from '../../src/tests/_helpers/git-repository.js'
import type { ResponseRule } from '../fake-github/server.js'
import { graphqlRule } from './command-harness.js'
import { enterGitRepository, setUpProject } from './interface-case.js'
import { CONFIG_FILE, linkedRepositories, ORIGIN_URL } from './issue-project-case.js'

export type BoardValue = 'blocked' | 'needs_attention' | 'todo'

/**
設定のボードに、列 Blocked と札 Needs Attention・Todo を載せる。omit に挙げた値は載せない
*/
export function prepareDependencyProject(options: Readonly<{ omit?: readonly BoardValue[] }> = {}): void {
  const omit = new Set(options.omit)
  const workflow = { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6', ...!omit.has('blocked') && { blocked: 'o7' } }
  const status = { ...!omit.has('needs_attention') && { needs_attention: 's1' }, ...!omit.has('todo') && { todo: 's2' } }
  const fields = {
    workflow: { id: 'PVTSSF_workflow', options: workflow },
    status: { id: 'PVTSSF_status', options: status },
  }
  const project = { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields }
  const repositories = ['demo', 'other'].map(name => ({ owner: 'acme', name, develop_branch: 'main' }))
  const config = { host: 'ghes.example.com', owner: 'acme', workflow_suffix: 'acme', project, repositories }
  setUpProject({ repositories: ['demo', 'other'], files: { [`.pecot/config/projects/${CONFIG_FILE}`]: `${JSON.stringify(config, undefined, 2)}\n` } })
  const repository = enterGitRepository()
  gitForTest(repository, ['remote', 'add', 'origin', ORIGIN_URL])
}

/**
待つ側と待たれる側のリポジトリの確認。リンクの一覧は 1 回の実行で 1 回だけ読む
*/
export function bothLinked(repositories: readonly string[] = ['demo']): ResponseRule {
  return linkedRepositories(repositories)
}

export interface BlockerSpec {
  readonly number: number
  readonly repo?: string
  readonly state?: 'OPEN' | 'CLOSED'
}

export const nodeId = (number: number, repository = 'demo'): string => `I_${repository}_${String(number)}`

function referenceNode(blocker: BlockerSpec): Record<string, unknown> {
  const { number, repo: repository = 'demo', state = 'OPEN' } = blocker
  return { id: nodeId(number, repository), number, state, repository: { owner: { login: 'acme' }, name: repository } }
}

const connection = (blockers: readonly BlockerSpec[], total = blockers.length): Record<string, unknown> => ({ totalCount: total, nodes: blockers.map(blocker => referenceNode(blocker)) })

/**
GetIssueBlockedByReferences の応答。total が nodes の件数と違えば、件数の不足を作る
*/
export function targetReferences(number: number, body: string, blockers: readonly BlockerSpec[], total?: number): ResponseRule {
  const data = { repository: { issue: { id: nodeId(number), body, blockedBy: connection(blockers, total) } } }
  return graphqlRule('GetIssueBlockedByReferences', data, { owner: 'acme', repo: 'demo', number })
}

/**
GetIssueNodeId の応答。node ID は nodeId と同じ形
*/
export function nodeIdRule(number: number, repository = 'demo'): ResponseRule {
  return graphqlRule('GetIssueNodeId', { repository: { issue: { id: nodeId(number, repository), title: '見本の Issue' } } }, { owner: 'acme', repo: repository, number })
}

/**
GetBlockedByOfNodes の応答。entries は node ID ごとの前提。null は Issue でない node
*/
export function levelRule(ids: readonly string[], entries: Readonly<Record<string, readonly BlockerSpec[] | null>>): ResponseRule {
  const known = new Map(Object.entries(entries))
  const nodes = ids.map((id) => {
    const blockers = known.get(id)
    return blockers === null ? null : { id, blockedBy: connection(blockers ?? []) }
  })
  return graphqlRule('GetBlockedByOfNodes', { nodes }, { ids })
}

export function addBlockedByRule(issue: number, blocking: number, blockingRepository = 'demo'): ResponseRule {
  const data = { addBlockedBy: { issue: { number: issue }, blockingIssue: { number: blocking } } }
  return graphqlRule('AddBlockedBy', data, { issueId: nodeId(issue), blockingIssueId: nodeId(blocking, blockingRepository) })
}

export function removeBlockedByRule(issue: number, blocking: number, blockingRepository = 'demo'): ResponseRule {
  const data = { removeBlockedBy: { issue: { number: issue }, blockingIssue: { number: blocking } } }
  return graphqlRule('RemoveBlockedBy', data, { issueId: nodeId(issue), blockingIssueId: nodeId(blocking, blockingRepository) })
}

/**
本文の書き換え（PATCH）。送った本文が body と同じときだけ答える
*/
export function bodyWritten(number: number, body: string): ResponseRule {
  return { match: { method: 'PATCH', path: `/repos/acme/demo/issues/${String(number)}`, body: { body } }, respond: { status: 200, body: { number } }, times: 1 }
}

/**
札（Status）の更新の応答。optionId は設定の status のオプションの値（needs_attention は s1、todo は s2）
*/
export function labelUpdated(optionId: string, number = 7): ResponseRule {
  const data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: `PVTI_${String(number)}` } } }
  return graphqlRule('UpdateProjectItemField', data, { projectId: 'PVT_1', itemId: `PVTI_${String(number)}`, fieldId: 'PVTSSF_status', optionId })
}

export const WAITS_SECTION = (lines: readonly string[]): string => `## Waits for merge\n\n${lines.map(line => `- ${line}\n`).join('')}`
