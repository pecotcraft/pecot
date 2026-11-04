import { describe, expect, it } from 'vitest'

import type { DependabotAlert, DependabotFailure, DependabotResult, DependabotSource } from '../dependabot-source.js'
import { DependabotAlertError, fetchDependabotAlertStatus } from '../dependabot.js'
import type { DependabotAlertStatus } from '../dependabot.js'
import { PecotError } from '../errors.js'
import type { JsonValue } from '../python-format.js'

const URL = 'https://ghes.example.com/owner/repo/security/dependabot'

function alert(severity: JsonValue): DependabotAlert {
  return { number: 1, security_advisory: { severity: 'low' }, security_vulnerability: { severity } }
}

/**
severity が JSON の null の alert
*/
function alertWithNullSeverity(): DependabotAlert {
  // eslint-disable-next-line no-restricted-syntax -- JSON.parse の結果は定義上 JsonValue
  return JSON.parse('{"number":3,"security_vulnerability":{"severity":null}}') as JsonValue
}

type AlertList = DependabotResult<readonly DependabotAlert[]>

function ok(alerts: readonly DependabotAlert[]): AlertList {
  return { kind: 'ok', value: alerts }
}

const FORBIDDEN: DependabotFailure = {
  message: 'アクセスが拒否されました。',
  statusCode: 403,
  responseBody: '{"message":"Dependabot alerts are disabled for this repository."}\nextra',
}

const FORBIDDEN_RESULT: DependabotResult<never> = { kind: 'forbidden', failure: FORBIDDEN }

const RATE_LIMITED: DependabotFailure = { message: 'APIレート制限に達しました。', statusCode: 403, responseBody: 'rate limit' }

interface FakeSource {
  readonly source: DependabotSource
  readonly enabledCalls: readonly (readonly [string, string])[]
}

/**
DependabotSource のメモリ上の実装。一覧と有効判定の結果をそのまま返す。
enabled を渡さないときに有効判定が呼ばれたら、テストを失敗させる
*/
function fakeSource(alerts: AlertList, enabled?: DependabotResult<boolean>): FakeSource {
  const enabledCalls: (readonly [string, string])[] = []
  const source: DependabotSource = {
    listOpenAlerts: () => Promise.resolve(alerts),
    isAlertsEnabled: (owner, repository) => {
      enabledCalls.push([owner, repository])
      return enabled === undefined ? Promise.reject(new Error('isAlertsEnabled を呼んではならない')) : Promise.resolve(enabled)
    },
  }
  return { source, enabledCalls }
}

/**
severity だけを持つ alert を返す取得元
*/
function sourceWithSeverities(...severities: readonly JsonValue[]): FakeSource {
  return fakeSource(ok(severities.map(severity => alert(severity))))
}

async function fetchStatus(fake: FakeSource): Promise<DependabotAlertStatus> {
  return fetchDependabotAlertStatus(fake.source, 'ghes.example.com', 'owner', 'repo')
}

async function fetchError(fake: FakeSource): Promise<unknown> {
  try {
    await fetchStatus(fake)
  }
  catch (error: unknown) {
    return error
  }
  return undefined
}

async function messageForFailure(failure: DependabotFailure): Promise<string | undefined> {
  const fake = fakeSource({ kind: 'failure', failure })
  const error = await fetchError(fake)
  expect(fake.enabledCalls).toStrictEqual([])
  expect(error).toBeInstanceOf(DependabotAlertError)
  return error instanceof Error ? error.message : undefined
}

describe('DependabotAlertError', () => {
  it('PecotError を継承する', () => {
    expect(new DependabotAlertError('x')).toBeInstanceOf(PecotError)
  })
})

describe('open な alert がある', () => {
  it('最高 severity は critical。有効判定は呼ばない', async () => {
    const fake = sourceWithSeverities('low', 'critical', 'high', 'medium')
    expect(await fetchStatus(fake)).toStrictEqual({ enabled: true, openCount: 4, maxSeverity: 'critical', alertsUrl: URL })
    expect(fake.enabledCalls).toStrictEqual([])
  })

  it('未知の severity は落とさず、順位 -1 として扱う', async () => {
    const status = await fetchStatus(sourceWithSeverities('moderate', 'medium', 'weird'))
    expect(status.openCount).toBe(3)
    expect(status.maxSeverity).toBe('medium')
  })

  it('未知か欠落だけなら、先に現れた未知の値になる（同順位は先勝ち）', async () => {
    const alerts = [alert('moderate'), { number: 2 }, alertWithNullSeverity()]
    const status = await fetchStatus(fakeSource(ok(alerts)))
    expect(status.openCount).toBe(3)
    expect(status.maxSeverity).toBe('moderate')
  })

  it('同順位は先勝ち', async () => {
    const unknown = await fetchStatus(sourceWithSeverities('weird', 'moderate'))
    expect(unknown.maxSeverity).toBe('weird')
    const known = await fetchStatus(sourceWithSeverities('high', 'high'))
    expect(known.maxSeverity).toBe('high')
  })

  it('security_vulnerability がオブジェクトでない alert は severity に数えない', async () => {
    const alerts = ['x', { security_vulnerability: 'y' }, [], alert('low')]
    const status = await fetchStatus(fakeSource(ok(alerts)))
    expect(status.openCount).toBe(4)
    expect(status.maxSeverity).toBe('low')
  })

  it('0 件なら enabled=true で maxSeverity なし', async () => {
    const status = await fetchStatus(fakeSource(ok([])))
    expect(status).toStrictEqual({ enabled: true, openCount: 0, maxSeverity: undefined, alertsUrl: URL })
  })

  it('alertsUrl は host・owner・repository から作る', async () => {
    const status = await fetchDependabotAlertStatus(fakeSource(ok([])).source, 'ghe.example.com', 'org', 'proj')
    expect(status.alertsUrl).toBe('https://ghe.example.com/org/proj/security/dependabot')
  })
})

