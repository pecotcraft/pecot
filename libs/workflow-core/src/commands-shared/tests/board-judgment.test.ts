// ボードの Issue の判定と、列と札の動かし方。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'

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
  it('ボードに無い値を名前の順に並べ、数に合わせて代名詞を変える', () => {
    const one = missingWarning(new Set(['Todo']))
    const two = missingWarning(new Set(['Todo', 'Blocked']))
    expect([formatHinted(one, 'cli'), formatHinted(two, 'cli')]).toEqual([
      'the board has no option Todo; add it with pecot project init',
      'the board has no option Blocked, Todo; add them with pecot project init',
    ])
  })
})

describe('judgeBoard', () => {
  it('対象の列の Issue だけを読み、PR・Tracker・ほかの列・リポジトリの無いものを外す', async () => {
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

  it('withoutRead が skip なら外し、読み取り結果を返せばそれで判定する', async () => {
    const { client, server } = await startClient([])
    const judged = await judgeBoard(client, config(), [item(1, 'Ready'), item(2, 'Ready')], new Map(), {
      columns: SYNCED_COLUMNS,
      withoutRead: (target: BoardTarget) => target.ref.number === 1
        ? 'skip'
        : snapshotWithoutPrerequisites(config(), { title: 'T', target: { ref: target.ref, state: 'open', column: 'Ready', label: undefined, kind: 'task', branches: [], pullRequests: [] }, parent: undefined }),
    })
    expect({ judged: judged?.map(target => [target.target.key, judgedOf(target).readiness?.kind]), requests: graphqlRequests(server) }).toEqual({ judged: [['acme/demo#2', 'startable']], requests: [] })
  })

  it('ボードの Issue どうしの前提の輪を、判定に入れる', async () => {
    const { client } = await startClient([
      prerequisitesRule({ number: 1, column: 'Ready', blockedBy: [{ number: 2, column: 'Ready' }] }),
      prerequisitesRule({ number: 2, column: 'Ready', blockedBy: [{ number: 1, column: 'Ready' }] }),
    ])
    const judged = await judgeBoard(client, config(), [item(1, 'Ready'), item(2, 'Ready')], new Map(), readAll)
    expect(judged?.map(target => judgedOf(target).readiness?.reason?.code)).toEqual(['cycle', 'cycle'])
  })

  it('依存関係に対応しない GHES では、undefined を返す', async () => {
    const { client } = await startClient([{ match: { operation: 'GetIssuePrerequisites' }, respond: { status: 200, body: { errors: [{ message: UNSUPPORTED }] } }, times: 1 }])
    expect(await judgeBoard(client, config(), [item(1, 'Ready')], new Map(), readAll)).toBeUndefined()
  })

  it('読めない Issue は、読めない理由のまま返す', async () => {
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
  it('判定に合わせて列を書き、書いた行を返す', async () => {
    const { client, judged } = await judge([blockedRule(), write('PVTI_1', 'ob')])
    const io = capture()
    const result = await applyJudgedMoves({ out: createOutput(false, io), client, config: config(), home: HOME }, judged)
    expect({ failures: result.failures, moves: result.moves.map(move => [move.issue, move.column]), err: io.err.join('') }).toEqual({
      failures: 0,
      moves: [['#1', { from: 'Ready', to: 'Blocked' }]],
      err: 'moved: #1 Ready -> Blocked (blocked by #2 (not in review: #2 (not started)))\n',
    })
  })

  it('dry-run では書かず、予定の行を返す', async () => {
    const { client, judged } = await judge([blockedRule()])
    const io = capture()
    const result = await applyJudgedMoves({ out: createOutput(true, io), client, config: config(), home: HOME }, judged, true)
    expect({ moves: result.moves.map(move => move.column), err: io.err.join('') }).toEqual({ moves: [{ from: 'Ready', to: 'Blocked' }], err: 'dry-run: would move #1 Ready -> Blocked (blocked by #2 (not in review: #2 (not started)))\n' })
  })

  it('書き込みに失敗した Issue を数える', async () => {
    const { client, judged } = await judge([blockedRule(), { match: { operation: 'UpdateProjectItemField' }, respond: { status: 500, body: { message: 'boom' } }, times: 1 }])
    const result = await applyJudgedMoves({ out: createOutput(false, capture()), client, config: config(), home: HOME }, judged)
    expect(result).toEqual({ failures: 1, moves: [] })
  })

  it('ボードに無い動かし先は、最後に 1 行の warning にまとめる', async () => {
    const { client, judged } = await judge([blockedRule()], false)
    const io = capture()
    const result = await applyJudgedMoves({ out: createOutput(false, io), client, config: config(false), home: HOME }, judged)
    expect({ result, err: io.err.join('') }).toEqual({ result: { failures: 0, moves: [] }, err: 'warning: the board has no option Blocked; add it with pecot project init\n' })
  })

  it('読めない Issue は、空白を詰めた理由で warning にする', async () => {
    const io = capture()
    const { client } = await startClient([])
    const target: BoardTarget = { item: item(1, 'Ready'), key: 'acme/demo#1', ref: { repository: HOME, number: 1 } }
    const result = await applyJudgedMoves({ out: createOutput(false, io), client, config: config(), home: HOME }, [{ target, result: { kind: 'unreadable', reason: 'a\n  b' } }])
    expect({ result, err: io.err.join('') }).toEqual({ result: { failures: 0, moves: [] }, err: 'warning: could not judge #1: a b\n' })
  })

  it('動かす要らない判定は、何も書かない', async () => {
    const { client, judged } = await judge([prerequisitesRule({ number: 1, column: 'Ready' })])
    const io = capture()
    expect({ result: await applyJudgedMoves({ out: createOutput(false, io), client, config: config(), home: HOME }, judged), err: io.err.join('') }).toEqual({ result: { failures: 0, moves: [] }, err: '' })
    const [first] = judged
    expect(first === undefined ? 'none' : boardMoveOf(config(), first.target, judgedOf(first))).toBeUndefined()
  })
})
