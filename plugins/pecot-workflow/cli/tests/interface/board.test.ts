/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 偽サーバの応答は readonly にしない */
/* eslint-disable unicorn/no-null -- 偽サーバの応答に JSON の null を使う */
// board_add・board_move・board_show の振る舞いを、ツールをプロセス内で呼んで確かめる。GitHub は偽サーバにする。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import type { ResponseRule } from '../../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { prerequisitesRule } from '../../../../../libs/workflow-core/tests/_helpers/prerequisites.js'
import { CONFIG_FILE, DEFAULT_HOST, graphqlRule, projectConfig, restRule, runCommand, runTool } from '../_helpers/command-harness.js'
import type { CommandResult, ToolResult } from '../_helpers/command-harness.js'
import { addedToBoard, boardItems, fieldUpdated, issueNodeId, linkedRepositories } from '../_helpers/board-issue-case.js'

useIsolatedEnvironment()

type Json = Record<string, unknown>

const FULL_WORKFLOW = { backlog: 'o1', blocked: 'ob', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' }
const STATUS = { id: 'PVTSSF_status', options: { todo: 'st1', in_progress: 'st2', done: 'st3', needs_attention: 'st4' } }
const notStarted = { number: 9 }

function asJson(value: unknown): Json {
  if (typeof value !== 'object' || value === null) throw new TypeError('not an object')
  return Object.fromEntries(Object.entries(value))
}

// Blocked と Status の値を持つ設定
function boardConfig(repositories?: readonly Json[]): Json {
  const base = projectConfig(repositories === undefined ? { workflowOptions: FULL_WORKFLOW } : { workflowOptions: FULL_WORKFLOW, repositories })
  const project = asJson(base['project'])
  return { ...base, project: { ...project, fields: { ...asJson(project['fields']), status: STATUS } } }
}

interface ItemExtra {
  readonly blockedBy?: number
  readonly repository?: string
  readonly title?: string
  readonly isPullRequest?: boolean
  readonly updatedAt?: string
  readonly state?: string
  readonly field?: string
  /**
  進行の欄のほかに値を持つ単一選択のフィールドの名前
  */
  readonly others?: readonly string[]
  readonly lane?: string
  /**
  親の Issue。前提の件数（blockedBy）と一緒に指定したときだけ載せる
  */
  readonly parent?: number
}

// 一覧の応答に載る、着手の判定の軽い入力
function item(id: string, number: number, workflow: string, extra: ItemExtra = {}): Json {
  const { repository = 'demo' } = extra
  const progress = extra.blockedBy === undefined ? {} : { issueType: null, subIssues: { totalCount: 0 }, parent: extra.parent === undefined ? null : { number: extra.parent, repository: { owner: { login: 'acme' }, name: repository } }, blockedBy: { totalCount: extra.blockedBy } }
  return {
    id,
    updatedAt: extra.updatedAt ?? '2026-01-02T03:04:05Z',
    ...extra.lane !== undefined && { lane: { name: extra.lane } },
    fieldValues: { nodes: [{ field: { id: 'PVTSSF_workflow', name: extra.field ?? 'pecot-status' }, name: workflow }, ...(extra.others ?? []).map(name => ({ field: { id: `F_${name}`, name }, name: 'High' }))] },
    content: { id: `I_${String(number)}`, number, title: extra.title ?? `課題${String(number)}`, state: extra.state ?? 'OPEN', url: `https://${DEFAULT_HOST}/acme/${repository}/${extra.isPullRequest === true ? 'pull' : 'issues'}/${String(number)}`, labels: { nodes: [] }, repository: { owner: { login: 'acme' }, name: repository }, ...progress },
  }
}

const board = (...nodes: Json[]): ResponseRule => graphqlRule('ListProjectItems', { node: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } })
// single select の pecot-lane（選択肢は options）を持つボード
const laneBoard = (options: readonly string[], ...nodes: Json[]): ResponseRule => graphqlRule('ListProjectItems', { node: { laneField: { options: options.map(name => ({ name })) }, items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } })
// project activate の案内に出る名前（CONFIG_FILE のファイル名から .json を除いたもの）
const ACTIVE_PROJECT = path.basename(CONFIG_FILE, '.json')
const stable = (stderr: string): string => stderr.replaceAll(/http:\/\/127\.0\.0\.1:\d+/gu, 'http://127.0.0.1:PORT')

function expectClean(result: Readonly<Pick<CommandResult, 'problems' | 'unused'>>): void {
  expect(result.problems).toEqual([])
  expect(result.unused).toEqual([])
}

const tool = async (name: string, arguments_: Json, rules: ResponseRule[], config: Json = boardConfig()): Promise<ToolResult> => await runTool({ tool: name, arguments: arguments_, github: rules, config })

