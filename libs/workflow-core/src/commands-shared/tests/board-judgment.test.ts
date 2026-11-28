// ボードの Issue の判定と、列と札の動かし方。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { capture } from '../../../tests/_helpers/captured-io.js'
import { prerequisitesRule } from '../../../tests/_helpers/prerequisites.js'
import type { ResponseRule } from '../../../tests/_helpers/fake-github/server.js'
import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import type { BoardItem } from '../../domain/format.js'
import { createRepositoryReference } from '../../domain/repository-resolver.js'
import { graphqlError, graphqlRequests, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import type { StartedClient } from '../../infra/github/tests/fake-client.js'
import { applyJudgedMoves, boardMoveOf, judgeBoard, missingWarning, SYNCED_COLUMNS } from '../board-judgment.js'
import type { BoardTarget, JudgedTarget } from '../board-judgment.js'
import { snapshotWithoutPrerequisites } from '../issue-readiness.js'
import type { JudgedIssue } from '../issue-readiness.js'
import { formatHinted } from '../../domain/command-hint.js'
import { createOutput } from '../output.js'
// 案内のコマンドの形を登録する
import '../../../tests/_helpers/hint-commands.js'

useFakeGithub()

const HOME = createRepositoryReference('acme', 'demo')
const UNSUPPORTED = 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''

function config(hasBlocked = true): ProjectConfig {
  const workflow = hasBlocked ? { ready: 'o3', blocked: 'ob', active: 'o4' } : { ready: 'o3', active: 'o4' }
  return parseProjectConfig({
    host: 'github.com',
    owner: 'acme',
    project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: workflow }, status: { id: 'PVTSSF_status', options: { todo: 'st1' } } } },
    repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'main' }],
  })
}

function item(number: number, workflow: string, extra: Partial<BoardItem> & { readonly url?: string } = {}): BoardItem {
  const { url = `https://github.com/acme/demo/issues/${String(number)}`, ...rest } = extra
  return { id: `PVTI_${String(number)}`, workflow, title: `課題${String(number)}`, content: { number, state: 'OPEN', url, repository: 'acme/demo' }, ...rest }
}

const write = (itemId: string, optionId: string): ResponseRule => ({ match: { operation: 'UpdateProjectItemField', variables: { itemId, optionId } }, respond: { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } } } }, times: 1 })

const readAll = { columns: SYNCED_COLUMNS, withoutRead: (): undefined => undefined }

function judgedOf(target: JudgedTarget): JudgedIssue {
  if (target.result.kind !== 'judged') throw new Error(target.result.reason)
  return target.result
}

describe('missingWarning', () => {
  it('ボードに存在しない選択肢を名前順に並べ、数に応じて it と them を使い分けた警告文を作成する', async () => {
    await explains('ボードに存在しない選択肢（`Blocked` や `Todo` など）へ Issue を移動しようとしたときに表示する、警告文のテストです。不足している選択肢が 1 つの場合と 2 つの場合で、名前が名前順に並び、`it` と `them` が正しく使い分けられることを確認します。')
    const one = missingWarning(new Set(['Todo']))
    const two = missingWarning(new Set(['Todo', 'Blocked']))
    expect([formatHinted(one), formatHinted(two)]).toEqual([
      'the board has no option Todo; add it with project_check with method: "fields" and apply the changes it asks for with the project-fields operation of github-ops, then project_activate to read the board into the project config',
      'the board has no option Blocked, Todo; add them with project_check with method: "fields" and apply the changes it asks for with the project-fields operation of github-ops, then project_activate to read the board into the project config',
    ])
  })
})

