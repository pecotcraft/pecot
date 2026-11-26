// プラグインの版の解決。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { resolvePluginRoot } from './infra/_shared/plugin-root.js'

const DEFAULT_VERSION = '0.0.0+dev'

/**
version を解決する。プラグインルート直下の `.claude-plugin/plugin.json` から読み、読めなければ "0.0.0+dev"。
*/
export function readVersion(): string {
  const manifestPath = path.join(resolvePluginRoot(), '.claude-plugin/plugin.json')
  return loadVersionFromPluginJson(manifestPath) ?? DEFAULT_VERSION
}

export function loadVersionFromPluginJson(manifestPath: string): string | undefined {
  let parsed: unknown
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  }
  catch {
    return undefined
  }
  // eslint-disable-next-line no-restricted-syntax -- narrowed via typeof/in checks
  const version = (parsed as { readonly version?: unknown } | null)?.version
  return typeof version === 'string' && version !== '' ? version : undefined
}
