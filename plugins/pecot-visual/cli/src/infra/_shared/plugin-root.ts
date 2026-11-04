// プラグインルート（= プラグイン形態の $CLAUDE_PLUGIN_ROOT / 単体配布形態の配布ルート）の解決。
//
// 同梱アセット（assets/drawio-icons・assets/slidev/templates・plugin.json）の起点。
// dependency-root.ts の「実行時依存を探すルート」とは意味が違う。
// 依存ルート側は「PECOTV_DEPENDENCY_ROOT、無ければ CLAUDE_PLUGIN_ROOT、それも無ければ永続層」という優先順位を持つ。
// こちらは「必ず 1 つに決まる同梱アセットの起点」なので、変数も fallback の形も別になる。
// 混ぜると、依存をデータ置き場のミラーへ向けたときに、アセットの読み先までミラーへ動く。

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { trimmedEnvironment } from './dependency-root.js'

/**
プラグインルートを解決する。

`CLAUDE_PLUGIN_ROOT` を直接読む。依存ルート（`PECOTV_DEPENDENCY_ROOT`）には引きずられない。
bin/pecotv は cli を実行用ミラー（`${データ置き場}/runtime/<hash>/cli/dist/`）から起動する。
source 相対で解決すると、同梱アセットの無いミラー側を指す。そのため wrapper が env を必ず渡す。
単体配布形態では bin shim が自ルートを立てる。`node dist/cli.js` の直叩き（開発）に備えた
source 相対の fallback だけを残す。
*/
export function resolvePluginRoot(): string {
  // <plugin-root>/cli/{src,dist}/infra/_shared/plugin-root.{ts,js} から 4 階層上がプラグインルート。
  return trimmedEnvironment('CLAUDE_PLUGIN_ROOT')
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
}