describe('judgeBoard', () => {
  it('対象の列の Issue だけを読み込み、PR・Tracker・ほかの列の項目と、リポジトリが不明な項目を除外する', async () => {
    await explains('ボードの項目から判定の対象を絞り込む処理のテストです。`Ready` 列の Issue だけが判定の対象になり、PR・Tracker・ほかの列・リポジトリが不明の項目は除外され、前提の取得も対象の 1 件だけであることを確認します。')
    const { client, server } = await startClient([prerequisitesRule({ number: 1, column: 'Ready' })])
    const items = [
      item(1, 'Ready'),
      item(2, 'Ready', { url: 'https://github.com/acme/demo/pull/2' }),
      item(3, 'Ready', { title: '[Tracker] 追う' }),
      item(4, 'Backlog'),
      { ...item(5, 'Ready'), content: { number: 5, url: 'https://github.com/x' } },
    ]
    const judged = await judgeBoard(client, config(), items, new Map(), readAll)
    expect({ targets: judged?.map(({ target }) => target.key), operations: graphqlRequests(server).map(request => request.operation) }).toEqual({ targets: ['acme/demo#1'], operations: ['GetIssuePrerequisites'] })
  })

  it('withoutRead が skip を返した Issue は除外し、判定用のデータを返した Issue はそのデータで判定する', async () => {
    await explains('前提の取得を省略できる仕組み（`withoutRead`）のテストです。`skip` を返した Issue が判定の対象から除外され、データを返した Issue はそのデータで判定されて、API を呼び出さないことを確認します。')
    const { client, server } = await startClient([])
    const judged = await judgeBoard(client, config(), [item(1, 'Ready'), item(2, 'Ready')], new Map(), {
      columns: SYNCED_COLUMNS,
      withoutRead: (target: BoardTarget) => target.ref.number === 1
        ? 'skip'
        : snapshotWithoutPrerequisites(config(), { title: 'T', target: { ref: target.ref, state: 'open', column: 'Ready', label: undefined, kind: 'task', branches: [], pullRequests: [] }, parent: undefined }),
    })
    expect({ judged: judged?.map(target => [target.target.key, judgedOf(target).readiness?.kind]), requests: graphqlRequests(server) }).toEqual({ judged: [['acme/demo#2', 'startable']], requests: [] })
  })

  it('ボードの Issue どうしが互いを前提にしている場合は、循環した前提として判定する', async () => {
    await explains('2 つの Issue が互いを前提にしている場合の、判定のテストです。どちらの Issue も、判定の理由が循環（`cycle`）になることを確認します。')
    const { client } = await startClient([
      prerequisitesRule({ number: 1, column: 'Ready', blockedBy: [{ number: 2, column: 'Ready' }] }),
      prerequisitesRule({ number: 2, column: 'Ready', blockedBy: [{ number: 1, column: 'Ready' }] }),
    ])
    const judged = await judgeBoard(client, config(), [item(1, 'Ready'), item(2, 'Ready')], new Map(), readAll)
    expect(judged?.map(target => judgedOf(target).readiness?.reason?.code)).toEqual(['cycle', 'cycle'])
  })

  it('依存関係に対応していない GHES の場合は、undefined を返す', async () => {
    await explains('GitHub Enterprise Server が前提の取得（`blockedBy` フィールド）に対応していない場合のテストです。API が `blockedBy` フィールドは存在しないと応答したときに、判定せず `undefined` を返すことを確認します。')
    const { client } = await startClient([{ match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: UNSUPPORTED }] } }, times: 1 }])
    expect(await judgeBoard(client, config(), [item(1, 'Ready')], new Map(), readAll)).toBeUndefined()
  })

  it('Issue の取得に失敗した場合は、判定できなかった項目（unreadable）として返す', async () => {
    await explains('前提の取得で GraphQL のエラーが発生した場合のテストです。その Issue が、判定できなかった項目（`unreadable`）として返されることを確認します。')
    const { client } = await startClient([graphqlError('GetIssuePrerequisites', 'boom')])
    const judged = await judgeBoard(client, config(), [item(1, 'Ready')], new Map(), readAll)
    expect(judged?.map(target => target.result.kind)).toEqual(['unreadable'])
  })
})

async function judge(rules: readonly ResponseRule[], hasBlocked = true): Promise<{ client: StartedClient['client'], judged: readonly JudgedTarget[] }> {
  const { client } = await startClient(rules)
  const judged = await judgeBoard(client, config(hasBlocked), [item(1, 'Ready')], new Map(), readAll)
  if (judged === undefined) throw new Error('unsupported')
  return { client, judged }
}

// #1 が、着手していない #2 を前提に持つ
const blockedRule = (): ResponseRule => prerequisitesRule({ number: 1, column: 'Ready', blockedBy: [{ number: 2 }] })

