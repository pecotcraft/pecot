// auto gate・start・finish のテストが共有する準備と、偽サーバの応答。
import { setEnvironment } from '../../src/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../fake-github/server.js'
import { CONFIG_FILE } from './board-issue-case.js'
import { setUpProject } from './interface-case.js'

export const AUTO_TOKEN = 'dummy-auto-token'
export const ISSUE_COMMENTS = '/repos/acme/demo/issues/7/comments'
export const AUTO_COMMENT_URL = 'https://ghes.example.com/acme/demo/issues/7#issuecomment-9'
export const LABEL_PATH = '/repos/acme/demo/issues/7/labels/pecot-auto'

// 既定の Status の選択肢。auto のコマンドは fields.status を要る
const STATUS_OPTIONS: ReadonlyMap<string, string> = new Map([['todo', 'st_todo'], ['in_progress', 'st_in_progress'], ['needs_attention', 'st_needs_attention']])

export interface AutoProjectOptions {
  /**
  偽なら、設定に fields.status を置かない
  */
  readonly hasStatus?: boolean
  /**
  既定の Status の選択肢から外すもの
  */
  readonly missingStatus?: string | undefined
}

function buildConfig(hasStatus: boolean, missingStatus: string | undefined): string {
  const workflow = { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } }
  const options = Object.fromEntries([...STATUS_OPTIONS].filter(([name]) => name !== missingStatus))
  const fields = hasStatus ? { workflow, status: { id: 'FIELD_status', options } } : { workflow }
  const project = { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields }
  const config = { host: 'ghes.example.com', owner: 'acme', project, repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'main' }] }
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/**
設定を置き、トークンと実行の環境変数を入れる
*/
export function prepareAuto(options: Readonly<AutoProjectOptions> = {}, environment: Readonly<Record<string, string | undefined>> = {}): void {
  const { hasStatus = true, missingStatus } = options
  setUpProject({ token: AUTO_TOKEN, files: { [`.pecot/config/projects/${CONFIG_FILE}`]: buildConfig(hasStatus, missingStatus) } })
  setEnvironment({ GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'acme/demo', ...environment })
}

export interface RecordSpec {
  readonly body: string
  readonly login?: string
  readonly association?: string
  readonly createdAt?: string
}

/**
自動処理の結果のコメントの本文。先頭に目印を置く
*/
export function autoResult(result: string, branch = 'feat/fix-x/7', run = '1', attempt = '1'): string {
  return `<!-- pecot-auto: result=${result} run=${run} attempt=${attempt} branch=${branch} -->\n## Auto result — 見本`
}

/**
bot が書いたコメント
*/
export function bot(body: string, createdAt = '2026-11-24T10:00:00Z'): RecordSpec {
  return { body, login: 'pecot-agent[bot]', association: 'NONE', createdAt }
}

/**
bot が書いた、自動処理の結果のコメント
*/
export function botResult(result: string, run = '1'): RecordSpec {
  return bot(autoResult(result, 'feat/fix-x/7', run))
}

/**
Issue のコメントの一覧（REST）の応答。書いた人とリポの関係・作った時刻を持つ
*/
export function issueComments(comments: readonly RecordSpec[] = [], times = 1): ResponseRule {
  const body = comments.map((comment, index) => {
    const login = comment.login ?? 'alice'
    return {
      id: index + 1,
      body: comment.body,
      user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
      author_association: comment.association ?? 'MEMBER',
      created_at: comment.createdAt ?? '2026-11-24T11:00:00Z',
      html_url: `https://ghes.example.com/acme/demo/issues/7#issuecomment-${String(index + 1)}`,
    }
  })
  return { match: { method: 'GET', path: ISSUE_COMMENTS }, respond: { status: 200, body }, times }
}

export function permissionOf(login: string, permission: string): ResponseRule {
  return { match: { method: 'GET', path: `/repos/acme/demo/collaborators/${login}/permission` }, respond: { status: 200, body: { permission } }, times: 1 }
}

export const AUTO_POSTED: ResponseRule = { match: { method: 'POST', path: ISSUE_COMMENTS }, respond: { status: 201, body: { id: 9, html_url: AUTO_COMMENT_URL } }, times: 1 }

export function labelRemoved(status = 200): ResponseRule {
  return { match: { method: 'DELETE', path: LABEL_PATH }, respond: { status, body: status === 200 ? [] : { message: 'Label does not exist' } }, times: 1 }
}

/**
既定の Status の書き込みの応答。key は todo・in_progress・needs_attention
*/
export function statusUpdated(key: string): ResponseRule {
  const body = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } } }
  const variables = { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'FIELD_status', optionId: STATUS_OPTIONS.get(key) }
  return { match: { operation: 'UpdateProjectItemField', variables }, respond: { status: 200, body }, times: 1 }
}

export function postedBody(requests: readonly RecordedRequest[]): string {
  const posted = requests.find(request => request.type === 'rest' && request.method === 'POST' && request.path === ISSUE_COMMENTS)
  if (posted?.type !== 'rest') throw new Error('コメントを書いていません')
  const sent = posted.body
  if (typeof sent !== 'object' || sent === null || !('body' in sent) || typeof sent.body !== 'string') throw new TypeError('コメントの本文がありません')
  return sent.body
}

// 書き込みの要求（GET 以外の REST と、GraphQL の mutation）の名前
function writeOf(request: Readonly<RecordedRequest>): string | undefined {
  if (request.type === 'rest') return request.method === 'GET' ? undefined : `${request.method} ${request.path}`
  return /^(?:Update|Add)/u.test(request.operation) ? request.operation : undefined
}

export function writesOf(requests: readonly RecordedRequest[]): readonly string[] {
  return requests.map(request => writeOf(request)).filter(name => name !== undefined)
}
