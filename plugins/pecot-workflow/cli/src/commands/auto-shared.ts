/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- GitHubClient は内部の状態を持つ */
// auto gate・start・finish が共有する、設定の確かめ・環境変数の読み方・GitHub の読み取り。
import type { ProjectConfig } from '../domain/config.js'
import type { RunIdentity } from '../domain/review-finish.js'
import type { RepositoryReference } from '../domain/repository-resolver.js'
import { isWritePermission } from '../domain/write-permission.js'
import type { GitHubClient } from '../infra/github/index.js'
import { GitHubAPIError } from '../infra/github/errors.js'
import { commandHint, hinted, RUN_COLON } from './command-hint.js'
import { requireConfigFor, stopWith } from './command-stop.js'
import { kindOfFailure } from './failure.js'
import { issuePath } from './issue-shared.js'
import type { IssueTarget } from './issue-shared.js'
import type { Output } from './output.js'

export const DEFAULT_AUTO_LABEL = 'pecot-auto'
const DEFAULT_SERVER_URL = 'https://github.com'

// 環境変数の宣言の確かめ（.githooks/tests/test_nx_env_inputs.py）が名前を拾えるよう、process.env は名前の文字列で読む
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

export function autoLabel(): string {
  return nonEmpty(process.env['PECOT_AUTO_LABEL']) ?? DEFAULT_AUTO_LABEL
}

export function runIdentity(): RunIdentity | undefined {
  const runId = nonEmpty(process.env['GITHUB_RUN_ID'])
  return runId === undefined ? undefined : { runId, attempt: nonEmpty(process.env['GITHUB_RUN_ATTEMPT']) ?? '1' }
}

/**
実行の記録の URL。GITHUB_REPOSITORY か GITHUB_RUN_ID が無ければ undefined
*/
export function runUrl(): string | undefined {
  const repository = nonEmpty(process.env['GITHUB_REPOSITORY'])
  const runId = nonEmpty(process.env['GITHUB_RUN_ID'])
  if (repository === undefined || runId === undefined) return undefined
  const server = (nonEmpty(process.env['GITHUB_SERVER_URL']) ?? DEFAULT_SERVER_URL).replace(/\/+$/u, '')
  return `${server}/${repository}/actions/runs/${runId}`
}

export function issueDisplay(target: Readonly<IssueTarget>): string {
  return `Issue ${issuePath(target.owner, target.repository, target.number)}`
}

/**
対象のリポの設定を選び、既定の Status（fields.status）があることを確かめる。無ければ project init を案内して止まる
*/
export function requireAutoConfig(out: Readonly<Output>, target: Readonly<RepositoryReference>, project: string | undefined, commandPath: readonly string[]): ProjectConfig {
  const { config } = requireConfigFor(out, target, project, commandPath)
  return config.project.fields.status === undefined
    ? stopWith(out, hinted`the project config has no Status field (fields.status)\n${RUN_COLON}${commandHint(['project', 'init'])}`, 'not-initialized')
    : config
}

export async function readOrStop<T>(out: Readonly<Output>, what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    return stopWith(out, `could not read ${what}: ${error.message}`, kindOfFailure(error))
  }
}

/**
書き込み権限（admin・write）を持つか。[bot] の名前と、読めないとき（404・API の失敗）は持たない側に倒す
*/
export async function hasWritePermission(out: Readonly<Output>, client: GitHubClient, repository: Readonly<RepositoryReference>, login: string): Promise<boolean> {
  if (login.endsWith('[bot]')) return false
  try {
    return isWritePermission(await client.getCollaboratorPermission(repository.owner, repository.repository, login))
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    out.warning(`could not read the permission of ${login}: ${error.message}`)
    return false
  }
}

/**
logins のうち、書き込み権限を持つ人
*/
export async function writersAmong(out: Readonly<Output>, client: GitHubClient, repository: Readonly<RepositoryReference>, logins: readonly string[]): Promise<ReadonlySet<string>> {
  const checked = await Promise.all(logins.map(async login => await hasWritePermission(out, client, repository, login)))
  return new Set(logins.filter((_login, index) => checked.at(index) === true))
}
