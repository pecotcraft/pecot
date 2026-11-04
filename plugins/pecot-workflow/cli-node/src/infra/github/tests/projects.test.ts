// ProjectsApi のテスト。GitHub は偽サーバ（tests/fake-github）にする。
// 対応する Python のテストは cli/tests/core/test_github.py（対応表は .pecot/work/1315/test-map-D2.md）。
// user のクエリが失敗したら organization を試す流れは、GitHub が返す失敗（errors を 200 で返す）で確かめる。
import { describe, expect, it } from 'vitest'

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

describe('listProjectItems の cursor', () => {
  it.each([JSON_NULL, 5])('hasNextPage が真で endCursor が %j なら、同じページを取り続けずに GitHubAPIError', async (endCursor) => {
    const { client, server } = await startClient([graphqlData('ListProjectItems', page([{ id: 'a' }], true, endCursor))])
    expect(await rejection(client.listProjectItems('PVT'))).toMatchObject(failure(GitHubAPIError, 'ページ送りの cursor が得られませんでした'))
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
    expect(await rejection(client.addToProject('PVT_proj', 'I_issue'))).toMatchObject(failure(GitHubAPIError, 'プロジェクトへの追加に失敗しました'))
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
    expect(await rejection(client.updateProjectItemField('PVT_proj', 'PVTI_item', 'FIELD_id', 'OPT_id'))).toMatchObject(failure(GitHubAPIError, 'フィールドの更新に失敗しました'))
  })

  it('deleteProjectItem は削除したアイテムの ID を返す', async () => {
    const { client, server } = await startClient([graphqlData('DeleteProjectItem', { deleteProjectV2Item: { deletedItemId: 'PVTI_deleted' } })])
    expect(await client.deleteProjectItem('PVT_proj', 'PVTI_item')).toBe('PVTI_deleted')
    expect(graphqlRequests(server)).toEqual([{ operation: 'DeleteProjectItem', variables: { projectId: 'PVT_proj', itemId: 'PVTI_item' } }])
  })

  it('deleteProjectItem は deletedItemId が null なら GitHubAPIError', async () => {
    const { client } = await startClient([graphqlData('DeleteProjectItem', { deleteProjectV2Item: { deletedItemId: JSON_NULL } })])
    expect(await rejection(client.deleteProjectItem('PVT_proj', 'PVTI_item'))).toMatchObject(failure(GitHubAPIError, 'プロジェクトアイテムの削除に失敗しました'))
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
  it('認証エラー（401）は org のクエリに進まず、GitHubAuthError', async () => {
    const { client, server } = await startClient([{ match: { operation: 'GetLinkedRepositoriesUser' }, respond: { status: 401, text: 'Bad credentials' }, times: 1 }])
    expect(await rejection(client.getLinkedRepositories('o', 1))).toMatchObject({ name: 'GitHubAuthError' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetLinkedRepositoriesUser'])
  })

  it('レート制限は org のクエリに進まず、GitHubRateLimitError', async () => {
    const { client, server } = await startClient([graphqlError('ListProjectsUser', 'API rate limit exceeded')])
    expect(await rejection(client.listProjects('o'))).toMatchObject({ name: 'GitHubRateLimitError' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['ListProjectsUser'])
  })
})

describe('getProjectId', () => {
  it('user のプロジェクトの ID', async () => {
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
    expect(await rejection(client.getProjectId('nobody', 99))).toMatchObject(failure(GitHubNotFoundError, 'プロジェクトが見つかりません: nobody/projects/99'))
  })
})

async function lookup(response: unknown): Promise<{ readonly result: string | undefined, readonly variables: unknown }> {
  const { client, server } = await startClient([graphqlData('GetIssueProjectItems', response)])
  const result = await client.getItemIdByIssue('PVT_proj', 'owner', 'repo', 123)
  return { result, variables: graphqlRequests(server).map(request => request.variables) }
}

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

describe('linkRepositoryToProject', () => {
  const projectFound = graphqlData('GetProjectIdUser', { user: { projectV2: { id: 'PVT_proj' } } })
  const repositoryFound = graphqlData('GetRepositoryId', { repository: { id: 'R_repo' } })

  it('リンクに成功したら、リポジトリ名つきのメッセージを返す', async () => {
    const { client, server } = await startClient([
      projectFound,
      repositoryFound,
      graphqlData('LinkProjectRepository', { linkProjectV2ToRepository: { repository: { id: 'R_repo', nameWithOwner: 'owner/repo' } } }),
    ])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ success: true, message: 'GitHub Projectにリンクしました: owner/repo' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetProjectIdUser', 'GetRepositoryId', 'LinkProjectRepository'])
    expect(graphqlRequests(server).at(2)?.variables).toEqual({ projectId: 'PVT_proj', repositoryId: 'R_repo' })
  })

  it.each(['already linked', 'Repository already exists in project'])('「%s」の失敗は、リンク済みとして成功にする', async (message) => {
    const { client } = await startClient([projectFound, repositoryFound, graphqlError('LinkProjectRepository', message)])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ success: true, message: '既にリンク済みです' })
  })

  it('プロジェクトが無ければ失敗（メッセージは GitHubNotFoundError の文）', async () => {
    const { client } = await startClient([
      graphqlData('GetProjectIdUser', { user: JSON_NULL }),
      graphqlData('GetProjectIdOrg', { organization: JSON_NULL }),
    ])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({
      success: false,
      message: 'リンクに失敗しました: プロジェクトが見つかりません: owner/projects/1',
    })
  })

  it('リポジトリが無ければ失敗', async () => {
    const { client } = await startClient([projectFound, graphqlData('GetRepositoryId', { repository: JSON_NULL })])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'nonexistent')).toEqual({
      success: false,
      message: 'リンクに失敗しました: リポジトリが見つかりません: owner/nonexistent',
    })
  })

  it('その他の API エラーは失敗（メッセージに GraphQL の文を含める）', async () => {
    const { client } = await startClient([projectFound, repositoryFound, graphqlError('LinkProjectRepository', 'Some API error')])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({
      success: false,
      message: 'リンクに失敗しました: GraphQLクエリ実行エラー: {\'message\': \'Some API error\'}',
    })
  })

  it('repository が null のレスポンスは「レスポンスが不正です」', async () => {
    const { client } = await startClient([projectFound, repositoryFound, graphqlData('LinkProjectRepository', { linkProjectV2ToRepository: { repository: JSON_NULL } })])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ success: false, message: 'リンクに失敗しました: レスポンスが不正です' })
  })

  it('nameWithOwner が無ければ空文字をつなぐ', async () => {
    const { client } = await startClient([projectFound, repositoryFound, graphqlData('LinkProjectRepository', { linkProjectV2ToRepository: { repository: { id: 'R_repo' } } })])
    expect(await client.linkRepositoryToProject('owner', 1, 'owner', 'repo')).toEqual({ success: true, message: 'GitHub Projectにリンクしました: ' })
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

  it('user に無ければ organization。first を指定できる', async () => {
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
    expect(await rejection(client.createProjectField('PVT_test123', 'pecot-workflow', options))).toMatchObject(failure(GitHubAPIError, 'フィールドの作成に失敗しました'))
  })

  it('GraphQL の失敗は GraphQLクエリ実行エラー', async () => {
    const { client } = await startClient([graphqlError('CreateProjectField', 'GraphQL error')])
    expect(await rejection(client.createProjectField('PVT_test123', 'pecot-workflow', options))).toMatchObject(
      failure(GitHubAPIError, 'GraphQLクエリ実行エラー: {\'message\': \'GraphQL error\'}'),
    )
  })
})

describe('getOwnerNodeId', () => {
  it('user の Node ID', async () => {
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

  it('user のクエリの認証エラーは org に進まず、GitHubAuthError', async () => {
    const { client, server } = await startClient([{ match: { operation: 'GetUserNodeId' }, respond: { status: 401, text: 'x' }, times: 1 }])
    expect(await rejection(client.getOwnerNodeId('o'))).toMatchObject({ name: 'GitHubAuthError' })
    expect(graphqlRequests(server)).toHaveLength(1)
  })

  it('どちらにも無ければ GitHubNotFoundError', async () => {
    const { client } = await startClient([graphqlData('GetUserNodeId', { user: JSON_NULL }), graphqlData('GetOrgNodeId', { organization: JSON_NULL })])
    expect(await rejection(client.getOwnerNodeId('nonexistent'))).toMatchObject(failure(GitHubNotFoundError, 'オーナーが見つかりません: nonexistent'))
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
    expect(await rejection(client.createProject('U_owner123', 'New Project'))).toMatchObject(failure(GitHubAPIError, 'プロジェクトの作成に失敗しました'))
  })

  it('GraphQL の失敗は GitHubAPIError', async () => {
    const { client } = await startClient([graphqlError('CreateProject', 'GraphQL error')])
    expect(await rejection(client.createProject('U_owner123', 'New Project'))).toMatchObject({ name: 'GitHubAPIError' })
  })
})
