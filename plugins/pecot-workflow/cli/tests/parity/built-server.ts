// ビルド済みの MCP のサーバ（dist/main.js）の場所と、あるかの確認。前後比較と MCP のテストが共有する。
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { Launcher } from './run.js'
import { pluginRoot } from './setup.js'

export const serverEntry = path.join(pluginRoot, 'cli', 'dist', 'main.js')

export const builtServer: Launcher = { command: process.execPath, args: [serverEntry] }

// ビルドされていれば undefined、無ければ理由の文。expect(...).toBeUndefined() の差分に理由が出る
export function builtServerProblem(): string | undefined {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の dist/main.js の有無を見るだけ
  return existsSync(serverEntry) ? undefined : `${serverEntry} がありません。pnpm run build を先に流してください`
}
