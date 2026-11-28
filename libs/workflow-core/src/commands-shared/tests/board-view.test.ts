/* eslint-disable unicorn/no-null -- 偽サーバの応答と JSON の出力に null を使う */
// board show の表示・Archived の整理・Dependabot alert の収集。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { capture } from '../../../tests/_helpers/captured-io.js'
import type { JsonObject } from '../../domain/json.js'
import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import type { BoardItem } from '../../domain/format.js'
import { graphqlData, graphqlError, restResponse, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import { boardShowData, boardShowJson, boardShowMarkdown, boardShowResult, collectAlertStatuses, mapWithLimit, pruneArchivedItems, readBoard, warnOldFieldName } from '../board-view.js'
import type { BoardRead, BoardShowView } from '../board-view.js'
import { createOutput } from '../output.js'
// 案内のコマンドの形を登録する
import '../../../tests/_helpers/hint-commands.js'

useFakeGithub()

type Json = JsonObject

function config(repositories: readonly Json[] = [], extra: Json = {}): ProjectConfig {
  return parseProjectConfig({ host: 'github.com', owner: 'acme', project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'PVTSSF_workflow', options: {} } } }, repositories, ...extra })
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
    const result = await mapWithLimit([30, 10, 20, 0], 2, async (value) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, value))
      running -= 1
      return value * 2
    })
    expect({ result, peak }).toEqual({ result: [60, 20, 40, 0], peak: 2 })
  })
})

describe('pruneArchivedItems', () => {
  it('Archived 列の項目が 20 件以下の場合は、何も削除しない', async () => {
    await explains('ボードの `Archived` 列の項目を整理する処理（`pruneArchivedItems`）のテストです。項目が 20 件の場合に、API を呼び出さず、削除した件数と失敗した件数がどちらも 0 になることを確認します。')
    const { client } = await startClient([])
    const out = createOutput(false, capture())
    expect(await pruneArchivedItems(out, client, config(), archivedItems().slice(2), false)).toEqual({ deleted: 0, failed: 0 })
  })

  it('dry-run の場合は、削除せず、削除する予定の件数を表示する', async () => {
    await explains('`Archived` 列の項目が 22 件ある状態で、`dry-run` を指定した場合のテストです。削除は行わず、古い 2 件を削除する予定であることを標準エラー出力に表示することを確認します。')
    const { client } = await startClient([])
    const io = capture()
    const result = await pruneArchivedItems(createOutput(true, io), client, config(), archivedItems(), true)
    expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 2, failed: 0 }, err: 'dry-run: would delete 2 archived items\n' })
  })

  it('削除に失敗した項目と ID が文字列でない項目の件数を、警告として表示する', async () => {
    await explains('古い 2 件の削除がどちらも失敗する場合のテストです。1 件は API が HTTP 500 を返し、もう 1 件は ID が文字列でないため、失敗が 2 件になり、その件数を警告として表示することを確認します。')
    const { client } = await startClient([deletion('PVTI_2', false)])
    const io = capture()
    const result = await pruneArchivedItems(createOutput(false, io), client, config(), archivedItems(archived(1, 5)), false)
    expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 0, failed: 2 }, err: 'warning: failed to delete 2 archived items\n' })
  })

  it('削除に成功した場合は、削除した件数を表示する', async () => {
    await explains('古い 2 件の削除がどちらも成功する場合のテストです。削除した件数が 2 件になり、その件数を標準エラー出力に表示することを確認します。')
    const { client } = await startClient([deletion('PVTI_1'), deletion('PVTI_2')])
    const io = capture()
    const result = await pruneArchivedItems(createOutput(false, io), client, config(), archivedItems(), false)
    expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 2, failed: 0 }, err: 'deleted: 2 archived items\n' })
  })
})

describe('collectAlertStatuses', () => {
  it('リポジトリごとの状態を登録した順に返し、取得に失敗したリポジトリはエラーの文字列で返す', async () => {
    await explains('登録したリポジトリの Dependabot alert の状態を収集する処理のテストです。1 件目は取得に成功して状態を返し、2 件目は HTTP 500 で失敗してエラーの文字列を返すことを、登録した順に確認します。')
    const { client } = await startClient([
      restResponse('GET', '/repos/acme/a/dependabot/alerts', { status: 200, body: [] }),
      restResponse('GET', '/repos/acme/b/dependabot/alerts', { status: 500, text: 'x' }),
    ])
    expect(await collectAlertStatuses(client, config([{ owner: 'acme', name: 'a' }, { owner: 'acme', name: 'b' }]))).toEqual([
      { enabled: true, openCount: 0, maxSeverity: undefined, alertsUrl: 'https://github.com/acme/a/security/dependabot', openAlerts: [] },
      'acme/b: GitHub API error: 500',
    ])
  })
})

