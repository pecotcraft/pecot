// プラグイン版数の解決。main.ts と mcp の双方から読むため、どの層にも属さない共通モジュールとして src 直下に置く。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_VERSION = '0.0.0+dev'

/**
plugin ルート（`plugins/pecot-tools/`）を返す。src・dist・npm の配布物のどれでも、本ファイルはその 2 階層下にある（version.test.ts が固定する）。
*/
export function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
}

/**
plugin.json の version を返す。読めなければ開発用の既定値。
*/
export function readVersion(): string {
  /* v8 ignore next -- 同梱 plugin.json は常在。読めない場合は loadVersionFromPluginJson の単体テストで担保 */
  return loadVersionFromPluginJson(path.join(pluginRoot(), '.claude-plugin/plugin.json')) ?? DEFAULT_VERSION
}

export function loadVersionFromPluginJson(manifestPath: string): string | undefined {
  let parsed: unknown
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- import.meta.url 由来のパス
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  }
  catch {
    return undefined
  }
  // eslint-disable-next-line no-restricted-syntax -- 直後の typeof で narrowing する
  const version = (parsed as { readonly version?: unknown } | null)?.version
  return typeof version === 'string' && version !== '' ? version : undefined
}
