import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../python-format.js'

import type { DependabotFailure, DependabotResult, DependabotSource } from '../dependabot-source.js'
import { fetchCodeScanningStatus, fetchSecretScanningStatus, listOpenAlerts, SecurityAlertError } from '../security-alerts.js'
import type { AlertSources } from '../security-alerts.js'
import type { ScanAlertSource, ScanKind, ScanListResult } from '../security-alerts-source.js'

// 取得元をメモリ上で置き換える。呼ばれた種類と対象も控える
function memorySource(result: ScanListResult): { readonly source: ScanAlertSource, readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    source: {
      listOpenAlerts: (kind: ScanKind, owner, repository) => {
        calls.push(`${kind} ${owner}/${repository}`)
        return Promise.resolve(result)
      },
    },
  }
}

describe('fetchCodeScanningStatus', () => {
  it('有効なら件数と、昇順にした番号と、一覧の URL を返す', async () => {
    const { source, calls } = memorySource({ kind: 'ok', alerts: [{ number: 10 }, { number: 2 }, { number: 7 }, { number: 'x' }] })
    expect(await fetchCodeScanningStatus(source, 'ghes.example.com', 'acme', 'demo')).toEqual({
      enabled: true,
      openCount: 4,
      alertsUrl: 'https://ghes.example.com/acme/demo/security/code-scanning',
      openNumbers: [2, 7, 10],
    })
    expect(calls).toEqual(['code-scanning acme/demo'])
  })

  it('無効なら enabled が偽で、件数は 0', async () => {
    const { source } = memorySource({ kind: 'disabled' })
    expect(await fetchCodeScanningStatus(source, 'github.com', 'o', 'r')).toEqual({
      enabled: false,
      openCount: 0,
      alertsUrl: 'https://github.com/o/r/security/code-scanning',
      openNumbers: [],
    })
  })

  const failures: readonly { readonly result: ScanListResult, readonly message: string }[] = [
    { result: { kind: 'failure', message: 'access denied forbidden' }, message: 'o/r: code scanning: access denied forbidden' },
    { result: { kind: 'network', message: 'timeout' }, message: 'o/r: request failed: timeout' },
    { result: { kind: 'unconfirmed' }, message: 'o/r: cannot fetch the secret scanning list (permission may be missing; it cannot be confirmed as disabled)' },
  ]

  it.for(failures)('$result.kind は SecurityAlertError にする', async ({ result, message }) => {
    const { source } = memorySource(result)
    await expect(fetchCodeScanningStatus(source, 'github.com', 'o', 'r')).rejects.toThrow(new SecurityAlertError(message))
  })
})

describe('fetchSecretScanningStatus', () => {
  it('secret-scanning の取得元を呼び、一覧の URL を返す', async () => {
    const { source, calls } = memorySource({ kind: 'ok', alerts: [] })
    expect(await fetchSecretScanningStatus(source, 'github.com', 'o', 'r')).toEqual({
      enabled: true,
      openCount: 0,
      alertsUrl: 'https://github.com/o/r/security/secret-scanning',
      openNumbers: [],
    })
    expect(calls).toEqual(['secret-scanning o/r'])
  })

  it('番号の無い alert も件数に数える', async () => {
    const { source } = memorySource({ kind: 'ok', alerts: [{ number: 5 }, {}, 7.5] })
    expect(await fetchSecretScanningStatus(source, 'github.com', 'o', 'r')).toMatchObject({ openCount: 3, openNumbers: [5] })
  })

  it('無効と確かめられないときは、権限不足をほのめかす SecurityAlertError', async () => {
    const { source } = memorySource({ kind: 'unconfirmed' })
    await expect(fetchSecretScanningStatus(source, 'github.com', 'o', 'r')).rejects.toThrow('o/r: cannot fetch the secret scanning list (permission may be missing; it cannot be confirmed as disabled)')
  })

  it('API の失敗は種類の表示名を添えた SecurityAlertError', async () => {
    const { source } = memorySource({ kind: 'failure', message: 'GitHub API error: 500' })
    await expect(fetchSecretScanningStatus(source, 'github.com', 'o', 'r')).rejects.toThrow('o/r: secret scanning: GitHub API error: 500')
  })
})

const FORBIDDEN: DependabotFailure = { message: 'access denied', statusCode: 403, responseBody: '{"message":"Resource not accessible"}' }