describe('board show の表示', () => {
  const repositories = [
    { owner: 'acme', name: 'a', develop_branch: 'develop', release_branch: 'main', packages: [{ name: 'pkg', changelog: 'pkg/CHANGELOG.md' }], release_type: 'nx' },
    { owner: 'acme', name: 'b', changelog_file: 'CHANGES.md' },
    { owner: 'acme', name: 'c' },
  ]
  const view: BoardShowView = {
    config: config(repositories, { aggregation_repo: 'acme/roadmap' }),
    projectName: 'board',
    statuses: [{ enabled: true, openCount: 3, maxSeverity: 'high', alertsUrl: 'https://github.com/acme/a/security/dependabot', openAlerts: [] }, { enabled: false, openCount: 0, maxSeverity: undefined, alertsUrl: 'u', openAlerts: [] }, 'boom'],
    laneOptions: ['fe', 'be'],
  }
  const items: BoardItem[] = [
    { id: 'PVTI_1', workflow: 'Ready', lane: 'fe', title: 'T1', content: { number: 1, url: 'https://github.com/acme/a/issues/1', labels: ['bug'], repository: 'acme/a' } },
    { id: 'PVTI_2', workflow: 'Active', lane: null, title: 'T2', content: { number: 2, url: 'https://github.com/acme/a/pull/2', repository: 'acme/a' } },
  ]

  it('判定を取得できる場合は、項目に判定を付け、着手できる Ready の Issue を Lane ごとに集計する', async () => {
    await explains('`board show` の表示用データを作成する処理のテストです。判定を渡した場合に、項目へ判定が付き、Lane ごとの件数と着手できる件数が集計され、リポジトリの alert とプロジェクトの情報が含まれることを確認します。')
    const data = boardShowData(view, items, item => item.content.number === 1 ? { kind: 'startable', stackOn: null, reason: null, text: 'ok' } : null)
    expect({ items: data.board.items.map(item => item.readiness), lanes: data.lanes, repositories: data.repositories.map(repository => repository.dependabot_alerts), project: data.project }).toEqual({
      items: [{ kind: 'startable', stackOn: null, reason: null, text: 'ok' }, null],
      lanes: [{ name: 'fe', count: 1, startable: 1 }, { name: 'be', count: 0, startable: 0 }],
      repositories: [{ enabled: true, open_count: 3, max_severity: 'high', alerts_url: 'https://github.com/acme/a/security/dependabot' }, { enabled: false, open_count: 0, max_severity: null, alerts_url: 'u' }, { error: 'boom' }],
      project: { name: 'board', host: 'github.com', owner: 'acme', number: 1, aggregation_repo: 'acme/roadmap' },
    })
  })

  it('判定と Lane の情報を渡さない場合は、項目に readiness を付けず、Lane の一覧を空にする', async () => {
    await explains('`board show` の表示用データのテストです。判定と Lane の情報を渡さない場合に、項目に `readiness` が付かず、Lane の一覧が空になり、JSON の出力が表示用データと同じ内容になることを確認します。')
    const data = boardShowData({ ...view, laneOptions: undefined }, items)
    const json: unknown = JSON.parse(boardShowJson(data))
    const hasReadiness = data.board.items.some(item => Object.hasOwn(item, 'readiness'))
    expect({ hasReadiness, lanes: data.lanes, json }).toEqual({ hasReadiness: false, lanes: [], json: structuredClone(data) })
  })

  it('取得した状態の数が登録したリポジトリの数より少ない場合は、例外が発生する', async () => {
    await explains('Dependabot alert の状態の数が、登録したリポジトリの数より不足している場合のテストです。`no Dependabot alert status for repository #0` というメッセージの例外が発生することを確認します。')
    expect(() => boardShowData({ ...view, statuses: [] }, items)).toThrow('no Dependabot alert status for repository #0')
  })

  it('MCP の data に、リリースの種類・パッケージ・CHANGELOG のファイルと、不一致の件数を追加する', async () => {
    await explains('MCP ツールが返す `data` を作成する処理のテストです。リポジトリごとにリリースの種類・パッケージ・CHANGELOG のファイル名が追加され、渡した不一致の件数 4 が `mismatches` に入ることを確認します。')
    const result = boardShowResult(view, boardShowData(view, items), 4)
    expect({ extras: result.repositories.map(({ release_type, packages, changelog_file }) => ({ release_type, packages, changelog_file })), mismatches: result.mismatches }).toEqual({
      extras: [
        { release_type: 'nx', packages: [{ name: 'pkg', changelog: 'pkg/CHANGELOG.md' }], changelog_file: undefined },
        { release_type: 'single', packages: [], changelog_file: 'CHANGES.md' },
        { release_type: 'single', packages: [], changelog_file: undefined },
      ],
      mismatches: 4,
    })
  })

  it('Markdown に、リポジトリのブランチ・リリース・alert・パッケージの情報と、Lanes の表を出力する', async () => {
    await explains('`board show` の Markdown を作成する処理のテストです。登録した 3 件のリポジトリの情報、絞り込みを示す見出し、Lanes の表が、定められた順序で出力されることを確認します。')
    expect(boardShowMarkdown(view, 'acme/a', '(board)', [{ name: 'fe', count: 1, startable: 1 }, { name: null, count: 2, startable: 0 }])).toBe([
      '# Project info',
      '',
      '## Overview',
      '- Project: board',
      '- Host: github.com',
      '- Owner: acme',
      '- Roadmap repo: `acme/roadmap`',
      '',
      '## Registered repositories',
      '- acme/a (develop: develop, release: main)',
      '    release_type: nx',
      '    dependabot_alerts: open 3',
      '    package: pkg → pkg/CHANGELOG.md',
      '- acme/b',
      '    release_type: single',
      '    dependabot_alerts: disabled',
      '    changelog: CHANGES.md',
      '- acme/c',
      '    release_type: single',
      '    dependabot_alerts: fetch failed (boom)',
      '',
      '## Board status (filter: acme/a)',
      '',
      '(board)',
      '',
      '## Lanes',
      '',
      '| Lane | Issues | Startable |',
      '|------|--------|-----------|',
      '| fe | 1 | 1 |',
      '| (none) | 2 | 0 |',
    ].join('\n'))
  })

  it('リポジトリが登録されておらず絞り込みも指定しない場合は、none を表示し、見出しに絞り込みを含めない', async () => {
    await explains('リポジトリが登録されていない場合の、Markdown のテストです。ロードマップのリポジトリと登録済みのリポジトリが `none` と表示され、見出しに絞り込みが含まれないことを確認します。')
    expect(boardShowMarkdown({ config: config(), projectName: 'board', statuses: [] }, undefined, '(board)')).toBe([
      '# Project info',
      '',
      '## Overview',
      '- Project: board',
      '- Host: github.com',
      '- Owner: acme',
      '- Roadmap repo: none',
      '',
      '## Registered repositories',
      '- none',
      '',
      '## Board status',
      '',
      '(board)',
    ].join('\n'))
  })
})

