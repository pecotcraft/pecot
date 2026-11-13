// add-to-project・update-issue-status・issue reopen のテストが共有する準備。
import type { ResponseRule } from '../fake-github/server.js'
import { gitForTest } from '../../src/tests/_helpers/git-repository.js'
import { enterGitRepository, setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'

export const CONFIG_FILE = 'ghes.example.com_acme_board_acme.json'
export const ORIGIN_URL = 'https://ghes.example.com/acme/demo.git'

// 設定の workflow に載せるオプション。fixtureConfig（interface-case.ts）と同じ値
const WORKFLOW_OPTIONS: Readonly<Record<string, string>> = { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' }

export interface ProjectCaseOptions {
  /**
  設定の repositories に載せるリポジトリ名。既定は demo だけ
  */
  readonly repositories?: readonly string[]
  /**
  ボードが定義しない status
  */
  readonly missingStatus?: string
  /**
  設定の workflow に blocked（o7）を載せる
  */
  readonly hasBlocked?: boolean
}

export interface ProjectCase {
  readonly project: ProjectFixture
  /**
  cwd が移った先の一時 git リポジトリ。origin は acme/demo
  */
  readonly repository: string
}

function buildConfig(missingStatus: string | undefined, hasBlocked: boolean, repositories: readonly string[]): string {
  const base = hasBlocked ? { ...WORKFLOW_OPTIONS, blocked: 'o7' } : WORKFLOW_OPTIONS
  const options = Object.fromEntries(Object.entries(base).filter(([name]) => name !== missingStatus))
  const fields = { workflow: { id: 'PVTSSF_workflow', options } }
  const project = { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields }
  const config = {
    host: 'ghes.example.com',
    owner: 'acme',
    workflow_suffix: 'acme',
    project,
    repositories: repositories.map(name => ({ owner: 'acme', name, develop_branch: 'main' })),
  }
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/**
一時のプロジェクトルートと、origin を持つ一時 git リポジトリを用意する
*/
export function prepareProject(options: Readonly<ProjectCaseOptions> = {}): ProjectCase {
  const { repositories = ['demo'], missingStatus, hasBlocked = false } = options
  const files = missingStatus === undefined && !hasBlocked ? {} : { [`.pecot/config/projects/${CONFIG_FILE}`]: buildConfig(missingStatus, hasBlocked, repositories) }
  const project = setUpProject({ repositories, files })
  const repository = enterGitRepository()
  gitForTest(repository, ['remote', 'add', 'origin', ORIGIN_URL])
  return { project, repository }
}

/**
プロジェクトにリンクされたリポジトリの一覧の応答
*/
export function linkedRepositories(names: readonly string[] = ['demo']): ResponseRule {
  const nodes = names.map(name => ({ name, owner: { login: 'acme' } }))
  const body = { data: { user: { projectV2: { repositories: { nodes } } } } }
  return { match: { operation: 'GetLinkedRepositoriesUser', variables: { owner: 'acme', projectNumber: 1 } }, respond: { status: 200, body }, times: 1 }
}

/**
Issue の node id の応答
*/
export function issueNodeId(repository = 'demo', number = 7): ResponseRule {
  const body = { data: { repository: { issue: { id: `I_${String(number)}`, title: '見本の Issue' } } } }
  return { match: { operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: repository, number } }, respond: { status: 200, body }, times: 1 }
}

/**
ボードへの追加の応答
*/
export function addedToBoard(number = 7): ResponseRule {
  const body = { data: { addProjectV2ItemById: { item: { id: `PVTI_${String(number)}` } } } }
  return { match: { operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: `I_${String(number)}` } }, respond: { status: 200, body }, times: 1 }
}

/**
Status の更新の応答。optionId は設定の workflow のオプションの値（ready は o3）
*/
export function fieldUpdated(optionId: string, number = 7): ResponseRule {
  const body = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: `PVTI_${String(number)}` } } } }
  const variables = { projectId: 'PVT_1', itemId: `PVTI_${String(number)}`, fieldId: 'PVTSSF_workflow', optionId }
  return { match: { operation: 'UpdateProjectItemField', variables }, respond: { status: 200, body }, times: 1 }
}

/**
Issue のボード項目の応答。onBoard が偽なら、項目が無い
*/
export function boardItems(options: Readonly<{ onBoard?: boolean, repository?: string, number?: number }> = {}): ResponseRule {
  const { onBoard = true, repository = 'demo', number = 7 } = options
  const nodes = onBoard ? [{ id: `PVTI_${String(number)}`, project: { id: 'PVT_1' } }] : []
  const body = { data: { repository: { issue: { projectItems: { nodes } } } } }
  return { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: repository, number } }, respond: { status: 200, body }, times: 1 }
}

/**
再オープンの応答（PATCH）。state は応答の state
*/
export function reopened(state = 'open', number = 7): ResponseRule {
  return { match: { method: 'PATCH', path: `/repos/acme/demo/issues/${String(number)}` }, respond: { status: 200, body: { state } }, times: 1 }
}

/**
コメント投稿の応答（POST）
*/
export function commented(number = 7): ResponseRule {
  const body = { html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}#issuecomment-3` }
  return { match: { method: 'POST', path: `/repos/acme/demo/issues/${String(number)}/comments` }, respond: { status: 201, body }, times: 1 }
}

/**
どの要求にも失敗で答える（GraphQL の operation か REST の method と path を指す）
*/
export function failing(match: ResponseRule['match'], status = 502): ResponseRule {
  return { match, respond: { status, body: { message: 'failure' } }, times: 1 }
}

/**
偽サーバが count 件以上の要求を受けるまで、実の setImmediate で I/O に順番を譲る。届かなければ例外にする
*/
export async function waitForRequests(received: () => number, count: number): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (received() >= count) return
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
  throw new Error(`waitForRequests: ${String(count)} 件の要求が届きません（${String(received())} 件）`)
}
