// issue create・issue quick のテストが共有する準備。設定の組み立てと、偽の GitHub の応答の組み立て。
import type { ResponseRule } from '../fake-github/server.js'
import { enterGitRepository, setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'

export const CONFIG_FILE = 'ghes.example.com_acme_board_acme.json'
export const ISSUE_URL_BASE = 'https://ghes.example.com/acme/demo/issues'

export const TASK_BODY = '## Goal — 達成したい状態\n\n実現したい状態\n\n## Acceptance — 達成判定\n\n- **条件1** — 確認: pytest\n'
export const EPIC_BODY = '## AS-IS — 現状\n\n現状の事実\n\n## TO-BE — 完了時の状態\n\n完了時にどうなっているか\n\n## GAP — 埋めるべき差分\n\nAS-IS と TO-BE の差\n'

export interface IssueProjectOptions {
  /**
  設定の aggregation_repo（owner/repo の形）
  */
  readonly aggregation?: string
  /**
  リポジトリ demo の develop_branch。既定は main。undefined を明示すると設定に書かない
  */
  readonly developBranch?: string | undefined
  /**
  プロジェクトルートに足すファイル（相対パス → 内容）
  */
  readonly files?: Readonly<Record<string, string>>
}

function configText(options: Readonly<IssueProjectOptions>): string {
  const { aggregation } = options
  const developBranch = Object.hasOwn(options, 'developBranch') ? options.developBranch : 'main'
  const status = { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' }
  const fields = {
    workflow: { id: 'PVTSSF_workflow', options: status },
    priority: { id: 'PVTSSF_priority', options: { high: 'p1', medium: 'p2', low: 'p3' } },
    size: { id: 'PVTSSF_size', options: { xs: 's1', s: 's2', m: 's3', l: 's4' } },
  }
  const config = {
    host: 'ghes.example.com',
    owner: 'acme',
    workflow_suffix: 'acme',
    ...aggregation !== undefined && { aggregation_repo: aggregation },
    project: { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields },
    repositories: [{ owner: 'acme', name: 'demo', ...developBranch !== undefined && { develop_branch: developBranch } }],
  }
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/**
プロジェクトルートに設定を置き、そのルートの一時 git リポジトリへ移る。issue create・issue quick は、カレントで動かす
*/
export function setUpIssueProject(options: Readonly<IssueProjectOptions> = {}): ProjectFixture {
  const project = setUpProject({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: configText(options), ...options.files } })
  enterGitRepository()
  return project
}

// --- 偽の GitHub の応答 ---

/**
プロジェクトにつながるリポジトリの一覧。既定は demo だけ
*/
export function linkedRepositories(times = 1, names: readonly string[] = ['demo']): ResponseRule {
  const nodes = names.map(name => ({ name, owner: { login: 'acme' } }))
  return { match: { operation: 'GetLinkedRepositoriesUser' }, times, respond: { status: 200, body: { data: { user: { projectV2: { repositories: { nodes } } } } } } }
}

export function createdIssue(number: number, options: Readonly<{ title?: string, repository?: string }> = {}): ResponseRule {
  const { title = '作成された Issue', repository = 'demo' } = options
  const body = { number, title, node_id: `I_kwDO${String(number)}`, html_url: `https://ghes.example.com/acme/${repository}/issues/${String(number)}` }
  return { match: { method: 'POST', path: `/repos/acme/${repository}/issues` }, times: 1, respond: { status: 201, body } }
}

export function failedIssueCreation(status: number): ResponseRule {
  return { match: { method: 'POST', path: '/repos/acme/demo/issues' }, times: 1, respond: { status, body: { message: 'failure' } } }
}

export function issueNodeId(number: number, times = 1): ResponseRule {
  const issue = { id: `I_kwDO${String(number)}`, title: 'Issue' }
  return { match: { operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number } }, times, respond: { status: 200, body: { data: { repository: { issue } } } } }
}

export function addedToProject(times = 1): ResponseRule {
  return { match: { operation: 'AddToProject' }, times, respond: { status: 200, body: { data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } } } }
}

export function failedAddToProject(): ResponseRule {
  return { match: { operation: 'AddToProject' }, times: 1, respond: { status: 200, body: { errors: [{ message: 'cannot add' }] } } }
}

export function updatedFields(times: number): ResponseRule {
  return { match: { operation: 'UpdateProjectItemField' }, times, respond: { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } } } }
}

export function subIssueAdded(): ResponseRule {
  return { match: { operation: 'AddSubIssue' }, times: 1, respond: { status: 200, body: { data: { addSubIssue: { issue: { number: 3 }, subIssue: { number: 12 } } } } } }
}

export function failedSubIssue(): ResponseRule {
  return { match: { operation: 'AddSubIssue' }, times: 1, respond: { status: 200, body: { errors: [{ message: 'cannot link' }] } } }
}

export interface SubIssue {
  readonly number: number
  readonly state: string
  readonly title: string
}

/**
親 Epic の読み取り（order の重複の確認）
*/
export function parentEpic(number: number, subIssues: readonly SubIssue[] = [], times = 1): ResponseRule {
  const issue = {
    number,
    state: 'OPEN',
    title: '親の Epic',
    body: '',
    comments: { totalCount: 0, nodes: [] },
    // eslint-disable-next-line unicorn/no-null -- GraphQL の応答の null
    parent: null,
    subIssues: { nodes: subIssues },
    linkedBranches: { nodes: [] },
    timelineItems: { nodes: [] },
  }
  return { match: { operation: 'GetIssueSlim', variables: { owner: 'acme', repo: 'demo', number } }, times, respond: { status: 200, body: { data: { repository: { issue } } } } }
}

/**
フロントマター付きの Markdown。fields の順に書く
*/
export function frontmatterFile(fields: Readonly<Record<string, string | number>>, body = TASK_BODY): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${String(value)}`)
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

export const TASK_FRONTMATTER: Readonly<Record<string, string>> = { title: '一覧に状態を出す', type: 'task', repository: 'acme/demo', status: 'ready', priority: 'high', size: 's' }

export const BRANCH_SHA = '0123456789abcdef0123456789abcdef01234567'

/**
develop ブランチの先頭の取得
*/
export function developBranchHead(): ResponseRule {
  return { match: { method: 'GET', path: '/repos/acme/demo/git/ref/heads/main' }, times: 1, respond: { status: 200, body: { object: { sha: BRANCH_SHA } } } }
}

export function missingDevelopBranch(): ResponseRule {
  return { match: { method: 'GET', path: '/repos/acme/demo/git/ref/heads/main' }, times: 1, respond: { status: 404, body: { message: 'Not Found' } } }
}

/**
リンク付きブランチの作成。応答の名前は、作成した Issue の番号の branch
*/
export function linkedBranchCreated(number: number): ResponseRule {
  const reference = { name: `feat/20260101-000000/${String(number)}`, prefix: 'refs/heads/' }
  return { match: { operation: 'CreateLinkedBranch' }, times: 1, respond: { status: 200, body: { data: { createLinkedBranch: { linkedBranch: { ref: reference } } } } } }
}
