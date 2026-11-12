/* eslint-disable security/detect-non-literal-fs-filename -- 書くのは golden/ 配下のみ */
// Python の CLI でシナリオを流し、golden/<id>.json を書く。Python を消すまでの間だけ使う。
// 次の誤りがあれば、その id の golden は書かない。終了コードは 1 にする。
//   - 表に無い operation。
//   - どの応答にも当たらない要求。
//   - 使われなかった応答。
//   - 起動の失敗、時間切れ、シグナル。
//   - stderr の traceback。
// --check を付けると、golden を書かずに差だけを出す。比べる相手は今の Python の出力。
// 差があれば終了コードは 1 にする。同じ動作のスクリプトは record:parity:check にする。
// 使い方は次のとおり。
//   pnpm -C plugins/pecot-workflow --filter @pecot/pecot-workflow-cli run record:parity [<id>...]
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { runScenario } from './run.js'
import type { Launcher } from './run.js'
import type { Golden } from './scenario.js'
import { goldenDirectory, goldenPath, hasGolden, readGolden, readScenario, scenarioIds } from './scenario.js'
import { pluginRoot } from './setup.js'

const python: Launcher = {
  command: path.join(pluginRoot, 'cli', '.venv', 'bin', 'pecot'),
  args: [],
  env: { CLAUDE_PLUGIN_ROOT: pluginRoot },
}

const GOLDEN_KEYS: readonly (keyof Golden)[] = ['stdout', 'stderr', 'exitCode', 'requests', 'files']

/**
golden と違うキーを返す。golden が無ければ undefined
*/
function differingKeys(id: string, actual: Golden): readonly string[] | undefined {
  if (!hasGolden(id)) return undefined
  const expected = readGolden(id)
  return GOLDEN_KEYS.filter(key => JSON.stringify(Reflect.get(actual, key)) !== JSON.stringify(Reflect.get(expected, key)))
}

async function main(): Promise<void> {
  const all = scenarioIds()
  const isCheck = process.argv.includes('--check')
  const requested = process.argv.slice(2).filter(argument => argument !== '--check')
  const unknown = requested.filter(id => !all.includes(id))
  if (unknown.length > 0) {
    process.stderr.write(`scenarios/ にない id: ${unknown.join(', ')}\n`)
    process.exitCode = 1
    return
  }
  const ids = requested.length > 0 ? requested : all
  if (!isCheck) mkdirSync(goldenDirectory, { recursive: true })
  let written = 0
  let failed = 0
  let differed = 0
  for (const id of ids) {
    const outcome = await runScenario(readScenario(id), python)
    const errors = [
      ...(outcome.spawnError === undefined ? [] : [`起動できません: ${outcome.spawnError}`]),
      ...(outcome.signal === undefined ? [] : [`シグナルで終わりました: ${outcome.signal}`]),
      ...(outcome.timedOut ? ['時間切れです'] : []),
      ...outcome.problems,
      ...outcome.unused.map(unused => `使われなかった応答: ${unused}`),
      ...(outcome.golden.stderr.includes('Traceback') ? ['stderr に Traceback があります'] : []),
    ]
    if (errors.length > 0) {
      failed += 1
      process.stderr.write(`[NG] ${id}\n${errors.map(error => `  - ${error}`).join('\n')}\n`)
      continue
    }
    if (isCheck) {
      const keys = differingKeys(id, outcome.golden)
      if (keys === undefined) {
        differed += 1
        process.stderr.write(`[差分] ${id}: golden がありません\n`)
      }
      else if (keys.length > 0) {
        differed += 1
        process.stderr.write(`[差分] ${id}: ${keys.join(', ')}\n`)
      }
      continue
    }
    writeFileSync(goldenPath(id), `${JSON.stringify(outcome.golden, undefined, 2)}\n`)
    written += 1
  }
  if (isCheck) {
    process.stdout.write(`確認 ${String(ids.length)} 件: 差分 ${String(differed)} 件、誤り ${String(failed)} 件\n`)
    if (differed > 0 || failed > 0) process.exitCode = 1
    return
  }
  process.stdout.write(`書いた件数: ${String(written)} / 対象 ${String(ids.length)} 件 (誤り ${String(failed)} 件)\n`)
  if (failed > 0) process.exitCode = 1
}

await main()
