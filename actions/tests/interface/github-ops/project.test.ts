/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// github-ops の project-fields・project-view・project-link を確かめる。ボードは組織 acme の #3。
import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { explains } from '../../_helpers/explains.js'
import { verifies } from '../../_helpers/verifies.js'
import { graphqlRule, restRule } from '../../_helpers/github-rules.js'
import { runOperation, writesOf } from '../../_helpers/github-ops-case.js'

useIsolatedEnvironment()

type Field = Record<string, unknown>

const BOARD_URL = 'https://github.com/orgs/acme/projects/3'
const statusField: Field = { id: 'F_status', name: 'Status', options: [{ id: 'o1', name: 'Todo', color: 'BLUE', description: '未着手' }, { id: 'o2', name: 'Done', color: 'GREEN', description: '' }] }
const titleField: Field = { id: 'F_title', name: 'Title' }

// 個人のボードを探して無く、組織のボードを読む。欄を読むたびに 2 つの要求が出る
function boardRead(fields: readonly Field[]): ResponseRule[] {
  return [
    graphqlRule('GetProjectFieldsUser', { user: null }),
    graphqlRule('GetProjectFieldsOrg', { organization: { projectV2: { id: 'PVT_3', title: 'board', url: BOARD_URL, views: { nodes: [] }, fields: { nodes: fields } } } }),
  ]
}

function variablesOf(requests: readonly RecordedRequest[], operation: string): unknown[] {
  return requests.flatMap(request => request.type === 'graphql' && request.operation === operation ? [request.variables] : [])
}

function viewTarget(views: readonly Field[]): ResponseRule {
  const project = { url: BOARD_URL, views: { nodes: views }, fields: { nodes: [{ databaseId: 456, name: 'Status' }, { databaseId: 789, name: 'pecot-lane' }] } }
  return graphqlRule('GetProjectViewTarget', { repositoryOwner: { __typename: 'Organization', projectV2: project } })
}

const projectId = [graphqlRule('GetProjectIdUser', { user: null }), graphqlRule('GetProjectIdOrg', { organization: { projectV2: { id: 'PVT_3' } } })]

