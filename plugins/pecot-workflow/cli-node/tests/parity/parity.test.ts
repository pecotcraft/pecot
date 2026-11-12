// Node の CLI でシナリオを流し、Python の CLI から作った golden と一致することを確かめる。コマンドの足し忘れは registry.test.ts が止める。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runScenario } from './run.js'
import type { Launcher } from './run.js'
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

const cliEntry = path.join(pluginRoot, 'cli-node', 'dist', 'cli.js')
const node: Launcher = { command: process.execPath, args: [cliEntry], env: {} }

describe('前後比較', () => {
  it('Node の CLI がビルドされている', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の dist/cli.js の有無を見るだけ
    expect(existsSync(cliEntry), `${cliEntry} がありません。pnpm run build を先に流してください`).toBe(true)
  })

  it.for(scenarioIds())('シナリオ %s を動かすと、golden と同じ出力になる（help の 4 件は stdout を除く）', { timeout: TEST_TIMEOUT_MS }, async (id) => {
    const scenario = readScenario(id)
    const outcome = await runScenario(scenario, node)

    // 起動できて、時間内にシグナルなしで終わったこと。
    expect(outcome.spawnError).toBeUndefined()
    expect(outcome.signal).toBeUndefined()
    expect(outcome.timedOut).toBe(false)

    // 偽サーバの誤りと、使われなかった応答も無いこと
    expect(outcome.problems).toEqual([])
    expect(outcome.unused).toEqual([])
    const golden = readGolden(id)
    const isNodeHelp = SCENARIOS_WITH_NODE_HELP.has(id)
    const compared = (result: Golden): Golden => isNodeHelp ? { ...result, stdout: '' } : result
    expect(compared(outcome.golden)).toEqual(compared(golden))
    // help の 4 件の stdout は golden（Python の枠）と違い、ほかは同じ
    expect(outcome.golden.stdout === golden.stdout).toBe(!isNodeHelp)
  })
})
