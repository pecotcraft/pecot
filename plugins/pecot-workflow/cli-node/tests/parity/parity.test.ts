// Node の CLI でシナリオを流し、Python の CLI から作った golden と比べる。
// 移植済みの一覧（PORTED）に無いコマンドは「golden と一致しない」ことを確かめる。
// 一覧に入れたコマンドは「一致する」ことを確かめる。
// help を stdout に出す 4 件は、書式を Node で決めたので stdout だけ golden と比べない（SCENARIOS_WITH_NODE_HELP）。
// it.fails を使わないのは、本体のどこで throw しても通ってしまうため。
// build が無い、起動の失敗、git の失敗が「期待どおりの失敗」として緑になる。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../../src/commands/registry.js'
import { COMMAND_PATHS } from './commands.js'
import { runScenario } from './run.js'
import type { Launcher } from './run.js'
import type { Golden } from './scenario.js'
import { readGolden, readScenario, scenarioIds } from './scenario.js'
import { pluginRoot } from './setup.js'

/**
Node へ移植し終えたコマンドの path。registry の一覧から求める。空の path はグローバルオプションだけの起動
*/
const PORTED: readonly (readonly string[])[] = [[], ...COMMANDS.map(command => command.path)]

/**
help の一覧や「近いコマンド」の案内は、Python の全 34 コマンドの登録が前提になる。
全コマンドが registry に入るまでは、登録の進み具合で結果が変わるので、golden と比べない
*/
const SCENARIOS_NEEDING_ALL_COMMANDS: ReadonlySet<string> = new Set([
  'global-usage-command-suggestion',
  'global-usage-command-suggestion-group',
  'global-usage-group-missing-command',
])

/**
help を stdout に出すシナリオ。help の書式は Node で決めた（#362）ので、stdout は golden と比べない。
stdout 以外（終了コード・stderr・要求・ファイル）は golden と同じであること、stdout は golden と違うことを確かめる。
stdout の中身は src/commands/tests/help.test.ts が Node の期待値で確かめる。
コマンドの一覧は stdout にだけ出るので、全コマンドが登録される前でも比べられる
*/
const SCENARIOS_WITH_NODE_HELP: ReadonlySet<string> = new Set([
  'global-ok-help',
  'global-ok-help-group',
  'global-ok-help-after-double-dash',
  'global-usage-no-args',
])

// issue reopen は 3 秒待つ。子プロセスの時間切れ（25 秒）より長くする
const TEST_TIMEOUT_MS = 30_000

const cliEntry = path.join(pluginRoot, 'cli-node', 'dist', 'cli.js')
const node: Launcher = { command: process.execPath, args: [cliEntry], env: {} }

function isPorted(commandPath: readonly string[]): boolean {
  return PORTED.some(ported => ported.join(' ') === commandPath.join(' '))
}

function isAllCommandsPorted(): boolean {
  return COMMAND_PATHS.every(commandPath => isPorted(commandPath))
}

/**
isNodeHelp は help の書式を Node で決めたシナリオ。stdout 以外が golden と同じで、stdout は golden と違う help であること
*/
function expectParity(actual: Golden, golden: Golden, isPortedCommand: boolean, isNodeHelp: boolean): void {
  if (isNodeHelp) {
    expect({ ...actual, stdout: '' }).toEqual({ ...golden, stdout: '' })
    expect(actual.stdout).not.toBe(golden.stdout)
    expect(actual.stdout).toContain('Usage: pecot')
    return
  }
  if (isPortedCommand) {
    expect(actual).toEqual(golden)
    return
  }
  expect(actual).not.toEqual(golden)
}

describe('前後比較', () => {
  it('Node の CLI がビルドされている', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の dist/cli.js の有無を見るだけ
    expect(existsSync(cliEntry), `${cliEntry} がありません。pnpm run build を先に流してください`).toBe(true)
  })

  it.for(scenarioIds())('シナリオ %s を動かすと、移植済みなら golden と同じ出力になり、未移植なら違う出力になる', { timeout: TEST_TIMEOUT_MS }, async (id, context) => {
    const scenario = readScenario(id)
    const outcome = await runScenario(scenario, node)

    // 起動できて、時間内にシグナルなしで終わったこと。
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.signal).toBeUndefined()
    expect(outcome.timedOut).toBe(false)

    const golden = readGolden(id)
    // 全コマンドが登録されるまでは比べない。合格に見せず skipped と出す
    if (SCENARIOS_NEEDING_ALL_COMMANDS.has(id) && !isAllCommandsPorted()) context.skip()
    const isPortedCommand = isPorted(scenario.command.path)
    const isNodeHelp = SCENARIOS_WITH_NODE_HELP.has(id)
    // 移植済みのコマンドと help は、偽サーバの誤りと使われなかった応答も無いこと
    expect(isPortedCommand || isNodeHelp ? outcome.problems : []).toEqual([])
    expect(isPortedCommand || isNodeHelp ? outcome.unused : []).toEqual([])
    expectParity(outcome.golden, golden, isPortedCommand, isNodeHelp)
  })
})