const ENABLED: DependabotResult<boolean> = { kind: 'ok', value: true }

// Dependabot の取得元をメモリ上で置き換える。有効 / 無効の判定が呼ばれた回数も控える
function dependabotSource(listed: DependabotResult<readonly JsonValue[]>, enabled = ENABLED): { readonly source: DependabotSource, readonly checks: string[] } {
  const checks: string[] = []
  return {
    checks,
    source: {
      listOpenAlerts: () => Promise.resolve(listed),
      isAlertsEnabled: (owner, repository) => {
        checks.push(`${owner}/${repository}`)
        return Promise.resolve(enabled)
      },
    },
  }
}

function sourcesOf(dependabot: DependabotSource, scan: ScanAlertSource = memorySource({ kind: 'disabled' }).source): AlertSources {
  return { scan, dependabot }
}

describe('listOpenAlerts', () => {
  it('Dependabot の一覧が取れたら、応答の alert をそのまま返す', async () => {
    const { source } = dependabotSource({ kind: 'ok', value: [{ number: 1 }] })
    expect(await listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).toEqual([{ number: 1 }])
  })

  it('code scanning は scan の取得元を種類つきで呼び、取れた alert を返す', async () => {
    const { source, calls } = memorySource({ kind: 'ok', alerts: [{ number: 3 }] })
    const { source: dependabot } = dependabotSource({ kind: 'ok', value: [] })
    expect(await listOpenAlerts(sourcesOf(dependabot, source), 'code-scanning', 'o', 'r')).toEqual([{ number: 3 }])
    expect(calls).toEqual(['code-scanning o/r'])
  })

  it('scan の取得元が無効を返すと、undefined を返す', async () => {
    const { source: dependabot } = dependabotSource({ kind: 'ok', value: [] })
    expect(await listOpenAlerts(sourcesOf(dependabot), 'secret-scanning', 'o', 'r')).toBeUndefined()
  })

  it('Dependabot が 403 で alerts が無効なら、undefined を返す', async () => {
    const { source, checks } = dependabotSource({ kind: 'forbidden', failure: FORBIDDEN }, { kind: 'ok', value: false })
    expect(await listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).toBeUndefined()
    expect(checks).toEqual(['o/r'])
  })

  it('Dependabot が 403 で alerts が有効なら、権限不足をほのめかすエラーにする', async () => {
    const { source } = dependabotSource({ kind: 'forbidden', failure: FORBIDDEN })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)'))
  })

  it('Dependabot のレート制限は、有効 / 無効を調べずエラーで返す', async () => {
    const { source, checks } = dependabotSource({ kind: 'rateLimited', failure: { message: 'API rate limit', statusCode: 403, responseBody: undefined } })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: Dependabot: API rate limit'))
    expect(checks).toEqual([])
  })

  it('Dependabot の API エラーは、応答本文の message を添えた文にする', async () => {
    const { source } = dependabotSource({ kind: 'failure', failure: { message: 'GitHub API error: 500', statusCode: 500, responseBody: '{"message":"boom"}' } })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: Dependabot: GitHub API error: 500 boom'))
  })

  it('Dependabot の通信エラーは、request failed の文にする', async () => {
    const { source } = dependabotSource({ kind: 'network', message: 'down' })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: request failed: down'))
  })

  it('有効 / 無効の判定が通信エラーなら、request failed の文にする', async () => {
    const { source } = dependabotSource({ kind: 'forbidden', failure: FORBIDDEN }, { kind: 'network', message: 'down' })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: request failed: down'))
  })

  it('有効 / 無効の判定が API エラーなら、Dependabot の文にする', async () => {
    const { source } = dependabotSource({ kind: 'forbidden', failure: FORBIDDEN }, { kind: 'failure', failure: { message: 'GitHub API error: 500', statusCode: 500, responseBody: undefined } })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: Dependabot: GitHub API error: 500'))
  })

  it('scan の取得元が失敗を返すと、種類の表示名を添えたエラーにする', async () => {
    const { source } = memorySource({ kind: 'failure', message: 'GitHub API error: 500' })
    const { source: dependabot } = dependabotSource({ kind: 'ok', value: [] })
    await expect(listOpenAlerts(sourcesOf(dependabot, source), 'code-scanning', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: code scanning: GitHub API error: 500'))
  })
})
