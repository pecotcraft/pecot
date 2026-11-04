// プラグイン版数の解決。cli.ts と commands/ の双方から参照するため、cli.ts から独立させている
// （commands → cli.ts の import は循環になる）。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { resolvePluginRoot } from './infra/_shared/plugin-root.js'

const DEFAULT_VERSION = '0.0.0+dev'

/**
version を解決する。

プラグインルートの決定 (CLAUDE_PLUGIN_ROOT env → source 相対) は resolvePluginRoot() に
委ねる。ここが持つのは「そのルート直下の `.claude-plugin/plugin.json` から version を
読み、読めなければ "0.0.0+dev"」という 1 段だけ。

bin/pecotv ラッパー経由では CLAUDE_PLUGIN_ROOT が未設定でも親 bin から再注入される。
そのため env なしの source 相対ルートは `node dist/cli.js` 直叩き時のみ到達する。
*/
export function readVersion(): string {
  const manifestPath = path.join(resolvePluginRoot(), '.claude-plugin/plugin.json')
  return loadVersionFromPluginJson(manifestPath) ?? DEFAULT_VERSION
}

export function loadVersionFromPluginJson(manifestPath: string): string | undefined {
  let parsed: unknown
  try {
    // path joined from CLAUDE_PLUGIN_ROOT or import.meta.url relative.
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
