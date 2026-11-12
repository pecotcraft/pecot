// security alert の種類と、code scanning・secret scanning の状態判定。`release preflight` が使う。
// 取得は ScanAlertSource に任せる。Dependabot は dependabot.ts が受け持つ。

import { PecotError } from './errors.js'
import type { ScanAlertSource, ScanKind, ScanListResult } from './security-alerts-source.js'

const KIND_LABELS: ReadonlyMap<ScanKind, string> = new Map([
  ['code-scanning', 'code scanning'],
  ['secret-scanning', 'secret scanning'],
])

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
      throw new SecurityAlertError(`${owner}/${repository}: ${KIND_LABELS.get(kind) ?? kind}: ${result.message}`)
    }
    case 'network': {
      throw new SecurityAlertError(`${owner}/${repository}: request failed: ${result.message}`)
    }
  }
}

async function scanStatus(source: ScanAlertSource, kind: ScanKind, host: string, owner: string, repository: string): Promise<ScanAlertStatus> {
  const alertsUrl = `https://${host}/${owner}/${repository}/security/${kind}`
  const listed = unwrap(await source.listOpenAlerts(kind, owner, repository), kind, owner, repository)
  return listed.kind === 'disabled'
    ? { enabled: false, openCount: 0, alertsUrl, openNumbers: [] }
    : { enabled: true, openCount: listed.count, alertsUrl, openNumbers: listed.numbers.toSorted((a, b) => a - b) }
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
