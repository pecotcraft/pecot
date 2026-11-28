/* eslint-disable unicorn/no-null -- 偽サーバの応答と JSON の出力に null を使う */
// board show の表示・Archived の整理・Dependabot alert の収集。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'
import { step, stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'

import { capture } from '../../../tests/_helpers/captured-io.js'
import type { JsonObject } from '../../domain/json.js'
import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import type { BoardItem } from '../../domain/format.js'
import { graphqlData, graphqlError, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { mapWithLimit, pruneArchivedItems, readBoard, warnOldFieldName } from '../board-view.js'
import type { BoardRead } from '../board-view.js'
import { createOutput } from '../output.js'
// 案内のコマンドの形を登録する
import '../../../tests/_helpers/hint-commands.js'

useFakeGithub()

type Json = JsonObject

function config(): ProjectConfig {
  return parseProjectConfig({ host: 'github.com', owner: 'acme', project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: {} } } }, repositories: [] })
}

function archived(index: number, id: BoardItem['id'] = `PVTI_${String(index)}`): BoardItem {
  const day = String(index).padStart(2, '0')
  return { id, workflow: 'Archived', updatedAt: `2026-01-${day}T00:00:00Z`, content: {} }
}

// 1 日目から 22 日目までの 22 件。古い 2 件（1・2 日目）が消す対象になる
function archivedItems(first: BoardItem = archived(1)): BoardItem[] {
  const rest = Array.from({ length: 21 }, (_unused, index) => archived(index + 2))
  return [first, ...rest]
}

const deletion = (itemId: string, isOk = true): ReturnType<typeof graphqlData> => isOk
  ? { match: { operation: 'DeleteProjectItem', variables: { itemId } }, respond: { status: 200, body: { data: { deleteProjectV2Item: { deletedItemId: itemId } } } }, times: 1 }
  : { match: { operation: 'DeleteProjectItem', variables: { itemId } }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }

interface NodeExtra {
  readonly repository?: string
  readonly state?: string
  readonly field?: string
  readonly others?: readonly string[]
}

// ListProjectItems の応答の 1 件
function node(id: string, number: number, workflow: string, extra: NodeExtra = {}): Json {
  const { repository = 'demo', state = 'OPEN', field = 'pecot-status', others = [] } = extra
  const otherValues = others.map(name => ({ field: { id: `F_${name}`, name }, name: 'High' }))
  const url = `https://github.com/acme/${repository}/issues/${String(number)}`
  return {
    id,
    updatedAt: '2026-01-02T03:04:05Z',
    fieldValues: { nodes: [{ field: { id: 'PVTSSF_workflow', name: field }, name: workflow }, ...otherValues] },
    content: { id: `I_${String(number)}`, number, title: `課題${String(number)}`, state, url, labels: { nodes: [] }, repository: { owner: { login: 'acme' }, name: repository }, issueType: null, subIssues: { totalCount: 0 }, parent: null, blockedBy: { totalCount: 1 } },
  }
}

function page(nodes: readonly Json[], laneOptions?: readonly string[]): Json {
  const laneField = laneOptions === undefined ? {} : { laneField: { options: laneOptions.map(name => ({ name })) } }
  return { node: { ...laneField, items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }
}

describe('mapWithLimit', () => {
  it('並列の数を limit までにし、結果を入力の順で返す', async () => {
    await explains('並列の実行数を制限して非同期の処理を回す関数（`mapWithLimit`）のテストです。上限が 2 の場合は、同時に実行する処理が 2 件を超えず、結果が入力と同じ順序で返ることを確認します。')
    let running = 0
    let peak = 0
    const result = await step('並列数を制限して実行する', async () => await mapWithLimit([30, 10, 20, 0], 2, async (value) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, value))
      running -= 1
      return value * 2
    }))
    stepSync('結果を確認する', () => {
      expect({ result, peak }).toEqual({ result: [60, 20, 40, 0], peak: 2 })
    })
  })
})

describe('pruneArchivedItems', () => {
  it('Archived 列の項目が 20 件以下の場合は、何も削除しない', async () => {
    await explains('ボードの `Archived` 列の項目を整理する処理（`pruneArchivedItems`）のテストです。項目が 20 件の場合に、API を呼び出さず、削除した件数と失敗した件数がどちらも 0 になることを確認します。')
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([]))
    const out = stepSync('出力の捕捉を用意する', () => createOutput(false, capture()))
    await step('結果を確認する', async () => {
      expect(await pruneArchivedItems(out, client, config(), archivedItems().slice(2), false)).toEqual({ deleted: 0, failed: 0 })
    })
  })

  it('dry-run の場合は、削除せず、削除する予定の件数を表示する', async () => {
    await explains('`Archived` 列の項目が 22 件ある状態で、`dry-run` を指定した場合のテストです。削除は行わず、古い 2 件を削除する予定であることを標準エラー出力に表示することを確認します。')
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([]))
    const io = stepSync('出力の捕捉を用意する', () => capture())
    const result = await step('アーカイブ済みの項目を取り除く', async () => await pruneArchivedItems(createOutput(true, io), client, config(), archivedItems(), true))
    stepSync('結果を確認する', () => {
      expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 2, failed: 0 }, err: 'dry-run: would delete 2 archived items\n' })
    })
  })

  it('削除に失敗した項目と ID が文字列でない項目の件数を、警告として表示する', async () => {
    await explains('古い 2 件の削除がどちらも失敗する場合のテストです。1 件は API が HTTP 500 を返し、もう 1 件は ID が文字列でないため、失敗が 2 件になり、その件数を警告として表示することを確認します。')
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([deletion('PVTI_2', false)]))
    const io = stepSync('出力の捕捉を用意する', () => capture())
    const result = await step('アーカイブ済みの項目を取り除く', async () => await pruneArchivedItems(createOutput(false, io), client, config(), archivedItems(archived(1, 5)), false))
    stepSync('結果を確認する', () => {
      expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 0, failed: 2 }, err: 'warning: failed to delete 2 archived items\n' })
    })
  })

  it('削除に成功した場合は、削除した件数を表示する', async () => {
    await explains('古い 2 件の削除がどちらも成功する場合のテストです。削除した件数が 2 件になり、その件数を標準エラー出力に表示することを確認します。')
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([deletion('PVTI_1'), deletion('PVTI_2')]))
    const io = stepSync('出力の捕捉を用意する', () => capture())
    const result = await step('アーカイブ済みの項目を取り除く', async () => await pruneArchivedItems(createOutput(false, io), client, config(), archivedItems(), false))
    stepSync('結果を確認する', () => {
      expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 2, failed: 0 }, err: 'deleted: 2 archived items\n' })
    })
  })
})

