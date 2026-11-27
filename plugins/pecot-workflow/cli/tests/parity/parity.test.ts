// ビルドした MCP のサーバでシナリオを流し、golden（ツールの結果）と一致することを確かめる。golden は回帰の控えで、挙動を変えたら作り直して差分を確かめる。
import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { builtServer, builtServerProblem } from './built-server.js'
import { runScenario } from './run.js'
import { readGolden, readScenario, scenarioIds } from './scenario.js'

// 子プロセスの時間切れ（CHILD_TIMEOUT_MS の 25 秒）より長くする
const TEST_TIMEOUT_MS = 30_000

// 入力の検証でツールの本体を呼ばずに断った結果の detail の前置き（server.ts の rejected）
const REJECTED_PREFIX = 'invalid input: '

// 時間内に呼べたこと。偽サーバの誤りと、使われなかった応答が無いこと
const COMPLETED = { spawnError: undefined, timedOut: false, problems: [], unused: [] }

function isRejected(id: string): boolean {
  const { structuredContent } = readGolden(id)
  return structuredContent['kind'] === 'invalid-input' && String(structuredContent['detail']).startsWith(REJECTED_PREFIX)
}

describe('前後比較', () => {
  it('MCP のサーバがビルドされていると、ビルドの問題を報告しない', async () => {
    await explains('前後比較の前提のテストです。MCP のサーバのビルド成果物（`dist/main.js`）が存在し、`builtServerProblem` がビルドの問題を報告しないことを確認します。')
    expect(builtServerProblem()).toBeUndefined()
  })

  it.for(scenarioIds())('シナリオ %s を動かすと、期待出力（golden）と同じ結果になる', { timeout: TEST_TIMEOUT_MS }, async (id) => {
    await explains('シナリオを MCP のサーバで実行したときの結果のテストです。ツールの結果（成否・要約の文・structuredContent）、サーバの標準エラー、偽サーバへの要求、ファイルが、保存済みの期待出力（golden）と一致することを確認します。')
    const outcome = await runScenario(readScenario(id), builtServer)
    expect(outcome).toMatchObject(COMPLETED)
    expect(outcome.golden).toEqual(readGolden(id))
    // 要約の文が表の行（見出しなど）にならない
    expect(outcome.golden?.text?.startsWith('|') ?? false).toBe(false)
  })

  it.for(scenarioIds().filter(id => isRejected(id)))('入力の検証で断るシナリオ %s は、偽サーバに要求を送らない', async (id) => {
    await explains(`入力の検証で断るシナリオのテストです。\`${id}\` の期待出力が \`invalid input:\` から始まる失敗であり、偽サーバへの要求が無いことを確認します。`)
    expect(readGolden(id)).toMatchObject({ isError: true, requests: [] })
  })

  it('入力の検証で断るシナリオが 1 件以上ある', async () => {
    await explains('前後比較のシナリオの網羅のテストです。入力の検証が、ツールの本体を呼ばずに断る結果を持つシナリオが、1 件以上存在することを確認します。')
    expect(scenarioIds().filter(id => isRejected(id)).length).toBeGreaterThan(0)
  })
})