describe('applyJudgedMoves', () => {
  it('判定の結果に従って列を更新し、更新した内容を返す', async () => {
    await explains('判定の結果をボードへ反映する処理のテストです。未着手の Issue を前提に持つ Issue を `Blocked` 列へ移動し、移動した内容と標準エラー出力のメッセージを返すことを確認します。')
    const { client, judged } = await judge([blockedRule(), write('PVTI_1', 'ob')])
    const io = capture()
    const result = await applyJudgedMoves({ out: createOutput(false, io), client, config: config(), home: HOME }, judged)
    expect({ failures: result.failures, moves: result.moves.map(move => [move.issue, move.column]), err: io.err.join('') }).toEqual({
      failures: 0,
      moves: [['#1', { from: 'Ready', to: 'Blocked' }]],
      err: 'moved: #1 Ready -> Blocked (blocked by #2 (not in review: #2 (not started)))\n',
    })
  })

  it('dry-run の場合は、列を更新せず、移動の予定だけを表示する', async () => {
    await explains('`dry-run` を指定した場合のテストです。ボードへ書き込まず、移動の予定（`Ready` から `Blocked`）を標準エラー出力に表示することを確認します。')
    const { client, judged } = await judge([blockedRule()])
    const io = capture()
    const result = await applyJudgedMoves({ out: createOutput(true, io), client, config: config(), home: HOME }, judged, true)
    expect({ moves: result.moves.map(move => move.column), err: io.err.join('') }).toEqual({ moves: [{ from: 'Ready', to: 'Blocked' }], err: 'dry-run: would move #1 Ready -> Blocked (blocked by #2 (not in review: #2 (not started)))\n' })
  })

  it('ボードへの書き込みに失敗した場合は、失敗した Issue の数を返す', async () => {
    await explains('ボードへの書き込みが HTTP 500 で失敗した場合のテストです。失敗の件数が 1 件になり、移動した内容は空になることを確認します。')
    const { client, judged } = await judge([blockedRule(), { match: { operation: 'UpdateProjectItemField' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])
    const result = await applyJudgedMoves({ out: createOutput(false, capture()), client, config: config(), home: HOME }, judged)
    expect(result).toEqual({ failures: 1, moves: [] })
  })

  it('ボードに存在しない列への移動は、最後に警告を 1 行だけ表示する', async () => {
    await explains('移動先の `Blocked` 列がボードに存在しない場合のテストです。書き込みは行わず、不足している列を知らせる警告を 1 行だけ表示することを確認します。')
    const { client, judged } = await judge([blockedRule()], false)
    const io = capture()
    const result = await applyJudgedMoves({ out: createOutput(false, io), client, config: config(false), home: HOME }, judged)
    expect({ result, err: io.err.join('') }).toEqual({ result: { failures: 0, moves: [] }, err: 'warning: the board has no option Blocked; add it with project_check with method: "fields" and apply the changes it asks for with the project-fields operation of github-ops, then project_activate to read the board into the project config\n' })
  })

  it('判定できなかった Issue は、理由の空白を 1 つにまとめた警告を表示する', async () => {
    await explains('判定できなかった Issue がある場合の警告のテストです。理由に含まれる改行と連続した空白が 1 つの空白にまとめられ、警告に表示されることを確認します。')
    const io = capture()
    const { client } = await startClient([])
    const target: BoardTarget = { item: item(1, 'Ready'), key: 'acme/demo#1', ref: { repository: HOME, number: 1 } }
    const result = await applyJudgedMoves({ out: createOutput(false, io), client, config: config(), home: HOME }, [{ target, result: { kind: 'unreadable', reason: 'a\n  b' } }])
    expect({ result, err: io.err.join('') }).toEqual({ result: { failures: 0, moves: [] }, err: 'warning: could not judge #1: a b\n' })
  })

  it('列を移動する必要がない判定の場合は、何も書き込まない', async () => {
    await explains('移動が不要と判定された Issue のテストです。書き込みや出力をせず、`boardMoveOf` が `undefined` を返すことを確認します。')
    const { client, judged } = await judge([prerequisitesRule({ number: 1, column: 'Ready' })])
    const io = capture()
    expect({ result: await applyJudgedMoves({ out: createOutput(false, io), client, config: config(), home: HOME }, judged), err: io.err.join('') }).toEqual({ result: { failures: 0, moves: [] }, err: '' })
    const [first] = judged
    expect(first === undefined ? 'none' : boardMoveOf(config(), first.target, judgedOf(first))).toBeUndefined()
  })
})
