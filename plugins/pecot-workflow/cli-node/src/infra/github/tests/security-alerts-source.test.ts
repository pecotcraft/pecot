// createScanAlertSource のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_security_alerts.py の list_open_alerts と preflight の判定。
import { describe, expect, it } from 'vitest'

import { fetchCodeScanningStatus, fetchSecretScanningStatus } from '../../../domain/security-alerts.js'
import { createScanAlertSource } from '../security-alerts-source.js'
import { restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

const CODE = '/repos/owner/repo/code-scanning/alerts'
const SECRET = '/repos/owner/repo/secret-scanning/alerts'
const REPOSITORY = '/repos/owner/repo'

describe('code scanning', () => {
  it('取得できたら件数と、整数の番号だけを返す', async () => {
    const { client } = await startClient([restResponse('GET', CODE, { status: 200, body: [{ number: 3 }, { number: 'x' }, {}, 5] })])
    expect(await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo')).toEqual({ kind: 'ok', count: 4, numbers: [3] })
  })

  it.each([
    ['Advanced Security must be enabled for this repository to use code scanning.'],
    ['Code scanning is not enabled for this repository'],
  ])('403 で本文が %j なら disabled', async (message) => {
    const { client } = await startClient([restResponse('GET', CODE, { status: 403, text: JSON.stringify({ message }) })])
    expect(await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo')).toEqual({ kind: 'disabled' })
  })

  it('403 で本文が無効を示さない（権限不足）なら failure', async () => {
    const { client } = await startClient([restResponse('GET', CODE, { status: 403, text: '{"message":"Resource not accessible by integration"}' })])
    expect(await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo')).toEqual({
      kind: 'failure',
      message: 'access denied Resource not accessible by integration',
    })
  })

  it('レート制限の 403 は、本文が not enabled を含んでも failure', async () => {
    const { client } = await startClient([restResponse('GET', CODE, { status: 403, text: 'API rate limit exceeded: not enabled' })])
    expect(await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo')).toMatchObject({ kind: 'failure' })
  })

  it('404 で本文が no analysis found なら、alert 0 件の ok', async () => {
    const { client } = await startClient([restResponse('GET', CODE, { status: 404, text: '{"message":"No analysis found"}' })])
    expect(await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo')).toEqual({ kind: 'ok', count: 0, numbers: [] })
  })

  it('404 で本文が別の文なら failure', async () => {
    const { client } = await startClient([restResponse('GET', CODE, { status: 404, text: '{"message":"Not Found"}' })])
    expect(await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo')).toMatchObject({ kind: 'failure' })
  })

  it('接続できなければ network', async () => {
    const { client, server } = await startClient([])
    await server.close()
    expect(await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo')).toMatchObject({ kind: 'network' })
  })
})

describe('secret scanning', () => {
  it('取得できたら件数と番号を返す', async () => {
    const { client } = await startClient([restResponse('GET', SECRET, { status: 200, body: [{ number: 9 }] })])
    expect(await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo')).toEqual({ kind: 'ok', count: 1, numbers: [9] })
  })

  it('404 でリポの状態が disabled なら disabled', async () => {
    const { client, server } = await startClient([
      restResponse('GET', SECRET, { status: 404, text: 'x' }),
      restResponse('GET', REPOSITORY, { status: 200, body: { security_and_analysis: { secret_scanning: { status: 'disabled' } } } }),
    ])
    expect(await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo')).toEqual({ kind: 'disabled' })
    expect(restRequests(server).map(({ path }) => path)).toEqual([SECRET, REPOSITORY])
  })

  it.each([
    ['enabled', { security_and_analysis: { secret_scanning: { status: 'enabled' } } }],
    ['状態が載っていない', {}],
  ])('404 でリポの状態が %s なら unconfirmed', async (_name, body) => {
    const { client } = await startClient([restResponse('GET', SECRET, { status: 404, text: 'x' }), restResponse('GET', REPOSITORY, { status: 200, body })])
    expect(await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo')).toEqual({ kind: 'unconfirmed' })
  })

  it('404 の後にリポの状態を読めなければ、その失敗を failure にする', async () => {
    const { client } = await startClient([restResponse('GET', SECRET, { status: 404, text: 'x' }), restResponse('GET', REPOSITORY, { status: 500, text: 'boom' })])
    expect(await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo')).toEqual({ kind: 'failure', message: 'GitHub API error: 500' })
  })

  it('404 以外の失敗は、リポの状態を読まずに failure', async () => {
    const { client, server } = await startClient([restResponse('GET', SECRET, { status: 403, text: 'x' })])
    expect(await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo')).toMatchObject({ kind: 'failure' })
    expect(restRequests(server)).toHaveLength(1)
  })
})

describe('domain の判定につないだとき', () => {
  it('code scanning の open の alert を、番号の昇順で数える', async () => {
    const { client } = await startClient([restResponse('GET', CODE, { status: 200, body: [{ number: 12 }, { number: 4 }] })])
    expect(await fetchCodeScanningStatus(createScanAlertSource(client), 'github.com', 'owner', 'repo')).toMatchObject({ enabled: true, openCount: 2, openNumbers: [4, 12] })
  })

  it('secret scanning の 404 が無効と確かめられないなら SecurityAlertError', async () => {
    const { client } = await startClient([restResponse('GET', SECRET, { status: 404, text: 'x' }), restResponse('GET', REPOSITORY, { status: 200, body: {} })])
    await expect(fetchSecretScanningStatus(createScanAlertSource(client), 'github.com', 'owner', 'repo')).rejects.toThrow('owner/repo: cannot fetch the secret scanning list')
  })
})
