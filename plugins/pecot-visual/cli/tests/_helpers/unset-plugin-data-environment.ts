// vitest の setupFiles。
// データ置き場の解決が、実ホームの `~/.local/share/pecot/` を指さないようにする。
// 解決する関数は infra/_shared/dependency-root.ts の dataDirectory。
// そのため全テストの前に環境を固定する。
//
// - CLAUDE_PLUGIN_DATA を、ファイルごとの一時ディレクトリへ向ける。手で `vitest` を叩いたときも、
//   開発者のクライアントが渡した置き場や実ホームに書かない。
// - PLUGIN_DATA と、wrapper が渡す実行用ミラーの変数は落とす。
// - XDG_DATA_HOME は付け替えない（pnpm の store と uv の Python の置き場まで動くため）。
//   既定の場所を確かめるテストだけが、自分で CLAUDE_PLUGIN_DATA を外し XDG_DATA_HOME / HOME を立てる。
// 各テストは、自分が使う変数を `vi.stubEnv` で立て直す。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll } from 'vitest'

for (const name of [
  'PLUGIN_DATA',
  'PECOTV_DEPENDENCY_ROOT',
  'PECOTV_RUNTIME_DIR',
]) {
  Reflect.deleteProperty(process.env, name)
}

const pluginData = mkdtempSync(path.join(tmpdir(), 'pecotv-plugin-data-'))
process.env['CLAUDE_PLUGIN_DATA'] = pluginData
afterAll(() => {
  rmSync(pluginData, { recursive: true, force: true })
})
