// vitest の setupFiles。データ置き場（dataDirectory）が実ホームを指さないよう、CLAUDE_PLUGIN_DATA を一時ディレクトリへ向け、PLUGIN_DATA を落とす。
// XDG_DATA_HOME は付け替えない（pnpm の store と uv の Python の置き場まで動くため）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll } from 'vitest'

Reflect.deleteProperty(process.env, 'PLUGIN_DATA')

const pluginData = mkdtempSync(path.join(tmpdir(), 'pecotv-plugin-data-'))
process.env['CLAUDE_PLUGIN_DATA'] = pluginData
afterAll(() => {
  rmSync(pluginData, { recursive: true, force: true })
})
