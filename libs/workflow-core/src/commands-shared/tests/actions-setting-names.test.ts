import { describe, expect, it } from 'vitest'

import { step, stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { restResponse, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { readSettingNames } from '../actions-setting-names.js'

useFakeGithub()

const REPOSITORY = '/repos/owner/repo'

describe('readSettingNames', () => {
  it('持ち主が User なら、リポの secret と variable の名前だけを読む', async () => {
    await explains('リポの secret と variable の名前を読む `readSettingNames` のテストです。持ち主が `User` の場合に、リポの一覧だけを読み、organization の一覧を要求せず、`complete` が true になることを確認します。')
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([
      restResponse('GET', REPOSITORY, { status: 200, body: { owner: { type: 'User' } } }),
      restResponse('GET', `${REPOSITORY}/actions/secrets`, { status: 200, body: { total_count: 1, secrets: [{ name: 'S1' }] } }),
      restResponse('GET', `${REPOSITORY}/actions/variables`, { status: 200, body: { total_count: 1, variables: [{ name: 'V1', value: 'x' }] } }),
    ]))
    const names = await step('設定の名前を読む', async () => await readSettingNames(client, 'owner', 'repo'))
    stepSync('結果を確認する', () => {
      expect(names).toEqual({ secrets: { names: new Set(['S1']), complete: true }, variables: { names: new Set(['V1']), complete: true } })
    })
  })

  it('持ち主が Organization なら、organization の secret と variable の名前も合わせる', async () => {
    await explains('`readSettingNames` のテストです。持ち主が `Organization` の場合に、リポと organization の一覧の名前を合わせて返すことを確認します。')
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([
      restResponse('GET', REPOSITORY, { status: 200, body: { owner: { type: 'Organization' } } }),
      restResponse('GET', `${REPOSITORY}/actions/secrets`, { status: 200, body: { total_count: 1, secrets: [{ name: 'S1' }] } }),
      restResponse('GET', `${REPOSITORY}/actions/organization-secrets`, { status: 200, body: { total_count: 1, secrets: [{ name: 'OS1' }] } }),
      restResponse('GET', `${REPOSITORY}/actions/variables`, { status: 200, body: { total_count: 1, variables: [{ name: 'V1', value: 'x' }] } }),
      restResponse('GET', `${REPOSITORY}/actions/organization-variables`, { status: 200, body: { total_count: 1, variables: [{ name: 'OV1', value: 'x' }] } }),
    ]))
    const names = await step('設定の名前を読む', async () => await readSettingNames(client, 'owner', 'repo'))
    stepSync('結果を確認する', () => {
      expect(names).toEqual({ secrets: { names: new Set(['S1', 'OS1']), complete: true }, variables: { names: new Set(['V1', 'OV1']), complete: true } })
    })
  })

  it('読めない一覧が 1 つでもあれば、その種類の complete を false にして、読めた名前は残す', async () => {
    await explains('`readSettingNames` のテストです。organization の secret の一覧が 403 で読めない場合に、secret の `complete` だけが false になり、読めたリポの名前が残ることを確認します。')
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([
      restResponse('GET', REPOSITORY, { status: 200, body: { owner: { type: 'Organization' } } }),
      restResponse('GET', `${REPOSITORY}/actions/secrets`, { status: 200, body: { total_count: 1, secrets: [{ name: 'S1' }] } }),
      restResponse('GET', `${REPOSITORY}/actions/organization-secrets`, { status: 403, text: 'Forbidden' }),
      restResponse('GET', `${REPOSITORY}/actions/variables`, { status: 200, body: { total_count: 0, variables: [] } }),
      restResponse('GET', `${REPOSITORY}/actions/organization-variables`, { status: 200, body: { total_count: 0, variables: [] } }),
    ]))
    const names = await step('設定の名前を読む', async () => await readSettingNames(client, 'owner', 'repo'))
    stepSync('結果を確認する', () => {
      expect(names).toEqual({ secrets: { names: new Set(['S1']), complete: false }, variables: { names: new Set(), complete: true } })
    })
  })
})