describe('github ops', () => {
  it('project-fields に changes を渡すと、並べた順に欄を作り・名前を変え・消し、書いた後の欄と選択肢の ID を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-08')
    await explains('`project-fields` のテストです。作成・名前の変更・削除の 3 つの変更を指定した場合に、指定した順で GitHub へ送信し、書き込んだ後の欄と選択肢の ID を返すことを確認します。')
    const lane: Field = { id: 'F_lane', name: 'pecot-lane', options: [{ id: 'l1', name: 'cli' }] }
    const renamed: Field = { ...lane, name: 'Lane' }
    const rules = [
      ...boardRead([statusField, titleField]),
      graphqlRule('CreateProjectField', { createProjectV2Field: { projectV2Field: lane } }),
      ...boardRead([statusField, titleField, lane]),
      graphqlRule('RenameProjectField', { updateProjectV2Field: { projectV2Field: renamed } }),
      ...boardRead([statusField, titleField, renamed]),
      graphqlRule('DeleteProjectField', { deleteProjectV2Field: { projectV2Field: titleField } }),
      ...boardRead([statusField, renamed]),
    ]
    const changes = [
      { action: 'create', name: 'pecot-lane', options: [{ name: 'cli' }] },
      { action: 'rename', name: 'pecot-lane', to: 'Lane' },
      { action: 'delete', name: 'Title' },
    ]
    const result = await runOperation('project-fields', { project: 3, changes }, rules)
    expect(result.code).toBe(0)
    expect(writesOf(result.github.requests())).toEqual(['CreateProjectField', 'RenameProjectField', 'DeleteProjectField'])
    expect(variablesOf(result.github.requests(), 'CreateProjectField')).toEqual([{ projectId: 'PVT_3', name: 'pecot-lane', options: [{ name: 'cli', color: 'GRAY', description: '' }] }])
    expect(result.result).toEqual({
      project: 3,
      applied: 3,
      fields: [{ name: 'Status', id: 'F_status', options: [{ name: 'Todo', id: 'o1' }, { name: 'Done', id: 'o2' }] }, { name: 'Lane', id: 'F_lane', options: [{ name: 'cli', id: 'l1' }] }],
    })
  })

  it('project-fields の set-options は、名前の合う選択肢の ID・色・説明を引き継ぎ、新しい選択肢だけ ID 無しで送る', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-09')
    await explains('`project-fields` の `set-options` のテストです。既存の選択肢と同じ名前の選択肢は ID・色・説明を引き継ぎ、新しい選択肢だけを ID 無しで送信して、カードの値が消えないことを確認します。')
    const rules = [...boardRead([statusField]), graphqlRule('UpdateProjectField', { updateProjectV2Field: { projectV2Field: statusField } }), ...boardRead([statusField])]
    const changes = [{ action: 'set-options', name: 'Status', options: [{ name: 'Todo' }, { name: 'Blocked', color: 'RED' }, { name: 'Done' }] }]
    const result = await runOperation('project-fields', { project: 3, changes }, rules)
    expect(result.code).toBe(0)
    expect(variablesOf(result.github.requests(), 'UpdateProjectField')).toEqual([{
      fieldId: 'F_status',
      options: [
        { id: 'o1', name: 'Todo', color: 'BLUE', description: '未着手' },
        { name: 'Blocked', color: 'RED', description: '' },
        { id: 'o2', name: 'Done', color: 'GREEN', description: '' },
      ],
    }])
  })

  it.for([
    { name: '既に存在する欄の create', change: { action: 'create', name: 'Status', options: [{ name: 'x' }] }, kind: 'already-exists' },
    { name: 'ボードに存在しない欄の rename', change: { action: 'rename', name: 'Missing', to: 'x' }, kind: 'github-not-found' },
    { name: '単一選択でない欄の set-options', change: { action: 'set-options', name: 'Title', options: [{ name: 'x' }] }, kind: 'invalid-input' },
  ])('project-fields に $name を渡すと、書き込まずに ok: false を返す', async ({ change, kind }, context) => {
    await verifies(context, 'PA-GITHUB-OPS-09')
    await explains('`project-fields` の、書けない変更のテストです。欄の有無や種類と合わない変更を指定した場合に、ボードへ書き込まず、`ok: false` と失敗の種類を返すことを確認します。')
    const result = await runOperation('project-fields', { project: 3, changes: [change] }, boardRead([statusField, titleField]))
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind } })
    expect(writesOf(result.github.requests())).toEqual([])
  })

  it('project-view に名前・列・行の欄を渡すと、列と行の欄で分けたボードのビューを作り、番号と URL を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-10')
    await explains('`project-view` のテストです。ビューの名前と、列・行に使う欄を指定した場合に、組織のボードに `board` のレイアウトのビューを作成し、番号と URL を返すことを確認します。')
    const created = restRule('POST', '/orgs/acme/projectsV2/3/views', 201, { id: 2, number: 2, name: 'Lanes', html_url: `${BOARD_URL}/views/2` })
    const result = await runOperation('project-view', { project: 3, name: 'Lanes', column: 'Status', row: 'pecot-lane' }, [viewTarget([{ number: 1, name: 'View 1' }]), created])
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ created: true, number: 2, url: `${BOARD_URL}/views/2` })
    expect(result.github.requests().find(request => request.type === 'rest' && request.method === 'POST')).toMatchObject({ body: { name: 'Lanes', layout: 'board', vertical_group_by: [456], group_by: [789] } })
  })

  it('project-view で同じ名前のビューが既にあると、作らずに created: false と既存のビューを返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-10')
    await explains('`project-view` の 2 回目の呼び出しのテストです。同じ名前のビューが既に存在する場合に、ビューを作成せず、既存のビューの番号と URL を返すことを確認します。')
    const result = await runOperation('project-view', { project: 3, name: 'Lanes', column: 'Status', row: 'pecot-lane' }, [viewTarget([{ number: 4, name: 'Lanes' }])])
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ created: false, number: 4, url: `${BOARD_URL}/views/4` })
    expect(writesOf(result.github.requests())).toEqual([])
  })

  it('project-view で列の欄がボードに無いと、作らずに github-not-found を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-10')
    await explains('`project-view` のテストです。列として指定した欄がボードで見つからない場合に、ビューを作成せず、`github-not-found` を返すことを確認します。')
    const result = await runOperation('project-view', { project: 3, name: 'Lanes', column: 'Missing', row: 'pecot-lane' }, [viewTarget([])])
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'github-not-found' } })
  })

  it('project-link に repo を省くと、ワークフローのリポをボードにつなぎ、linked を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-11')
    await explains('`project-link` のテストです。`repo` を省いた場合に、ワークフローを動かしたリポをボードにつなぎ、`status` を `linked` として返すことを確認します。')
    const rules = [...projectId, graphqlRule('GetRepositoryId', { repository: { id: 'R_1' } }, { owner: 'acme', name: 'demo' }), graphqlRule('LinkProjectRepository', { linkProjectV2ToRepository: { repository: { id: 'R_1', nameWithOwner: 'acme/demo' } } })]
    const result = await runOperation('project-link', { project: 3 }, rules)
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ project: 3, repo: 'acme/demo', status: 'linked' })
    expect(variablesOf(result.github.requests(), 'LinkProjectRepository')).toEqual([{ projectId: 'PVT_3', repositoryId: 'R_1' }])
  })

  it('project-link でリポが既につながっていると、ok: true と already_linked を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-11')
    await explains('`project-link` の 2 回目の呼び出しのテストです。GitHub がリポは既につながっていると返した場合に、成功として `already_linked` を返すことを確認します。')
    const already: ResponseRule = { match: { operation: 'LinkProjectRepository' }, respond: { status: 200, body: { errors: [{ type: 'UNPROCESSABLE', message: 'Repository is already linked to this project' }] } }, times: 1 }
    const result = await runOperation('project-link', { project: 3, repo: 'acme/other' }, [...projectId, graphqlRule('GetRepositoryId', { repository: { id: 'R_2' } }), already])
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ project: 3, repo: 'acme/other', status: 'already_linked' })
  })

  it('project-link で GitHub が FORBIDDEN を返すと、ok: false と GitHub の文を返し、step を失敗にする', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-11')
    await explains('`project-link` の権限の不足のテストです。token の権限が足りず GitHub が `FORBIDDEN` を返した場合に、成功にせず、`ok: false` と GitHub のエラー文を返すことを確認します。')
    const forbidden: ResponseRule = { match: { operation: 'LinkProjectRepository' }, respond: { status: 200, body: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] } }, times: 1 }
    const result = await runOperation('project-link', { project: 3 }, [...projectId, graphqlRule('GetRepositoryId', { repository: { id: 'R_1' } }), forbidden])
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'github-api' } })
    expect(result.message).toContain('Resource not accessible by integration')
  })
})
