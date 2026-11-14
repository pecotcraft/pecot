// ProjectsApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// user のクエリが失敗したら organization を試す流れは、GitHub が返す失敗（errors を 200 で返す）で確かめる。
import { describe, expect, it, vi } from 'vitest'

import { JSON_NULL } from '../../../domain/json-null.js'
import { GitHubAPIError, GitHubNotFoundError } from '../errors.js'
import { failure, graphqlData, graphqlError, graphqlRequests, rejection, startClient, useFakeGithub } from './fake-client.js'

useFakeGithub()

function page(nodes: readonly unknown[], hasNextPage: boolean, endCursor: unknown): unknown {
  return { node: { items: { nodes, pageInfo: { hasNextPage, endCursor } } } }
}

function archivedItem(id: string, status: string): unknown {
  return { id, fieldValues: { nodes: [{ field: { name: 'pecot-workflow' }, name: status }] } }
}

function archivedItems(prefix: string, count: number): readonly unknown[] {
  return Array.from({ length: count }, (_unused, index) => archivedItem(`${prefix}${String(index)}`, 'Archived'))
}

describe('listProjectItems', () => {
  it('1 ページ分を返す。最初の cursor は null', async () => {
    const { client, server } = await startClient([graphqlData('ListProjectItems', page([{ id: 'item1' }, { id: 'item2' }], false, JSON_NULL))])
    expect(await client.listProjectItems('PVT_test123')).toEqual([{ id: 'item1' }, { id: 'item2' }])
    expect(graphqlRequests(server)).toEqual([{ operation: 'ListProjectItems', variables: { projectId: 'PVT_test123', cursor: JSON_NULL } }])
  })

  it('hasNextPage の間、endCursor を次の cursor に送って辿る', async () => {
    const { client, server } = await startClient([
      graphqlData('ListProjectItems', page([{ id: 'item1' }], true, 'cursor1')),
      graphqlData('ListProjectItems', page([{ id: 'item2' }], false, JSON_NULL)),
    ])
    expect(await client.listProjectItems('PVT_test123')).toEqual([{ id: 'item1' }, { id: 'item2' }])
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([
      { projectId: 'PVT_test123', cursor: JSON_NULL },
      { projectId: 'PVT_test123', cursor: 'cursor1' },
    ])
  })

  it('limit に達したら次のページを取らずに切り詰める', async () => {
    const nodes = Array.from({ length: 10 }, (_unused, index) => ({ id: `item${String(index)}` }))
    const { client, server } = await startClient([graphqlData('ListProjectItems', page(nodes, true, 'cursor'))])
    const result = await client.listProjectItems('PVT_test123', { limit: 5 })
    expect(result.map(item => item['id'])).toEqual(['item0', 'item1', 'item2', 'item3', 'item4'])
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('limit が 0 なら制限しない', async () => {
    const { client } = await startClient([graphqlData('ListProjectItems', page([{ id: 'a' }, { id: 'b' }], false, JSON_NULL))])
    expect(await client.listProjectItems('PVT_test123', { limit: 0 })).toHaveLength(2)
  })

  it('node が null なら空', async () => {
    const { client } = await startClient([graphqlData('ListProjectItems', { node: JSON_NULL })])
    expect(await client.listProjectItems('PVT_invalid')).toEqual([])
  })

  it('items が無ければ空（次のページも無い）', async () => {
    const { client } = await startClient([graphqlData('ListProjectItems', { node: { id: 'PVT' } })])
    expect(await client.listProjectItems('PVT')).toEqual([])
  })

  it('オブジェクトでない要素（null）は結果に入れない', async () => {
    const { client } = await startClient([graphqlData('ListProjectItems', page([{ id: 'a' }, JSON_NULL], false, JSON_NULL))])
    expect(await client.listProjectItems('PVT')).toEqual([{ id: 'a' }])
  })

  it('excludeArchived は Archived のアイテムを除く。フィールド名は大文字小文字を区別しない', async () => {
    const items = [
      archivedItem('a', 'Archived'),
      archivedItem('b', 'Active'),
      { id: 'c', fieldValues: { nodes: [JSON_NULL, { field: { name: 'other' }, name: 'Archived' }] } },
      { id: 'd' },
      archivedItem('e', 'archived'),
    ]
    const { client } = await startClient([graphqlData('ListProjectItems', page(items, false, JSON_NULL))])
    const result = await client.listProjectItems('PVT', { excludeArchived: true, workflowFieldName: 'PECOT-Workflow' })
    expect(result.map(item => item['id'])).toEqual(['b', 'c', 'd'])
  })

  it('excludeArchived で連続 50 件 Archived が続いたら、次のページを取らずに打ち切る', async () => {
    const items = [archivedItem('keep', 'Ready'), ...archivedItems('x', 50)]
    const { client, server } = await startClient([graphqlData('ListProjectItems', page(items, true, 'next'))])
    const result = await client.listProjectItems('PVT', { excludeArchived: true, workflowFieldName: 'pecot-workflow' })
    expect(result.map(item => item['id'])).toEqual(['keep'])
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('Archived でないアイテムが挟まれば、連続の数は 0 に戻る', async () => {
    const items = [...archivedItems('a', 49), archivedItem('mid', 'Ready'), ...archivedItems('b', 49)]
    const { client, server } = await startClient([graphqlData('ListProjectItems', page(items, false, JSON_NULL))])
    const result = await client.listProjectItems('PVT', { excludeArchived: true, workflowFieldName: 'pecot-workflow' })
    expect(result.map(item => item['id'])).toEqual(['mid'])
    expect(graphqlRequests(server)).toHaveLength(1)
  })
})

describe('listProjectItems の古い GHES への読み直し', () => {
  it.for(['Field \'blockedBy\' doesn\'t exist on type \'Issue\'', 'Cannot query field "parent" on type "Issue"'])('着手の判定のフィールド（%s）のスキーマの失敗は、足す前のクエリで先頭から読み直す', async (message) => {
    const { client, server } = await startClient([graphqlError('ListProjectItems', message), graphqlData('ListProjectItemsLegacy', page([{ id: 'a' }], false, JSON_NULL))])
    const onLegacy = vi.fn()
    expect(await client.listProjectItems('PVT', { onLegacy })).toEqual([{ id: 'a' }])
    expect(onLegacy).toHaveBeenCalledTimes(1)
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['ListProjectItems', 'ListProjectItemsLegacy'])
  })

  it('フィールド名でないところに parent を含むスキーマの失敗は、読み直さずに投げる', async () => {
    const { client, server } = await startClient([graphqlError('ListProjectItems', 'Field \'labels\' doesn\'t exist on type \'Issue\' (parent query)')])
    expect(await rejection(client.listProjectItems('PVT'))).toBeInstanceOf(GitHubAPIError)
    expect(graphqlRequests(server)).toHaveLength(1)
  })
})

describe('listProjectItems の cursor', () => {
  it.each([JSON_NULL, 5])('hasNextPage が真で endCursor が %j なら、同じページを取り続けずに GitHubAPIError', async (endCursor) => {
    const { client, server } = await startClient([graphqlData('ListProjectItems', page([{ id: 'a' }], true, endCursor))])
    expect(await rejection(client.listProjectItems('PVT'))).toMatchObject(failure(GitHubAPIError, 'could not get the cursor for the next page'))
    expect(graphqlRequests(server)).toHaveLength(1)
  })
})

describe('アイテムの追加・更新・削除', () => {
  it('addToProject はアイテム ID を返す', async () => {
    const { client, server } = await startClient([graphqlData('AddToProject', { addProjectV2ItemById: { item: { id: 'PVTI_test123' } } })])
    expect(await client.addToProject('PVT_proj', 'I_issue')).toBe('PVTI_test123')
    expect(graphqlRequests(server)).toEqual([{ operation: 'AddToProject', variables: { projectId: 'PVT_proj', contentId: 'I_issue' } }])
  })

  it('addToProject は item が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('AddToProject', { addProjectV2ItemById: { item: JSON_NULL } })])
    expect(await rejection(client.addToProject('PVT_proj', 'I_issue'))).toMatchObject(failure(GitHubAPIError, 'failed to add the item to the project'))
  })

  it('updateProjectItemField はアイテム ID を返す', async () => {
    const { client, server } = await startClient([graphqlData('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_test' } } })])
    expect(await client.updateProjectItemField('PVT_proj', 'PVTI_item', 'FIELD_id', 'OPT_id')).toBe('PVTI_test')
    expect(graphqlRequests(server)).toEqual([{
      operation: 'UpdateProjectItemField',
      variables: { projectId: 'PVT_proj', itemId: 'PVTI_item', fieldId: 'FIELD_id', optionId: 'OPT_id' },
    }])
  })

  it('updateProjectItemField は projectV2Item が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: JSON_NULL } })])
    expect(await rejection(client.updateProjectItemField('PVT_proj', 'PVTI_item', 'FIELD_id', 'OPT_id'))).toMatchObject(failure(GitHubAPIError, 'failed to update the field'))
  })

  it('deleteProjectItem は削除したアイテムの ID を返す', async () => {
    const { client, server } = await startClient([graphqlData('DeleteProjectItem', { deleteProjectV2Item: { deletedItemId: 'PVTI_deleted' } })])
    expect(await client.deleteProjectItem('PVT_proj', 'PVTI_item')).toBe('PVTI_deleted')
    expect(graphqlRequests(server)).toEqual([{ operation: 'DeleteProjectItem', variables: { projectId: 'PVT_proj', itemId: 'PVTI_item' } }])
  })

  it('unarchiveProjectItem は projectId と itemId を送る', async () => {
    const { client, server } = await startClient([graphqlData('UnarchiveProjectItem', { unarchiveProjectV2Item: { item: { id: 'PVTI_item' } } })])
    await client.unarchiveProjectItem('PVT_proj', 'PVTI_item')
    expect(graphqlRequests(server)).toEqual([{ operation: 'UnarchiveProjectItem', variables: { projectId: 'PVT_proj', itemId: 'PVTI_item' } }])
  })

  it('unarchiveProjectItem は item が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('UnarchiveProjectItem', { unarchiveProjectV2Item: { item: JSON_NULL } })])
    expect(await rejection(client.unarchiveProjectItem('PVT_proj', 'PVTI_item'))).toMatchObject(failure(GitHubAPIError, 'failed to unarchive the project item'))
  })

  it('deleteProjectItem は deletedItemId が null なら GitHubAPIError', async () => {
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

  it('user のクエリが成功すれば、そこで終わる（null ノードは落とす）', async () => {
    const { client, server } = await startClient([graphqlData('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes } } } })])
    expect(await client.getLinkedRepositories('testuser', 1)).toEqual([{ owner: 'owner1', name: 'repo1' }, { owner: 'owner2', name: 'repo2' }])
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetLinkedRepositoriesUser', variables: { owner: 'testuser', projectNumber: 1 } }])
  })

  it('user が null なら organization のクエリに進む', async () => {
    const { client, server } = await startClient([
      graphqlData('GetLinkedRepositoriesUser', { user: JSON_NULL }),
      graphqlData('GetLinkedRepositoriesOrg', { organization: { projectV2: { repositories: { nodes: [{ owner: { login: 'org' }, name: 'repo' }] } } } }),
    ])
    expect(await client.getLinkedRepositories('testorg', 1)).toEqual([{ owner: 'org', name: 'repo' }])
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetLinkedRepositoriesUser', 'GetLinkedRepositoriesOrg'])
  })

  it('user のクエリが GraphQL の失敗（owner が organization のとき）でも organization に進む', async () => {
    const { client } = await startClient([
      graphqlError('GetLinkedRepositoriesUser', 'Could not resolve to a User with the login of \'testorg\'.'),
      graphqlData('GetLinkedRepositoriesOrg', { organization: { projectV2: { repositories: { nodes: [{ owner: { login: 'org' }, name: 'repo' }] } } } }),
    ])
    expect(await client.getLinkedRepositories('testorg', 1)).toEqual([{ owner: 'org', name: 'repo' }])
  })

  it('どちらも無ければ空', async () => {
    const { client } = await startClient([
      graphqlData('GetLinkedRepositoriesUser', { user: JSON_NULL }),
      graphqlData('GetLinkedRepositoriesOrg', { organization: JSON_NULL }),
    ])
    expect(await client.getLinkedRepositories('unknown', 1)).toEqual([])
  })

  it('organization のクエリの失敗は例外にする', async () => {
    const { client } = await startClient([
      graphqlData('GetLinkedRepositoriesUser', { user: JSON_NULL }),
      graphqlError('GetLinkedRepositoriesOrg', 'Something broke'),
    ])
    expect(await rejection(client.getLinkedRepositories('x', 1))).toMatchObject({ name: 'GitHubAPIError' })
  })

  it('getLinkedRepositoriesCached と linkedRepositories は、同じ引数の 2 回目からキャッシュを返す', async () => {
    const { client, server } = await startClient([graphqlData('GetLinkedRepositoriesUser', { user: { projectV2: { repositories: { nodes } } } })])
    const first = await client.getLinkedRepositoriesCached('testuser', 1)
    const second = await client.linkedRepositories('testuser', 1)
    expect(second).toEqual(first)
    expect(second).toHaveLength(2)
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('キャッシュは owner と番号ごと', async () => {
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
  it('認証エラー（401）でも org のクエリに進み、org も 401 なら GitHubAuthError', async () => {
    const unauthorized = { status: 401, text: 'Bad credentials' }
    const { client, server } = await startClient([
      { match: { operation: 'GetLinkedRepositoriesUser' }, respond: unauthorized, times: 1 },
      { match: { operation: 'GetLinkedRepositoriesOrg' }, respond: unauthorized, times: 1 },
    ])
    expect(await rejection(client.getLinkedRepositories('o', 1))).toMatchObject({ name: 'GitHubAuthError' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetLinkedRepositoriesUser', 'GetLinkedRepositoriesOrg'])
  })

  it('レート制限でも org のクエリに進み、org も同じなら GitHubRateLimitError', async () => {
    const { client, server } = await startClient([
      graphqlError('ListProjectsUser', 'API rate limit exceeded'),
      graphqlError('ListProjectsOrg', 'API rate limit exceeded'),
    ])
    expect(await rejection(client.listProjects('o'))).toMatchObject({ name: 'GitHubRateLimitError' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['ListProjectsUser', 'ListProjectsOrg'])
  })
})

describe('getProjectId', () => {
  it('user にプロジェクトがあれば、その ID を返す', async () => {
    const { client } = await startClient([graphqlData('GetProjectIdUser', { user: { projectV2: { id: 'PVT_test123' } } })])
    expect(await client.getProjectId('testuser', 1)).toBe('PVT_test123')
  })

  it('user に無ければ organization のプロジェクトの ID', async () => {
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

  it('どちらにも無ければ GitHubNotFoundError', async () => {
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
    ['isArchived が無い', undefined, false],
  ])('%s のアイテムは、ID とアーカイブ済みか（%s → %s）を返す', async (_label, isArchived, expected) => {
    const { client } = await startClient([graphqlData('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [
      { id: 'PVTI_item1', ...isArchived !== undefined && { isArchived }, project: { id: 'PVT_proj' } },
    ] } } } })])
    expect(await client.getIssueProjectItem('PVT_proj', 'owner', 'repo', 123)).toEqual({ id: 'PVTI_item1', isArchived: expected })
  })

  it('指定のプロジェクトに紐づかなければ undefined', async () => {
    const { client } = await startClient([graphqlData('GetIssueProjectItems', { repository: { issue: { projectItems: { nodes: [
      { id: 'PVTI_item1', isArchived: true, project: { id: 'PVT_other' } },
    ] } } } })])
    expect(await client.getIssueProjectItem('PVT_proj', 'owner', 'repo', 123)).toBeUndefined()
  })
})

describe('getItemIdByIssue', () => {
  it('指定のプロジェクトのアイテム ID を返す', async () => {
    const { result, variables } = await lookup({ repository: { issue: { projectItems: { nodes: [
      { id: 'PVTI_item1', project: { id: 'PVT_proj' } },
      { id: 'PVTI_item2', project: { id: 'PVT_other' } },
    ] } } } })
    expect(result).toBe('PVTI_item1')
    expect(variables).toEqual([{ owner: 'owner', repo: 'repo', number: 123 }])
  })

  it('null のアイテムは飛ばす', async () => {
    const { result } = await lookup({ repository: { issue: { projectItems: { nodes: [JSON_NULL, { id: 'PVTI_item1', project: { id: 'PVT_proj' } }] } } } })
    expect(result).toBe('PVTI_item1')
  })

  it.each([
    ['Issue が無い', { repository: { issue: JSON_NULL } }],
    ['リポジトリが無い', { repository: JSON_NULL }],
    ['別のプロジェクトにだけ紐づく', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_item1', project: { id: 'PVT_other' } }] } } } }],
    ['どのプロジェクトにも紐づかない', { repository: { issue: { projectItems: { nodes: [] } } } }],
  ])('%sときは undefined', async (_label, response) => {
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
    const { client, server } = await startClient([graphqlData('GetIssueBoardItem', boardItemIssue([
      { id: 'PVTI_other', project: { id: 'PVT_other' }, workflow: { name: 'Ready' } },
      JSON_NULL,
      { id: 'PVTI_13', project: { id: 'PVT_proj' }, workflow: { name: 'Blocked' } },
    ]))])
    expect(await client.getIssueBoardItem('PVT_proj', 'acme', 'other', 13, 'pecot-workflow-x')).toEqual({
      id: 'PVTI_13',
      workflow: 'Blocked',
      title: '課題13',
      content: { number: 13, state: 'OPEN', url: 'https://github.com/acme/other/issues/13', repository: 'acme/other' },
    })
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetIssueBoardItem', variables: { owner: 'acme', repo: 'other', number: 13, workflowFieldName: 'pecot-workflow-x' } }])
  })

  it('進行の列に値が無ければ、workflow を null にする', async () => {
    const { client } = await startClient([graphqlData('GetIssueBoardItem', boardItemIssue([{ id: 'PVTI_13', project: { id: 'PVT_proj' }, workflow: JSON_NULL }]))])
    expect(await client.getIssueBoardItem('PVT_proj', 'acme', 'other', 13, 'pecot-workflow-x')).toMatchObject({ id: 'PVTI_13', workflow: JSON_NULL })
  })

  it.each([
    ['Issue が無い', { repository: { issue: JSON_NULL } }],
    ['リポジトリが無い', { repository: JSON_NULL }],
    ['別のプロジェクトにだけ載っている', boardItemIssue([{ id: 'PVTI_x', project: { id: 'PVT_other' }, workflow: JSON_NULL }])],
    ['どのプロジェクトにも載っていない', boardItemIssue([])],
  ])('%sときは undefined', async (_label, response) => {
    const { client } = await startClient([graphqlData('GetIssueBoardItem', response)])
    expect(await client.getIssueBoardItem('PVT_proj', 'acme', 'other', 13, 'pecot-workflow-x')).toBeUndefined()
  })

  it('項目 ID が文字列でなければ GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('GetIssueBoardItem', boardItemIssue([{ id: 5, project: { id: 'PVT_proj' }, workflow: JSON_NULL }]))])
    expect(await rejection(client.getIssueBoardItem('PVT_proj', 'acme', 'other', 13, 'pecot-workflow-x'))).toMatchObject(failure(GitHubAPIError, 'malformed GitHub response: projectItems.nodes.id'))
  })
})

describe('linkRepositoryToProject', () => {
  const projectFound = graphqlData('GetProjectIdUser', { user: { projectV2: { id: 'PVT_proj' } } })
  const repositoryFound = graphqlData('GetRepositoryId', { repository: { id: 'R_repo' } })

  it('リンクに成功したら linked を返す', async () => {
    const { client, server } = await startClient([
      projectFound,
      repositoryFound,
      graphqlData('LinkProjectRepository', { linkProjectV2ToRepository: { repository: { id: 'R_repo', nameWithOwner: 'owner/repo' } } }),
    ])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ status: 'linked', detail: '' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetProjectIdUser', 'GetRepositoryId', 'LinkProjectRepository'])
    expect(graphqlRequests(server).at(2)?.variables).toEqual({ projectId: 'PVT_proj', repositoryId: 'R_repo' })
  })

  it.each(['already linked', 'Repository already exists in project'])('「%s」の失敗は、already_linked にして GitHub の message を detail に入れる', async (message) => {
    const { client } = await startClient([projectFound, repositoryFound, graphqlError('LinkProjectRepository', message)])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ status: 'already_linked', detail: `GraphQL query error: {'message': '${message}'}` })
  })

  it('プロジェクトが無ければ失敗（メッセージは GitHubNotFoundError の文）', async () => {
    const { client } = await startClient([
      graphqlData('GetProjectIdUser', { user: JSON_NULL }),
      graphqlData('GetProjectIdOrg', { organization: JSON_NULL }),
    ])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({
      status: 'failed',
      detail: 'project not found: owner/projects/1',
    })
  })

  it('リポジトリが無ければ失敗', async () => {
    const { client } = await startClient([projectFound, graphqlData('GetRepositoryId', { repository: JSON_NULL })])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'nonexistent')).toEqual({
      status: 'failed',
      detail: 'repository not found: owner/nonexistent',
    })
  })

  it('その他の API エラーは失敗（メッセージに GraphQL の文を含める）', async () => {
    const { client } = await startClient([projectFound, repositoryFound, graphqlError('LinkProjectRepository', 'Some API error')])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({
      status: 'failed',
      detail: 'GraphQL query error: {\'message\': \'Some API error\'}',
    })
  })

  it('repository が null のレスポンスはunexpected response', async () => {
    const { client } = await startClient([projectFound, repositoryFound, graphqlData('LinkProjectRepository', { linkProjectV2ToRepository: { repository: JSON_NULL } })])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ status: 'failed', detail: 'unexpected response' })
  })

  it('nameWithOwner が無くても linked', async () => {
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

  it('user のプロジェクトを返す（null は落とす）。first の既定は 20', async () => {
    const { client, server } = await startClient([graphqlData('ListProjectsUser', { user: { projectsV2: { nodes: projects } } })])
    expect(await client.listProjects('u')).toEqual([projects[0], projects[2]])
    expect(graphqlRequests(server)).toEqual([{ operation: 'ListProjectsUser', variables: { owner: 'u', first: 20 } }])
  })

  it('user に無いとき organization のプロジェクトを返し、first を変数に送る', async () => {
    const { client, server } = await startClient([
      graphqlData('ListProjectsUser', { user: JSON_NULL }),
      graphqlData('ListProjectsOrg', { organization: { projectsV2: { nodes: [projects[0]] } } }),
    ])
    expect(await client.listProjects('o', 5)).toEqual([projects[0]])
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([{ owner: 'o', first: 5 }, { owner: 'o', first: 5 }])
  })

  it('どちらも無ければ空', async () => {
    const { client } = await startClient([graphqlData('ListProjectsUser', { user: JSON_NULL }), graphqlData('ListProjectsOrg', { organization: JSON_NULL })])
    expect(await client.listProjects('nobody')).toEqual([])
  })
})

describe('getProjectFields', () => {
  const project = { id: 'PVT_1', title: 'P', url: 'https://github.com/users/u/projects/1', fields: { nodes: [{ id: 'F1', name: 'Status' }] } }

  it('user のプロジェクトを返す', async () => {
    const { client, server } = await startClient([graphqlData('GetProjectFieldsUser', { user: { projectV2: project } })])
    expect(await client.getProjectFields('u', 1)).toEqual(project)
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetProjectFieldsUser', variables: { owner: 'u', projectNumber: 1 } }])
  })

  it('user に無ければ organization のプロジェクトを返す', async () => {
    const { client } = await startClient([graphqlData('GetProjectFieldsUser', { user: JSON_NULL }), graphqlData('GetProjectFieldsOrg', { organization: { projectV2: project } })])
    expect(await client.getProjectFields('o', 1)).toEqual(project)
  })

  it('どちらにも無ければ undefined', async () => {
    const { client } = await startClient([graphqlData('GetProjectFieldsUser', { user: JSON_NULL }), graphqlData('GetProjectFieldsOrg', { organization: JSON_NULL })])
    expect(await client.getProjectFields('nobody', 1)).toBeUndefined()
  })
})

describe('createProjectField', () => {
  const options = [
    { name: 'Backlog', color: 'RED', description: 'Epic置き場' },
    { name: 'Ready', color: 'GREEN', description: '未着手' },
  ]

  it('作ったフィールドを返す。変数は projectId・name・options', async () => {
    const created = { id: 'PVTSSF_new123', name: 'pecot-workflow', options: [{ id: 'opt1', name: 'Backlog' }, { id: 'opt2', name: 'Ready' }] }
    const { client, server } = await startClient([graphqlData('CreateProjectField', { createProjectV2Field: { projectV2Field: created } })])
    expect(await client.createProjectField('PVT_test123', 'pecot-workflow', options)).toEqual(created)
    expect(graphqlRequests(server)).toEqual([{ operation: 'CreateProjectField', variables: { projectId: 'PVT_test123', name: 'pecot-workflow', options } }])
  })

  it('projectV2Field が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('CreateProjectField', { createProjectV2Field: { projectV2Field: JSON_NULL } })])
    expect(await rejection(client.createProjectField('PVT_test123', 'pecot-workflow', options))).toMatchObject(failure(GitHubAPIError, 'failed to create the field'))
  })

  it('GraphQL の失敗は GraphQLクエリ実行エラー', async () => {
    const { client } = await startClient([graphqlError('CreateProjectField', 'GraphQL error')])
    expect(await rejection(client.createProjectField('PVT_test123', 'pecot-workflow', options))).toMatchObject(
      failure(GitHubAPIError, 'GraphQL query error: {\'message\': \'GraphQL error\'}'),
    )
  })
})

describe('updateProjectFieldOptions', () => {
  const options = [
    { id: 'opt1', name: 'Backlog', color: 'RED', description: 'Epic置き場' },
    { name: 'Blocked', color: 'ORANGE', description: '待ち' },
  ]

  it('更新後のフィールドを返す。変数は fieldId・options で、options は id 付きのまま送る', async () => {
    const updated = { id: 'PVTSSF_f1', name: 'pecot-workflow', options: [{ id: 'opt1', name: 'Backlog' }, { id: 'opt9', name: 'Blocked' }] }
    const { client, server } = await startClient([graphqlData('UpdateProjectField', { updateProjectV2Field: { projectV2Field: updated } })])
    expect(await client.updateProjectFieldOptions('PVTSSF_f1', options)).toEqual(updated)
    expect(graphqlRequests(server)).toEqual([{ operation: 'UpdateProjectField', variables: { fieldId: 'PVTSSF_f1', options } }])
  })

  it('projectV2Field が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('UpdateProjectField', { updateProjectV2Field: { projectV2Field: JSON_NULL } })])
    expect(await rejection(client.updateProjectFieldOptions('PVTSSF_f1', options))).toMatchObject(failure(GitHubAPIError, 'failed to update the field'))
  })

  it('GraphQL の失敗は GraphQLクエリ実行エラー', async () => {
    const { client } = await startClient([graphqlError('UpdateProjectField', 'GraphQL error')])
    expect(await rejection(client.updateProjectFieldOptions('PVTSSF_f1', options))).toMatchObject(
      failure(GitHubAPIError, 'GraphQL query error: {\'message\': \'GraphQL error\'}'),
    )
  })
})

describe('getOwnerNodeId', () => {
  it('user の Node ID を返し、login を変数に送る', async () => {
    const { client, server } = await startClient([graphqlData('GetUserNodeId', { user: { id: 'U_kgDOtest123' } })])
    expect(await client.getOwnerNodeId('testuser')).toBe('U_kgDOtest123')
    expect(graphqlRequests(server)).toEqual([{ operation: 'GetUserNodeId', variables: { login: 'testuser' } }])
  })

  it('user に無ければ organization の Node ID', async () => {
    const { client, server } = await startClient([
      graphqlData('GetUserNodeId', { user: JSON_NULL }),
      graphqlData('GetOrgNodeId', { organization: { id: 'O_kgDOorg456' } }),
    ])
    expect(await client.getOwnerNodeId('testorg')).toBe('O_kgDOorg456')
    expect(graphqlRequests(server).map(({ variables }) => variables)).toEqual([{ login: 'testorg' }, { login: 'testorg' }])
  })

  it('user のクエリが GraphQL の失敗（owner が organization のとき）でも organization に進む', async () => {
    const { client } = await startClient([
      graphqlError('GetUserNodeId', 'Could not resolve to a User with the login of \'testorg\'.'),
      graphqlData('GetOrgNodeId', { organization: { id: 'O_kgDOorg456' } }),
    ])
    expect(await client.getOwnerNodeId('testorg')).toBe('O_kgDOorg456')
  })

  it('user のクエリの認証エラーでも org に進み、org も 401 なら GitHubAuthError', async () => {
    const { client, server } = await startClient([
      { match: { operation: 'GetUserNodeId' }, respond: { status: 401, text: 'x' }, times: 1 },
      { match: { operation: 'GetOrgNodeId' }, respond: { status: 401, text: 'x' }, times: 1 },
    ])
    expect(await rejection(client.getOwnerNodeId('o'))).toMatchObject({ name: 'GitHubAuthError' })
    expect(graphqlRequests(server)).toHaveLength(2)
  })

  it('どちらにも無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetUserNodeId', { user: JSON_NULL }), graphqlData('GetOrgNodeId', { organization: JSON_NULL })])
    expect(await rejection(client.getOwnerNodeId('nonexistent'))).toMatchObject(failure(GitHubNotFoundError, 'owner not found: nonexistent'))
  })
})

