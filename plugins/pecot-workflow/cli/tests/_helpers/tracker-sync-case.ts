// tracker sync security と tracker sync dependabot のテストが共有する準備。時計・設定・git・ボードの応答・Tracker の作成と Issue の一覧の応答を置く。
import { vi } from 'vitest'

import type { JsonObject } from '@pecot/workflow-core/domain/json.js'
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { enterGitRepository, setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'
import { makeAmbiguous } from './project-selection.js'

export const NOW = new Date('2026-11-09T12:00:00Z')
export const WORKFLOW_FIELD = 'PVTSSF_workflow'

export function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
}

export interface SyncSetup {
  /**
  設定の repositories に載せるリポジトリ名。既定は demo
  */
  readonly repositories?: readonly string[]
  /**
  真なら、同じリポを含む 2 つ目の設定を足し、.active を外す
  */
  readonly ambiguous?: boolean
  readonly hasRemote?: boolean
}

/**
設定と origin（acme/demo）を持つ一時 git リポジトリへ移る
*/
export function prepareSync(setup: Readonly<SyncSetup> = {}): ProjectFixture {
  const { repositories, ambiguous = false, hasRemote = true } = setup
  const project = setUpProject(repositories === undefined ? {} : { repositories })
  if (ambiguous) makeAmbiguous(project)
  const repository = enterGitRepository()
  if (hasRemote) gitForTest(repository, ['remote', 'add', 'origin', 'https://ghes.example.com/acme/demo.git'])
  return project
}

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

/**
トークンが見つからないときの error の行（標準エラーの全文）。root はプロジェクトルート
*/
export function missingTokenStderr(root: string): string {
  const environmentFile = `${root}/.pecot/config/.env`
  const lines = [
    'error: authentication error: could not get a GitHub API token',
    '  ',
    `  ${environmentFile} was generated. Set the token as follows:`,
    '  ',
    '  1. get a token: https://ghes.example.com/settings/tokens',
    '  ',
    '  ',
    `  2. edit ${environmentFile} and set the token in PECOT_GITHUB_GHES_EXAMPLE_COM_TOKEN`,
    '  ',
    '  or authenticate with the GitHub CLI:',
    '     gh auth login -h ghes.example.com',
    '',
  ]
  return lines.join('\n')
}

/**
GraphQL がサーバエラーを返したときの文。url は偽サーバの URL、status は `500 Internal Server Error` のような状態の文
*/
export function graphqlServerError(url: string, status = '500 Internal Server Error'): string {
  return `GraphQL query error: Server error '${status}' for url '${url}/graphql'\n  For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${status.slice(0, 3)}`
}
