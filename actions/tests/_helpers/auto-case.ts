/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// auto-gate・auto-start・auto-finish のテストが共有する準備と、偽サーバの応答。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { setEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { makeTemporaryDirectory } from '../../../libs/workflow-core/tests/_helpers/temporary.js'
import { setUpProject } from './action-case.js'

export const AUTO_TOKEN = 'dummy-auto-token'
export const ISSUE_COMMENTS = '/repos/acme/demo/issues/7/comments'
export const AUTO_COMMENT_URL = 'https://github.com/acme/demo/issues/7#issuecomment-9'
export const LABEL_PATH = '/repos/acme/demo/issues/7/labels/pecot-auto'

// setUpProject が置く設定のファイル名。中身を fields.status のある設定に置き換える
const CONFIG_FILE = 'github.com_acme_board_acme.json'

// 既定の Status の選択肢。auto の処理は fields.status を要る
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
  /**
  偽なら、対象のリポの設定に develop_branch を置かない
  */
  readonly hasDevelopBranch?: boolean
}

function buildConfig(hasStatus: boolean, missingStatus: string | undefined, hasDevelopBranch: boolean): string {
  const workflow = { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } }
  const options = Object.fromEntries([...STATUS_OPTIONS].filter(([name]) => name !== missingStatus))
  const fields = hasStatus ? { workflow, status: { id: 'FIELD_status', options } } : { workflow }
  const project = { number: 1, id: 'PVT_1', board_url: 'https://github.com/users/acme/projects/1', fields }
  const config = { host: 'github.com', owner: 'acme', project, repositories: [{ owner: 'acme', name: 'demo', ...hasDevelopBranch && { develop_branch: 'main' } }] }
  return `${JSON.stringify(config, undefined, 2)}\n`
}

export interface AutoRunner {
  /**
  runner の RUNNER_TEMP
  */
  readonly temporary: string
  /**
  step の outputs を書く GITHUB_OUTPUT のファイル
  */
  readonly outputFile: string
}

/**
設定を置き、実行の環境変数と、runner の一時ディレクトリ・outputs のファイルを入れる
*/
export function prepareAuto(options: Readonly<AutoProjectOptions> = {}, environment: Readonly<Record<string, string | undefined>> = {}): AutoRunner {
  const { hasStatus = true, missingStatus, hasDevelopBranch = true } = options
  setUpProject({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: buildConfig(hasStatus, missingStatus, hasDevelopBranch) } })
  const temporary = makeTemporaryDirectory('pecot-runner-')
  const outputFile = path.join(temporary, 'github-output')
  writeFileSync(outputFile, '', 'utf8')
  setEnvironment({ GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'acme/demo', RUNNER_TEMP: temporary, GITHUB_OUTPUT: outputFile, ...environment })
  return { temporary, outputFile }
}

/**
GITHUB_OUTPUT に書かれた outputs。@actions/core の setOutput が書く `name<<区切り` の形を読む
*/
export function readOutputs(file: string): Readonly<Record<string, string>> {
  const lines = readFileSync(file, 'utf8').split('\n')
  const outputs: [string, string][] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([^<]+)<<(.+)$/u.exec(lines.at(index) ?? '')
    if (match === null) continue
    const [, name = '', delimiter = ''] = match
    const end = lines.indexOf(delimiter, index + 1)
    outputs.push([name, lines.slice(index + 1, end).join('\n')])
    index = end
  }
  return Object.fromEntries(outputs)
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
      html_url: `https://github.com/acme/demo/issues/7#issuecomment-${String(index + 1)}`,
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

/**
Issue の node id の応答
*/
export function issueNodeId(): ResponseRule {
  const body = { data: { repository: { issue: { id: 'I_7', title: '見本の Issue' } } } }
  return { match: { operation: 'GetIssueNodeId', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body }, times: 1 }
}

/**
Issue の node id と、つながったブランチが無いことの応答
*/
export function noLinkedBranches(): ResponseRule {
  const body = { data: { repository: { issue: { id: 'I_7', linkedBranches: { nodes: [] } } } } }
  return { match: { operation: 'GetIssueLinkedBranches', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body }, times: 1 }
}

/**
ブランチを作る書き込みの応答。base の先頭の commit を読み、Issue につないだブランチを作る
*/
export function branchCreated(branch: string, base = 'main'): readonly ResponseRule[] {
  const head: ResponseRule = { match: { method: 'GET', path: `/repos/acme/demo/git/ref/heads/${base}` }, respond: { status: 200, body: { object: { sha: 'a'.repeat(40) } } }, times: 1 }
  const created: ResponseRule = { match: { operation: 'CreateLinkedBranch' }, respond: { status: 200, body: { data: { createLinkedBranch: { linkedBranch: { ref: { name: branch, prefix: 'refs/heads/' } } } } } }, times: 1 }
  return [head, noLinkedBranches(), created]
}

/**
ボードへの追加の応答
*/
export function addedToBoard(): ResponseRule {
  const body = { data: { addProjectV2ItemById: { item: { id: 'PVTI_7' } } } }
  return { match: { operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: 'I_7' } }, respond: { status: 200, body }, times: 1 }
}

/**
進行の欄（workflow）の更新の応答。optionId は設定の workflow のオプションの値（ready は o3）
*/
export function fieldUpdated(optionId: string): ResponseRule {
  const body = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } } } }
  const variables = { projectId: 'PVT_1', itemId: 'PVTI_7', fieldId: 'PVTSSF_workflow', optionId }
  return { match: { operation: 'UpdateProjectItemField', variables }, respond: { status: 200, body }, times: 1 }
}

/**
Issue のボード項目の応答。onBoard が偽なら、項目が無い
*/
export function boardItems(options: Readonly<{ onBoard?: boolean }> = {}): ResponseRule {
  const { onBoard = true } = options
  const nodes = onBoard ? [{ id: 'PVTI_7', project: { id: 'PVT_1' } }] : []
  const body = { data: { repository: { issue: { projectItems: { nodes } } } } }
  return { match: { operation: 'GetIssueProjectItems', variables: { owner: 'acme', repo: 'demo', number: 7 } }, respond: { status: 200, body }, times: 1 }
}

/**
どの要求にも失敗で答える（GraphQL の operation か REST の method と path を指す）
*/
export function failing(match: ResponseRule['match'], status = 502): ResponseRule {
  return { match, respond: { status, body: { message: 'failure' } }, times: 1 }
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
  return /^(?:Update|Add|Create)/u.test(request.operation) ? request.operation : undefined
}

export function writesOf(requests: readonly RecordedRequest[]): readonly string[] {
  return requests.map(request => writeOf(request)).filter(name => name !== undefined)
}