describe('一覧が 403', () => {
  it('vulnerability-alerts が 404 なら無効', async () => {
    const fake = fakeSource(FORBIDDEN_RESULT, { kind: 'ok', value: false })
    const status = await fetchStatus(fake)
    expect(status).toStrictEqual({ enabled: false, openCount: 0, maxSeverity: undefined, alertsUrl: URL })
    expect(fake.enabledCalls).toStrictEqual([['owner', 'repo']])
  })

  it('有効なのに一覧が取れなければエラー（権限不足の可能性）', async () => {
    const error = await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'ok', value: true }))
    expect(error).toBeInstanceOf(DependabotAlertError)
    expect(error).toHaveProperty('message', 'owner/repo: Dependabot alerts は有効ですが一覧を取得できません（権限不足の可能性）')
  })

  it('有効判定が失敗したら、応答本文の message を添えたエラー', async () => {
    const failure: DependabotFailure = { message: 'GitHub APIエラー: 500', statusCode: 500, responseBody: '{"message":"boom"}' }
    const error = await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'failure', failure }))
    expect(error).toHaveProperty('message', 'owner/repo: GitHub APIエラー: 500 boom')
  })

  it('有効判定も 403 なら API エラーとして包む', async () => {
    const failure: DependabotFailure = { ...FORBIDDEN, responseBody: '{"message":"Resource not accessible"}' }
    const error = await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'forbidden', failure }))
    expect(error).toHaveProperty('message', 'owner/repo: アクセスが拒否されました。 Resource not accessible')
  })

  it('有効判定がレート制限ならエラー', async () => {
    const error = await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'rateLimited', failure: RATE_LIMITED }))
    expect(error).toHaveProperty('message', 'owner/repo: APIレート制限に達しました。')
  })

  it('一覧のレート制限は分類せずエラー（有効判定を呼ばない）', async () => {
    const fake = fakeSource({ kind: 'rateLimited', failure: RATE_LIMITED })
    const error = await fetchError(fake)
    expect(error).toBeInstanceOf(DependabotAlertError)
    expect(error).toHaveProperty('message', expect.stringContaining('レート制限'))
    expect(fake.enabledCalls).toStrictEqual([])
  })

  it('有効判定の通信失敗は「通信に失敗しました」', async () => {
    const error = await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'network', message: 'down' }))
    expect(error).toHaveProperty('message', 'owner/repo: 通信に失敗しました: down')
  })
})

describe('エラー', () => {
  it('JSON の本文は message だけを添える', async () => {
    const body = '{"message":"Server Error","documentation_url":"https://docs"}'
    expect(await messageForFailure({ message: 'GitHub APIエラー: 500', statusCode: 500, responseBody: body })).toBe('owner/repo: GitHub APIエラー: 500 Server Error')
  })

  it('message は前後の空白を落として添える', async () => {
    expect(await messageForFailure({ message: 'm', statusCode: 500, responseBody: '{"message":"  x \\n"}' })).toBe('owner/repo: m x')
  })

  it('HTML の本文は何も添えない', async () => {
    const failure: DependabotFailure = { message: 'GitHub APIエラー: 502', statusCode: 502, responseBody: '<html><body>Bad Gateway</body></html>' }
    expect(await messageForFailure(failure)).toBe('owner/repo: GitHub APIエラー: 502')
  })

  it('本文が無ければ何も添えない', async () => {
    expect(await messageForFailure({ message: 'リソースが見つかりません', statusCode: 404, responseBody: undefined })).toBe('owner/repo: リソースが見つかりません')
  })

  it.each([
    ['オブジェクトでない JSON', '[1]'],
    ['message が無い', '{"a":1}'],
    ['message が文字列でない', '{"message":3}'],
    ['message が空白だけ', '{"message":"  "}'],
    ['本文の後ろに余計な文字（JSON として不正）', '{"message":"x"}\nextra'],
    ['空文字列', ''],
  ])('%s なら何も添えない', async (_name, body) => {
    expect(await messageForFailure({ message: 'm', statusCode: 500, responseBody: body })).toBe('owner/repo: m')
  })

  it('通信の失敗は「通信に失敗しました」に包む', async () => {
    const error = await fetchError(fakeSource({ kind: 'network', message: 'connection refused' }))
    expect(error).toBeInstanceOf(DependabotAlertError)
    expect(error).toHaveProperty('message', 'owner/repo: 通信に失敗しました: connection refused')
  })
})
