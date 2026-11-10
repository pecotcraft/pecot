// createDependabotSource のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 例外を結果の種類に直す分類と、domain/dependabot.ts の fetchDependabotAlertStatus につないだときの結果を確かめる。
// 対応する Python のテストは cli/tests/core/test_dependabot.py の domain 側と、test_github.py の Dependabot の 5 件。
// 後者は repos.test.ts に置いた。
import { describe, expect, it } from 'vitest'

import { DependabotAlertError, fetchDependabotAlertStatus } from '../../../domain/dependabot.js'
import { httpQueryOutput } from '../../../tests/_helpers/python-output.js'
import { createDependabotSource } from '../dependabot-source.js'
import { rejection, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

const ALERTS = '/repos/owner/repo/dependabot/alerts'
// REST の要求に付くクエリ文字列。Python の httpx が作る形（tests/python-output/http-query.json）
const QUERY = httpQueryOutput()
const ENABLED = '/repos/owner/repo/vulnerability-alerts'

describe('listOpenAlerts', () => {
  it('取得できたら ok と alert の一覧', async () => {
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 200, body: [{ number: 1 }, { number: 2 }] })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({ kind: 'ok', value: [{ number: 1 }, { number: 2 }] })
  })

  it('403（レート制限ではない）は forbidden で、状態コード・本文・文言を持つ', async () => {
    const body = '{"message":"Dependabot alerts are disabled for this repository."}'
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 403, text: body })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({
      kind: 'forbidden',
      failure: { message: 'access denied', statusCode: 403, responseBody: body },
    })
  })

  it('レート制限の 403 は rateLimited', async () => {
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 403, text: 'API rate limit exceeded' })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({
      kind: 'rateLimited',
      failure: { message: 'API rate limit reached', statusCode: 403, responseBody: 'API rate limit exceeded' },
    })
  })

  it.each([
    [401, 'authentication failed: check the token'],
    [500, 'GitHub API error: 500'],
  ])('%i は failure', async (status, message) => {
    const { client } = await startClient([restResponse('GET', ALERTS, { status, text: 'x' })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({
      kind: 'failure',
      failure: { message, statusCode: status, responseBody: 'x' },
    })
  })

  it('404 は failure で、文言に要求した URL を含む', async () => {
    const { client, server } = await startClient([restResponse('GET', ALERTS, { status: 404, text: 'x' })])
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({
      kind: 'failure',
      failure: { message: `resource not found: ${server.url}${ALERTS}${QUERY}`, statusCode: 404, responseBody: 'x' },
    })
  })

  it('接続できなければ network で、Python の errno の文を持つ', async () => {
    const { client, server } = await startClient([])
    await server.close()
    expect(await createDependabotSource(client).listOpenAlerts('owner', 'repo')).toEqual({ kind: 'network', message: '[Errno 111] Connection refused' })
  })

  it('応答が JSON でなければ、分類せずに例外のまま投げる', async () => {
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 200, text: 'not json' })])
    expect(await rejection(createDependabotSource(client).listOpenAlerts('owner', 'repo'))).toBeInstanceOf(Error)
  })
})

describe('isAlertsEnabled', () => {
  it.each([[204, true], [404, false]])('%i は ok と %s', async (status, expected) => {
    const { client } = await startClient([restResponse('GET', ENABLED, { status, text: '' })])
    expect(await createDependabotSource(client).isAlertsEnabled('owner', 'repo')).toEqual({ kind: 'ok', value: expected })
  })

  it('403 は forbidden', async () => {
    const { client } = await startClient([restResponse('GET', ENABLED, { status: 403, text: 'forbidden' })])
    expect(await createDependabotSource(client).isAlertsEnabled('owner', 'repo')).toEqual({
      kind: 'forbidden',
      failure: { message: 'access denied', statusCode: 403, responseBody: 'forbidden' },
    })
  })

  it('204・404 以外は failure', async () => {
    const { client } = await startClient([restResponse('GET', ENABLED, { status: 502, text: 'bad gateway' })])
    expect(await createDependabotSource(client).isAlertsEnabled('owner', 'repo')).toEqual({
      kind: 'failure',
      failure: { message: 'GitHub API error: 502', statusCode: 502, responseBody: 'bad gateway' },
    })
  })

  it('接続できなければ network', async () => {
    const { client, server } = await startClient([])
    await server.close()
    expect(await createDependabotSource(client).isAlertsEnabled('owner', 'repo')).toEqual({ kind: 'network', message: '[Errno 111] Connection refused' })
  })
})

function alert(severity: string): unknown {
  return { security_vulnerability: { severity } }
}

describe('fetchDependabotAlertStatus につないだとき', () => {
  it('一覧が取れれば有効で、件数と重さが最大の severity を返す', async () => {
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 200, body: [alert('low'), alert('critical'), alert('high')] })])
    expect(await fetchDependabotAlertStatus(createDependabotSource(client), 'github.com', 'owner', 'repo')).toEqual({
      enabled: true,
      openCount: 3,
      maxSeverity: 'critical',
      alertsUrl: 'https://github.com/owner/repo/security/dependabot',
    })
  })

  it('一覧が 403 で vulnerability-alerts が 404 なら、無効', async () => {
    const { client } = await startClient([
      restResponse('GET', ALERTS, { status: 403, text: '{"message":"disabled"}' }),
      restResponse('GET', ENABLED, { status: 404, text: '' }),
    ])
    expect(await fetchDependabotAlertStatus(createDependabotSource(client), 'ghes.example.com', 'owner', 'repo')).toEqual({
      enabled: false,
      openCount: 0,
      maxSeverity: undefined,
      alertsUrl: 'https://ghes.example.com/owner/repo/security/dependabot',
    })
  })

  it('一覧が 403 で vulnerability-alerts が 204 なら、権限不足の DependabotAlertError', async () => {
    const { client } = await startClient([
      restResponse('GET', ALERTS, { status: 403, text: '{"message":"denied"}' }),
      restResponse('GET', ENABLED, { status: 204, text: '' }),
    ])
    const error = await rejection(fetchDependabotAlertStatus(createDependabotSource(client), 'github.com', 'owner', 'repo'))
    expect(error).toBeInstanceOf(DependabotAlertError)
    expect(error).toMatchObject({ message: 'owner/repo: Dependabot alerts are enabled but the list cannot be fetched (permission may be missing)' })
  })

  it('レート制限は分類せず DependabotAlertError にする（本文の message を添える）', async () => {
    const { client } = await startClient([restResponse('GET', ALERTS, { status: 403, text: '{"message":"API rate limit exceeded"}' })])
    const source = createDependabotSource(client)
    expect(await rejection(fetchDependabotAlertStatus(source, 'github.com', 'owner', 'repo'))).toMatchObject({
      message: 'owner/repo: API rate limit reached API rate limit exceeded',
    })
  })

  it('通信の失敗は「通信に失敗しました」', async () => {
    const { client, server } = await startClient([])
    await server.close()
    const source = createDependabotSource(client)
    expect(await rejection(fetchDependabotAlertStatus(source, 'github.com', 'owner', 'repo'))).toMatchObject({
      message: 'owner/repo: request failed: [Errno 111] Connection refused',
    })
  })
})
