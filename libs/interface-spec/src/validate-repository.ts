import path from 'node:path'
import { formatFinding } from './domain/finding.js'
import { TARGETS_PATH, validateDefinitions, validateTargets } from './domain/validate.js'
import { loadJson, loadPlugin } from './infra/load.js'

// リポジトリの定義書を検証し、失敗の行を決定的な順で返す。targets.json に載っていないプラグインは検証しない。
export async function validateRepository(root: string): Promise<string[]> {
  const { targets, findings } = validateTargets(await loadJson(path.join(root, TARGETS_PATH)))
  if (targets === undefined) return findings.map(finding => formatFinding(finding))
  const plugins = await Promise.all(Object.entries(targets.plugins).map(([name, setting]) => loadPlugin(root, name, setting)))
  return validateDefinitions(plugins).map(finding => formatFinding(finding))
}
