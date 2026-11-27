import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

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
  it('code scanning が有効なら、件数・昇順の番号・一覧の URL を返す', async () => {
    await explains('code scanning の状態を取得する `fetchCodeScanningStatus` のテストです。有効で、番号が不揃いの alert が 4 件ある場合に、件数 4・昇順にした番号・一覧の URL を返し、番号が数値でない alert は件数だけに数えることを確認します。')
    const { source, calls } = memorySource({ kind: 'ok', alerts: [{ number: 10 }, { number: 2 }, { number: 7 }, { number: 'x' }] })
    expect(await fetchCodeScanningStatus(source, 'ghes.example.com', 'acme', 'demo')).toEqual({
      enabled: true,
      openCount: 4,
      alertsUrl: 'https://ghes.example.com/acme/demo/security/code-scanning',
      openNumbers: [2, 7, 10],
    })
    expect(calls).toEqual(['code-scanning acme/demo'])
  })

  it('code scanning が無効なら、enabled が偽で件数は 0 を返す', async () => {
    await explains('code scanning が無効の場合の、`fetchCodeScanningStatus` のテストです。`enabled` が偽で、件数が 0、番号が空の配列になり、一覧の URL は返すことを確認します。')
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

  it.for(failures)('取得が $result.kind の場合は、SecurityAlertError の例外が発生する', async ({ result, message }) => {
    await explains('code scanning の取得に失敗した場合の、`fetchCodeScanningStatus` のテストです。API の失敗・通信の失敗・無効と確認できない場合のそれぞれで、メッセージを持つ `SecurityAlertError` の例外が発生することを確認します。')
    const { source } = memorySource(result)
    await expect(fetchCodeScanningStatus(source, 'github.com', 'o', 'r')).rejects.toThrow(new SecurityAlertError(message))
  })
})