describe('createProject', () => {
  it('作ったプロジェクトを返す。変数は ownerId・title', async () => {
    const created = { id: 'PVT_kwHOtest123', number: 42, title: 'New Project', url: 'https://github.com/users/owner/projects/42' }
    const { client, server } = await startClient([graphqlData('CreateProject', { createProjectV2: { projectV2: created } })])
    expect(await client.createProject('U_owner123', 'New Project')).toEqual(created)
    expect(graphqlRequests(server)).toEqual([{ operation: 'CreateProject', variables: { ownerId: 'U_owner123', title: 'New Project' } }])
  })

  it('projectV2 が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('CreateProject', { createProjectV2: { projectV2: JSON_NULL } })])
    expect(await rejection(client.createProject('U_owner123', 'New Project'))).toMatchObject(failure(GitHubAPIError, 'failed to create the project'))
  })

  it('GraphQL の失敗は GitHubAPIError', async () => {
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
  it('指定のプロジェクトの指定のアイテムの、値が入っているフィールド ID を返す', async () => {
    const { result, variables } = await lookupSetFieldIds({ repository: { issue: { projectItems: { nodes: [
      { id: 'PVTI_other', project: { id: 'PVT_proj' }, fieldValues: { nodes: [fieldValue('F_other')] } },
      { id: 'PVTI_item', project: { id: 'PVT_other' }, fieldValues: { nodes: [fieldValue('F_wrong_project')] } },
      { id: 'PVTI_item', project: { id: 'PVT_proj' }, fieldValues: { nodes: [fieldValue('F_workflow'), {}, JSON_NULL, fieldValue(1), fieldValue('F_priority')] } },
    ] } } } })
    expect(result).toEqual(new Set(['F_workflow', 'F_priority']))
    expect(variables).toEqual([{ owner: 'owner', repo: 'repo', number: 123 }])
  })

  it.each([
    ['Issue が無い', { repository: { issue: JSON_NULL } }],
    ['リポジトリが無い', { repository: JSON_NULL }],
    ['アイテムが無い', { repository: { issue: { projectItems: { nodes: [] } } } }],
    ['値が入っていない', { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_item', project: { id: 'PVT_proj' }, fieldValues: { nodes: [] } }] } } } }],
  ])('%sときは空', async (_label, response) => {
    const { result } = await lookupSetFieldIds(response)
    expect(result.size).toBe(0)
  })
})
