// ボード操作の関数のテスト。GitHub は偽サーバ（tests/fake-github）にする。期待値は cli/tests/core/test_issue_board.py と同じ。
import { describe, expect, it } from 'vitest'

import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import { GitHubAPIError } from '../../infra/github/errors.js'
import { graphqlData, graphqlError, graphqlRequests, rejection, restResponse, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { addIssueToBoard, createIssue, itemHasFieldValue, putOnBoard, setIssueField } from '../issue-board.js'

useFakeGithub()

function config(): ProjectConfig {
  return parseProjectConfig({
    host: 'github.com',
    owner: 'o',
    workflow_suffix: 'o',
    project: {
      number: 1,
      id: 'PVT_1',
      fields: {
        workflow: { id: 'F_workflow', options: { backlog: 'O_workflow_backlog' } },
        priority: { id: 'F_priority', options: { high: 'O_priority_high' } },
      },
    },
  })
}

function fieldValue(fieldId: string): unknown {
  return { field: { id: fieldId } }
}

function projectItems(filledFieldIds: readonly string[]): unknown {
  return { repository: { issue: { projectItems: { nodes: [{ id: 'ITEM', project: { id: 'PVT_1' }, fieldValues: { nodes: filledFieldIds.map(id => fieldValue(id)) } }] } } } }
}

const ADD_TO_PROJECT = graphqlData('AddToProject', { addProjectV2ItemById: { item: { id: 'ITEM' } } })
const ISSUE_NODE_ID = graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_node', title: 't' } } })

function updateRule(times: number): ReturnType<typeof graphqlData> {
  return graphqlData('UpdateProjectItemField', { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM' } } }, times)
}

describe('createIssue', () => {
  it('Issue を作って API の応答を返す', async () => {
    const { client } = await startClient([restResponse('POST', '/repos/o/r/issues', { status: 201, body: { number: 5 } })])
    expect(await createIssue(client, 'o', 'r', 'T', 'B', ['bug'])).toEqual({ number: 5 })
  })

  it('作成に失敗したら GitHubAPIError を伝える', async () => {
    const { client } = await startClient([restResponse('POST', '/repos/o/r/issues', { status: 422, text: 'bad' })])
    expect(await rejection(createIssue(client, 'o', 'r', 'T', 'B', undefined))).toBeInstanceOf(GitHubAPIError)
  })
})

describe('addIssueToBoard', () => {
  it('node id が無ければ取ってから追加し、項目 ID と node id を返す', async () => {
    const { client, server } = await startClient([ISSUE_NODE_ID, ADD_TO_PROJECT])
    expect(await addIssueToBoard(client, config(), 'o', 'r', 5, undefined)).toEqual({ itemId: 'ITEM', issueNodeId: 'I_node' })
    expect(graphqlRequests(server)).toEqual([
      { operation: 'GetIssueNodeId', variables: { owner: 'o', repo: 'r', number: 5 } },
      { operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: 'I_node' } },
    ])
  })

  it('node id を渡せば取らずに追加する', async () => {
    const { client, server } = await startClient([ADD_TO_PROJECT])
    expect(await addIssueToBoard(client, config(), 'o', 'r', 5, 'I_given')).toEqual({ itemId: 'ITEM', issueNodeId: 'I_given' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['AddToProject'])
  })

  it('追加に失敗したら GitHubAPIError を伝える', async () => {
    const { client } = await startClient([graphqlError('AddToProject', 'boom')])
    const addition = addIssueToBoard(client, config(), 'o', 'r', 5, 'I_given')
    expect(await rejection(addition)).toBeInstanceOf(GitHubAPIError)
  })
})

describe('setIssueField', () => {
  it('設定にあるフィールドとオプションを更新して true を返す', async () => {
    const { client, server } = await startClient([updateRule(1)])
    expect(await setIssueField(client, config(), 'ITEM', 'workflow', 'backlog')).toBe(true)
    expect(graphqlRequests(server)).toEqual([{ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'ITEM', fieldId: 'F_workflow', optionId: 'O_workflow_backlog' } }])
  })

  it.each([
    ['フィールド', 'size', 'xs'],
    ['オプション', 'workflow', 'nothing'],
  ])('設定に無い%sは何も送らず false を返す', async (_label, field, option) => {
    const { client, server } = await startClient([])
    expect(await setIssueField(client, config(), 'ITEM', field, option)).toBe(false)
    expect(graphqlRequests(server)).toEqual([])
  })
})

describe('itemHasFieldValue', () => {
  it.each([
    [['F_workflow'], true],
    [['F_priority'], false],
    [[], false],
  ])('値が入ったフィールド %j のとき workflow は %s', async (filledFieldIds, expected) => {
    const { client } = await startClient([graphqlData('GetIssueProjectItems', projectItems(filledFieldIds))])
    expect(await itemHasFieldValue(client, config(), 'o', 'r', 5, 'ITEM', 'workflow')).toBe(expected)
  })

  it('設定に無いフィールドは取得せず、入っているとみなす', async () => {
    const { client, server } = await startClient([])
    expect(await itemHasFieldValue(client, config(), 'o', 'r', 5, 'ITEM', 'size')).toBe(true)
    expect(graphqlRequests(server)).toEqual([])
  })
})

describe('putOnBoard', () => {
  const WORKFLOW = { operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'ITEM', fieldId: 'F_workflow', optionId: 'O_workflow_backlog' } }
  const PRIORITY = { operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'ITEM', fieldId: 'F_priority', optionId: 'O_priority_high' } }

  it.each([
    [[], [WORKFLOW, PRIORITY]],
    [['F_workflow'], [PRIORITY]],
    [['F_priority'], [WORKFLOW]],
    [['F_workflow', 'F_priority'], []],
  ])('onlyIfEmpty は、値が入ったフィールド %j を除いた空のフィールドだけ設定する', async (filledFieldIds, expected) => {
    const { client, server } = await startClient([
      ISSUE_NODE_ID,
      ADD_TO_PROJECT,
      graphqlData('GetIssueProjectItems', projectItems(filledFieldIds), 2),
      ...expected.length === 0 ? [] : [updateRule(expected.length)],
    ])
    await putOnBoard(client, config(), 'o', 'r', 5, 'high', { onlyIfEmpty: true })
    expect(graphqlRequests(server).filter(({ operation }) => operation === 'UpdateProjectItemField')).toEqual(expected)
  })

  it('onlyIfEmpty でなければ、入っている値も上書きする', async () => {
    const { client, server } = await startClient([ISSUE_NODE_ID, ADD_TO_PROJECT, updateRule(2)])
    await putOnBoard(client, config(), 'o', 'r', 5, 'high', { onlyIfEmpty: false })
    expect(graphqlRequests(server).filter(({ operation }) => operation !== 'GetIssueNodeId' && operation !== 'AddToProject')).toEqual([WORKFLOW, PRIORITY])
  })

  it('priority が無ければ Status だけ設定する', async () => {
    const { client, server } = await startClient([ISSUE_NODE_ID, ADD_TO_PROJECT, updateRule(1)])
    await putOnBoard(client, config(), 'o', 'r', 5, undefined, { onlyIfEmpty: false })
    expect(graphqlRequests(server).at(-1)).toEqual(WORKFLOW)
    expect(graphqlRequests(server)).toHaveLength(3)
  })
})
