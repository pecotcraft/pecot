// createDependabotSource のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 例外を結果の種類に直す分類と、domain/dependabot.ts の fetchDependabotAlertStatus につないだときの結果を確かめる。
// 対応する Python のテストは cli/tests/core/test_dependabot.py の domain 側と、test_github.py の Dependabot の 5 件。
// 後者は repos.test.ts に置いた。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'

import { DependabotAlertError, fetchDependabotAlertStatus } from '../../../domain/dependabot.js'
import { httpQueryOutput } from '../../../../tests/_helpers/python-output.js'
import { createDependabotSource } from '../dependabot-source.js'
import { rejection, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

const ALERTS = '/repos/owner/repo/dependabot/alerts'
// REST の要求に付くクエリ文字列。Python の httpx が作る形（tests/python-output/http-query.json）
const QUERY = httpQueryOutput()
const ENABLED = '/repos/owner/repo/vulnerability-alerts'

describe('listOpenAlerts', () => {
  it('取得に成功した場合は、ok と alert の一覧を返す', async () => {
    await explains('Dependabot の alert の一覧を取得する関数のテストです。取得に成功した場合は、`ok` と alert の一覧を返すことを確認します。')
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 200, body: [{ number: 1 }, { number: 2 }] })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({ kind: 'ok', value: [{ number: 1 }, { number: 2 }] })
  })

  it('403（レート制限ではない）は forbidden に分類し、状態コード・本文・メッセージを持たせる', async () => {
    await explains('Dependabot の alert の一覧を取得する関数のテストです。レート制限ではない 403 が返った場合に、`forbidden` に分類し、状態コード・本文・メッセージ `access denied` を持つことを確認します。')
    const body = '{"message":"Dependabot alerts are disabled for this repository."}'
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 403, text: body })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({
      kind: 'forbidden',
      failure: { message: 'access denied', statusCode: 403, responseBody: body },
    })
  })

  it('レート制限の 403 は、rateLimited に分類する', async () => {
    await explains('Dependabot の alert の一覧を取得する関数のテストです。レート制限の 403 が返った場合に、`rateLimited` に分類することを確認します。')
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 403, text: 'API rate limit exceeded' })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({
      kind: 'rateLimited',
      failure: { message: 'API rate limit reached', statusCode: 403, responseBody: 'API rate limit exceeded' },
    })
  })

  it.each([
    [401, 'authentication failed: check the token'],
    [500, 'GitHub API error: 500'],
  ])('%i は、failure に分類する', async (status, message) => {
    await explains('Dependabot の alert の一覧を取得する関数のテストです。401 と 500 が返った場合に、`failure` に分類し、状態コードと本文、状態ごとのメッセージを持つことを確認します。')
    const { client } = await startClient([restResponse('GET', ALERTS, { status, text: 'x' })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({
      kind: 'failure',
      failure: { message, statusCode: status, responseBody: 'x' },
    })
  })

  it('404 は failure に分類し、メッセージに要求した URL を含める', async () => {
    await explains('Dependabot の alert の一覧を取得する関数のテストです。404 が返った場合に、`failure` に分類し、メッセージに要求した URL を含めることを確認します。')
    const { client, server } = await startClient([restResponse('GET', ALERTS, { status: 404, text: 'x' })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({
      kind: 'failure',
      failure: { message: `resource not found: ${server.url}${ALERTS}${QUERY}`, statusCode: 404, responseBody: 'x' },
    })
  })

  it('接続できない場合は、network に分類し、Python の errno と同じ文を持たせる', async () => {
    await explains('Dependabot の alert の一覧を取得する関数のテストです。接続できない場合に、`network` に分類し、Python の errno と同じ文（`[Errno 111] Connection refused`）を持つことを確認します。')
    const { client, server } = await startClient([])
    await server.close()
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({ kind: 'network', message: '[Errno 111] Connection refused' })
  })

  it('応答が JSON でない場合は、分類せずに例外をそのまま発生させる', async () => {
    await explains('Dependabot の alert の一覧を取得する関数のテストです。応答が JSON でない場合に、結果の種類に分類せず、例外をそのまま発生させることを確認します。')
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 200, text: 'not json' })])
    expect(await rejection(createDependabotSource(client).listOpenAlerts('owner', 'repo'))).toBeInstanceOf(Error)
  })
})

