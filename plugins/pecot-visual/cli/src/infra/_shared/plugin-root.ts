// プラグインルート（プラグイン形態のプラグインのディレクトリ / 単体配布形態の配布ルート）の解決。
//
// 同梱アセット（assets/drawio-icons・assets/slidev/templates・plugin.json）の起点。
// dependency-root.ts の「実行時依存を探すルート」とは意味が違う。

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
プラグインルートを解決する。

サーバ自身の置き場所だけから求め、環境変数を読まない。
npx で起動したサーバに Claude Code が渡す `CLAUDE_PLUGIN_ROOT` は、入れたプラグインのディレクトリを指す。
そこには lint のルールの dist や `vendor/text-rules` の実体が無いので、起点にしない。
*/
export function resolvePluginRoot(): string {
  // <plugin-root>/cli/{src,dist}/infra/_shared/plugin-root.{ts,js} から 4 階層上がプラグインルート。
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
}
