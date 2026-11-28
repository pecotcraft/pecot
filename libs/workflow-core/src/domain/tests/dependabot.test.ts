import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../tests/_helpers/step.js'
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
  message: 'access denied',
  statusCode: 403,
  responseBody: '{"message":"Dependabot alerts are disabled for this repository."}\nextra',
}

const FORBIDDEN_RESULT: DependabotResult<never> = { kind: 'forbidden', failure: FORBIDDEN }

const RATE_LIMITED: DependabotFailure = { message: 'API rate limit reached', statusCode: 403, responseBody: 'rate limit' }

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
  it('DependabotAlertError は PecotError を継承する', async () => {
    await explains('Dependabot の alert の取得に失敗したときの例外 `DependabotAlertError` のテストです。`PecotError` を継承していることを確認します。')
    stepSync('結果を比べる', () => {
      expect(new DependabotAlertError('x')).toBeInstanceOf(PecotError)
    })
  })
})

describe('open な alert がある', () => {
  it('open な alert が複数ある場合は、最も高い severity を critical として返し、有効かどうかの判定を呼ばない', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。severity が `low` や `critical` などの open な alert が複数ある場合に、最も高い `critical` を返すことを確認します。')
    const fake = stepSync('`sourceWithSeverities` を呼ぶ', () => sourceWithSeverities('low', 'critical', 'high', 'medium'))

    await step('結果を比べる', async () => {
      expect(await fetchStatus(fake)).toStrictEqual({ enabled: true, openCount: 4, maxSeverity: 'critical', alertsUrl: URL, openAlerts: [{ number: 1, package: undefined, severity: 'low' }, { number: 1, package: undefined, severity: 'critical' }, { number: 1, package: undefined, severity: 'high' }, { number: 1, package: undefined, severity: 'medium' }] })
      expect(fake.enabledCalls).toStrictEqual([])
    })
  })

  it('未知の severity は、エラーにせず最も低い順位として扱う', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。`moderate` や `weird` のように定義にない severity を含む場合に、エラーにせず最も低い順位として扱うことを確認します。')
    const status = await step('`fetchStatus` を呼ぶ', async () => await fetchStatus(sourceWithSeverities('moderate', 'medium', 'weird')))

    stepSync('結果を比べる', () => {
      expect(status.openCount).toBe(3)
      expect(status.maxSeverity).toBe('medium')
    })
  })

  it('severity が未知の値か欠落だけの場合は、先に現れた未知の値を最も高い severity とする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。severity が未知の値、欠落、`null` だけの場合に、先に現れた未知の値（`moderate`）を最も高い severity として返すことを確認します。')
    const { status } = await step('`fetchStatus` を呼ぶ', async () => {
      const alerts = [alert('moderate'), { number: 2 }, alertWithNullSeverity()]
      const status = await fetchStatus(fakeSource(ok(alerts)))
      return { status }
    })

    stepSync('結果を比べる', () => {
      expect(status.openCount).toBe(3)
      expect(status.maxSeverity).toBe('moderate')
    })
  })

  it('順位が同じ severity は、先に現れたものを最も高い severity とする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。未知の値どうし、既知の値どうしのようにseverity の順位が同じ場合に、先に現れたものを最も高い severity として返すことを確認します。')
    const unknown = await step('`fetchStatus` を呼ぶ', async () => await fetchStatus(sourceWithSeverities('weird', 'moderate')))

    stepSync('結果を比べる', () => {
      expect(unknown.maxSeverity).toBe('weird')
    })

    const known = await step('`fetchStatus` を呼ぶ', async () => await fetchStatus(sourceWithSeverities('high', 'high')))

    stepSync('結果を比べる', () => {
      expect(known.maxSeverity).toBe('high')
    })
  })

  it('security_vulnerability がオブジェクトでない alert は、severity の判定に含めない', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。`security_vulnerability` が文字列や配列などオブジェクトでない alert がある場合に、件数には数えるが severity の判定には含めないことを確認します。')
    const { status } = await step('`fetchStatus` を呼ぶ', async () => {
      const alerts = ['x', { security_vulnerability: 'y' }, [], alert('low')]
      const status = await fetchStatus(fakeSource(ok(alerts)))
      return { status }
    })

    stepSync('結果を比べる', () => {
      expect(status.openCount).toBe(4)
      expect(status.maxSeverity).toBe('low')
    })
  })

  it('open な alert が 0 件の場合は、enabled を true、maxSeverity を未設定として返す', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。open な alert が 0 件の場合に、`enabled` が `true`、`maxSeverity` が未設定、`openAlerts` が空の状況を返すことを確認します。')
    const status = await step('`fetchStatus` を呼ぶ', async () => await fetchStatus(fakeSource(ok([]))))

    stepSync('結果を比べる', () => {
      expect(status).toStrictEqual({ enabled: true, openCount: 0, maxSeverity: undefined, alertsUrl: URL, openAlerts: [] })
    })
  })

  it('alertsUrl を host・owner・repository から作成する', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。ホスト名・owner・リポジトリ名の場合に、`alertsUrl` が `https://<host>/<owner>/<repo>/security/dependabot` の形になることを確認します。')
    const status = await step('`fetchDependabotAlertStatus` を呼ぶ', async () => await fetchDependabotAlertStatus(fakeSource(ok([])).source, 'ghe.example.com', 'org', 'proj'))

    stepSync('結果を比べる', () => {
      expect(status.alertsUrl).toBe('https://ghe.example.com/org/proj/security/dependabot')
    })
  })
})