describe('fetchSecretScanningStatus', () => {
  it('secret scanning の取得元を呼び、一覧の URL を返す', async () => {
    await explains('secret scanning の状態を取得する `fetchSecretScanningStatus` のテストです。取得元を `secret-scanning` の種類で呼び、有効で alert が 0 件の場合に、`secret-scanning` の一覧の URL を返すことを確認します。')
    const { source, calls } = memorySource({ kind: 'ok', alerts: [] })
    expect(await fetchSecretScanningStatus(source, 'github.com', 'o', 'r')).toEqual({
      enabled: true,
      openCount: 0,
      alertsUrl: 'https://github.com/o/r/security/secret-scanning',
      openNumbers: [],
    })
    expect(calls).toEqual(['secret-scanning o/r'])
  })

  it('番号が存在しない alert も、件数に数える', async () => {
    await explains('番号を持たない alert の、`fetchSecretScanningStatus` のテストです。番号が存在しない alert や数値でない値も件数に数え、番号の一覧には整数の番号だけを入れることを確認します。')
    const { source } = memorySource({ kind: 'ok', alerts: [{ number: 5 }, {}, 7.5] })
    expect(await fetchSecretScanningStatus(source, 'github.com', 'o', 'r')).toMatchObject({ openCount: 3, openNumbers: [5] })
  })

  it('無効と確認できないときは、権限不足を示す SecurityAlertError の例外が発生する', async () => {
    await explains('有効か無効かを確認できない場合の、`fetchSecretScanningStatus` のテストです。権限が不足している可能性を示すメッセージで、`SecurityAlertError` の例外が発生することを確認します。')
    const { source } = memorySource({ kind: 'unconfirmed' })
    await expect(fetchSecretScanningStatus(source, 'github.com', 'o', 'r')).rejects.toThrow('o/r: cannot fetch the secret scanning list (permission may be missing; it cannot be confirmed as disabled)')
  })

  it('API が失敗した場合は、種類の表示名を付けた SecurityAlertError の例外が発生する', async () => {
    await explains('API が失敗した場合の、`fetchSecretScanningStatus` のテストです。メッセージの先頭に `o/r: secret scanning:` を付けた `SecurityAlertError` の例外が発生することを確認します。')
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
  it('Dependabot の一覧を取得できたら、応答の alert をそのまま返す', async () => {
    await explains('開いている alert を取得する `listOpenAlerts` のテストです。種類が `dependabot` で、取得に成功した場合は、応答の alert を加工せずに返すことを確認します。')
    const { source } = dependabotSource({ kind: 'ok', value: [{ number: 1 }] })
    expect(await listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).toEqual([{ number: 1 }])
  })

  it('code scanning は、種類を付けて scan の取得元を呼び、取得できた alert を返す', async () => {
    await explains('種類が `code-scanning` の場合の、`listOpenAlerts` のテストです。scan の取得元を種類と対象のリポジトリ付きで呼び、取得できた alert を返すことを確認します。')
    const { source, calls } = memorySource({ kind: 'ok', alerts: [{ number: 3 }] })
    const { source: dependabot } = dependabotSource({ kind: 'ok', value: [] })
    expect(await listOpenAlerts(sourcesOf(dependabot, source), 'code-scanning', 'o', 'r')).toEqual([{ number: 3 }])
    expect(calls).toEqual(['code-scanning o/r'])
  })

  it('scan の取得元が無効を返したら、undefined を返す', async () => {
    await explains('scan の取得元が無効を返す場合の、`listOpenAlerts` のテストです。種類が `secret-scanning` のとき、alert の一覧は存在しないものとして `undefined` を返すことを確認します。')
    const { source: dependabot } = dependabotSource({ kind: 'ok', value: [] })
    expect(await listOpenAlerts(sourcesOf(dependabot), 'secret-scanning', 'o', 'r')).toBeUndefined()
  })

  it('Dependabot が 403 で alerts が無効なら、undefined を返す', async () => {
    await explains('Dependabot が 403 を返す場合の、`listOpenAlerts` のテストです。alerts が無効と判定できたとき、`undefined` を返し、有効かどうかの確認を 1 回だけ行うことを確認します。')
    const { source, checks } = dependabotSource({ kind: 'forbidden', failure: FORBIDDEN }, { kind: 'ok', value: false })
    expect(await listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).toBeUndefined()
    expect(checks).toEqual(['o/r'])
  })

  it('Dependabot が 403 で alerts が有効なら、権限不足を示すエラーが発生する', async () => {
    await explains('Dependabot が 403 を返す場合の、`listOpenAlerts` のテストです。alerts が有効なのに一覧を取得できないとき、権限が不足している可能性を示す `SecurityAlertError` の例外が発生することを確認します。')
    const { source } = dependabotSource({ kind: 'forbidden', failure: FORBIDDEN })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)'))
  })

  it('Dependabot のレート制限は、有効かどうかは調べず、エラーで返す', async () => {
    await explains('Dependabot がレート制限を返す場合の、`listOpenAlerts` のテストです。有効かどうかの確認は行わず、`SecurityAlertError` の例外が発生することを確認します。')
    const { source, checks } = dependabotSource({ kind: 'rateLimited', failure: { message: 'API rate limit', statusCode: 403, responseBody: undefined } })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: Dependabot: API rate limit'))
    expect(checks).toEqual([])
  })

  it('Dependabot の API エラーは、応答本文の message を付けたメッセージにする', async () => {
    await explains('Dependabot の API が失敗した場合の、`listOpenAlerts` のテストです。応答の本文にある `message` を、API のエラーの文の後ろに付けた例外が発生することを確認します。')
    const { source } = dependabotSource({ kind: 'failure', failure: { message: 'GitHub API error: 500', statusCode: 500, responseBody: '{"message":"boom"}' } })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: Dependabot: GitHub API error: 500 boom'))
  })

  it('Dependabot の通信エラーは、request failed のメッセージにする', async () => {
    await explains('Dependabot への通信が失敗した場合の、`listOpenAlerts` のテストです。メッセージが `request failed:` で始まる `SecurityAlertError` の例外が発生することを確認します。')
    const { source } = dependabotSource({ kind: 'network', message: 'down' })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: request failed: down'))
  })

  it('有効かどうかの確認で通信エラーが起きたら、request failed のメッセージにする', async () => {
    await explains('Dependabot が 403 で、有効かどうかの確認が通信エラーになる場合の、`listOpenAlerts` のテストです。メッセージが `request failed:` で始まる例外が発生することを確認します。')
    const { source } = dependabotSource({ kind: 'forbidden', failure: FORBIDDEN }, { kind: 'network', message: 'down' })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: request failed: down'))
  })

  it('有効かどうかの確認で API エラーが起きたら、Dependabot のメッセージにする', async () => {
    await explains('Dependabot が 403 で、有効かどうかの確認が API エラーになる場合の、`listOpenAlerts` のテストです。メッセージが `Dependabot:` で始まる例外が発生することを確認します。')
    const { source } = dependabotSource({ kind: 'forbidden', failure: FORBIDDEN }, { kind: 'failure', failure: { message: 'GitHub API error: 500', statusCode: 500, responseBody: undefined } })
    await expect(listOpenAlerts(sourcesOf(source), 'dependabot', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: Dependabot: GitHub API error: 500'))
  })

  it('scan の取得元が失敗を返したら、種類の表示名を付けたエラーにする', async () => {
    await explains('scan の取得元が失敗を返す場合の、`listOpenAlerts` のテストです。メッセージの先頭に `o/r: code scanning:` を付けた `SecurityAlertError` の例外が発生することを確認します。')
    const { source } = memorySource({ kind: 'failure', message: 'GitHub API error: 500' })
    const { source: dependabot } = dependabotSource({ kind: 'ok', value: [] })
    await expect(listOpenAlerts(sourcesOf(dependabot, source), 'code-scanning', 'o', 'r')).rejects.toThrow(new SecurityAlertError('o/r: code scanning: GitHub API error: 500'))
  })
})
