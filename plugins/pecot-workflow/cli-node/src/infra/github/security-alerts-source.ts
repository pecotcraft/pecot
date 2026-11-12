// code scanning と secret scanning の alert の取得元を、GitHub の REST で満たす実体。型は domain/security-alerts-source.ts の ScanAlertSource。
// 例外を結果の種類（kind）に直す。「無効」「解析なし」「権限不足」は、応答の状態コードと本文から見分ける。

import { isJsonObject, tryParseJsonText } from '../../domain/json.js'
import type { JsonValue } from '../../domain/python-format.js'
import type { ScanAlertSource, ScanListResult } from '../../domain/security-alerts-source.js'
import { TransportFailure } from './client.js'
import { describeApiError, GitHubAPIError, GitHubRateLimitError } from './errors.js'

const FORBIDDEN = 403
const NOT_FOUND = 404

/**
取得に使うクライアントの操作。ReposApi（GitHubClient）が満たす
*/
export interface ScanAlertClient {
  readonly listOpenCodeScanningAlerts: (owner: string, repository: string) => Promise<readonly JsonValue[]>
  readonly listOpenSecretScanningAlerts: (owner: string, repository: string) => Promise<readonly JsonValue[]>
  readonly getSecretScanningStatus: (owner: string, repository: string) => Promise<string | undefined>
}

function bodyMessage(error: Readonly<Pick<GitHubAPIError, 'responseBody'>>): string {
  const body = tryParseJsonText(error.responseBody ?? '')
  const message = isJsonObject(body) ? body['message'] : undefined
  return typeof message === 'string' ? message.toLowerCase() : ''
}

/**
403 の本文が Advanced Security・code scanning の未有効を示すときだけ無効とみなす。権限不足は含めない
*/
function isCodeScanningDisabled(error: Readonly<GitHubAPIError>): boolean {
  if (error.statusCode !== FORBIDDEN || error instanceof GitHubRateLimitError) return false
  const message = bodyMessage(error)
  return message.includes('advanced security') || message.includes('not enabled')
}

/**
解析がまだ無いリポの 404（有効だが alert は 0 件）か
*/
function isNoAnalysis(error: Readonly<GitHubAPIError>): boolean {
  return error.statusCode === NOT_FOUND && bodyMessage(error).includes('no analysis found')
}

function okOf(alerts: readonly JsonValue[]): ScanListResult {
  const numbers = alerts.map(alert => (isJsonObject(alert) ? alert['number'] : undefined)).filter((number): number is number => Number.isSafeInteger(number))
  return { kind: 'ok', count: alerts.length, numbers }
}

async function listCodeScanning(client: ScanAlertClient, owner: string, repository: string): Promise<ScanListResult> {
  try {
    return okOf(await client.listOpenCodeScanningAlerts(owner, repository))
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError)) throw error
    if (isCodeScanningDisabled(error)) return { kind: 'disabled' }
    if (isNoAnalysis(error)) return { kind: 'ok', count: 0, numbers: [] }
    throw error
  }
}

// 404 は「無効」だけでなく、権限不足（admin でない）でも起きる。無効と確かめられたときだけ無効にする
async function listSecretScanning(client: ScanAlertClient, owner: string, repository: string): Promise<ScanListResult> {
  try {
    return okOf(await client.listOpenSecretScanningAlerts(owner, repository))
  }
  catch (error: unknown) {
    if (!(error instanceof GitHubAPIError) || error.statusCode !== NOT_FOUND) throw error
    return (await client.getSecretScanningStatus(owner, repository)) === 'disabled' ? { kind: 'disabled' } : { kind: 'unconfirmed' }
  }
}

/**
GitHub のクライアントから ScanAlertSource を作る
*/
export function createScanAlertSource(client: ScanAlertClient): ScanAlertSource {
  return {
    listOpenAlerts: async (kind, owner, repository) => {
      try {
        return kind === 'code-scanning' ? await listCodeScanning(client, owner, repository) : await listSecretScanning(client, owner, repository)
      }
      catch (error: unknown) {
        if (error instanceof GitHubAPIError) return { kind: 'failure', message: describeApiError(error) }
        if (error instanceof TransportFailure) return { kind: 'network', message: error.message }
        throw error
      }
    },
  }
}
