// プラグイン版数の解決。cli.ts と今後の mcp の双方から参照するため、cli.ts から独立させている
// （mcp → cli.ts の import は循環になる）。
// 層構成は domain ← infra ← mcp。本ファイルはどの層にも属さない共通モジュールとして src 直下に置く。 確認用。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_VERSION = '0.0.0+dev'

/**
plugin ルート（`plugins/pecot-tools/`）を返す。

`CLAUDE_PLUGIN_ROOT` が最優先。
bin/pecot-tools は cli を実行用ミラー（`${データ置き場}/runtime/<hash>/cli/dist/`）から起動する。
そのため source 相対で解決すると、plugin.json の無いミラー側を指す。wrapper が env を必ず渡す。

env が無いとき（`node dist/cli.js` の直叩き・単体配布・テスト）は source 相対。本ファイルは
src 直下 / dist 直下（tsconfig.build.json の rootDir: src で平坦化）/ 配布ツリーのいずれでも
plugin ルートから 2 階層下に置かれる。
src 直下から動かすとこの相対解決が成り立たなくなるため、階層は version.test.ts で固定する。
*/
export function pluginRoot(): string {
  const fromEnvironment = process.env['CLAUDE_PLUGIN_ROOT']?.trim()
  return fromEnvironment === undefined || fromEnvironment === '' ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..') : fromEnvironment
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 環境変数か import.meta.url 由来のパス
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  }
  catch {
    return undefined
  }
  // eslint-disable-next-line no-restricted-syntax -- 直後の typeof で narrowing する
  const version = (parsed as { readonly version?: unknown } | null)?.version
  return typeof version === 'string' && version !== '' ? version : undefined
}
