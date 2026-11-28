// createScanAlertSource のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_security_alerts.py の list_open_alerts と preflight の判定。
import { describe, expect, it } from 'vitest'

import { fetchCodeScanningStatus, fetchSecretScanningStatus } from '../../../domain/security-alerts.js'
import { createScanAlertSource } from '../security-alerts-source.js'
import { restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'
import { explains } from '../../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../../tests/_helpers/step.js'

useFakeGithub()

const CODE = '/repos/owner/repo/code-scanning/alerts'
const SECRET = '/repos/owner/repo/secret-scanning/alerts'
const REPOSITORY = '/repos/owner/repo'

describe('code scanning', () => {
  it('code scanning の alert を取得できた場合は、応答の alert をそのまま返す', async () => {
    await explains('code scanning の alert 一覧を取得する `listOpenAlerts` のテストです。GitHub が 200 を返した場合に、応答の内容を変更せず `ok` として返すことを確認します。')
    const { client } = await step('alert を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', CODE, { status: 200, body: [{ number: 3 }, { number: 'x' }, {}, 5] })]))
    const outcome = await step('code scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toEqual({ kind: 'ok', alerts: [{ number: 3 }, { number: 'x' }, {}, 5] })
    })
  })

  it.each([
    ['Advanced Security must be enabled for this repository to use code scanning.'],
    ['Code scanning is not enabled for this repository'],
  ])('403 で本文が %j の場合は、code scanning が無効であると判定する', async (message) => {
    await explains(`code scanning が無効なリポジトリのテストです。ステータスが 403 で、本文のメッセージが \`${message}\` の場合に、\`disabled\` を返すことを確認します。`)
    const { client } = await step('403 を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', CODE, { status: 403, text: JSON.stringify({ message }) })]))
    const outcome = await step('code scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toEqual({ kind: 'disabled' })
    })
  })

  it('403 で本文が無効を示さない場合（権限不足など）は、失敗として返す', async () => {
    await explains('code scanning の `listOpenAlerts` のテストです。ステータスが 403 で、本文が `Resource not accessible by integration` のように無効を示さない場合に、`failure` とエラーメッセージを返すことを確認します。')
    const { client } = await step('権限不足の 403 を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', CODE, { status: 403, text: '{"message":"Resource not accessible by integration"}' })]))
    const outcome = await step('code scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toEqual({
        kind: 'failure',
        message: 'access denied Resource not accessible by integration',
      })
    })
  })

  it('レート制限による 403 は、本文に not enabled を含んでいても失敗として返す', async () => {
    await explains('code scanning の `listOpenAlerts` のテストです。レート制限による 403 の本文に `not enabled` が含まれる場合でも、`disabled` ではなく `failure` を返すことを確認します。')
    const { client } = await step('レート制限の 403 を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', CODE, { status: 403, text: 'API rate limit exceeded: not enabled' })]))
    const outcome = await step('code scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toMatchObject({ kind: 'failure' })
    })
  })

  it('404 で本文が No analysis found の場合は、alert が 0 件の成功として返す', async () => {
    await explains('code scanning の `listOpenAlerts` のテストです。解析がまだ存在しないリポジトリで 404 が返った場合に、alert が 0 件の `ok` を返すことを確認します。')
    const { client } = await step('解析が無い 404 を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', CODE, { status: 404, text: '{"message":"No analysis found"}' })]))
    const outcome = await step('code scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toEqual({ kind: 'ok', alerts: [] })
    })
  })

  it('404 で本文が別の文の場合は、失敗として返す', async () => {
    await explains('code scanning の `listOpenAlerts` のテストです。404 の本文が `Not Found` のように解析の不在を示さない場合に、`failure` を返すことを確認します。')
    const { client } = await step('Not Found の 404 を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', CODE, { status: 404, text: '{"message":"Not Found"}' })]))
    const outcome = await step('code scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toMatchObject({ kind: 'failure' })
    })
  })

  it('サーバに接続できない場合は、ネットワークの失敗として返す', async () => {
    await explains('code scanning の `listOpenAlerts` のテストです。サーバを停止して接続できない場合に、`network` を返すことを確認します。')
    const { client, server } = await step('偽の GitHub とクライアントを用意する', async () => await startClient([]))
    await step('偽の GitHub を停止する', async () => {
      await server.close()
    })
    const outcome = await step('code scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('code-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toMatchObject({ kind: 'network' })
    })
  })
})