describe('一覧が 403', () => {
  it('alert の一覧が 403 で、vulnerability-alerts が 404 の場合は、無効として返す', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。alert の一覧の取得が 403 で、続けて呼ぶ有効かどうかの判定が「無効」を返す場合に、`enabled` が `false` の状況を返すことを確認します。')
    const { fake, status } = await step('`fetchStatus` を呼ぶ', async () => {
      const fake = fakeSource(FORBIDDEN_RESULT, { kind: 'ok', value: false })
      const status = await fetchStatus(fake)
      return { fake, status }
    })

    stepSync('結果を比べる', () => {
      expect(status).toStrictEqual({ enabled: false, openCount: 0, maxSeverity: undefined, alertsUrl: URL, openAlerts: [] })
      expect(fake.enabledCalls).toStrictEqual([['owner', 'repo']])
    })
  })

  it('Dependabot が有効なのに一覧が取得できない場合は、権限不足の可能性を示すエラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。一覧の取得が 403 で、有効かどうかの判定が「有効」を返す場合に、権限が不足している可能性を示すメッセージで `DependabotAlertError` の例外が発生することを確認します。')
    const error = await step('`fetchError` を呼ぶ', async () => await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'ok', value: true })))

    stepSync('結果を比べる', () => {
      expect(error).toBeInstanceOf(DependabotAlertError)
      expect(error).toHaveProperty('message', 'owner/repo: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)')
    })
  })

  it('有効かどうかの判定が失敗した場合は、応答本文の message を添えたエラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。一覧の取得が 403 で、有効かどうかの判定が失敗した場合に、応答本文の `message` を末尾に添えたメッセージで例外が発生することを確認します。')
    const { error } = await step('`fetchError` を呼ぶ', async () => {
      const failure: DependabotFailure = { message: 'GitHub API error: 500', statusCode: 500, responseBody: '{"message":"boom"}' }
      const error = await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'failure', failure }))
      return { error }
    })

    stepSync('結果を比べる', () => {
      expect(error).toHaveProperty('message', 'owner/repo: GitHub API error: 500 boom')
    })
  })

  it('有効かどうかの判定も 403 の場合は、API のエラーとして例外にする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。一覧の取得も有効かどうかの判定も 403 の場合に、判定の失敗の文と応答本文の `message` をつないだメッセージで例外が発生することを確認します。')
    const { error } = await step('`fetchError` を呼ぶ', async () => {
      const failure: DependabotFailure = { ...FORBIDDEN, responseBody: '{"message":"Resource not accessible"}' }
      const error = await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'forbidden', failure }))
      return { error }
    })

    stepSync('結果を比べる', () => {
      expect(error).toHaveProperty('message', 'owner/repo: access denied Resource not accessible')
    })
  })

  it('有効かどうかの判定がレート制限の場合は、エラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。一覧の取得が 403 で、有効かどうかの判定がレート制限だった場合に、レート制限を示すメッセージで例外が発生することを確認します。')
    const error = await step('`fetchError` を呼ぶ', async () => await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'rateLimited', failure: RATE_LIMITED })))

    stepSync('結果を比べる', () => {
      expect(error).toHaveProperty('message', 'owner/repo: API rate limit reached')
    })
  })

  it('一覧の取得がレート制限の場合は、有効かどうかの判定を呼ばず、エラーとして扱う', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。一覧の取得がレート制限だった場合に、無効や権限不足の分類をせず、有効かどうかの判定も呼ばず、`rate limit` を含むメッセージで例外が発生することを確認します。')
    const { fake, error } = await step('`fetchError` を呼ぶ', async () => {
      const fake = fakeSource({ kind: 'rateLimited', failure: RATE_LIMITED })
      const error = await fetchError(fake)
      return { fake, error }
    })

    stepSync('結果を比べる', () => {
      expect(error).toBeInstanceOf(DependabotAlertError)
      expect(error).toHaveProperty('message', expect.stringContaining('rate limit'))
      expect(fake.enabledCalls).toStrictEqual([])
    })
  })

  it('有効かどうかの判定で通信に失敗した場合は、通信の失敗を示すエラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。一覧の取得が 403 で、有効かどうかの判定で通信が失敗した場合に、`request failed:` と原因を並べたメッセージの例外が発生することを確認します。')
    const error = await step('`fetchError` を呼ぶ', async () => await fetchError(fakeSource(FORBIDDEN_RESULT, { kind: 'network', message: 'down' })))

    stepSync('結果を比べる', () => {
      expect(error).toHaveProperty('message', 'owner/repo: request failed: down')
    })
  })
})