const stableWarnings = (result: ToolResult): string[] => (Array.isArray(result.structured['warnings']) ? result.structured['warnings'].map(String) : []).map(warning => stable(warning))

const noAlerts = (): ResponseRule => restRule('GET', '/repos/acme/demo/dependabot/alerts', 200, [])
// pecot-lane の無いボード。Ready の #1 は着手できる
const noLaneRules = (): ResponseRule[] => [board(item('PVTI_1', 1, 'Ready'), item('PVTI_3', 3, 'Active')), noAlerts(), prerequisitesRule({ number: 1 })]
const showCommand = async (arguments_: Readonly<Record<string, unknown>>, rules: ResponseRule[]): Promise<CommandResult> => await runCommand({ tool: 'board_show', arguments: arguments_, github: rules, config: boardConfig() })

function itemLanes(result: ToolResult): unknown[] {
  const items = asJson(result.structured['board'])['items']
  return Array.isArray(items) ? items.map(entry => asJson(entry)['lane']) : []
}

// board show の data を確かめる応答。Ready の #1 に済んでいない前提があり、列が判定と合わない
const showRules = (): ResponseRule[] => [
  board(item('PVTI_1', 1, 'Ready')),
  restRule('GET', '/repos/acme/demo/dependabot/alerts', 200, [{ security_vulnerability: { severity: 'high' } }]),
  prerequisitesRule({ number: 1, blockedBy: [notStarted] }),
]

describe('board_add', () => {
  describe('MCP の data', () => {
    it('Issue を追加すると、追加した Issue・設定した Status を返す', async () => {
      await explains('MCP ツール `board_add` の結果のテストです。Issue を追加した場合に、追加した Issue と設定した Status を返すことを確認します。')
      const result = await tool('board_add', { issue_ref: 'acme/demo/7' }, [linkedRepositories(), issueNodeId(), addedToBoard(), fieldUpdated('o3')])
      expect(result.structured).toEqual({ issue: 'acme/demo/7', added: true, status: 'ready' })
    })
  })
})

describe('board_move', () => {
  describe('MCP の data', () => {
    it('Status を設定すると、その Issue と Status を返す', async () => {
      await explains('MCP ツール `board_move` の結果のテストです。Status を設定した場合に、その Issue と Status を返すことを確認します。')
      const result = await tool('board_move', { issue_ref: 'acme/demo/7', status: 'in_review' }, [linkedRepositories(), boardItems(), fieldUpdated('o5')])
      expect(result.structured).toEqual({ issue: 'acme/demo/7', status: 'in_review' })
    })
  })
})