describe('secret scanning', () => {
  it('secret scanning の alert を取得できた場合は、応答の alert を返す', async () => {
    await explains('secret scanning の alert 一覧を取得する `listOpenAlerts` のテストです。GitHub が 200 を返した場合に、応答の alert を `ok` として返すことを確認します。')
    const { client } = await step('alert を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', SECRET, { status: 200, body: [{ number: 9 }] })]))
    const outcome = await step('secret scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toEqual({ kind: 'ok', alerts: [{ number: 9 }] })
    })
  })

  it('404 でリポジトリの secret scanning が無効な場合は、無効として返す', async () => {
    await explains('secret scanning の `listOpenAlerts` のテストです。404 が返り、リポジトリの設定が `disabled` の場合に、`disabled` を返し、2 件の要求を順に送信することを確認します。')
    const { client, server } = await step('404 と無効なリポジトリ設定を返す偽の GitHub とクライアントを用意する', async () => await startClient([
      restResponse('GET', SECRET, { status: 404, text: 'x' }),
      restResponse('GET', REPOSITORY, { status: 200, body: { security_and_analysis: { secret_scanning: { status: 'disabled' } } } }),
    ]))
    const outcome = await step('secret scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo'))
    await step('取得結果と送った要求を比べる', () => {
      expect(outcome).toEqual({ kind: 'disabled' })
      expect(restRequests(server).map(({ path }) => path)).toEqual([SECRET, REPOSITORY])
    })
  })

  it.each([
    ['enabled', { security_and_analysis: { secret_scanning: { status: 'enabled' } } }],
    ['状態が載っていない', {}],
  ])('404 で、リポジトリの状態に関する応答が「%s」の場合は、unconfirmed を返す', async (_name, body) => {
    await explains(`secret scanning の \`listOpenAlerts\` のテストです。404 が返り、リポジトリの応答が「${_name}」の場合に、無効と確認できないため \`unconfirmed\` を返すことを確認します。`)
    const { client } = await step('404 とリポジトリ設定を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', SECRET, { status: 404, text: 'x' }), restResponse('GET', REPOSITORY, { status: 200, body })]))
    const outcome = await step('secret scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toEqual({ kind: 'unconfirmed' })
    })
  })

  it('404 の後にリポジトリの情報を取得できない場合は、その失敗を返す', async () => {
    await explains('secret scanning の `listOpenAlerts` のテストです。404 の後のリポジトリ情報の取得が 500 で失敗した場合に、`GitHub API error: 500` を持つ `failure` を返すことを確認します。')
    const { client } = await step('404 と 500 を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', SECRET, { status: 404, text: 'x' }), restResponse('GET', REPOSITORY, { status: 500, text: 'boom' })]))
    const outcome = await step('secret scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo'))
    await step('取得結果を比べる', () => {
      expect(outcome).toEqual({ kind: 'failure', message: 'GitHub API error: 500' })
    })
  })

  it('404 以外の失敗の場合は、リポジトリの情報を取得せずに失敗として返す', async () => {
    await explains('secret scanning の `listOpenAlerts` のテストです。ステータスが 403 の場合に、`failure` を返し、要求が alert 一覧の 1 回だけであることを確認します。')
    const { client, server } = await step('403 を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', SECRET, { status: 403, text: 'x' })]))
    const outcome = await step('secret scanning の alert を取得する', async () => await createScanAlertSource(client).listOpenAlerts('secret-scanning', 'owner', 'repo'))
    await step('取得結果と要求の数を比べる', () => {
      expect(outcome).toMatchObject({ kind: 'failure' })
      expect(restRequests(server)).toHaveLength(1)
    })
  })
})

describe('domain の判定につないだとき', () => {
  it('code scanning の未解決の alert を、件数と番号の昇順で集計する', async () => {
    await explains('domain 層の `fetchCodeScanningStatus` に実装をつないだテストです。alert が 2 件の場合に、有効で件数が 2、番号が昇順（4 と 12）の状態を返すことを確認します。')
    const { client } = await step('2 件の alert を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', CODE, { status: 200, body: [{ number: 12 }, { number: 4 }] })]))
    const source = stepSync('code scanning の取得元を作る', () => createScanAlertSource(client))
    const status = await step('code scanning の状態を取得する', async () => await fetchCodeScanningStatus(source, 'github.com', 'owner', 'repo'))
    await step('状態を比べる', () => {
      expect(status).toMatchObject({ enabled: true, openCount: 2, openNumbers: [4, 12] })
    })
  })

  it('secret scanning の 404 が無効と確認できない場合は、SecurityAlertError を発生させる', async () => {
    await explains('domain 層の `fetchSecretScanningStatus` に実装をつないだテストです。404 が返りリポジトリの状態からも無効と確認できない場合に、一覧を取得できないことを示す `SecurityAlertError` が発生することを確認します。')
    const { client } = await step('404 と空のリポジトリ設定を返す偽の GitHub とクライアントを用意する', async () => await startClient([restResponse('GET', SECRET, { status: 404, text: 'x' }), restResponse('GET', REPOSITORY, { status: 200, body: {} })]))
    const source = stepSync('secret scanning の取得元を作る', () => createScanAlertSource(client))
    await step('エラーのメッセージを確かめる', async () => {
      await expect(fetchSecretScanningStatus(source, 'github.com', 'owner', 'repo')).rejects.toThrow('owner/repo: cannot fetch the secret scanning list')
    })
  })
})
