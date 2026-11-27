// ボード操作の関数のテスト。GitHub は偽サーバ（tests/fake-github）にする。期待値は cli/tests/core/test_issue_board.py と同じ。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import { GitHubAPIError } from '../../infra/github/errors.js'
import { createIssueReference } from '../../domain/reference-parser.js'
import { createRepositoryReference } from '../../domain/repository-resolver.js'
import { graphqlData, graphqlError, graphqlRequests, rejection, restResponse, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { addIssueToBoard, applyBoardMove, createIssue, itemHasFieldValue, planBoardMove, putOnBoard, setIssueField } from '../issue-board.js'

import type { BoardMove } from '../../domain/board-move.js'
import type { Readiness } from '../../domain/readiness.js'
import { createOutput } from '../output.js'
// 案内のコマンドの形を登録する
import '../../../tests/_helpers/hint-commands.js'
import { capture } from '../../../tests/_helpers/captured-io.js'

useFakeGithub()

function config(): ProjectConfig {
  return parseProjectConfig({
    host: 'github.com',
    owner: 'o',
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

// config の選択肢の ID が古いときの書き込みの応答（GitHub は VALIDATION を返す）
const STALE_OPTION = { type: 'VALIDATION', message: 'The single select option Id does not belong to the field' }
const STALE_OPTION_TEXT = `GraphQL query error: {'type': 'VALIDATION', 'message': '${STALE_OPTION.message}'}`

// 2 件の書き込みがどちらも古い ID で落ちる
const STALE_UPDATES: ReturnType<typeof graphqlData> = { match: { operation: 'UpdateProjectItemField' }, respond: { status: 200, body: { errors: [STALE_OPTION] } }, times: 2 }

function hintLines(stderr: string): readonly string[] {
  return stderr.split('\n').filter(line => line.trimStart().startsWith('hint: if the board options were recreated'))
}

function newHint(): { hasHinted: boolean } {
  return { hasHinted: false }
}

describe('createIssue', () => {
  it('Issue を作成し、API の応答を返す', async () => {
    await explains('Issue を作成する関数（`createIssue`）のテストです。API が HTTP 201 で番号を返した場合に、その応答（`{ number: 5 }`）をそのまま返すことを確認します。')
    const { client } = await startClient([restResponse('POST', '/repos/o/r/issues', { status: 201, body: { number: 5 } })])
    expect(await createIssue(client, 'o', 'r', 'T', 'B', ['bug'])).toEqual({ number: 5 })
  })

  it('Issue の作成に失敗した場合は、GitHubAPIError が発生する', async () => {
    await explains('`createIssue` の失敗のテストです。API が HTTP 422 を返した場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([restResponse('POST', '/repos/o/r/issues', { status: 422, text: 'bad' })])
    expect(await rejection(createIssue(client, 'o', 'r', 'T', 'B', undefined))).toBeInstanceOf(GitHubAPIError)
  })
})

describe('addIssueToBoard', () => {
  it('node id を指定しない場合は、node id を取得してからボードへ追加し、項目 ID と node id を返す', async () => {
    await explains('Issue をボードへ追加する関数（`addIssueToBoard`）のテストです。node id を指定しない場合に、先に node id を取得してから追加し、項目 ID と node id を返すことを確認します。')
    const { client, server } = await startClient([ISSUE_NODE_ID, ADD_TO_PROJECT])
    expect(await addIssueToBoard(client, config(), 'o', 'r', 5, undefined)).toEqual({ itemId: 'ITEM', issueNodeId: 'I_node' })
    expect(graphqlRequests(server)).toEqual([
      { operation: 'GetIssueNodeId', variables: { owner: 'o', repo: 'r', number: 5 } },
      { operation: 'AddToProject', variables: { projectId: 'PVT_1', contentId: 'I_node' } },
    ])
  })

  it('node id を指定した場合は、取得せずにボードへ追加する', async () => {
    await explains('`addIssueToBoard` に node id を指定した場合のテストです。node id の取得は行わず、追加の API だけを呼び出すことを確認します。')
    const { client, server } = await startClient([ADD_TO_PROJECT])
    expect(await addIssueToBoard(client, config(), 'o', 'r', 5, 'I_given')).toEqual({ itemId: 'ITEM', issueNodeId: 'I_given' })
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['AddToProject'])
  })

  it('ボードへの追加に失敗した場合は、GitHubAPIError が発生する', async () => {
    await explains('`addIssueToBoard` の失敗のテストです。追加の API がエラーを返した場合に、`GitHubAPIError` が発生することを確認します。')
    const { client } = await startClient([graphqlError('AddToProject', 'boom')])
    const addition = addIssueToBoard(client, config(), 'o', 'r', 5, 'I_given')
    expect(await rejection(addition)).toBeInstanceOf(GitHubAPIError)
  })
})

describe('setIssueField', () => {
  it('設定に存在するフィールドとオプションを指定した場合は、その値で更新して true を返す', async () => {
    await explains('ボードのフィールドを更新する関数（`setIssueField`）のテストです。設定に存在するフィールドとオプションを指定した場合に、対応する ID で更新の API を呼び出し、`true` を返すことを確認します。')
    const { client, server } = await startClient([updateRule(1)])
    expect(await setIssueField(client, config(), 'ITEM', 'workflow', 'backlog')).toBe(true)
    expect(graphqlRequests(server)).toEqual([{ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'ITEM', fieldId: 'F_workflow', optionId: 'O_workflow_backlog' } }])
  })

  it.each([
    ['フィールド', 'size', 'xs'],
    ['オプション', 'workflow', 'nothing'],
  ])('設定に存在しない%sを指定した場合は、何も送信せず false を返す', async (label, field, option) => {
    await explains(`設定に存在しない${label}を指定した場合のテストです。API を呼び出さず、\`false\` を返すことを確認します。`)
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
  ])('値が入力済みのフィールドが %j の場合は、workflow が入力済みかどうかの判定が %s になる', async (filledFieldIds, expected) => {
    await explains(`項目のフィールドに値が入力されているかを調べる関数（\`itemHasFieldValue\`）のテストです。値が入力済みのフィールドが ${JSON.stringify(filledFieldIds)} の場合に、\`workflow\` の判定が ${String(expected)} になることを確認します。`)
    const { client } = await startClient([graphqlData('GetIssueProjectItems', projectItems(filledFieldIds))])
    expect(await itemHasFieldValue(client, config(), 'o', 'r', 5, 'ITEM', 'workflow')).toBe(expected)
  })

  it('設定に存在しないフィールドを指定した場合は、取得せずに入力済みとして扱う', async () => {
    await explains('設定に存在しないフィールド（`size`）を指定した場合のテストです。API を呼び出さず、値が入力済みであるとして `true` を返すことを確認します。')
    const { client, server } = await startClient([])
    expect(await itemHasFieldValue(client, config(), 'o', 'r', 5, 'ITEM', 'size')).toBe(true)
    expect(graphqlRequests(server)).toEqual([])
  })
})

describe('putOnBoard', () => {
  const WORKFLOW = { operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'ITEM', fieldId: 'F_workflow', optionId: 'O_workflow_backlog' } }

  // 設定とボードに旧い priority の欄が残っていても、書くのは Status だけ
  it.each([
    [[], [WORKFLOW]],
    [['F_priority'], [WORKFLOW]],
    [['F_workflow'], []],
  ])('onlyIfEmpty を指定した場合は、入力済みのフィールドが %j のとき、空の Status だけを設定する', async (filledFieldIds, expected) => {
    await explains(`Issue をボードへ載せる関数（\`putOnBoard\`）で \`onlyIfEmpty\` を指定した場合のテストです。入力済みのフィールドが ${JSON.stringify(filledFieldIds)} の場合に、Status が空のときだけ設定し、失敗が 0 件であることを確認します。`)
    const { client, server } = await startClient([
      ISSUE_NODE_ID,
      ADD_TO_PROJECT,
      graphqlData('GetIssueProjectItems', projectItems(filledFieldIds)),
      ...expected.length === 0 ? [] : [updateRule(expected.length)],
    ])
    const out = createOutput(false, capture())
    expect(await putOnBoard(out, client, config(), 'o', 'r', 5, { onlyIfEmpty: true })).toBe(0)
    expect(graphqlRequests(server).filter(({ operation }) => operation === 'UpdateProjectItemField')).toEqual(expected)
  })

  it('onlyIfEmpty を指定しない場合は、入力済みかどうかを調べず、Status だけを上書きする', async () => {
    await explains('`putOnBoard` で `onlyIfEmpty` を `false` にした場合のテストです。値の取得は行わず、Status だけを更新し、失敗が 0 件であることを確認します。')
    const { client, server } = await startClient([ISSUE_NODE_ID, ADD_TO_PROJECT, updateRule(1)])
    const failures = await putOnBoard(createOutput(false, capture()), client, config(), 'o', 'r', 5, { onlyIfEmpty: false })
    expect(failures).toBe(0)
    expect(graphqlRequests(server).filter(({ operation }) => operation !== 'GetIssueNodeId' && operation !== 'AddToProject')).toEqual([WORKFLOW])
  })

  it('Status の書き込みが VALIDATION で失敗した場合は、エラーと案内を 1 回ずつ表示し、1 を返す', async () => {
    await explains('Status の書き込みが、選択肢の ID の不一致（`VALIDATION`）で失敗した場合のテストです。エラーの行と、ボードの選択肢を作り直したときの案内を 1 回ずつ表示し、失敗の件数 1 を返すことを確認します。')
    const stale: ReturnType<typeof graphqlData> = { ...STALE_UPDATES, times: 1 }
    const { client, server } = await startClient([ISSUE_NODE_ID, ADD_TO_PROJECT, stale])
    const io = capture()
    expect(await putOnBoard(createOutput(false, io), client, config(), 'o', 'r', 5, { onlyIfEmpty: false })).toBe(1)
    const stderr = io.err.join('')
    expect(stderr.split('\n').filter(line => line.startsWith('error: '))).toEqual([`error: could not set status backlog of Tracker #5: ${STALE_OPTION_TEXT}`])
    expect(hintLines(stderr)).toHaveLength(1)
    expect(graphqlRequests(server).filter(({ operation }) => operation === 'UpdateProjectItemField')).toEqual([WORKFLOW])
  })

  it('Status の書き込みが VALIDATION 以外で失敗した場合は、エラーだけを表示し、案内なしで 1 を返す', async () => {
    await explains('Status の書き込みが `VALIDATION` 以外のエラーで失敗した場合のテストです。エラーの行だけを表示して案内は表示せず、失敗の件数 1 を返すことを確認します。')
    const { client } = await startClient([ISSUE_NODE_ID, ADD_TO_PROJECT, graphqlError('UpdateProjectItemField', 'boom')])
    const io = capture()
    expect(await putOnBoard(createOutput(false, io), client, config(), 'o', 'r', 5, { onlyIfEmpty: false })).toBe(1)
    expect(io.err.join('')).toBe('error: could not set status backlog of Tracker #5: GraphQL query error: {\'message\': \'boom\'}\n')
  })

  it('ボードへの追加に失敗した場合は、Status を書き込まずに GitHubAPIError が発生する', async () => {
    await explains('ボードへの追加に失敗した場合のテストです。Status の書き込みは行わず、`GitHubAPIError` が発生し、標準エラー出力には何も表示しないことを確認します。')
    const { client, server } = await startClient([ISSUE_NODE_ID, graphqlError('AddToProject', 'boom')])
    const io = capture()
    const putting = putOnBoard(createOutput(false, io), client, config(), 'o', 'r', 5, { onlyIfEmpty: false })
    expect(await rejection(putting)).toBeInstanceOf(GitHubAPIError)
    expect(io.err).toEqual([])
    expect(graphqlRequests(server).map(({ operation }) => operation)).toEqual(['GetIssueNodeId', 'AddToProject'])
  })
})

describe('applyBoardMove', () => {
  const reference = createIssueReference(createRepositoryReference('o', 'r'), 7)
  const target = { ref: reference, home: createRepositoryReference('o', 'r') }
  const withBlocked = parseProjectConfig({
    host: 'github.com',
    owner: 'o',
    project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'F_workflow', options: { ready: 'O_ready', blocked: 'O_blocked' } }, status: { id: 'F_status', options: { todo: 'O_todo' } } } },
  })

  it('列を移動し、移動先の列と moved の行を返す', async () => {
    await explains('判定した移動をボードへ反映する関数（`applyBoardMove`）のテストです。`Ready` から `Blocked` へ列を移動し、移動の結果を返して、`moved:` の行を表示することを確認します。')
    const { client, server } = await startClient([updateRule(1)])
    const io = capture()
    const applied = await applyBoardMove(createOutput(false, io), client, withBlocked, 'ITEM', target, { column: { from: 'Ready', to: 'Blocked', reason: { kind: 'blocked', stackOn: undefined, reason: undefined, needsReview: false, attention: [] } }, missing: [] }, 'blocked by #3')
    expect(applied).toEqual({ column: 'Blocked', missing: [], hasFailed: false, written: { issue: '#7', column: { from: 'Ready', to: 'Blocked' }, label: undefined, reason: 'blocked by #3' } })
    expect(io.err.join('')).toBe('moved: #7 Ready -> Blocked (blocked by #3)\n')
    expect(graphqlRequests(server)).toEqual([{ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'ITEM', fieldId: 'F_workflow', optionId: 'O_blocked' } }])
  })

  it('書き込みに失敗した場合は、警告を表示し、元の列のままにする', async () => {
    await explains('列の書き込みが失敗した場合のテストです。`warning: could not move #7` の行を表示し、移動後の列を返さず、失敗として扱うことを確認します。')
    const { client } = await startClient([graphqlError('UpdateProjectItemField', 'boom')])
    const io = capture()
    const applied = await applyBoardMove(createOutput(false, io), client, withBlocked, 'ITEM', target, { column: { from: 'Ready', to: 'Blocked', reason: { kind: 'blocked', stackOn: undefined, reason: undefined, needsReview: false, attention: [] } }, missing: [] }, 't')
    expect(applied).toEqual({ column: undefined, missing: [], hasFailed: true })
    expect(io.err.join('')).toBe('warning: could not move #7: GraphQL query error: {\'message\': \'boom\'}\n')
  })

  it('書き込みが VALIDATION で失敗した場合は、案内を表示し、2 回目以降の失敗では案内を重ねて表示しない', async () => {
    await explains('2 件の移動がどちらも `VALIDATION` で失敗する場合のテストです。同じ案内の状態を渡すと、案内は 1 回だけ、2 件目の警告より前に表示されることを確認します。')
    const { client } = await startClient([STALE_UPDATES])
    const io = capture()
    const out = createOutput(false, io)
    const move: BoardMove = { column: { from: 'Ready', to: 'Blocked', reason: { kind: 'blocked', stackOn: undefined, reason: undefined, needsReview: false, attention: [] } }, missing: [] }
    const hint = newHint()
    const first = await applyBoardMove(out, client, withBlocked, 'ITEM', target, move, 't', hint)
    const second = await applyBoardMove(out, client, withBlocked, 'ITEM', { ref: createIssueReference(createRepositoryReference('o', 'r'), 8), home: target.home }, move, 't', hint)
    expect([first.hasFailed, second.hasFailed]).toEqual([true, true])
    const stderr = io.err.join('')
    expect(stderr.split('\n').filter(line => line.startsWith('warning: '))).toEqual([
      `warning: could not move #7: ${STALE_OPTION_TEXT}`,
      `warning: could not move #8: ${STALE_OPTION_TEXT}`,
    ])
    expect(hintLines(stderr)).toHaveLength(1)
    expect(stderr.indexOf('hint:')).toBeLessThan(stderr.indexOf('#8'))
  })

  it('Status の値だけを移動する場合は、set の行を表示し、列は移動しない', async () => {
    await explains('列の移動を伴わず、Status の値（`Todo`）だけを更新する場合のテストです。`set: Status of #7 to Todo` の行を表示し、列は更新しないことを確認します。')
    const { client, server } = await startClient([updateRule(1)])
    const io = capture()
    const applied = await applyBoardMove(createOutput(false, io), client, withBlocked, 'ITEM', target, { label: 'Todo', missing: [] }, 'startable')
    expect(applied).toEqual({ column: undefined, missing: [], hasFailed: false, written: { issue: '#7', column: undefined, label: 'Todo', reason: 'startable' } })
    expect(io.err.join('')).toBe('set: Status of #7 to Todo\n')
    expect(graphqlRequests(server)).toEqual([{ operation: 'UpdateProjectItemField', variables: { projectId: 'PVT_1', itemId: 'ITEM', fieldId: 'F_status', optionId: 'O_todo' } }])
  })

  it('Active 列の Issue が blocked と判定された場合は、警告を表示し、列を移動しない', async () => {
    await explains('着手済み（`Active` 列）の Issue が、未完了の前提を持つと判定された場合のテストです。警告を表示するだけで列を移動せず、書き込みの API も呼び出さないことを確認します。')
    const { client, server } = await startClient([])
    const io = capture()
    const blocker = createIssueReference(createRepositoryReference('o', 'other'), 3)
    const applied = await applyBoardMove(createOutput(false, io), client, withBlocked, 'ITEM', target, { conflict: { column: 'Active', issues: [blocker] }, missing: [] }, 'blocked by o/other#3')
    expect(applied).toEqual({ column: undefined, missing: [], hasFailed: false })
    expect(io.err.join('')).toBe('warning: #7 is in Active but blocked by o/other#3\n')
    expect(graphqlRequests(server)).toEqual([])
  })

  it('planBoardMove は、applyBoardMove と同じ内容を dry-run の行で表示し、書き込まずに予定の列と Status を返す', async () => {
    await explains('`dry-run` で移動の予定を作成する関数（`planBoardMove`）のテストです。書き込みは行わず、予定の列と Status の値を返し、`dry-run: would move` などの行を表示することを確認します。')
    const io = capture()
    const reason: Readiness = { kind: 'blocked', stackOn: undefined, reason: undefined, needsReview: true, attention: [] }
    const planned = planBoardMove(createOutput(true, io), target, { column: { from: 'Ready', to: 'Blocked', reason }, label: 'Todo', missing: [] }, 'blocked by #3')
    expect(planned).toEqual({ issue: '#7', column: { from: 'Ready', to: 'Blocked' }, label: 'Todo', reason: 'blocked by #3' })
    expect(io.err.join('')).toBe('dry-run: would move #7 Ready -> Blocked (blocked by #3)\ndry-run: would set Status of #7 to Todo\n')
  })
})