describe('openAlerts', () => {
  it('openAlerts には、番号が整数の alert の番号・パッケージ名・severity を含める', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。番号が整数でない alert を除き、整数の alert から番号・パッケージ名・severity を `openAlerts` に含めることを確認します。')
    const { status } = await step('`fetchStatus` を呼ぶ', async () => {
      const alerts = [
        { number: 3, dependency: { package: { name: 'lodash' } }, security_vulnerability: { severity: 'high' } },
        { number: 4 },
        { number: 'x', dependency: { package: { name: 'skip' } } },
        { number: 1.5 },
        { number: 5, dependency: { package: { name: 1 } }, security_vulnerability: { severity: 7 } },
      ]
      const status = await fetchStatus(fakeSource(ok(alerts)))
      return { status }
    })

    stepSync('結果を比べる', () => {
      expect(status.openCount).toBe(5)
      expect(status.openAlerts).toStrictEqual([
        { number: 3, package: 'lodash', severity: 'high' },
        { number: 4, package: undefined, severity: undefined },
        { number: 5, package: undefined, severity: undefined },
      ])
    })
  })
})

describe('エラー', () => {
  it('応答本文に errors の message がある場合は、それも添えたエラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。失敗の応答本文が JSON で、`message` に加えて `errors` の各 `message` を持つ場合に、それらを順につないだメッセージで例外が発生することを確認します。')
    const body = stepSync('入力を用意する', () => '{"message":"Validation Failed","errors":[{"message":"detail"}]}')

    await step('結果を比べる', async () => {
      expect(await messageForFailure({ message: 'GitHub API error: 422', statusCode: 422, responseBody: body })).toBe('owner/repo: GitHub API error: 422 Validation Failed detail')
    })
  })

  it('応答本文が JSON の場合は、message だけを添えたエラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。失敗の応答本文が JSON の場合に、`documentation_url` などの項目は添えず、`message` だけを添えたメッセージで例外が発生することを確認します。')
    const body = stepSync('入力を用意する', () => '{"message":"Server Error","documentation_url":"https://docs"}')

    await step('結果を比べる', async () => {
      expect(await messageForFailure({ message: 'GitHub API error: 500', statusCode: 500, responseBody: body })).toBe('owner/repo: GitHub API error: 500 Server Error')
    })
  })

  it('応答本文の message は、前後の空白を除いて添える', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。応答本文の `message` の前後に空白や改行がある場合に、それらを除いた文字列を添えたメッセージで例外が発生することを確認します。')
    await step('`messageForFailure` を呼び、結果を比べる', async () => {
      expect(await messageForFailure({ message: 'm', statusCode: 500, responseBody: '{"message":"  x \\n"}' })).toBe('owner/repo: m x')
    })
  })

  it('応答本文が HTML の場合は、本文を添えず、エラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。失敗の応答本文が HTML の場合に、本文を添えず、失敗の文だけのメッセージで例外が発生することを確認します。')
    const failure: DependabotFailure = stepSync('入力を用意する', () => ({ message: 'GitHub API error: 502', statusCode: 502, responseBody: '<html><body>Bad Gateway</body></html>' }))

    await step('結果を比べる', async () => {
      expect(await messageForFailure(failure)).toBe('owner/repo: GitHub API error: 502')
    })
  })

  it('応答本文が存在しない場合は、本文を添えず、エラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。失敗の応答に本文が存在しない場合に、失敗の文だけのメッセージで例外が発生することを確認します。')
    await step('`messageForFailure` を呼び、結果を比べる', async () => {
      expect(await messageForFailure({ message: 'リソースが見つかりません', statusCode: 404, responseBody: undefined })).toBe('owner/repo: リソースが見つかりません')
    })
  })

  it.each([
    ['オブジェクトでない JSON', '[1]'],
    ['message が無い', '{"a":1}'],
    ['message が文字列でない', '{"message":3}'],
    ['message が空白だけ', '{"message":"  "}'],
    ['本文の後ろに余計な文字（JSON として不正）', '{"message":"x"}\nextra'],
    ['空文字列', ''],
  ])('応答本文が「%s」の場合は、本文を添えず、エラーにする', async (_name, body) => {
    await explains(`Dependabot の alert の状況を取得する、\`fetchDependabotAlertStatus\` のテストです。失敗の応答本文が「${_name}」の場合に、本文を添えず、失敗の文だけのメッセージで例外が発生することを確認します。`)
    await step('`messageForFailure` を呼び、結果を比べる', async () => {
      expect(await messageForFailure({ message: 'm', statusCode: 500, responseBody: body })).toBe('owner/repo: m')
    })
  })

  it('一覧の取得で通信に失敗した場合は、通信の失敗を示すエラーにする', async () => {
    await explains('Dependabot の alert の状況を取得する、`fetchDependabotAlertStatus` のテストです。一覧の取得で通信が失敗した場合に、`request failed:` と原因を並べたメッセージの `DependabotAlertError` が発生することを確認します。')
    const error = await step('`fetchError` を呼ぶ', async () => await fetchError(fakeSource({ kind: 'network', message: 'connection refused' })))

    stepSync('結果を比べる', () => {
      expect(error).toBeInstanceOf(DependabotAlertError)
      expect(error).toHaveProperty('message', 'owner/repo: request failed: connection refused')
    })
  })
})
