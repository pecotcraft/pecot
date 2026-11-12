// Node の CLI でシナリオを流し、golden と一致することを確かめる。golden は Node の回帰の控えで、挙動を変えたら再生成して差分を確かめ、手で直す。コマンドの足し忘れは registry.test.ts が止める。
import { describe, expect, it } from 'vitest'

import { cliEntry, builtCliProblem } from './built-cli.js'
import { readToolShape, toolInputOf } from './mcp-input.js'
import { runScenario } from './run.js'
import type { Launcher, Outcome } from './run.js'
import type { Golden } from './scenario.js'
import { readGolden, readScenario, scenarioIds } from './scenario.js'

// issue reopen は 3 秒待つ。子プロセスの時間切れ（25 秒）より長くする
const TEST_TIMEOUT_MS = 30_000

// help を stdout に出すシナリオ。書式は Node で決めた（#362）ので、stdout だけ golden と比べない。中身は help.test.ts が確かめる
const SCENARIOS_WITH_NODE_HELP: ReadonlySet<string> = new Set([
  'global-ok-help',
  'global-ok-help-group',
  'global-ok-help-after-double-dash',
  'global-usage-no-args',
])

// MCP のツールの呼び出しに写せないシナリオ。ここに無いものは、MCP 経由でも流す
const MCP_UNMAPPABLE_STDIN: ReadonlySet<string> = new Set([
  'worktree-link-ok-overwrite-confirmed',
  'worktree-link-state-overwrite-declined',
  'worktree-link-state-overwrite-eof',
])

// 名前に usage を含む CLI の引数の誤りのうち、MCP 経由では golden と比べないもの。理由は 2 種類
//   unmappable: argv を入力に写せない（未知のフラグなど）。toolInputOf が例外にする
//   rejected: 入力には写せるが、入力の検証で断られる（必須の欠けなど）。本体を呼ばないので `_meta` が無い
// ここに無い usage のシナリオは MCP 経由でも流し、golden と比べる
const MCP_USAGE_EXCLUDED: ReadonlyMap<string, 'unmappable' | 'rejected'> = new Map([
  ['add-to-project-usage', 'rejected'],
  ['dependabot-sync-usage-unknown-option', 'unmappable'],
  ['issue-read-usage', 'rejected'],
  ['pr-preflight-usage', 'rejected'],
  ['project-init-usage', 'rejected'],
  ['project-search-usage', 'rejected'],
  ['project-set-aggregation-repo-usage', 'rejected'],
  ['project-set-repo-usage', 'rejected'],
  ['release-create-usage-no-version', 'rejected'],
  ['release-preflight-usage-unknown-option', 'unmappable'],
  ['security-sync-usage-unknown-option', 'unmappable'],
  ['session-status-usage', 'rejected'],
  ['worktree-add-usage', 'rejected'],
  ['worktree-init-usage', 'rejected'],
  ['worktree-link-usage', 'rejected'],
  ['worktree-remove-usage', 'rejected'],
])

// global-*: --help・--version・--show-repo・未知のコマンド・引数なしは、ツールの呼び出しに写せない。
// 標準入力を使う 3 件: MCP のツールは標準入力を持たない
function isMcpMappable(id: string): boolean {
  return !id.startsWith('global-') && !MCP_USAGE_EXCLUDED.has(id) && !MCP_UNMAPPABLE_STDIN.has(id)
}

function excludedBy(reason: 'unmappable' | 'rejected'): readonly string[] {
  return [...MCP_USAGE_EXCLUDED].filter(([, kind]) => kind === reason).map(([id]) => id)
}

const node: Launcher = { command: process.execPath, args: [cliEntry], env: {} }
const nodeMcp: Launcher = { ...node, via: 'mcp' }

interface Comparison {
  readonly outcome: Outcome
  readonly actual: Golden
  readonly expected: Golden
}

// help の 4 件は stdout を除いて比べる（isStdoutSkipped）
async function compareWithGolden(id: string, launcher: Launcher, isStdoutSkipped: boolean): Promise<Comparison> {
  const outcome = await runScenario(readScenario(id), launcher)
  const compared = (result: Golden): Golden => isStdoutSkipped ? { ...result, stdout: '' } : result
  return { outcome, actual: compared(outcome.golden), expected: compared(readGolden(id)) }
}

// 起動できて、時間内にシグナルなしで終わること。偽サーバの誤りと、使われなかった応答が無いこと
const COMPLETED = { spawnError: undefined, signal: undefined, timedOut: false, problems: [], unused: [] }

describe('前後比較', () => {
  it('Node の CLI がビルドされている', () => {
    expect(builtCliProblem()).toBeUndefined()
  })

  it.for(scenarioIds())('シナリオ %s を動かすと、golden と同じ出力になる（help の 4 件は stdout を除く）', { timeout: TEST_TIMEOUT_MS }, async (id) => {
    const isNodeHelp = SCENARIOS_WITH_NODE_HELP.has(id)
    const { outcome, actual, expected } = await compareWithGolden(id, node, isNodeHelp)
    expect(outcome).toMatchObject(COMPLETED)
    expect(actual).toEqual(expected)
    // help の 4 件の stdout は golden（Python の枠）と違い、ほかは同じ
    expect(outcome.golden.stdout === readGolden(id).stdout).toBe(!isNodeHelp)
  })

  it('標準入力が空でないシナリオは、MCP へ写せない 3 件の中にある', () => {
    const withStdin = scenarioIds().filter(id => readScenario(id).stdin !== '')
    expect(withStdin.filter(id => !MCP_UNMAPPABLE_STDIN.has(id))).toEqual([])
    expect(withStdin.length).toBeGreaterThan(0)
  })

  it.for(scenarioIds().filter(id => isMcpMappable(id)))('MCP 経由でシナリオ %s を動かすと、golden と同じ出力になる', { timeout: TEST_TIMEOUT_MS }, async (id) => {
    const { outcome, actual, expected } = await compareWithGolden(id, nodeMcp, false)
    expect(outcome).toMatchObject(COMPLETED)
    expect(actual).toEqual(expected)
  })

  it('MCP 経由で除く usage の一覧は、実在する usage のシナリオだけで、残りの usage は流す', () => {
    const usageIds = scenarioIds().filter(id => id.includes('usage') && !id.startsWith('global-'))
    expect([...excludedBy('unmappable'), ...excludedBy('rejected')].filter(id => !usageIds.includes(id))).toEqual([])
    expect(usageIds.filter(id => isMcpMappable(id)).length).toBeGreaterThan(0)
  })

  it.for(excludedBy('unmappable'))('usage のシナリオ %s は、argv を入力に写せず、例外になる', (id) => {
    const { command } = readScenario(id)
    expect(() => toolInputOf(readToolShape(command.path), command.args)).toThrow()
  })

  it.for(excludedBy('rejected'))('usage のシナリオ %s は、MCP が入力の検証で断り、本体を呼ばない', { timeout: TEST_TIMEOUT_MS }, async (id) => {
    const { command } = readScenario(id)
    expect(() => toolInputOf(readToolShape(command.path), command.args)).not.toThrow()
    const outcome = await runScenario(readScenario(id), nodeMcp)
    expect(outcome).toMatchObject(COMPLETED)
    // _meta が無いので終了コードは -1。本体が呼ばれていれば、偽サーバに要求が届く
    expect(outcome.golden).toMatchObject({ exitCode: -1, requests: [] })
    expect(outcome.golden.stdout).toMatch(/^invalid input: /u)
  })
})
