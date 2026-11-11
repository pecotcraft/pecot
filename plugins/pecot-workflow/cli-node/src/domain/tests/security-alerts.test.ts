import { describe, expect, it } from 'vitest'

import { fetchCodeScanningStatus, fetchSecretScanningStatus, KIND_LABELS, SecurityAlertError } from '../security-alerts.js'
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

describe('KIND_LABELS', () => {
  it('種類ごとの表示名を持つ', () => {
    expect(KIND_LABELS).toEqual({ 'dependabot': 'Dependabot', 'code-scanning': 'code scanning', 'secret-scanning': 'secret scanning' })
  })
})

describe('fetchCodeScanningStatus', () => {
  it('有効なら件数と、昇順にした番号と、一覧の URL を返す', async () => {
    const { source, calls } = memorySource({ kind: 'ok', count: 4, numbers: [10, 2, 7] })
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
    const { source, calls } = memorySource({ kind: 'ok', count: 0, numbers: [] })
    expect(await fetchSecretScanningStatus(source, 'github.com', 'o', 'r')).toEqual({
      enabled: true,
      openCount: 0,
      alertsUrl: 'https://github.com/o/r/security/secret-scanning',
      openNumbers: [],
    })
    expect(calls).toEqual(['secret-scanning o/r'])
  })

  it('番号の無い alert も件数に数える', async () => {
    const { source } = memorySource({ kind: 'ok', count: 3, numbers: [5] })
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