describe('isAlertsEnabled', () => {
  it.each([[204, true], [404, false]])('%i の場合は、ok と %s を返す', async (status, expected) => {
    await explains('Dependabot alerts が有効かを調べる関数のテストです。204 の場合は有効、404 の場合は無効として、`ok` と真偽値を返すことを確認します。')
    const { client } = await startClient([restResponse('GET', ENABLED, { status, text: '' })])
    expect(await createDependabotSource(client).isAlertsEnabled('owner', 'repo')).toEqual({ kind: 'ok', value: expected })
  })

  it('403 は、forbidden に分類する', async () => {
    await explains('Dependabot alerts が有効かを調べる関数のテストです。403 が返った場合に、`forbidden` に分類することを確認します。')
    const { client } = await startClient([restResponse('GET', ENABLED, { status: 403, text: 'forbidden' })])
    expect(await createDependabotSource(client).isAlertsEnabled('owner', 'repo')).toEqual({
      kind: 'forbidden',
      failure: { message: 'access denied', statusCode: 403, responseBody: 'forbidden' },
    })
  })

  it('204・404 以外の状態コードは、failure に分類する', async () => {
    await explains('Dependabot alerts が有効かを調べる関数のテストです。204 と 404 以外の状態コード（502 など）が返った場合に、`failure` に分類することを確認します。')
    const { client } = await startClient([restResponse('GET', ENABLED, { status: 502, text: 'bad gateway' })])
    expect(await createDependabotSource(client).isAlertsEnabled('owner', 'repo')).toEqual({
      kind: 'failure',
      failure: { message: 'GitHub API error: 502', statusCode: 502, responseBody: 'bad gateway' },
    })
  })

  it('接続できない場合は、network に分類する', async () => {
    await explains('Dependabot alerts が有効かを調べる関数のテストです。接続できない場合に、`network` に分類することを確認します。')
    const { client, server } = await startClient([])
    await server.close()
    expect(await createDependabotSource(client).isAlertsEnabled('owner', 'repo')).toEqual({ kind: 'network', message: '[Errno 111] Connection refused' })
  })
})

function alert(severity: string): unknown {
  return { security_vulnerability: { severity } }
}

describe('fetchDependabotAlertStatus につないだとき', () => {
  it('一覧を取得できた場合は有効とし、件数と最大の severity を返す', async () => {
    await explains('`fetchDependabotAlertStatus` に接続したときのテストです。alert の一覧を取得できた場合に、有効として、件数と深刻度が最大の severity を返すことを確認します。')
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 200, body: [alert('low'), alert('critical'), alert('high')] })])
    expect(await fetchDependabotAlertStatus(createDependabotSource(client), 'github.com', 'owner', 'repo')).toEqual({
      enabled: true,
      openCount: 3,
      maxSeverity: 'critical',
      alertsUrl: 'https://github.com/owner/repo/security/dependabot',
      openAlerts: [],
    })
  })

  it('一覧が 403 で vulnerability-alerts が 404 の場合は、無効として返す', async () => {
    await explains('`fetchDependabotAlertStatus` に接続したときのテストです。一覧が 403 で `vulnerability-alerts` が 404 の場合に、Dependabot alerts を無効として返すことを確認します。')
    const { client } = await startClient([
      restResponse('GET', ALERTS, { status: 403, text: '{"message":"disabled"}' }),
      restResponse('GET', ENABLED, { status: 404, text: '' }),
    ])
    expect(await fetchDependabotAlertStatus(createDependabotSource(client), 'ghes.example.com', 'owner', 'repo')).toEqual({
      enabled: false,
      openCount: 0,
      maxSeverity: undefined,
      alertsUrl: 'https://ghes.example.com/owner/repo/security/dependabot',
      openAlerts: [],
    })
  })

  it('一覧が 403 で vulnerability-alerts が 204 の場合は、権限不足を示す DependabotAlertError が発生する', async () => {
    await explains('`fetchDependabotAlertStatus` に接続したときのテストです。一覧が 403 で `vulnerability-alerts` が 204 の場合に、権限不足を示す `DependabotAlertError` が発生することを確認します。')
    const { client } = await startClient([
      restResponse('GET', ALERTS, { status: 403, text: '{"message":"denied"}' }),
      restResponse('GET', ENABLED, { status: 204, text: '' }),
    ])
    const error = await rejection(fetchDependabotAlertStatus(createDependabotSource(client), 'github.com', 'owner', 'repo'))
    expect(error).toBeInstanceOf(DependabotAlertError)
    expect(error).toMatchObject({ message: 'owner/repo: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)' })
  })

  it('レート制限の場合は、分類せずに DependabotAlertError が発生し、本文の message をメッセージに含める', async () => {
    await explains('`fetchDependabotAlertStatus` に接続したときのテストです。レート制限の場合に、分類せずに `DependabotAlertError` が発生し、本文の `message` がメッセージに含まれることを確認します。')
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 403, text: '{"message":"API rate limit exceeded"}' })])
    const source = createDependabotSource(client)
    expect(await rejection(fetchDependabotAlertStatus(source, 'github.com', 'owner', 'repo'))).toMatchObject({
      message: 'owner/repo: API rate limit reached API rate limit exceeded',
    })
  })

  it('通信に失敗した場合は、request failed を含むメッセージの DependabotAlertError が発生する', async () => {
    await explains('`fetchDependabotAlertStatus` に接続したときのテストです。通信に失敗した場合は、`request failed:` を含むメッセージの `DependabotAlertError` が発生することを確認します。')
    const { client, server } = await startClient([])
    await server.close()
    const source = createDependabotSource(client)
    expect(await rejection(fetchDependabotAlertStatus(source, 'github.com', 'owner', 'repo'))).toMatchObject({
      message: 'owner/repo: request failed: [Errno 111] Connection refused',
    })
  })
})
