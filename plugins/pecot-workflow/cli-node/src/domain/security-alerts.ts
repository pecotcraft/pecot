// security alert の種類と、種類ごとの open の alert の取得、code scanning・secret scanning の状態判定。`release preflight` と `security sync` が使う。
// 取得は ScanAlertSource と DependabotSource に任せる。

import { describeErrorBody } from './api-error-detail.js'
import type { DependabotFailure, DependabotResult, DependabotSource } from './dependabot-source.js'
import { PecotError } from './errors.js'
import { jsonField } from './json.js'
import type { JsonValue } from './python-format.js'
import type { ScanAlertSource, ScanKind, ScanListResult } from './security-alerts-source.js'

export type AlertKind = 'dependabot' | ScanKind

/**
種類の並び。Tracker の見出しと行の並びはこの順
*/
export const ALERT_KINDS: readonly AlertKind[] = ['dependabot', 'code-scanning', 'secret-scanning']

/**
Tracker の見出しとエラー文に出す種類の表示名
*/
export function kindLabel(kind: AlertKind): string {
  switch (kind) {
    case 'dependabot': { return 'Dependabot' }
    case 'code-scanning': { return 'code scanning' }
    case 'secret-scanning': { return 'secret scanning' }
  }
}

/**
security alert の状態を判定できない
*/
export class SecurityAlertError extends PecotError {}

export interface ScanAlertStatus {
  readonly enabled: boolean
  /**
  open の alert 件数（無効なら 0）
  */
  readonly openCount: number
  /**
  alert 一覧の Web URL
  */
  readonly alertsUrl: string
  /**
  open の alert 番号（昇順）
  */
  readonly openNumbers: readonly number[]
}

const UNCONFIRMED_MESSAGE = 'cannot fetch the secret scanning list (permission may be missing; it cannot be confirmed as disabled)'

function unwrap(result: ScanListResult, kind: ScanKind, owner: string, repository: string): Exclude<ScanListResult, { readonly kind: 'unconfirmed' | 'failure' | 'network' }> {
  switch (result.kind) {
    case 'ok':
    case 'disabled': {
      return result
    }
    case 'unconfirmed': {
      throw new SecurityAlertError(`${owner}/${repository}: ${UNCONFIRMED_MESSAGE}`)
    }
    case 'failure': {
      throw new SecurityAlertError(`${owner}/${repository}: ${kindLabel(kind)}: ${result.message}`)
    }
    case 'network': {
      throw new SecurityAlertError(`${owner}/${repository}: request failed: ${result.message}`)
    }
  }
}

function describeFailure(failure: DependabotFailure): string {
  return describeErrorBody(failure.message, failure.responseBody)
}

// forbidden は呼び出し側が分けて扱う。ここに来る forbidden は、有効 / 無効の判定の応答（レート制限以外の 403 は ok にならない）
function unwrapDependabot<T>(result: DependabotResult<T>, owner: string, repository: string): T {
  switch (result.kind) {
    case 'ok': {
      return result.value
    }
    case 'network': {
      throw new SecurityAlertError(`${owner}/${repository}: request failed: ${result.message}`)
    }
    case 'forbidden':
    case 'rateLimited':
    case 'failure': {
      throw new SecurityAlertError(`${owner}/${repository}: ${kindLabel('dependabot')}: ${describeFailure(result.failure)}`)
    }
  }
}

async function listDependabot(source: DependabotSource, owner: string, repository: string): Promise<readonly JsonValue[] | undefined> {
  const listed = await source.listOpenAlerts(owner, repository)
  if (listed.kind !== 'forbidden') return unwrapDependabot(listed, owner, repository)
  // 403 は無効と権限不足の両方で起きる。有効なら権限不足としてエラーにする
  if (unwrapDependabot(await source.isAlertsEnabled(owner, repository), owner, repository)) {
    throw new SecurityAlertError(`${owner}/${repository}: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)`)
  }
  return undefined
}

async function listScan(source: ScanAlertSource, kind: ScanKind, owner: string, repository: string): Promise<readonly JsonValue[] | undefined> {
  const listed = unwrap(await source.listOpenAlerts(kind, owner, repository), kind, owner, repository)
  return listed.kind === 'disabled' ? undefined : listed.alerts
}

export interface AlertSources {
  readonly scan: ScanAlertSource
  readonly dependabot: DependabotSource
}

/**
種類ごとの open の alert（API の応答そのもの）を取る。機能が無効のリポは undefined。
一覧を取得できず無効とも言えないとき（API エラー・通信エラー・権限不足）は SecurityAlertError
*/
export async function listOpenAlerts(sources: AlertSources, kind: AlertKind, owner: string, repository: string): Promise<readonly JsonValue[] | undefined> {
  return kind === 'dependabot' ? listDependabot(sources.dependabot, owner, repository) : listScan(sources.scan, kind, owner, repository)
}

async function scanStatus(source: ScanAlertSource, kind: ScanKind, host: string, owner: string, repository: string): Promise<ScanAlertStatus> {
  const alertsUrl = `https://${host}/${owner}/${repository}/security/${kind}`
  const alerts = await listScan(source, kind, owner, repository)
  if (alerts === undefined) return { enabled: false, openCount: 0, alertsUrl, openNumbers: [] }
  const numbers = alerts.map(alert => jsonField(alert, 'number')).filter((number): number is number => Number.isSafeInteger(number))
  return { enabled: true, openCount: alerts.length, alertsUrl, openNumbers: numbers.toSorted((a, b) => a - b) }
}

/**
code scanning の open の alert 数を取る（既定ブランチが対象）。状態を判定できなければ SecurityAlertError
*/
export async function fetchCodeScanningStatus(source: ScanAlertSource, host: string, owner: string, repository: string): Promise<ScanAlertStatus> {
  return scanStatus(source, 'code-scanning', host, owner, repository)
}

/**
secret scanning の open の alert 数を取る（値は取得しない）。
権限不足などで無効と確かめられないときも SecurityAlertError
*/
export async function fetchSecretScanningStatus(source: ScanAlertSource, host: string, owner: string, repository: string): Promise<ScanAlertStatus> {
  return scanStatus(source, 'secret-scanning', host, owner, repository)
}
