/* eslint-disable security/detect-non-literal-fs-filename -- パスは一時ディレクトリの中だけ */
// session show のテストが共有する準備。
import { realpathSync } from 'node:fs'

import type { ResponseRule } from '../fake-github/server.js'
import { createGitRepository, gitForTest } from '../../src/tests/_helpers/git-repository.js'
import { developmentRecordOf } from './base-record.js'
import type { BaseRecordOption } from './base-record.js'
import { setUpProject } from './interface-case.js'
import type { ProjectFixture } from './interface-case.js'

export const CONFIG_FILE = 'ghes.example.com_acme_board_acme.json'
export const ORIGIN_URL = 'https://ghes.example.com/acme/demo.git'

export interface SessionCaseOptions extends BaseRecordOption {
  /**
  既定は feat/demo/7
  */
  readonly branch?: string
  /**
  追加する remote（名前 → URL）。既定は origin だけ
  */
  readonly remotes?: Readonly<Record<string, string>>
  /**
  プロジェクトルートに足すファイル（設定ファイルの上書きを含む）
  */
  readonly files?: Readonly<Record<string, string>>
}

export interface SessionCase {
  readonly project: ProjectFixture
  readonly repository: string
}

/**
一時のプロジェクトルートを git リポにして、cwd をそこへ移す。ブランチと remote で作業中の Issue が決まる
*/
export function prepareSession(options: Readonly<SessionCaseOptions> = {}): SessionCase {
  const { branch = 'feat/demo/7', remotes = { origin: ORIGIN_URL }, files = {} } = options
  const project = setUpProject({ files: { ...developmentRecordOf(options), ...files } })
  const repository = realpathSync(createGitRepository(undefined, project.root))
  process.chdir(repository)
  gitForTest(repository, ['checkout', '-q', '-b', branch])
  for (const [name, url] of Object.entries(remotes)) gitForTest(repository, ['remote', 'add', name, url])
  return { project, repository }
}

/**
プロジェクトルートとは別の git リポ（clone した場所など）を、ブランチ feat/demo/7 と origin で用意する。cwd は変えない
*/
export function separateRepository(): string {
  const repository = realpathSync(createGitRepository())
  gitForTest(repository, ['checkout', '-q', '-b', 'feat/demo/7'])
  gitForTest(repository, ['remote', 'add', 'origin', ORIGIN_URL])
  return repository
}

/**
GetIssueSlim の 200 の応答
*/
export function issueResponse(fields: Readonly<{ number: number, title: string, body?: string, state?: string }>): ResponseRule {
  const { number, title, body = '', state = 'OPEN' } = fields
  const issue = {
    number,
    state,
    title,
    body,
    comments: { totalCount: 0, nodes: [] },
    // eslint-disable-next-line unicorn/no-null -- GraphQL の応答の null
    parent: null,
    subIssues: { nodes: [] },
    linkedBranches: { nodes: [] },
    timelineItems: { nodes: [] },
  }
  return { match: { operation: 'GetIssueSlim' }, respond: { status: 200, body: { data: { repository: { issue } } } }, times: 1 }
}

export function issueFailure(status: number): ResponseRule {
  return { match: { operation: 'GetIssueSlim' }, respond: { status, body: { message: 'failure' } }, times: 1 }
}
