import path from 'node:path'
import { formatFinding } from './domain/finding.js'
import { checkLinks } from './domain/links.js'
import { TARGETS_PATH, collectBehaviorIds, validateTargets } from './domain/validate.js'
import { loadJson, loadSources, loadYaml } from './infra/load.js'

// 定義書の ID とテストのファイルの ID を比べ、失敗の行を決定的な順で返す。テストは動かさない。
export async function linkRepository(root: string): Promise<string[]> {
  const { targets, findings } = validateTargets(await loadJson(path.join(root, TARGETS_PATH)))
  if (targets === undefined) return findings.map(finding => formatFinding(finding))
  const plugins = await Promise.all(Object.entries(targets.plugins).map(async ([name, setting]) => {
    const authored = await loadYaml(path.join(root, 'plugins', name, 'interface', 'authored.yaml'))
    return {
      name,
      coverage: setting.coverage,
      ids: authored.kind === 'ok' ? collectBehaviorIds(authored.data) : [],
      tests: await loadSources(root, name, setting.tests),
    }
  }))
  return checkLinks(plugins)
}
