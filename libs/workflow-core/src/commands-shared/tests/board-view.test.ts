/* eslint-disable unicorn/no-null -- 偽サーバの応答と JSON の出力に null を使う */
// board show の表示・Archived の整理・Dependabot alert の収集。GitHub は偽サーバにする。
import { describe, expect, it } from 'vitest'

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
  it('20 件以下なら何もしない', async () => {
    const { client } = await startClient([])
    const out = createOutput(false, capture())
    expect(await pruneArchivedItems(out, client, config(), archivedItems().slice(2), false)).toEqual({ deleted: 0, failed: 0 })
  })

  it('dry-run では消す予定の件数を出す', async () => {
    const { client } = await startClient([])
    const io = capture()
    const result = await pruneArchivedItems(createOutput(true, io), client, config(), archivedItems(), true)
    expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 2, failed: 0 }, err: 'dry-run: would delete 2 archived items\n' })
  })

  it('古いものから消し、消せなかった件数と ID の無い件数を warning で出す', async () => {
    const { client } = await startClient([deletion('PVTI_2', false)])
    const io = capture()
    const result = await pruneArchivedItems(createOutput(false, io), client, config(), archivedItems(archived(1, 5)), false)
    expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 0, failed: 2 }, err: 'warning: failed to delete 2 archived items\n' })
  })

  it('消せた件数を出す', async () => {
    const { client } = await startClient([deletion('PVTI_1'), deletion('PVTI_2')])
    const io = capture()
    const result = await pruneArchivedItems(createOutput(false, io), client, config(), archivedItems(), false)
    expect({ result, err: io.err.join('') }).toEqual({ result: { deleted: 2, failed: 0 }, err: 'deleted: 2 archived items\n' })
  })
})

describe('collectAlertStatuses', () => {
  it('リポジトリごとの状態を登録の順で返し、取れなかったリポジトリは理由の文字列にする', async () => {
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

  it('判定を引けるときは、アイテムに判定を添え、Ready の着手できる Issue を Lane ごとに数える', () => {
    const data = boardShowData(view, items, item => item.content.number === 1 ? { kind: 'startable', stackOn: null, reason: null, text: 'ok' } : null)
    expect({ items: data.board.items.map(item => item.readiness), lanes: data.lanes, repositories: data.repositories.map(repository => repository.dependabot_alerts), project: data.project }).toEqual({
      items: [{ kind: 'startable', stackOn: null, reason: null, text: 'ok' }, null],
      lanes: [{ name: 'fe', count: 1, startable: 1 }, { name: 'be', count: 0, startable: 0 }],
      repositories: [{ enabled: true, open_count: 3, max_severity: 'high', alerts_url: 'https://github.com/acme/a/security/dependabot' }, { enabled: false, open_count: 0, max_severity: null, alerts_url: 'u' }, { error: 'boom' }],
      project: { name: 'board', host: 'github.com', owner: 'acme', number: 1, aggregation_repo: 'acme/roadmap' },
    })
  })

  it('判定が無いときは、readiness を付けず、着手できる数を 0 にする', () => {
    const data = boardShowData({ ...view, laneOptions: undefined }, items)
    const json: unknown = JSON.parse(boardShowJson(data))
    const hasReadiness = data.board.items.some(item => Object.hasOwn(item, 'readiness'))
    expect({ hasReadiness, lanes: data.lanes, json }).toEqual({ hasReadiness: false, lanes: [], json: structuredClone(data) })
  })

  it('取得結果の数が登録のリポジトリより少なければ投げる', () => {
    expect(() => boardShowData({ ...view, statuses: [] }, items)).toThrow('no Dependabot alert status for repository #0')
  })

  it('MCP の data に、リリースの種類・パッケージ・CHANGELOG と食い違いの件数を足す', () => {
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

  it('Markdown に、リポジトリの枝・リリース・alert・パッケージと、Lanes と後ろの節を並べる', () => {
    expect(boardShowMarkdown(view, 'acme/a', '(board)', '## Chains', [{ name: 'fe', count: 1, startable: 1 }, { name: null, count: 2, startable: 0 }])).toBe([
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
      '',
      '## Chains',
    ].join('\n'))
  })

  it('リポジトリと絞り込みが無ければ、none と絞り込みの無い見出しにする', () => {
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
  it('表示する列の OPEN のアイテムに絞り、リポジトリの指定でさらに絞る', async () => {
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

  it('依存関係を知らない GHES では、足す前のクエリで読み直す', async () => {
    const legacy = page([node('PVTI_1', 1, 'Ready', { field: 'pecot-workflow-acme', others: ['pecot-priority'] })])
    const { client } = await startClient([graphqlError('ListProjectItems', 'Field \'blockedBy\' doesn\'t exist on type \'Issue\''), graphqlData('ListProjectItemsLegacy', legacy)])
    const read = await readBoard(client, config(), undefined)
    expect({ items: read.items.map(item => item.id), isLegacy: read.isLegacy, name: read.workflowFieldName, unused: read.unusedFieldNames }).toEqual({ items: ['PVTI_1'], isLegacy: true, name: 'pecot-workflow-acme', unused: ['pecot-priority'] })
  })
})

describe('warnOldFieldName', () => {
  const read = (workflowFieldName: string | undefined, unusedFieldNames: readonly string[]): BoardRead => ({ allItems: [], items: [], progress: new Map(), isLegacy: false, workflowFieldName, unusedFieldNames, laneOptions: undefined })

  it.for([
    { name: '今の名前で、使わないフィールドが無い', workflowFieldName: 'pecot-status', unused: [], expected: '' },
    { name: '旧い名前で、使わないフィールドもある', workflowFieldName: 'pecot-workflow-acme', unused: ['pecot-priority', 'pecot-size'], expected: 'warning: this board uses the old field name pecot-workflow-acme and still has fields pecot does not use: pecot-priority, pecot-size\n  run: pecot project init acme <name> --host github.com\n' },
    { name: '値が無い', workflowFieldName: undefined, unused: ['pecot-size'], expected: 'warning: this board still has fields pecot does not use: pecot-size\n  run: pecot project init acme <name> --host github.com\n' },
  ])('$name とき、移行の手順を 1 つの warning で出すかを決める', ({ workflowFieldName, unused, expected }) => {
    const io = capture()
    warnOldFieldName(createOutput(false, io), config(), read(workflowFieldName, unused))
    expect(io.err.join('')).toBe(expected)
  })
})
