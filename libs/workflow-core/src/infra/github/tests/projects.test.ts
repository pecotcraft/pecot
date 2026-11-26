// ProjectsApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// user のクエリが失敗したら organization を試す流れは、GitHub が返す失敗（errors を 200 で返す）で確かめる。
import { describe, expect, it, vi } from 'vitest'
import { explains } from '../../../../tests/_helpers/explains.js'

import type { ProjectFieldValueInput } from '../../../domain/attributes.js'
import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubAPIError, GitHubNotFoundError } from '../errors.js'
import type { ProjectViewBody, ProjectViewTarget } from '../projects.js'
import { failure, graphqlData, graphqlError, graphqlRequests, rejection, restRequests, restResponse, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

function page(nodes: readonly unknown[], hasNextPage: boolean, endCursor: unknown): unknown {
  return { node: { items: { nodes, pageInfo: { hasNextPage, endCursor } } } }
}

// single select の pecot-lane（選択肢 alpha・beta）を持つボードの 1 ページ
function lanePage(endCursor: unknown, hasNextPage: boolean): unknown {
  return { node: { laneField: { options: [{ name: 'alpha' }, { name: 'beta' }] }, items: { nodes: [], pageInfo: { hasNextPage, endCursor } } } }
}

function archivedItem(id: string, status: string): unknown {
  return { id, fieldValues: { nodes: [{ field: { id: 'F_wf', name: 'pecot-status' }, name: status }] } }
}

function archivedItems(prefix: string, count: number): readonly unknown[] {
  return Array.from({ length: count }, (_unused, index) => archivedItem(`${prefix}${String(index)}`, 'Archived'))
}

describe('listProjectItems', () => {
  it('アイテムが 1 ページに収まる場合は、すべてのアイテムを返し、最初の cursor は null にする', async () => {
    await explains('`listProjectItems` のテストです。アイテムが 1 ページに収まる場合は、すべてのアイテムを返し、最初の `cursor` を `null` にして送信することを確認します。')
    const { client, server } = await startClient([graphqlData('ListProjectItems', page([{ id: 'item1' }, { id: 'item2' }], false, JSON_NULL))])
    expect(await client.listProjectItems('PVT_test123')).toEqual([{ id: 'item1' }, { id: 'item2' }])
    expect(graphqlRequests(server)).toEqual([{ operation: 'ListProjectItems', variables: { projectId: 'PVT_test123', cursor: JSON_NULL, laneFieldName: 'pecot-lane' } }])
  })

  it('hasNextPage が真の間は、endCursor を次の cursor として送信し、最後のページまで読み取る', async () => {
    await explains('`listProjectItems` のテストです。`hasNextPage` が真の間は、`endCursor` を次の `cursor` として送信し、最後のページまで読み取ることを確認します。')
    const { client, server } = await startClient([
      graphqlData('ListProjectItems', page([{ id: 'item1' }], true, 'cursor1')),
      graphqlData('ListProjectItems', page([{ id: 'item2' }], false, JSON_NULL)),
    ])
    expect(await client.listProjectItems('PVT_test123')).toEqual([{ id: 'item1' }, { id: 'item2' }])
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([
      { projectId: 'PVT_test123', cursor: JSON_NULL, laneFieldName: 'pecot-lane' },
      { projectId: 'PVT_test123', cursor: 'cursor1', laneFieldName: 'pecot-lane' },
    ])
  })

  it('1 ページ目の laneField の選択肢の名前を、onLaneOptions へ 1 回だけ渡す', async () => {
    await explains('`listProjectItems` の `onLaneOptions` のテストです。複数ページを読み取る場合は、1 ページ目の `laneField` の選択肢の名前を、コールバックへ 1 回だけ渡すことを確認します。')
    const { client } = await startClient([graphqlData('ListProjectItems', lanePage('cursor1', true)), graphqlData('ListProjectItems', lanePage(JSON_NULL, false))])
    const onLaneOptions = vi.fn()
    await client.listProjectItems('PVT', { onLaneOptions })
    expect(onLaneOptions.mock.calls).toEqual([[['alpha', 'beta']]])
  })

  it('laneField が存在しない場合は、onLaneOptions へ undefined を渡す', async () => {
    await explains('`listProjectItems` の `onLaneOptions` のテストです。応答に `laneField` が存在しない場合は、コールバックへ `undefined` を渡すことを確認します。')
    const { client } = await startClient([graphqlData('ListProjectItems', page([], false, JSON_NULL))])
    const onLaneOptions = vi.fn()
    await client.listProjectItems('PVT', { onLaneOptions })
    expect(onLaneOptions.mock.calls).toEqual([[undefined]])
  })

  it('ボードに pecot-lane が存在せず laneField が NOT_FOUND の部分エラーになる場合は、アイテムを返し、onLaneOptions へ undefined を渡す', async () => {
    await explains('`listProjectItems` のテストです。ボードに `pecot-lane` が存在せず、`laneField` が `NOT_FOUND` の部分エラーになる場合は、アイテムを返し、コールバックへ `undefined` を渡すことを確認します。')
    const data = { node: { laneField: JSON_NULL, items: { nodes: [{ id: 'a' }], pageInfo: { hasNextPage: false, endCursor: JSON_NULL } } } }
    const errors = [{ type: 'NOT_FOUND', path: ['node', 'laneField'], message: 'Could not resolve to a Unions::ProjectV2FieldConfiguration with the name pecot-lane' }]
    const { client } = await startClient([{ match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { data, errors } }, times: 1 }])
    const onLaneOptions = vi.fn()
    expect(await client.listProjectItems('PVT', { onLaneOptions })).toEqual([{ id: 'a' }])
    expect(onLaneOptions.mock.calls).toEqual([[undefined]])
  })

  it('laneField 以外の部分エラーの場合は、例外が発生する', async () => {
    await explains('`listProjectItems` のテストです。`laneField` 以外の部分エラーの場合は、許容せずに例外が発生することを確認します。')
    const data = { node: { laneField: JSON_NULL, items: JSON_NULL } }
    const errors = [{ type: 'NOT_FOUND', path: ['node', 'items'], message: 'boom' }]
    const { client } = await startClient([{ match: { operation: 'ListProjectItems' }, respond: { status: 200, body: { data, errors } }, times: 1 }])
    await expect(client.listProjectItems('PVT')).rejects.toThrow('boom')
  })

  it('limit に達した場合は、次のページを取得せずに切り詰める', async () => {
    await explains('`listProjectItems` の `limit` のテストです。1 ページ目で指定の件数に達した場合は、次のページを取得せず、指定の件数まで切り詰めることを確認します。')
    const nodes = Array.from({ length: 10 }, (_unused, index) => ({ id: `item${String(index)}` }))
    const { client, server } = await startClient([graphqlData('ListProjectItems', page(nodes, true, 'cursor'))])
    const result = await client.listProjectItems('PVT_test123', { limit: 5 })
    expect(result.map(item => item['id'])).toEqual(['item0', 'item1', 'item2', 'item3', 'item4'])
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('limit が 0 の場合は、件数を制限しない', async () => {
    await explains('`listProjectItems` の `limit` のテストです。`limit` が 0 の場合は、件数を制限せずにすべてのアイテムを返すことを確認します。')
    const { client } = await startClient([graphqlData('ListProjectItems', page([{ id: 'a' }, { id: 'b' }], false, JSON_NULL))])
    expect(await client.listProjectItems('PVT_test123', { limit: 0 })).toHaveLength(2)
  })

  it('node が null の場合は、空配列を返す', async () => {
    await explains('`listProjectItems` のテストです。応答の `node` が `null` の場合は、空配列を返すことを確認します。')
    const { client } = await startClient([graphqlData('ListProjectItems', { node: JSON_NULL })])
    expect(await client.listProjectItems('PVT_invalid')).toEqual([])
  })

  it('items が存在しない場合は、空配列を返し、次のページを取得しない', async () => {
    await explains('`listProjectItems` のテストです。応答に `items` が存在しない場合は、空配列を返し、次のページを取得しないことを確認します。')
    const { client } = await startClient([graphqlData('ListProjectItems', { node: { id: 'PVT' } })])
    expect(await client.listProjectItems('PVT')).toEqual([])
  })

  it('オブジェクトでない要素（null）は、結果から除く', async () => {
    await explains('`listProjectItems` のテストです。要素にオブジェクトでない値（`null`）が含まれる場合は、結果から除くことを確認します。')
    const { client } = await startClient([graphqlData('ListProjectItems', page([{ id: 'a' }, JSON_NULL], false, JSON_NULL))])
    expect(await client.listProjectItems('PVT')).toEqual([{ id: 'a' }])
  })

  it('excludeArchived は、ID で特定した進行の欄が Archived のアイテムを除き、値の大文字と小文字を区別しない', async () => {
    await explains('`listProjectItems` の `excludeArchived` のテストです。ID で特定した進行の欄が `Archived` のアイテムを除き、値の大文字と小文字は区別しないことを確認します。')
    const items = [
      archivedItem('a', 'Archived'),
      archivedItem('b', 'Active'),
      { id: 'c', fieldValues: { nodes: [JSON_NULL, { field: { id: 'F_other', name: 'pecot-status' }, name: 'Archived' }] } },
      { id: 'd' },
      archivedItem('e', 'archived'),
    ]
    const { client } = await startClient([graphqlData('ListProjectItems', page(items, false, JSON_NULL))])
    const result = await client.listProjectItems('PVT', { excludeArchived: true, workflowFieldId: 'F_wf' })
    expect(result.map(item => item['id'])).toEqual(['b', 'c', 'd'])
  })

  it('excludeArchived で Archived のアイテムが連続して 50 件続いた場合は、次のページを取得せずに打ち切る', async () => {
    await explains('`listProjectItems` の `excludeArchived` のテストです。`Archived` のアイテムが連続して 50 件続いた場合は、次のページを取得せずに打ち切ることを確認します。')
    const items = [archivedItem('keep', 'Ready'), ...archivedItems('x', 50)]
    const { client, server } = await startClient([graphqlData('ListProjectItems', page(items, true, 'next'))])
    const result = await client.listProjectItems('PVT', { excludeArchived: true, workflowFieldId: 'F_wf' })
    expect(result.map(item => item['id'])).toEqual(['keep'])
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('Archived でないアイテムが途中に挟まる場合は、連続の数が 0 に戻り、打ち切らずに最後まで読み取る', async () => {
    await explains('`listProjectItems` の `excludeArchived` のテストです。`Archived` でないアイテムが途中に挟まる場合は、連続の数が 0 に戻り、打ち切らずに最後まで読み取ることを確認します。')
    const items = [...archivedItems('a', 49), archivedItem('mid', 'Ready'), ...archivedItems('b', 49)]
    const { client, server } = await startClient([graphqlData('ListProjectItems', page(items, false, JSON_NULL))])
    const result = await client.listProjectItems('PVT', { excludeArchived: true, workflowFieldId: 'F_wf' })
    expect(result.map(item => item['id'])).toEqual(['mid'])
    expect(graphqlRequests(server)).toHaveLength(1)
  })
})

describe('listProjectItems の古い GHES への読み直し', () => {
  it.for(['Field \'blockedBy\' doesn\'t exist on type \'Issue\'', 'Cannot query field "parent" on type "Issue"'])('着手の判定に使うフィールド（%s）のスキーマエラーの場合は、追加する前のクエリで先頭から読み直す', async (message) => {
    await explains('`listProjectItems` の古い GHES 対応のテストです。着手の判定に使うフィールドのスキーマエラーの場合は、フィールドを追加する前のクエリで先頭から読み直し、`onLegacy` を 1 回呼び出すことを確認します。')
    const { client, server } = await startClient([graphqlError('ListProjectItems', message), graphqlData('ListProjectItemsLegacy', page([{ id: 'a' }], false, JSON_NULL))])
    const onLegacy = vi.fn()
    expect(await client.listProjectItems('PVT', { onLegacy })).toEqual([{ id: 'a' }])
    expect(onLegacy).toHaveBeenCalledTimes(1)
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['ListProjectItems', 'ListProjectItemsLegacy'])
  })

  it('フィールド名ではない箇所に parent を含むスキーマエラーの場合は、読み直さずに例外が発生する', async () => {
    await explains('`listProjectItems` のテストです。フィールド名ではない箇所に `parent` を含むスキーマエラーの場合は、読み直さずに `GitHubAPIError` が発生することを確認します。')
    const { client, server } = await startClient([graphqlError('ListProjectItems', 'Field \'labels\' doesn\'t exist on type \'Issue\' (parent query)')])
    expect(await rejection(client.listProjectItems('PVT'))).toBeInstanceOf(GitHubAPIError)
    expect(graphqlRequests(server)).toHaveLength(1)
  })
})

describe('listProjectItems の cursor', () => {
  it.each([JSON_NULL, 5])('hasNextPage が真で endCursor が %j の場合は、同じページを取得し続けず、GitHubAPIError が発生する', async (endCursor) => {
    await explains('`listProjectItems` の `cursor` のテストです。`hasNextPage` が真で `endCursor` が `null` または数値の場合は、同じページを取得し続けず、`GitHubAPIError` が発生することを確認します。')
    const { client, server } = await startClient([graphqlData('ListProjectItems', page([{ id: 'a' }], true, endCursor))])
    expect(await rejection(client.listProjectItems('PVT'))).toMatchObject(failure(GitHubAPIError, 'could not get the cursor for the next page'))
    expect(graphqlRequests(server)).toHaveLength(1)
  })
})

describe('アイテムの追加・更新・削除', () => {
  it('addToProject は、追加したアイテムの ID を返す', async () => {
    await explains('`addToProject` のテストです。Issue の Node ID をボードへ追加した場合に、作成したアイテムの ID を返すことを確認します。')
    const { client, server } = await startClient([graphqlData('AddToProject', { addProjectV2ItemById: { item: { id: 'PVTI_test123' } } })])
    expect(await client.addToProject('PVT_proj', 'I_issue')).toBe('PVTI_test123')
    expect(graphqlRequests(server)).toEqual([{ operation: 'AddToProject', variables: { projectId: 'PVT_proj', contentId: 'I_issue' } }])
  })

  it('addToProject は、item が null の場合に GitHubAPIError が発生する', async () => {
    await explains('`addToProject` の失敗時のテストです。応答の `item` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('AddToProject', { addProjectV2ItemById: { item: JSON_NULL } })])
    expect(await rejection(client.addToProject('PVT_proj', 'I_issue'))).toMatchObject(failure(GitHubAPIError, 'failed to add the item to the project'))
  })

  it('updateProjectItemField は、更新したアイテムの ID を返す', async () => {
    await explains('`updateProjectItemField` のテストです。選択肢の ID を指定して更新した場合に、更新したアイテムの ID を返すことを確認します。')
    const { client, server } = await startClient([graphqlData('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_test' } } })])
    expect(await client.updateProjectItemField('PVT_proj', 'PVTI_item', 'FIELD_id', 'OPT_id')).toBe('PVTI_test')
    expect(graphqlRequests(server)).toEqual([{
      operation: 'UpdateProjectItemField',
      variables: { projectId: 'PVT_proj', itemId: 'PVTI_item', fieldId: 'FIELD_id', optionId: 'OPT_id' },
    }])
  })

  it('updateProjectItemField は、projectV2Item が null の場合に GitHubAPIError が発生する', async () => {
    await explains('`updateProjectItemField` の失敗時のテストです。応答の `projectV2Item` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: JSON_NULL } })])
    expect(await rejection(client.updateProjectItemField('PVT_proj', 'PVTI_item', 'FIELD_id', 'OPT_id'))).toMatchObject(failure(GitHubAPIError, 'failed to update the field'))
  })

  it.for<{ readonly name: string, readonly value: ProjectFieldValueInput }>([
    { name: 'text', value: { text: 'メモ' } },
    { name: 'number', value: { number: 2.5 } },
    { name: 'date', value: { date: '2026-12-01' } },
    { name: 'singleSelectOptionId', value: { singleSelectOptionId: 'O_cli' } },
    { name: 'multiSelectOptionIds', value: { multiSelectOptionIds: ['O_a', 'O_b'] } },
    { name: 'iterationId', value: { iterationId: 'I_2' } },
  ])('setProjectItemFieldValue は、$name の値を ProjectV2FieldValue の形のまま送信し、アイテムの ID を返す', async ({ value }) => {
    await explains('`setProjectItemFieldValue` のテストです。テキスト・数値・日付・選択肢などの値を渡した場合に、`ProjectV2FieldValue` の形のまま送信し、アイテムの ID を返すことを確認します。')
    const { client, server } = await startClient([graphqlData('UpdateProjectItemFieldValue', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_item' } } })])
    expect(await client.setProjectItemFieldValue('PVT_proj', 'PVTI_item', 'FIELD_id', value)).toBe('PVTI_item')
    expect(graphqlRequests(server)).toEqual([{
      operation: 'UpdateProjectItemFieldValue',
      variables: { projectId: 'PVT_proj', itemId: 'PVTI_item', fieldId: 'FIELD_id', value },
    }])
  })

  it('setProjectItemFieldValue は、projectV2Item が null の場合に GitHubAPIError が発生する', async () => {
    await explains('`setProjectItemFieldValue` の失敗時のテストです。応答の `projectV2Item` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('UpdateProjectItemFieldValue', { updateProjectV2ItemFieldValue: { projectV2Item: JSON_NULL } })])
    expect(await rejection(client.setProjectItemFieldValue('PVT_proj', 'PVTI_item', 'FIELD_id', { text: 'x' }))).toMatchObject(failure(GitHubAPIError, 'failed to update the field'))
  })

  it('deleteProjectItem は、削除したアイテムの ID を返す', async () => {
    await explains('`deleteProjectItem` のテストです。アイテムを削除した場合に、削除したアイテムの ID を返すことを確認します。')
    const { client, server } = await startClient([graphqlData('DeleteProjectItem', { deleteProjectV2Item: { deletedItemId: 'PVTI_deleted' } })])
    expect(await client.deleteProjectItem('PVT_proj', 'PVTI_item')).toBe('PVTI_deleted')
    expect(graphqlRequests(server)).toEqual([{ operation: 'DeleteProjectItem', variables: { projectId: 'PVT_proj', itemId: 'PVTI_item' } }])
  })

  it('unarchiveProjectItem は、projectId と itemId を変数に送信する', async () => {
    await explains('`unarchiveProjectItem` のテストです。`projectId` と `itemId` を変数にして、アーカイブの解除を送信することを確認します。')
    const { client, server } = await startClient([graphqlData('UnarchiveProjectItem', { unarchiveProjectV2Item: { item: { id: 'PVTI_item' } } })])
    await client.unarchiveProjectItem('PVT_proj', 'PVTI_item')
    expect(graphqlRequests(server)).toEqual([{ operation: 'UnarchiveProjectItem', variables: { projectId: 'PVT_proj', itemId: 'PVTI_item' } }])
  })

  it('unarchiveProjectItem は、item が null の場合に GitHubAPIError が発生する', async () => {
    await explains('`unarchiveProjectItem` の失敗時のテストです。応答の `item` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('UnarchiveProjectItem', { unarchiveProjectV2Item: { item: JSON_NULL } })])
    expect(await rejection(client.unarchiveProjectItem('PVT_proj', 'PVTI_item'))).toMatchObject(failure(GitHubAPIError, 'failed to unarchive the project item'))
  })

  it('deleteProjectItem は、deletedItemId が null の場合に GitHubAPIError が発生する', async () => {
    await explains('`deleteProjectItem` の失敗時のテストです。応答の `deletedItemId` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('DeleteProjectItem', { deleteProjectV2Item: { deletedItemId: JSON_NULL } })])
    expect(await rejection(client.deleteProjectItem('PVT_proj', 'PVTI_item'))).toMatchObject(failure(GitHubAPIError, 'failed to delete the project item'))
  })
})

describe('getLinkedRepositories', () => {
  const nodes = [
    { owner: { login: 'owner1' }, name: 'repo1' },
    JSON_NULL,
    { owner: { login: 'owner2' }, name: 'repo2' },
  ]

  it('user のクエリが成功した場合は、organization のクエリを送信せず、null のノードを除いて返す', async () => {
    await explains('`getLinkedRepositories` のテストです。`user` のクエリが成功した場合は、`organization` のクエリを送信せず、`null` のノードを除いたリポジトリを返すことを確認します。')
    const { client, server } = await startClient([graphqlData('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes } } } })])
    expect(await client.getLinkedRepositories('testuser', 1)).toEqual([{ owner: 'owner1', name: 'repo1' }, { owner: 'owner2', name: 'repo2' }])
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetLinkedRepositoriesUser', variables: { owner: 'testuser', projectNumber: 1 } }])
  })

  it('user が null の場合は、organization のクエリへ進む', async () => {
    await explains('`getLinkedRepositories` のテストです。`user` が `null` の場合は、`organization` のクエリへ進み、そのリポジトリを返すことを確認します。')
    const { client, server } = await startClient([
      graphqlData('GetLinkedRepositoriesUser', { user: JSON_NULL }),
      graphqlData('GetLinkedRepositoriesOrg', { organization: { projectV2: { repositories: { nodes: [{ owner: { login: 'org' }, name: 'repo' }] } } } }),
    ])
    expect(await client.getLinkedRepositories('testorg', 1)).toEqual([{ owner: 'org', name: 'repo' }])
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetLinkedRepositoriesUser', 'GetLinkedRepositoriesOrg'])
  })

  it('user のクエリが GraphQL のエラー（owner が organization の場合）でも、organization のクエリへ進む', async () => {
    await explains('`getLinkedRepositories` のテストです。`user` のクエリが GraphQL のエラーになる場合も、`organization` のクエリへ進み、そのリポジトリを返すことを確認します。')
    const { client } = await startClient([
      graphqlError('GetLinkedRepositoriesUser', 'Could not resolve to a User with the login of \'testorg\'.'),
      graphqlData('GetLinkedRepositoriesOrg', { organization: { projectV2: { repositories: { nodes: [{ owner: { login: 'org' }, name: 'repo' }] } } } }),
    ])
    expect(await client.getLinkedRepositories('testorg', 1)).toEqual([{ owner: 'org', name: 'repo' }])
  })

  it('user と organization のどちらも存在しない場合は、空配列を返す', async () => {
    await explains('`getLinkedRepositories` のテストです。`user` と `organization` のどちらも存在しない場合は、空配列を返すことを確認します。')
    const { client } = await startClient([
      graphqlData('GetLinkedRepositoriesUser', { user: JSON_NULL }),
      graphqlData('GetLinkedRepositoriesOrg', { organization: JSON_NULL }),
    ])
    expect(await client.getLinkedRepositories('unknown', 1)).toEqual([])
  })

  it('organization のクエリがエラーになる場合は、GitHubAPIError が発生する', async () => {
    await explains('`getLinkedRepositories` の失敗時のテストです。`organization` のクエリがエラーになる場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([
      graphqlData('GetLinkedRepositoriesUser', { user: JSON_NULL }),
      graphqlError('GetLinkedRepositoriesOrg', 'Something broke'),
    ])
    expect(await rejection(client.getLinkedRepositories('x', 1))).toMatchObject({ name: 'GitHubAPIError' })
  })

  it('getLinkedRepositoriesCached と linkedRepositories は、同じ引数の 2 回目からキャッシュを返す', async () => {
    await explains('`getLinkedRepositoriesCached` と `linkedRepositories` のテストです。同じ引数で 2 回呼び出した場合は、2 回目からキャッシュを返し、GraphQL を 1 回しか送信しないことを確認します。')
    const { client, server } = await startClient([graphqlData('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes } } } })])
    const first = await client.getLinkedRepositoriesCached('testuser', 1)
    const second = await client.linkedRepositories('testuser', 1)
    expect(second).toEqual(first)
    expect(second).toHaveLength(2)
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('キャッシュは、owner とプロジェクト番号の組ごとに別々に持つ', async () => {
    await explains('`linkedRepositories` のキャッシュのテストです。`owner` が同じでもプロジェクト番号が異なる場合は、番号ごとに別のクエリを送信することを確認します。')
    const { client, server } = await startClient([
      graphqlData('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes: [] } } } }, 2),
    ])
    await client.linkedRepositories('testuser', 1)
    await client.linkedRepositories('testuser', 2)
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([
      { owner: 'testuser', projectNumber: 1 },
      { owner: 'testuser', projectNumber: 2 },
    ])
  })
})

describe('user のクエリの失敗の扱い', () => {
  it('状態コード 401 でも organization のクエリへ進み、そちらも 401 の場合は GitHubAuthError が発生する', async () => {
    await explains('`getLinkedRepositories` のテストです。`user` のクエリが状態コード 401 になる場合も、`organization` のクエリへ進み、そちらも 401 であれば `GitHubAuthError` が発生することを確認します。')
    const unauthorized = { status: 401, text: 'Bad credentials' }
    const { client, server } = await startClient([
      { match: { operation: 'GetLinkedRepositoriesUser' }, respond: unauthorized, times: 1 },
      { match: { operation: 'GetLinkedRepositoriesOrg' }, respond: unauthorized, times: 1 },
    ])
    expect(await rejection(client.getLinkedRepositories('o', 1))).toMatchObject({ name: 'GitHubAuthError' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetLinkedRepositoriesUser', 'GetLinkedRepositoriesOrg'])
  })

  it('レート制限でも organization のクエリへ進み、そちらも同じ場合は GitHubRateLimitError が発生する', async () => {
    await explains('`listProjects` のテストです。`user` のクエリがレート制限になる場合も、`organization` のクエリへ進み、そちらも同じであれば `GitHubRateLimitError` が発生することを確認します。')
    const { client, server } = await startClient([
      graphqlError('ListProjectsUser', 'API rate limit exceeded'),
      graphqlError('ListProjectsOrg', 'API rate limit exceeded'),
    ])
    expect(await rejection(client.listProjects('o'))).toMatchObject({ name: 'GitHubRateLimitError' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['ListProjectsUser', 'ListProjectsOrg'])
  })
})

describe('getProjectId', () => {
  it('user にプロジェクトが存在する場合は、その ID を返す', async () => {
    await explains('`getProjectId` のテストです。`user` にプロジェクトが存在する場合は、その ID を返すことを確認します。')
    const { client } = await startClient([graphqlData('GetProjectIdUser', { user: { projectV2: { id: 'PVT_test123' } } })])
    expect(await client.getProjectId('testuser', 1)).toBe('PVT_test123')
  })

  it('user が null の場合は、organization のプロジェクトの ID を返す', async () => {
    await explains('`getProjectId` のテストです。`user` が `null` の場合は、`organization` のクエリへ進み、そのプロジェクトの ID を返すことを確認します。')
    const { client, server } = await startClient([
      graphqlData('GetProjectIdUser', { user: JSON_NULL }),
      graphqlData('GetProjectIdOrg', { organization: { projectV2: { id: 'PVT_org456' } } }),
    ])
    expect(await client.getProjectId('testorg', 2)).toBe('PVT_org456')
    expect(graphqlRequests(server)).toEqual([
      { operation: 'GetProjectIdUser', variables: { owner: 'testorg', projectNumber: 2 } },
      { operation: 'GetProjectIdOrg', variables: { owner: 'testorg', projectNumber: 2 } },
    ])
  })

  it('user と organization のどちらにもプロジェクトが存在しない場合は、GitHubNotFoundError が発生する', async () => {
    await explains('`getProjectId` の失敗時のテストです。`user` と `organization` のどちらにもプロジェクトが存在しない場合は、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await startClient([
      graphqlData('GetProjectIdUser', { user: JSON_NULL }),
      graphqlData('GetProjectIdOrg', { organization: JSON_NULL }),
    ])
    expect(await rejection(client.getProjectId('nobody', 99))).toMatchObject(failure(GitHubNotFoundError, 'project not found: nobody/projects/99'))
  })
})

async function lookup(response: unknown): Promise<{ readonly result: string | undefined, readonly variables: unknown }> {
  const { client, server } = await startClient([graphqlData('GetIssueProjectItems', response)])
  const result = await client.getItemIdByIssue('PVT_proj', 'owner', 'repo', 123)
  return { result, variables: graphqlRequests(server).map(request => request.variables) }
}

describe('getIssueProjectItem', () => {
  it.each([
    ['isArchived が真', true, true],
    ['isArchived が偽', false, false],
    ['isArchived が存在しない', undefined, false],
  ])('%s のアイテムは、ID とアーカイブ済みか（%s → %s）を返す', async (_label, isArchived, expected) => {
    await explains('`getIssueProjectItem` のテストです。アイテムの `isArchived` が真・偽・存在しないのいずれの場合も、ID とアーカイブ済みかどうかを返すことを確認します。')
    const { client } = await startClient([graphqlData('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [
      { id: 'PVTI_item1', ...isArchived !== undefined && { isArchived }, project: { id: 'PVT_proj' } },
    ] } } } })])
    expect(await client.getIssueProjectItem('PVT_proj', 'owner', 'repo', 123)).toEqual({ id: 'PVTI_item1', isArchived: expected })
  })

  it('指定のプロジェクトに紐づかない場合は、undefined を返す', async () => {
    await explains('`getIssueProjectItem` のテストです。指定のプロジェクトに紐づくアイテムが存在しない場合は、`undefined` を返すことを確認します。')
    const { client } = await startClient([graphqlData('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [
      { id: 'PVTI_item1', isArchived: true, project: { id: 'PVT_other' } },
    ] } } } })])
    expect(await client.getIssueProjectItem('PVT_proj', 'owner', 'repo', 123)).toBeUndefined()
  })
})

describe('getItemIdByIssue', () => {
  it('指定のプロジェクトのアイテム ID を返す', async () => {
    await explains('`getItemIdByIssue` のテストです。Issue が複数のプロジェクトに紐づく場合は、指定のプロジェクトのアイテム ID を返すことを確認します。')
    const { result, variables } = await lookup({ repository: { issue: { projectItems: { nodes: [
      { id: 'PVTI_item1', project: { id: 'PVT_proj' } },
      { id: 'PVTI_item2', project: { id: 'PVT_other' } },
    ] } } } })
    expect(result).toBe('PVTI_item1')
    expect(variables).toEqual([{ owner: 'owner', repo: 'repo', number: 123 }])
  })

  it('null のアイテムは、読み飛ばす', async () => {
    await explains('`getItemIdByIssue` のテストです。アイテムの一覧に `null` が含まれる場合は、読み飛ばして指定のプロジェクトのアイテム ID を返すことを確認します。')
    const { result } = await lookup({ repository: { issue: { projectItems: { nodes: [JSON_NULL, { id: 'PVTI_item1', project: { id: 'PVT_proj' } }] } } } })
    expect(result).toBe('PVTI_item1')
  })

  it.each([
    ['Issue が存在しない', { repository: { issue: JSON_NULL } }],
    ['リポジトリが存在しない', { repository: JSON_NULL }],
    ['別のプロジェクトにだけ紐づく', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_item1', project: { id: 'PVT_other' } }] } } } }],
    ['どのプロジェクトにも紐づかない', { repository: { issue: { projectItems: { nodes: [] } } } }],
  ])('%s場合は、アイテム ID として undefined を返す', async (_label, response) => {
    await explains('`getItemIdByIssue` のテストです。Issue やリポジトリが存在しない場合、またはプロジェクトに紐づかない場合は、`undefined` を返すことを確認します。')
    const { result } = await lookup(response)
    expect(result).toBeUndefined()
  })
})

function boardItemIssue(projectItems: readonly unknown[]): unknown {
  return { repository: { issue: {
    number: 13,
    title: '課題13',
    state: 'OPEN',
    url: 'https://github.com/acme/other/issues/13',
    repository: { owner: { login: 'acme' }, name: 'other' },
    projectItems: { nodes: projectItems },
  } } }
}

describe('getIssueBoardItem', () => {
  it('指定のプロジェクトの項目 ID と進行の列を、ボードの一覧と同じ形で返す', async () => {
    await explains('`getIssueBoardItem` のテストです。指定のプロジェクトのアイテム ID と進行の列を、ボードの一覧と同じ形で返すことを確認します。')
    const { client, server } = await startClient([graphqlData('GetIssueBoardItem', boardItemIssue([
      { id: 'PVTI_other', project: { id: 'PVT_other' }, fieldValues: { nodes: [{ field: { id: 'F_wf', name: 'pecot-workflow-x' }, name: 'Ready' }] } },
      JSON_NULL,
      { id: 'PVTI_13', project: { id: 'PVT_proj' }, fieldValues: { nodes: [{}, { field: { id: 'F_other', name: 'Status' }, name: 'Todo' }, { field: { id: 'F_wf', name: 'pecot-workflow-x' }, name: 'Blocked' }] } },
    ]))])
    expect(await client.getIssueBoardItem('PVT_proj', 'acme', 'other', 13, 'F_wf')).toEqual({
      id: 'PVTI_13',
      workflow: 'Blocked',
      title: '課題13',
      content: { number: 13, state: 'OPEN', url: 'https://github.com/acme/other/issues/13', repository: 'acme/other' },
    })
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueBoardItem', variables: { owner: 'acme', repo: 'other', number: 13 } }])
  })

  it('進行の列に値が存在しない場合は、workflow を null にする', async () => {
    await explains('`getIssueBoardItem` のテストです。進行の列に値が存在しない場合は、`workflow` を `null` にすることを確認します。')
    const { client } = await startClient([graphqlData('GetIssueBoardItem', boardItemIssue([{ id: 'PVTI_13', project: { id: 'PVT_proj' }, fieldValues: { nodes: [] } }]))])
    expect(await client.getIssueBoardItem('PVT_proj', 'acme', 'other', 13, 'F_wf')).toMatchObject({ id: 'PVTI_13', workflow: JSON_NULL })
  })

  it.each([
    ['Issue が存在しない', { repository: { issue: JSON_NULL } }],
    ['リポジトリが存在しない', { repository: JSON_NULL }],
    ['別のプロジェクトにだけ載っている', boardItemIssue([{ id: 'PVTI_x', project: { id: 'PVT_other' }, workflow: JSON_NULL }])],
    ['どのプロジェクトにも載っていない', boardItemIssue([])],
  ])('%s場合は、ボードの項目として undefined を返す', async (_label, response) => {
    await explains('`getIssueBoardItem` のテストです。Issue やリポジトリが存在しない場合、またはプロジェクトに載っていない場合は、`undefined` を返すことを確認します。')
    const { client } = await startClient([graphqlData('GetIssueBoardItem', response)])
    expect(await client.getIssueBoardItem('PVT_proj', 'acme', 'other', 13, 'F_wf')).toBeUndefined()
  })

  it('項目 ID が文字列でない場合は、GitHubAPIError が発生する', async () => {
    await explains('`getIssueBoardItem` の失敗時のテストです。アイテム ID が文字列でない場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('GetIssueBoardItem', boardItemIssue([{ id: 5, project: { id: 'PVT_proj' }, fieldValues: { nodes: [] } }]))])
    expect(await rejection(client.getIssueBoardItem('PVT_proj', 'acme', 'other', 13, 'F_wf'))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: projectItems.nodes.id'))
  })
})

describe('linkRepositoryToProject', () => {
  const projectFound = graphqlData('GetProjectIdUser', { user: { projectV2: { id: 'PVT_proj' } } })
  const repositoryFound = graphqlData('GetRepositoryId', { repository: { id: 'R_repo' } })

  it('リンクに成功した場合は、linked を返す', async () => {
    await explains('`linkRepositoryToProject` のテストです。リンクが成功した場合は、`linked` を返し、プロジェクトとリポジトリの ID を変数にして送信することを確認します。')
    const { client, server } = await startClient([
      projectFound,
      repositoryFound,
      graphqlData('LinkProjectRepository', { linkProjectV2ToRepository: { repository: { id: 'R_repo', nameWithOwner: 'owner/repo' } } }),
    ])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ status: 'linked', detail: '' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetProjectIdUser', 'GetRepositoryId', 'LinkProjectRepository'])
    expect(graphqlRequests(server).at(2)?.variables).toEqual({ projectId: 'PVT_proj', repositoryId: 'R_repo' })
  })

  it.each(['already linked', 'Repository already exists in project'])('「%s」のエラーは、already_linked にして GitHub のメッセージを detail に含める', async (message) => {
    await explains('`linkRepositoryToProject` のテストです。すでにリンクされているエラーの場合は、`already_linked` を返し、GitHub のメッセージを `detail` に含めることを確認します。')
    const { client } = await startClient([projectFound, repositoryFound, graphqlError('LinkProjectRepository', message)])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ status: 'already_linked', detail: `GraphQL query error: {'message': '${message}'}` })
  })

  it('プロジェクトが存在しない場合は、failed を返し、GitHubNotFoundError と同じメッセージを detail に含める', async () => {
    await explains('`linkRepositoryToProject` のテストです。プロジェクトが存在しない場合は、`failed` を返し、`GitHubNotFoundError` と同じメッセージを `detail` に含めることを確認します。')
    const { client } = await startClient([
      graphqlData('GetProjectIdUser', { user: JSON_NULL }),
      graphqlData('GetProjectIdOrg', { organization: JSON_NULL }),
    ])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({
      status: 'failed',
      detail: 'project not found: owner/projects/1',
    })
  })

  it('リポジトリが存在しない場合は、failed を返し、存在しないリポジトリを示すメッセージを detail に含める', async () => {
    await explains('`linkRepositoryToProject` のテストです。リポジトリが存在しない場合は、`failed` を返し、存在しないリポジトリを示すメッセージを `detail` に含めることを確認します。')
    const { client } = await startClient([projectFound, graphqlData('GetRepositoryId', { repository: JSON_NULL })])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'nonexistent')).toEqual({
      status: 'failed',
      detail: 'repository not found: owner/nonexistent',
    })
  })

  it('その他の API エラーの場合は、failed を返し、GraphQL のエラー文を detail に含める', async () => {
    await explains('`linkRepositoryToProject` のテストです。それ以外の API エラーの場合は、`failed` を返し、GraphQL のエラー文を `detail` に含めることを確認します。')
    const { client } = await startClient([projectFound, repositoryFound, graphqlError('LinkProjectRepository', 'Some API error')])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({
      status: 'failed',
      detail: 'GraphQL query error: {\'message\': \'Some API error\'}',
    })
  })

  it('repository が null の応答は、failed を返し、detail を unexpected response にする', async () => {
    await explains('`linkRepositoryToProject` のテストです。応答の `repository` が `null` の場合は、`failed` を返し、`detail` を `unexpected response` にすることを確認します。')
    const { client } = await startClient([projectFound, repositoryFound, graphqlData('LinkProjectRepository', { linkProjectV2ToRepository: { repository: JSON_NULL } })])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ status: 'failed', detail: 'unexpected response' })
  })

  it('nameWithOwner が存在しない場合も、linked を返す', async () => {
    await explains('`linkRepositoryToProject` のテストです。応答に `nameWithOwner` が存在しない場合も、`linked` を返すことを確認します。')
    const { client } = await startClient([projectFound, repositoryFound, graphqlData('LinkProjectRepository', { linkProjectV2ToRepository: { repository: { id: 'R_repo' } } })])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ status: 'linked', detail: '' })
  })
})

describe('listProjects', () => {
  const projects = [
    { number: 1, title: 'A', url: 'https://github.com/users/u/projects/1', id: 'PVT_1' },
    JSON_NULL,
    { number: 2, title: 'B', url: 'https://github.com/users/u/projects/2', id: 'PVT_2' },
  ]

  it('user のプロジェクトから null を除いて返し、first の既定値は 20 にする', async () => {
    await explains('`listProjects` のテストです。`user` のプロジェクトから `null` を除いて返し、`first` の既定値が 20 であることを確認します。')
    const { client, server } = await startClient([graphqlData('ListProjectsUser', { user: { projectsV2: { nodes: projects } } })])
    expect(await client.listProjects('u')).toEqual([projects[0], projects[2]])
    expect(graphqlRequests(server)).toEqual([{ operation: 'ListProjectsUser', variables: { owner: 'u', first: 20 } }])
  })

  it('user が null の場合は、organization のプロジェクトを返し、first を変数として送信する', async () => {
    await explains('`listProjects` のテストです。`user` が `null` の場合は、`organization` のプロジェクトを返し、`first` を変数として送信することを確認します。')
    const { client, server } = await startClient([
      graphqlData('ListProjectsUser', { user: JSON_NULL }),
      graphqlData('ListProjectsOrg', { organization: { projectsV2: { nodes: [projects[0]] } } }),
    ])
    expect(await client.listProjects('o', 5)).toEqual([projects[0]])
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([{ owner: 'o', first: 5 }, { owner: 'o', first: 5 }])
  })

  it('user と organization のどちらも存在しない場合は、プロジェクトの一覧として空配列を返す', async () => {
    await explains('`listProjects` のテストです。`user` と `organization` のどちらも存在しない場合は、空配列を返すことを確認します。')
    const { client } = await startClient([graphqlData('ListProjectsUser', { user: JSON_NULL }), graphqlData('ListProjectsOrg', { organization: JSON_NULL })])
    expect(await client.listProjects('nobody')).toEqual([])
  })
})

describe('getProjectFields', () => {
  const project = { id: 'PVT_1', title: 'P', url: 'https://github.com/users/u/projects/1', fields: { nodes: [{ id: 'F1', name: 'Status' }] } }

  it('user のプロジェクトとフィールドを返す', async () => {
    await explains('`getProjectFields` のテストです。`user` のプロジェクトが存在する場合は、そのプロジェクトとフィールドを返すことを確認します。')
    const { client, server } = await startClient([graphqlData('GetProjectFieldsUser', { user: { projectV2: project } })])
    expect(await client.getProjectFields('u', 1)).toEqual(project)
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetProjectFieldsUser', variables: { owner: 'u', projectNumber: 1 } }])
  })

  it('user が null の場合は、organization のプロジェクトとフィールドを返す', async () => {
    await explains('`getProjectFields` のテストです。`user` が `null` の場合は、`organization` のプロジェクトを返すことを確認します。')
    const { client } = await startClient([graphqlData('GetProjectFieldsUser', { user: JSON_NULL }), graphqlData('GetProjectFieldsOrg', { organization: { projectV2: project } })])
    expect(await client.getProjectFields('o', 1)).toEqual(project)
  })

  it('user と organization のどちらも存在しない場合は、フィールドの取得で undefined を返す', async () => {
    await explains('`getProjectFields` のテストです。`user` と `organization` のどちらも存在しない場合は、`undefined` を返すことを確認します。')
    const { client } = await startClient([graphqlData('GetProjectFieldsUser', { user: JSON_NULL }), graphqlData('GetProjectFieldsOrg', { organization: JSON_NULL })])
    expect(await client.getProjectFields('nobody', 1)).toBeUndefined()
  })
})

describe('createProjectField', () => {
  const options = [
    { name: 'Backlog', color: 'RED', description: 'Epic置き場' },
    { name: 'Ready', color: 'GREEN', description: '未着手' },
  ]

  it('作成したフィールドを返し、projectId・name・options を変数として送信する', async () => {
    await explains('`createProjectField` のテストです。フィールドを作成した場合は、作成したフィールドを返し、`projectId`・`name`・`options` を変数として送信することを確認します。')
    const created = { id: 'PVTSSF_new123', name: 'pecot-workflow', options: [{ id: 'opt1', name: 'Backlog' }, { id: 'opt2', name: 'Ready' }] }
    const { client, server } = await startClient([graphqlData('CreateProjectField', { createProjectV2Field: { projectV2Field: created } })])
    expect(await client.createProjectField('PVT_test123', 'pecot-workflow', options)).toEqual(created)
    expect(graphqlRequests(server)).toEqual([{ operation: 'CreateProjectField', variables: { projectId: 'PVT_test123', name: 'pecot-workflow', options } }])
  })

  it('フィールドの作成で projectV2Field が null の場合は、GitHubAPIError が発生する', async () => {
    await explains('`createProjectField` の失敗時のテストです。応答の `projectV2Field` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('CreateProjectField', { createProjectV2Field: { projectV2Field: JSON_NULL } })])
    expect(await rejection(client.createProjectField('PVT_test123', 'pecot-workflow', options))).toMatchObject(failure(GitHubAPIError, 'failed to create the field'))
  })

  it('フィールドの作成で GraphQL のエラーの場合は、GraphQL のエラー文を含む GitHubAPIError が発生する', async () => {
    await explains('`createProjectField` の失敗時のテストです。GraphQL のエラーの場合は、GraphQL のエラー文を含む `GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlError('CreateProjectField', 'GraphQL error')])
    expect(await rejection(client.createProjectField('PVT_test123', 'pecot-workflow', options))).toMatchObject(
      failure(GitHubAPIError, 'GraphQL query error: {\'message\': \'GraphQL error\'}'),
    )
  })
})

describe('renameProjectField', () => {
  it('改名後のフィールドを返し、fieldId と name だけを送信して選択肢は送信しない', async () => {
    await explains('`renameProjectField` のテストです。フィールドを改名した場合は、改名後のフィールドを返し、`fieldId` と `name` だけを送信して選択肢は送信しないことを確認します。')
    const renamed = { id: 'PVTSSF_f1', name: 'pecot-status' }
    const { client, server } = await startClient([graphqlData('RenameProjectField', { updateProjectV2Field: { projectV2Field: renamed } })])
    expect(await client.renameProjectField('PVTSSF_f1', 'pecot-status')).toEqual(renamed)
    expect(graphqlRequests(server)).toEqual([{ operation: 'RenameProjectField', variables: { fieldId: 'PVTSSF_f1', name: 'pecot-status' } }])
  })

  it('フィールドの改名で projectV2Field が null の場合は、GitHubAPIError が発生する', async () => {
    await explains('`renameProjectField` の失敗時のテストです。応答の `projectV2Field` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('RenameProjectField', { updateProjectV2Field: { projectV2Field: JSON_NULL } })])
    expect(await rejection(client.renameProjectField('PVTSSF_f1', 'pecot-status'))).toMatchObject(failure(GitHubAPIError, 'failed to rename the field'))
  })
})

describe('deleteProjectField', () => {
  it('削除したフィールドを返し、fieldId だけを送信する', async () => {
    await explains('`deleteProjectField` のテストです。フィールドを削除した場合は、削除したフィールドを返し、`fieldId` だけを送信することを確認します。')
    const deleted = { id: 'PVTSSF_p', name: 'pecot-priority' }
    const { client, server } = await startClient([graphqlData('DeleteProjectField', { deleteProjectV2Field: { projectV2Field: deleted } })])
    expect(await client.deleteProjectField('PVTSSF_p')).toEqual(deleted)
    expect(graphqlRequests(server)).toEqual([{ operation: 'DeleteProjectField', variables: { fieldId: 'PVTSSF_p' } }])
  })

  it('フィールドの削除で projectV2Field が null の場合は、GitHubAPIError が発生する', async () => {
    await explains('`deleteProjectField` の失敗時のテストです。応答の `projectV2Field` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('DeleteProjectField', { deleteProjectV2Field: { projectV2Field: JSON_NULL } })])
    expect(await rejection(client.deleteProjectField('PVTSSF_p'))).toMatchObject(failure(GitHubAPIError, 'failed to delete the field'))
  })
})

describe('updateProjectFieldOptions', () => {
  const options = [
    { id: 'opt1', name: 'Backlog', color: 'RED', description: 'Epic置き場' },
    { name: 'Blocked', color: 'ORANGE', description: '待ち' },
  ]

  it('更新後のフィールドを返し、id を持つ選択肢をそのまま送信する', async () => {
    await explains('`updateProjectFieldOptions` のテストです。選択肢を更新した場合は、更新後のフィールドを返し、`id` を持つ選択肢をそのまま送信することを確認します。')
    const updated = { id: 'PVTSSF_f1', name: 'pecot-workflow', options: [{ id: 'opt1', name: 'Backlog' }, { id: 'opt9', name: 'Blocked' }] }
    const { client, server } = await startClient([graphqlData('UpdateProjectField', { updateProjectV2Field: { projectV2Field: updated } })])
    expect(await client.updateProjectFieldOptions('PVTSSF_f1', options)).toEqual(updated)
    expect(graphqlRequests(server)).toEqual([{ operation: 'UpdateProjectField', variables: { fieldId: 'PVTSSF_f1', options } }])
  })

  it('選択肢の更新で projectV2Field が null の場合は、GitHubAPIError が発生する', async () => {
    await explains('`updateProjectFieldOptions` の失敗時のテストです。応答の `projectV2Field` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('UpdateProjectField', { updateProjectV2Field: { projectV2Field: JSON_NULL } })])
    expect(await rejection(client.updateProjectFieldOptions('PVTSSF_f1', options))).toMatchObject(failure(GitHubAPIError, 'failed to update the field'))
  })

  it('選択肢の更新で GraphQL のエラーの場合は、GraphQL のエラー文を含む GitHubAPIError が発生する', async () => {
    await explains('`updateProjectFieldOptions` の失敗時のテストです。GraphQL のエラーの場合は、GraphQL のエラー文を含む `GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlError('UpdateProjectField', 'GraphQL error')])
    expect(await rejection(client.updateProjectFieldOptions('PVTSSF_f1', options))).toMatchObject(
      failure(GitHubAPIError, 'GraphQL query error: {\'message\': \'GraphQL error\'}'),
    )
  })
})

describe('getOwnerNodeId', () => {
  it('user の Node ID を返し、login を変数として送信する', async () => {
    await explains('`getOwnerNodeId` のテストです。`user` が存在する場合は、`login` を変数にして送信し、その Node ID を返すことを確認します。')
    const { client, server } = await startClient([graphqlData('GetUserNodeId', { user: { id: 'U_kgDOtest123' } })])
    expect(await client.getOwnerNodeId('testuser')).toBe('U_kgDOtest123')
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetUserNodeId', variables: { login: 'testuser' } }])
  })

  it('user が null の場合は、organization の Node ID を返す', async () => {
    await explains('`getOwnerNodeId` のテストです。`user` が `null` の場合は、`organization` のクエリへ進み、その Node ID を返すことを確認します。')
    const { client, server } = await startClient([
      graphqlData('GetUserNodeId', { user: JSON_NULL }),
      graphqlData('GetOrgNodeId', { organization: { id: 'O_kgDOorg456' } }),
    ])
    expect(await client.getOwnerNodeId('testorg')).toBe('O_kgDOorg456')
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([{ login: 'testorg' }, { login: 'testorg' }])
  })

  it('user のクエリが GraphQL のエラー（owner が organization の場合）でも、organization の Node ID を返す', async () => {
    await explains('`getOwnerNodeId` のテストです。`user` のクエリが GraphQL のエラーになる場合も、`organization` のクエリへ進み、その Node ID を返すことを確認します。')
    const { client } = await startClient([
      graphqlError('GetUserNodeId', 'Could not resolve to a User with the login of \'testorg\'.'),
      graphqlData('GetOrgNodeId', { organization: { id: 'O_kgDOorg456' } }),
    ])
    expect(await client.getOwnerNodeId('testorg')).toBe('O_kgDOorg456')
  })

  it('user のクエリが状態コード 401 でも organization のクエリへ進み、そちらも 401 の場合は GitHubAuthError が発生する', async () => {
    await explains('`getOwnerNodeId` のテストです。`user` のクエリが状態コード 401 になる場合も、`organization` のクエリへ進み、そちらも 401 であれば `GitHubAuthError` が発生することを確認します。')
    const { client, server } = await startClient([
      { match: { operation: 'GetUserNodeId' }, respond: { status: 401, text: 'x' }, times: 1 },
      { match: { operation: 'GetOrgNodeId' }, respond: { status: 401, text: 'x' }, times: 1 },
    ])
    expect(await rejection(client.getOwnerNodeId('o'))).toMatchObject({ name: 'GitHubAuthError' })
    expect(graphqlRequests(server)).toHaveLength(2)
  })

  it('user と organization のどちらも存在しない場合は、Node ID の取得で GitHubNotFoundError が発生する', async () => {
    await explains('`getOwnerNodeId` の失敗時のテストです。`user` と `organization` のどちらも存在しない場合は、`GitHubNotFoundError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('GetUserNodeId', { user: JSON_NULL }), graphqlData('GetOrgNodeId', { organization: JSON_NULL })])
    expect(await rejection(client.getOwnerNodeId('nonexistent'))).toMatchObject(failure(GitHubNotFoundError, 'owner not found: nonexistent'))
  })
})

describe('createProject', () => {
  it('作成したプロジェクトを返し、ownerId と title を変数として送信する', async () => {
    await explains('`createProject` のテストです。プロジェクトを作成した場合は、作成したプロジェクトを返し、`ownerId` と `title` を変数として送信することを確認します。')
    const created = { id: 'PVT_kwHOtest123', number: 42, title: 'New Project', url: 'https://github.com/users/owner/projects/42' }
    const { client, server } = await startClient([graphqlData('CreateProject', { createProjectV2: { projectV2: created } })])
    expect(await client.createProject('U_owner123', 'New Project')).toEqual(created)
    expect(graphqlRequests(server)).toEqual([{ operation: 'CreateProject', variables: { ownerId: 'U_owner123', title: 'New Project' } }])
  })

  it('プロジェクトの作成で projectV2 が null の場合は、GitHubAPIError が発生する', async () => {
    await explains('`createProject` の失敗時のテストです。応答の `projectV2` が `null` の場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlData('CreateProject', { createProjectV2: { projectV2: JSON_NULL } })])
    expect(await rejection(client.createProject('U_owner123', 'New Project'))).toMatchObject(failure(GitHubAPIError, 'failed to create the project'))
  })

  it('プロジェクトの作成で GraphQL のエラーの場合は、GitHubAPIError が発生する', async () => {
    await explains('`createProject` の失敗時のテストです。GraphQL のエラーの場合は、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlError('CreateProject', 'GraphQL error')])
    expect(await rejection(client.createProject('U_owner123', 'New Project'))).toMatchObject({ name: 'GitHubAPIError' })
  })
})

function fieldValue(fieldId: unknown): unknown {
  return { field: { id: fieldId } }
}

async function lookupSetFieldIds(response: unknown): Promise<{ readonly result: ReadonlySet<string>, readonly variables: unknown }> {
  const { client, server } = await startClient([graphqlData('GetIssueProjectItems', response)])
  const result = await client.getItemSetFieldIds('PVT_proj', 'owner', 'repo', 123, 'PVTI_item')
  return { result, variables: graphqlRequests(server).map(request => request.variables) }
}

describe('getItemSetFieldIds', () => {
  it('指定のプロジェクトの指定のアイテムについて、値が設定されているフィールドの ID を返す', async () => {
    await explains('`getItemSetFieldIds` のテストです。指定のプロジェクトの指定のアイテムについて、値が設定されているフィールドの ID だけを返すことを確認します。')
    const { result, variables } = await lookupSetFieldIds({ repository: { issue: { projectItems: { nodes: [
      { id: 'PVTI_other', project: { id: 'PVT_proj' }, fieldValues: { nodes: [fieldValue('F_other')] } },
      { id: 'PVTI_item', project: { id: 'PVT_other' }, fieldValues: { nodes: [fieldValue('F_wrong_project')] } },
      { id: 'PVTI_item', project: { id: 'PVT_proj' }, fieldValues: { nodes: [fieldValue('F_workflow'), {}, JSON_NULL, fieldValue(1), fieldValue('F_priority')] } },
    ] } } } })
    expect(result).toEqual(new Set(['F_workflow', 'F_priority']))
    expect(variables).toEqual([{ owner: 'owner', repo: 'repo', number: 123 }])
  })

  it.each([
    ['Issue が存在しない', { repository: { issue: JSON_NULL } }],
    ['リポジトリが存在しない', { repository: JSON_NULL }],
    ['アイテムが存在しない', { repository: { issue: { projectItems: { nodes: [] } } } }],
    ['値が設定されていない', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_item', project: { id: 'PVT_proj' }, fieldValues: { nodes: [] } }] } } } }],
  ])('%s場合は、空の集合を返す', async (_label, response) => {
    await explains('`getItemSetFieldIds` のテストです。Issue・リポジトリ・アイテムが存在しない場合や、値が設定されていない場合は、空の集合を返すことを確認します。')
    const { result } = await lookupSetFieldIds(response)
    expect(result.size).toBe(0)
  })
})

describe('getProjectViewTarget', () => {
  const project = {
    url: 'https://github.com/orgs/acme/projects/3',
    views: { nodes: [{ number: 1, name: 'Board' }, JSON_NULL] },
    fields: { nodes: [{ databaseId: 11, name: 'pecot-status' }, {}, { databaseId: 22, name: 'pecot-lane' }, { databaseId: 33, name: 'pecot-lane' }] },
  }

  it('組織のボードは、所有者の種類・URL・ビュー・single select の欄の databaseId を返し、同じ名前の欄は後のものを使う', async () => {
    await explains('`getProjectViewTarget` のテストです。組織のボードの場合は、所有者の種類・URL・ビュー・single select の欄の `databaseId` を返し、同じ名前の欄は後のものを使うことを確認します。')
    const { client, server } = await startClient([graphqlData('GetProjectViewTarget', { repositoryOwner: { __typename: 'Organization', projectV2: project } })])
    expect(await client.getProjectViewTarget('acme', 3)).toEqual({
      owner: 'acme',
      number: 3,
      ownerKind: 'Organization',
      userId: undefined,
      url: 'https://github.com/orgs/acme/projects/3',
      views: [{ number: 1, name: 'Board' }],
      fieldDatabaseIds: new Map([['pecot-status', 11], ['pecot-lane', 33]]),
    })
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetProjectViewTarget', variables: { owner: 'acme', projectNumber: 3 } }])
  })

  it('個人のボードは、User の数値の ID を userId に含める', async () => {
    await explains('`getProjectViewTarget` のテストです。個人のボードの場合は、`User` の数値の ID を `userId` に含めることを確認します。')
    const { client } = await startClient([graphqlData('GetProjectViewTarget', { repositoryOwner: { __typename: 'User', databaseId: 4242, projectV2: project } })])
    expect(await client.getProjectViewTarget('someone', 3)).toMatchObject({ ownerKind: 'User', userId: 4242 })
  })

  it('所有者またはボードが存在しない場合は、それぞれを示すメッセージの GitHubNotFoundError が発生する', async () => {
    await explains('`getProjectViewTarget` の失敗時のテストです。所有者またはボードが存在しない場合は、それぞれを示すメッセージの `GitHubNotFoundError` が発生することを確認します。')
    const { client } = await startClient([
      graphqlData('GetProjectViewTarget', { repositoryOwner: JSON_NULL }),
      graphqlData('GetProjectViewTarget', { repositoryOwner: { __typename: 'Organization', projectV2: JSON_NULL } }),
    ])
    expect(await rejection(client.getProjectViewTarget('nobody', 3))).toMatchObject(failure(GitHubNotFoundError, 'owner not found: nobody'))
    expect(await rejection(client.getProjectViewTarget('acme', 3))).toMatchObject(failure(GitHubNotFoundError, 'project not found: acme/projects/3'))
  })
})

describe('createProjectView', () => {
  const body: ProjectViewBody = { name: 'Lanes', layout: 'board', vertical_group_by: [11], group_by: [22] }
  const view = { id: 7, number: 2, name: 'Lanes', layout: 'board', html_url: 'https://github.com/orgs/acme/projects/3/views/2' }
  const target = { owner: 'acme', number: 3, url: 'https://github.com/orgs/acme/projects/3', views: [], fieldDatabaseIds: new Map<string, number>() }

  it('組織のボードは、/orgs/{org}/projectsV2/{number}/views へ本文の 4 つの項目を POST し、作成したビューを返す', async () => {
    await explains('`createProjectView` のテストです。組織のボードの場合は、`/orgs/{org}/projectsV2/{number}/views` へ本文の 4 つの項目を POST し、作成したビューを返すことを確認します。')
    const { client, server } = await startClient([restResponse('POST', '/orgs/acme/projectsV2/3/views', { status: 201, body: view })])
    expect(await client.createProjectView({ ...target, ownerKind: 'Organization', userId: undefined }, body)).toEqual(view)
    expect(restRequests(server).map(({ method, path, body: sent }) => ({ method, path, body: sent }))).toEqual([{ method: 'POST', path: '/orgs/acme/projectsV2/3/views', body }])
  })

  it('個人のボードは、/users/{user_id}/projectsV2/{number}/views へ数値の ID を使って POST する', async () => {
    await explains('`createProjectView` のテストです。個人のボードの場合は、`/users/{user_id}/projectsV2/{number}/views` へ数値の ID を使って POST することを確認します。')
    const { client, server } = await startClient([restResponse('POST', '/users/4242/projectsV2/3/views', { status: 201, body: view })])
    await client.createProjectView({ ...target, owner: 'someone', ownerKind: 'User', userId: 4242 }, body)
    expect(restRequests(server).map(request => request.path)).toEqual(['/users/4242/projectsV2/3/views'])
  })

  it('組織の名前に空白が含まれる場合は、パスの 1 区間として符号化して送信する', async () => {
    await explains('`createProjectView` のテストです。組織の名前に空白が含まれる場合は、パスの 1 区間として符号化して送信することを確認します。')
    const { client, server } = await startClient([restResponse('POST', '/orgs/a%20b/projectsV2/3/views', { status: 201, body: view })])
    await client.createProjectView({ ...target, owner: 'a b', ownerKind: 'Organization', userId: undefined }, body)
    expect(restRequests(server).map(request => request.path)).toEqual(['/orgs/a%20b/projectsV2/3/views'])
  })

  it('個人のボードで userId が存在しない場合は、リクエストを送信せず、GitHubAPIError が発生する', async () => {
    await explains('`createProjectView` の失敗時のテストです。個人のボードで `userId` が存在しない場合は、リクエストを送信せず、`GitHubAPIError` が発生することを確認します。')
    const { client, server } = await startClient([])
    expect(await rejection(client.createProjectView({ ...target, ownerKind: 'User', userId: undefined }, body))).toMatchObject(failure(GitHubAPIError, 'could not read the user id of acme'))
    expect(restRequests(server)).toEqual([])
  })

  it('404 の場合は GitHubNotFoundError、403 の場合は状態コードを保持した GitHubAPIError が発生する', async () => {
    await explains('`createProjectView` の失敗時のテストです。状態コード 404 の場合は `GitHubNotFoundError`、403 の場合は状態コードを保持した `GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([
      restResponse('POST', '/orgs/acme/projectsV2/3/views', { status: 404, body: { message: 'Not Found' } }),
      restResponse('POST', '/orgs/acme/projectsV2/3/views', { status: 403, body: { message: 'Resource not accessible by integration' } }),
    ])
    const organization: ProjectViewTarget = { ...target, ownerKind: 'Organization', userId: undefined }
    expect(await rejection(client.createProjectView(organization, body))).toMatchObject({ name: 'GitHubNotFoundError', statusCode: 404 })
    expect(await rejection(client.createProjectView(organization, body))).toMatchObject(failure(GitHubAPIError, 'access denied', { statusCode: 403 }))
  })
})
