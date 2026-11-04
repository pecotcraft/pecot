// vitest の setupFiles。データ置き場を使う分岐が実ホームの `~/.local/share/pecot/` に届かないよう、
// 全テストの前に環境を固定する。
//
// - CLAUDE_PLUGIN_DATA を、ファイルごとの一時ディレクトリへ向ける。手で `vitest` を叩いたときも、
//   開発者のクライアントが渡した置き場や実ホームに書かない。
// - PLUGIN_DATA と、wrapper が渡す実行用ミラーの変数は落とす。
// - XDG_DATA_HOME は付け替えない（pnpm の store と uv の Python の置き場まで動くため）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll } from 'vitest'

for (const name of [
  'PLUGIN_DATA',
  'PECOT_TOOLS_RUNTIME_DIR',
]) {
  Reflect.deleteProperty(process.env, name)
}

const pluginData = mkdtempSync(path.join(tmpdir(), 'pecot-tools-plugin-data-'))
process.env['CLAUDE_PLUGIN_DATA'] = pluginData
afterAll(() => {
  rmSync(pluginData, { recursive: true, force: true })
})