describe('board_show', () => {
  describe('MCP の data', () => {
    const repositories = [{ owner: 'acme', name: 'demo', develop_branch: 'main', release_branch: 'release', packages: [{ name: 'pkg', changelog: 'packages/pkg/CHANGELOG.md' }] }]
    const expected = {
      project: { name: `${DEFAULT_HOST}_acme_board_acme`, host: DEFAULT_HOST, owner: 'acme', number: 1, aggregation_repo: null },
      repositories: [{
        full_name: 'acme/demo',
        owner: 'acme',
        name: 'demo',
        develop_branch: 'main',
        release_branch: 'release',
        dependabot_alerts: { enabled: true, open_count: 1, max_severity: 'high', alerts_url: `https://${DEFAULT_HOST}/acme/demo/security/dependabot` },
        release_type: 'multi',
        packages: [{ name: 'pkg', changelog: 'packages/pkg/CHANGELOG.md' }],
      }],
      board: { items: [
        { id: 'PVTI_1', workflow: 'Ready', lane: null, title: '課題1', updatedAt: '2026-01-02T03:04:05Z', content: { number: 1, state: 'OPEN', url: `https://${DEFAULT_HOST}/acme/demo/issues/1`, labels: [], repository: 'acme/demo' }, readiness: { kind: 'blocked', stackOn: null, reason: 'not-in-review', text: 'blocked by #9 (not in review: #9 (not started))' } },
      ] },
      lanes: [],
      mismatches: 1,
      warnings: ['1 Ready or Blocked Issue may be in a column or Status that does not match its judgment; run the pecot-board-sync workflow (Run workflow on its page in the Actions tab) to fix'],
    }

    it('json を省くと、json の中身に release_type・packages と列の合わない件数を足して返す', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-01')
      await verifies(context, 'PW-BOARD-SHOW-33')
      await explains('MCP ツール `board_show` の結果のテストです。`json` を省略した場合に、`json` の内容に `release_type`・`packages` と、列が判定と合わない件数を加えて返すことを確認します。')
      const result = await tool('board_show', {}, showRules(), boardConfig(repositories))
      expect(result.structured).toEqual(expected)
    })

    it('json を true にしても、同じ data を返す', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-02')
      await explains('MCP ツール `board_show` の `json` のテストです。`json` に `true` を指定した場合に、省略した場合と同じ内容を返すことを確認します。')
      const result = await tool('board_show', { json: true }, showRules(), boardConfig(repositories))
      expect(result.structured).toEqual(expected)
    })

    it('進行の欄が旧い名前のボードでは、旧い名前と project_init の案内を warnings に入れる', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-36')
      await explains('進行の欄が旧い名前のボードを扱う、MCP ツール `board_show` のテストです。旧い名前と `project_init` の案内を `warnings` に入れることを確認します。')
      const [, ...rest] = showRules()
      const result = await tool('board_show', {}, [board(item('PVTI_1', 1, 'Ready', { field: 'pecot-workflow-acme' })), ...rest], boardConfig(repositories))
      expectClean(result)
      expect(stableWarnings(result)[0]).toMatch(/^this board uses the old field name pecot-workflow-acme\n.*project_init/su)
    })

    it('Item の値に pecot-priority・pecot-size が残るボードでは、残った名前と project_init の案内を warnings に入れる', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-37')
      await explains('Item の値に旧いフィールドが残るボードを扱う、MCP ツール `board_show` のテストです。`pecot-priority`・`pecot-size` が残る場合に、残った名前と `project_init` の案内を `warnings` に入れることを確認します。')
      const [, ...rest] = showRules()
      const result = await tool('board_show', {}, [board(item('PVTI_1', 1, 'Ready', { others: ['pecot-priority', 'pecot-size'] })), ...rest], boardConfig(repositories))
      expectClean(result)
      expect(stableWarnings(result)[0]).toBe(`this board still has fields pecot does not use: pecot-priority, pecot-size\n  call project_init with owner: "acme", name: <name>, host: "${DEFAULT_HOST}"`)
      expect(result.structured['board']).toEqual(expected.board)
    })
  })

  describe('pecot-lane', () => {
    const LANES = ['alpha', 'beta', 'gamma']
    // Ready の #1 は着手でき、#6 は済んでいない前提がある。#5 は beta の値を持つ PR
    const laneRules = (): ResponseRule[] => [
      laneBoard(LANES,
        item('PVTI_1', 1, 'Ready', { lane: 'alpha' }),
        item('PVTI_2', 2, 'Backlog', { lane: 'alpha' }),
        item('PVTI_3', 3, 'Active'),
        item('PVTI_5', 5, 'Active', { lane: 'beta', isPullRequest: true }),
        item('PVTI_6', 6, 'Ready', { lane: 'alpha' }),
      ),
      noAlerts(),
      prerequisitesRule({ number: 1 }),
      prerequisitesRule({ number: 6, blockedBy: [notStarted] }),
    ]
    const laneSummaries = [
      { name: 'alpha', count: 3, startable: 1 },
      { name: 'beta', count: 0, startable: 0 },
      { name: 'gamma', count: 0, startable: 0 },
      { name: null, count: 1, startable: 0 },
    ]
    it('ボードに pecot-lane があると、各 Item の lane に値を入れ、lanes に値ごとの Issue の数と着手できる数を選択肢の順で入れ、PR を数えない', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-38')
      await verifies(context, 'PW-BOARD-SHOW-39')
      await explains('`pecot-lane` を持つボードを扱う、MCP ツール `board_show` のテストです。ボードが `pecot-lane` を持つ場合に、各 Item の `lane` に値を入れ、値ごとの Issue の数と着手できる数を選択肢の順で `lanes` に入れ、PR は数えないことを確認します。')
      const result = await tool('board_show', {}, laneRules())
      expectClean(result)
      expect(itemLanes(result)).toEqual(['alpha', 'alpha', null, 'beta', 'alpha'])
      expect(result.structured['lanes']).toEqual(laneSummaries)
    })

    it('lane の値を持たない Issue が存在しなければ、name が null の組を入れない', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-39')
      await explains('`pecot-lane` を持つボードを扱う、MCP ツール `board_show` のテストです。`lane` の値を持たない Issue が存在しなければ、`lanes` に `name` が `null` の組を入れないことを確認します。')
      const result = await tool('board_show', {}, [laneBoard(LANES, item('PVTI_2', 2, 'Backlog', { lane: 'beta' })), noAlerts()])
      expectClean(result)
      expect(result.structured['lanes']).toEqual([
        { name: 'alpha', count: 0, startable: 0 },
        { name: 'beta', count: 1, startable: 0 },
        { name: 'gamma', count: 0, startable: 0 },
      ])
    })

    it('ボードに pecot-lane が無いと、各 Item の lane を null に、lanes を空にし、Markdown に Lanes の節を出さない', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-40')
      await explains('`pecot-lane` を持たないボードを扱う、MCP ツール `board_show` のテストです。ボードが `pecot-lane` を持たない場合に、各 Item の `lane` を `null` にし、`lanes` を空にして、Markdown に `Lanes` の節を出力しないことを確認します。')
      const result = await tool('board_show', {}, noLaneRules())
      expectClean(result)
      expect(itemLanes(result)).toEqual([null, null])
      expect(result.structured['lanes']).toEqual([])
      const markdown = await showCommand({}, noLaneRules())
      expect(markdown.code).toBe(0)
      expect(markdown.stdout).toBe([
        '# Project info', '', '## Overview', `- Project: ${ACTIVE_PROJECT}`, `- Host: ${DEFAULT_HOST}`, '- Owner: acme', '- Roadmap repo: none', '',
        '## Registered repositories', '- acme/demo (develop: main)', '    release_type: single', '    dependabot_alerts: open 0', '',
        '## Board status', '', '### Active (1)', '| Ref | Title |', '|-----|----------|', '| acme/demo#3 | 課題3 |', '',
        '### Ready (1)', '| Ref | Title | Readiness |', '|-----|----------|-----------|', '| acme/demo#1 | 課題1 | startable |', '',
      ].join('\n'))
    })

    it('lanes が空でないと、Markdown の Board status の後に Lanes の節を表で出し、lane の値を持たない組を (none) と書く', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-41')
      await explains('`board_show` の `Lanes` の節のテストです。`lanes` が空でない場合に、Markdown の `Board status` の後ろへ `Lanes` の節を表で出力し、`lane` の値を持たない組を `(none)` と表示することを確認します。')
      const result = await showCommand({}, laneRules())
      expect(result.code).toBe(0)
      expectClean(result)
      expect(result.stdout).toContain([
        '| acme/demo#2 | 課題2 |',
        '',
        '## Lanes',
        '',
        '| Lane | Issues | Startable |',
        '|------|--------|-----------|',
        '| alpha | 3 | 1 |',
        '| beta | 0 | 0 |',
        '| gamma | 0 | 0 |',
        '| (none) | 1 | 0 |',
        '',
      ].join('\n'))
    })

    it('json を付けて打つと、lanes を JSON にも入れる', async () => {
      await explains('`board_show` の `json` のテストです。`json` を指定した場合に、`lanes` を JSON にも含めることを確認します。')
      const result = await showCommand({ json: true }, laneRules())
      expect(result.code).toBe(0)
      expect(asJson(JSON.parse(result.stdout))['lanes']).toEqual(laneSummaries)
    })

    it('repo を付けると、そのリポの Item だけで lanes を数える', async (context) => {
      await verifies(context, 'PW-BOARD-SHOW-42')
      await explains('MCP ツール `board_show` の `repo` のテストです。`repo` を指定した場合に、そのリポジトリの Item だけで `lanes` を数えることを確認します。')
      const result = await tool('board_show', { repo: 'acme/other' }, [
        laneBoard(LANES,
          item('PVTI_1', 1, 'Ready', { lane: 'alpha' }),
          item('PVTI_7', 7, 'Ready', { lane: 'beta', repository: 'other' }),
          item('PVTI_8', 8, 'Backlog', { repository: 'other' }),
        ),
        noAlerts(),
        prerequisitesRule({ number: 7, repo: 'other' }),
      ])
      expectClean(result)
      expect(result.structured['lanes']).toEqual([
        { name: 'alpha', count: 0, startable: 0 },
        { name: 'beta', count: 1, startable: 1 },
        { name: 'gamma', count: 0, startable: 0 },
        { name: null, count: 1, startable: 0 },
      ])
    })

    it('前提の無い Ready の Issue が親 Issue を持つと、前提を問い合わせずに startable と判定する', async () => {
      await explains('MCP ツール `board_show` の `readiness` のテストです。前提の件数が 0 で親 Issue を持つ Ready の Issue を渡した場合に、前提の問い合わせなしで `startable` と判定することを確認します。')
      const result = await tool('board_show', {}, [board(item('PVTI_1', 1, 'Ready', { blockedBy: 0, parent: 3 })), noAlerts()])
      const items = asJson(result.structured['board'])['items']
      expect(items).toMatchObject([{ id: 'PVTI_1', readiness: { text: 'startable' } }])
      expect(result.requests.map(request => request.type === 'graphql' ? request.operation : request.method)).not.toContain('GetIssuePrerequisites')
    })

    it('repo が owner/repo の形でないと、GitHub へ何も要求せず invalid-input の失敗を返す', async () => {
      await explains('`board_show` の `repo` を検証するテストです。`repo` が `owner/repo` の形でない場合に、GitHub へ何も要求せず、`invalid-input` の失敗を返すことを確認します。')
      const result = await tool('board_show', { repo: 'invalid-format' }, [])
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('invalid-input')
      expect(result.structured['detail']).toContain('must be in')
      expect(result.requests).toEqual([])
    })
  })
})
