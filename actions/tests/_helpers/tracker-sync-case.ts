// tracker-sync の security と dependabot のテストが共有する準備。時計・設定・ボードの応答・Tracker の作成と Issue の一覧の応答を置く。
import { copyFileSync } from 'node:fs'
import path from 'node:path'

import { vi } from 'vitest'

import type { CommandIo } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { setEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { main } from '../../src/tracker-sync.js'
import { runActionCase, setUpProject } from './action-case.js'
import type { ActionResult, ProjectFixture } from './action-case.js'

export { boardRules, createdTracker, issueListRule, WORKFLOW_FIELD } from '../../../libs/workflow-core/tests/_helpers/tracker-rules.js'

export const NOW = new Date('2026-11-09T12:00:00Z')
export const TOKEN_VARIABLE = 'PECOT_GITHUB_GHES_EXAMPLE_COM_TOKEN'
const HOST = 'ghes.example.com'

export function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
}

export interface SyncSetup {
  /**
  設定の repositories に載せるリポジトリ名。既定は demo
  */
  readonly repositories?: readonly string[]
  /**
  真なら、同じリポを含む 2 つ目の設定（second）を足す
  */
  readonly ambiguous?: boolean
  /**
  GITHUB_REPOSITORY の値。既定は acme/demo
  */
  readonly repository?: string
}

/**
GHES の設定を持つ一時のリポへ移り、GITHUB_REPOSITORY とホストのトークンを置く
*/
export function prepareSync(setup: Readonly<SyncSetup> = {}): ProjectFixture {
  const { repositories, ambiguous = false, repository = 'acme/demo' } = setup
  const project = setUpProject({ host: HOST, ...repositories !== undefined && { repositories } })
  if (ambiguous) {
    const directory = path.join(project.root, '.pecot/config/projects')
    copyFileSync(path.join(directory, project.configFile), path.join(directory, 'second.json'))
  }
  // runAction は token の input を github.com の変数にだけ渡すので、GHES の変数を直に置く
  setEnvironment({ GITHUB_REPOSITORY: repository, [TOKEN_VARIABLE]: 'ghs_test-token' })
  return project
}

/**
tracker-sync の action を inputs で呼ぶ
*/
export async function runSync(source: string | undefined, inputs: Readonly<Record<string, string | undefined>> = {}): Promise<ActionResult> {
  return await runActionCase(async (io: CommandIo) => await main(io), { source, ...inputs })
}

/**
config の選択肢の ID が古いときの、ボードの欄の書き込みの応答（GitHub は VALIDATION を返す）
*/
export function staleOptionUpdate(): ResponseRule {
  const error = { type: 'VALIDATION', message: 'The single select option Id does not belong to the field' }
  return { match: { operation: 'UpdateProjectItemField' }, times: 1, respond: { status: 200, body: { errors: [error] } } }
}

/**
staleOptionUpdate を受けたときの、error の行の `GraphQL query error: …` の部分
*/
export const STALE_OPTION_TEXT = 'GraphQL query error: {\'type\': \'VALIDATION\', \'message\': \'The single select option Id does not belong to the field\'}'

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
