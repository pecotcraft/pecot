// Dependabot alert の取得元を、GitHub の REST で満たす実体。型は domain/dependabot-source.ts の DependabotSource。
// 例外を結果の種類（kind）に直す。レート制限は rateLimited、その他の 403 は forbidden、他の API エラーは failure。
// 通信の失敗は network にする。

import type { DependabotAlert, DependabotFailure, DependabotResult, DependabotSource } from '../../domain/dependabot-source.js'
import { TransportFailure } from './client.js'
import { GitHubAPIError, GitHubRateLimitError } from './errors.js'

const FORBIDDEN = 403

/**
取得に使うクライアントの操作。ReposApi（GitHubClient）が満たす
*/
export interface DependabotClient {
  readonly isDependabotAlertsEnabled: (owner: string, repository: string) => Promise<boolean>
  readonly listOpenDependabotAlerts: (owner: string, repository: string) => Promise<readonly DependabotAlert[]>
}

function failureOf(error: Readonly<Pick<GitHubAPIError, 'message' | 'responseBody' | 'statusCode'>>): DependabotFailure {
  return { message: error.message, statusCode: error.statusCode, responseBody: error.responseBody }
}

async function capture<T>(action: () => Promise<T>): Promise<DependabotResult<T>> {
  try {
    return { kind: 'ok', value: await action() }
  }
  catch (error: unknown) {
    if (error instanceof GitHubRateLimitError) return { kind: 'rateLimited', failure: failureOf(error) }
    if (error instanceof GitHubAPIError) return { kind: error.statusCode === FORBIDDEN ? 'forbidden' : 'failure', failure: failureOf(error) }
    if (error instanceof TransportFailure) return { kind: 'network', message: error.message }
    throw error
  }
}

/**
GitHub のクライアントから DependabotSource を作る
*/
export function createDependabotSource(client: DependabotClient): DependabotSource {
  return {
    listOpenAlerts: async (owner, repository) => capture(async () => client.listOpenDependabotAlerts(owner, repository)),
    isAlertsEnabled: async (owner, repository) => capture(async () => client.isDependabotAlertsEnabled(owner, repository)),
  }
}