describe('readBoard', () => {
  it('表示する列の OPEN の項目に絞り込み、リポジトリを指定した場合はそのリポジトリの項目にさらに絞り込む', async () => {
    await explains('ボードの項目を読み込む処理（`readBoard`）のテストです。`Archived` 列の項目、CLOSED の Issue、指定したリポジトリ以外の項目が除外され、`Ready` 列の OPEN の項目だけが残ることを確認します。')
    const nodes = [node('PVTI_1', 1, 'Ready'), node('PVTI_2', 2, 'Archived'), node('PVTI_3', 3, 'Ready', { state: 'CLOSED' }), node('PVTI_4', 4, 'Active', { repository: 'other' })]
    const { client } = await startClient([graphqlData('ListProjectItems', page(nodes, ['fe']))])
    const read = await readBoard(client, config(), 'acme/demo')
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

  it('依存関係に対応していない GHES の場合は、依存関係を含まない旧形式のクエリで読み込み直す', async () => {
    await explains('GitHub Enterprise Server が `blockedBy` に対応していない場合のテストです。最初のクエリがエラーとなった場合は、旧形式のクエリで読み込み直し、旧いフィールド名と使われていないフィールドを取得できることを確認します。')
    const legacy = page([node('PVTI_1', 1, 'Ready', { field: 'pecot-workflow-acme', others: ['pecot-priority'] })])
    const { client } = await startClient([graphqlError('ListProjectItems', 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''), graphqlData('ListProjectItemsLegacy', legacy)])
    const read = await readBoard(client, config(), undefined)
    expect({ items: read.items.map(item => item.id), isLegacy: read.isLegacy, name: read.workflowFieldName, unused: read.unusedFieldNames }).toEqual({ items: ['PVTI_1'], isLegacy: true, name: 'pecot-workflow-acme', unused: ['pecot-priority'] })
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
    const io = capture()
    warnOldFieldName(createOutput(false, io), config(), read(workflowFieldName, unused))
    expect(io.err.join('')).toBe(expected)
  })
})
