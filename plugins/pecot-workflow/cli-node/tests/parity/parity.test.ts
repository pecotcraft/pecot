// Node の CLI でシナリオを流し、Python の CLI から作った golden と一致することを確かめる。コマンドの足し忘れは registry.test.ts が止める。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runScenario } from './run.js'
import type { Launcher, Outcome } from './run.js'
import type { Golden } from './scenario.js'
import { readGolden, readScenario, scenarioIds } from './scenario.js'
import { pluginRoot } from './setup.js'

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

// global-*: --help・--version・--show-repo・未知のコマンド・引数なしは、ツールの呼び出しに写せない。
// usage を含む名前: CLI の引数の誤りで、MCP では入力の検証の誤りになる（tests/mcp/tools-list.test.ts が確かめる）。
// 標準入力を使う 3 件: MCP のツールは標準入力を持たない
function isMcpMappable(id: string): boolean {
  return !id.startsWith('global-') && !id.includes('usage') && !MCP_UNMAPPABLE_STDIN.has(id)
}

const cliEntry = path.join(pluginRoot, 'cli-node', 'dist', 'cli.js')
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の dist/cli.js の有無を見るだけ
    expect(existsSync(cliEntry), `${cliEntry} がありません。pnpm run build を先に流してください`).toBe(true)
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
})
