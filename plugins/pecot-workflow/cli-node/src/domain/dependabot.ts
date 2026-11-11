// Dependabot alert の状態判定。`release preflight` と `project info` が同じ判定を共有する。
// 有効 / 無効・open 件数・最高 severity・一覧 URL をまとめて返す。取得は DependabotSource に任せる。

import { describeErrorBody } from './api-error-detail.js'
import type { DependabotAlert, DependabotFailure, DependabotResult, DependabotSource } from './dependabot-source.js'
import { PecotError } from './errors.js'
import { isJsonObject, jsonField } from './json.js'

/**
alert の状態を判定できない。alerts が無効なのか権限不足なのかを区別できないときも含む
*/
export class DependabotAlertError extends PecotError {}

/**
open の alert 1 件の要点
*/
export interface OpenAlert {
  readonly number: number
  /**
  依存パッケージ名。応答に無ければ undefined
  */
  readonly package: string | undefined
  readonly severity: string | undefined
}

export interface DependabotAlertStatus {
  /**
  alerts が有効か
  */
  readonly enabled: boolean
  /**
  open の alert 件数（無効なら 0）
  */
  readonly openCount: number
  /**
  open の alert の最高 severity（0 件・無効なら undefined）
  */
  readonly maxSeverity: string | undefined
  /**
  alert 一覧の Web URL
  */
  readonly alertsUrl: string
  /**
  open の alert の要点（番号が整数のものだけ）
  */
  readonly openAlerts: readonly OpenAlert[]
}

// severity の強さ順（大きいほど重い）。未知の値は順位 -1 として扱い、落とさない
const SEVERITY_ORDER: ReadonlyMap<string, number> = new Map([['low', 0], ['medium', 1], ['high', 2], ['critical', 3]])

function severityRank(severity: string): number {
  return SEVERITY_ORDER.get(severity) ?? -1
}

/**
各 alert の security_vulnerability.severity の最大値。同順位は先に現れた値（Python の max と同じ）
*/
function maxSeverity(alerts: readonly DependabotAlert[]): string | undefined {
  let best: string | undefined
  for (const alert of alerts) {
    if (!isJsonObject(alert)) continue
    const vulnerability = alert['security_vulnerability']
    if (!isJsonObject(vulnerability)) continue
    const severity = vulnerability['severity']
    if (typeof severity === 'string' && (best === undefined || severityRank(severity) > severityRank(best))) best = severity
  }
  return best
}

function describe(failure: DependabotFailure): string {
  return describeErrorBody(failure.message, failure.responseBody)
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function openAlertOf(alert: DependabotAlert): OpenAlert | undefined {
  const number = jsonField(alert, 'number')
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) return undefined
  const dependency = jsonField(alert, 'dependency')
  return {
    number,
    package: stringOrUndefined(jsonField(jsonField(dependency, 'package'), 'name')),
    severity: stringOrUndefined(jsonField(jsonField(alert, 'security_vulnerability'), 'severity')),
  }
}

/**
成功以外の結果をエラーにする。ok のときは値を返す
*/
function unwrap<T>(result: DependabotResult<T>, owner: string, repository: string): T {
  switch (result.kind) {
    case 'ok': {
      return result.value
    }
    case 'network': {
      throw new DependabotAlertError(`${owner}/${repository}: request failed: ${result.message}`)
    }
    case 'forbidden':
    case 'rateLimited':
    case 'failure': {
      throw new DependabotAlertError(`${owner}/${repository}: ${describe(result.failure)}`)
    }
  }
}

/**
一覧が 403 のとき、vulnerability-alerts で「無効」かどうかを分類する。
404 のみを無効とみなす。204 は有効なのに一覧が取れない状態で、エラーにする
*/
async function classifyForbidden(source: DependabotSource, owner: string, repository: string, alertsUrl: string): Promise<DependabotAlertStatus> {
  if (unwrap(await source.isAlertsEnabled(owner, repository), owner, repository)) {
    throw new DependabotAlertError(`${owner}/${repository}: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)`)
  }
  return { enabled: false, openCount: 0, maxSeverity: undefined, alertsUrl, openAlerts: [] }
}

/**
リポジトリの Dependabot alert の状態を取得する。
一覧取得が成功なら有効確定で集計する。403（レート制限を除く）のときだけ有効 / 無効の判定で分類する（権限不足を「無効」と取り違えないため）。
状態を判定できなければ DependabotAlertError
*/
export async function fetchDependabotAlertStatus(source: DependabotSource, host: string, owner: string, repository: string): Promise<DependabotAlertStatus> {
  const alertsUrl = `https://${host}/${owner}/${repository}/security/dependabot`
  const listed = await source.listOpenAlerts(owner, repository)
  if (listed.kind === 'forbidden') return classifyForbidden(source, owner, repository, alertsUrl)

  const alerts = unwrap(listed, owner, repository)
  return { enabled: true, openCount: alerts.length, maxSeverity: maxSeverity(alerts), alertsUrl, openAlerts: alerts.map(alert => openAlertOf(alert)).filter(alert => alert !== undefined) }
}