describe('readBoard', () => {
  it('表示する列の OPEN の項目に絞り込み、リポジトリを指定した場合はそのリポジトリの項目にさらに絞り込む', async () => {
    await explains('ボードの項目を読み込む処理（`readBoard`）のテストです。`Archived` 列の項目、CLOSED の Issue、指定したリポジトリ以外の項目が除外され、`Ready` 列の OPEN の項目だけが残ることを確認します。')
    const nodes = [node('PVTI_1', 1, 'Ready'), node('PVTI_2', 2, 'Archived'), node('PVTI_3', 3, 'Ready', { state: 'CLOSED' }), node('PVTI_4', 4, 'Active', { repository: 'other' })]
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([graphqlData('ListProjectItems', page(nodes, ['fe']))]))
    const read = await step('ボードを読む', async () => await readBoard(client, config(), 'acme/demo'))
    stepSync('結果を確認する', () => {
      expect({ all: read.allItems.length, items: read.items.map(item => item.id), progress: [...read.progress].map(([key]) => key), isLegacy: read.isLegacy, name: read.workflowFieldName, unused: read.unusedFieldNames, lanes: read.laneOptions }).toEqual({
        all: 4,
        items: ['PVTI_1'],
        progress: ['acme/demo#1', 'acme/demo#2', 'acme/demo#3', 'acme/other#4'],
        isLegacy: false,
        name: 'pecot-status',
        unused: [],
        lanes: ['fe'],
      })
    })
  })

  it('依存関係に対応していない GHES の場合は、依存関係を含まない旧形式のクエリで読み込み直す', async () => {
    await explains('GitHub Enterprise Server が `blockedBy` に対応していない場合のテストです。最初のクエリがエラーとなった場合は、旧形式のクエリで読み込み直し、旧いフィールド名と使われていないフィールドを取得できることを確認します。')
    const legacy = page([node('PVTI_1', 1, 'Ready', { field: 'pecot-workflow-acme', others: ['pecot-priority'] })])
    const { client } = await step('GitHub の偽サーバを起動する', async () => await startClient([graphqlError('ListProjectItems', 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''), graphqlData('ListProjectItemsLegacy', legacy)]))
    const read = await step('ボードを読む', async () => await readBoard(client, config(), undefined))
    stepSync('結果を確認する', () => {
      expect({ items: read.items.map(item => item.id), isLegacy: read.isLegacy, name: read.workflowFieldName, unused: read.unusedFieldNames }).toEqual({ items: ['PVTI_1'], isLegacy: true, name: 'pecot-workflow-acme', unused: ['pecot-priority'] })
    })
  })
})

describe('warnOldFieldName', () => {
  const read = (workflowFieldName: string | undefined, unusedFieldNames: readonly string[]): BoardRead => ({ allItems: [], items: [], progress: new Map(), isLegacy: false, workflowFieldName, unusedFieldNames, laneOptions: undefined })

  it.for([
    { name: '現在のフィールド名で不要なフィールドも存在しなければ表示しない', workflowFieldName: 'pecot-status', unused: [], expected: '' },
    { name: '旧いフィールド名で不要なフィールドも存在すれば両方を知らせる', workflowFieldName: 'pecot-workflow-acme', unused: ['pecot-priority', 'pecot-size'], expected: 'warning: this board uses the old field name pecot-workflow-acme and still has fields pecot does not use: pecot-priority, pecot-size\n  call project_check with method: "fields", owner: "acme", project: 1 and apply the changes it asks for with the project-fields operation of github-ops, then project_activate with project: "1", owner: "acme" to read the board into the project config\n' },
    { name: 'ワークフローのフィールドが見つからない場合は、不要なフィールドだけを知らせる', workflowFieldName: undefined, unused: ['pecot-size'], expected: 'warning: this board still has fields pecot does not use: pecot-size\n  call project_check with method: "fields", owner: "acme", project: 1 and apply the changes it asks for with the project-fields operation of github-ops, then project_activate with project: "1", owner: "acme" to read the board into the project config\n' },
  ])('移行の警告は、$name', async ({ name, workflowFieldName, unused, expected }) => {
    await explains(`ボードのフィールド名に関する、移行の警告のテストです。移行の警告は、${name}ことを確認します。`)
    const io = stepSync('出力の捕捉を用意する', () => capture())
    stepSync('古い名前の警告を出す', () => {
      warnOldFieldName(createOutput(false, io), config(), read(workflowFieldName, unused))
    })
    stepSync('結果を確認する', () => {
      expect(io.err.join('')).toBe(expected)
    })
  })
})
