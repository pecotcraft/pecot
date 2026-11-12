// ビルド済みの Node の CLI（dist/cli.js）の場所と、あるかの確認。前後比較と MCP のテストが共有する。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { pluginRoot } from './setup.js'

export const cliEntry = path.join(pluginRoot, 'cli', 'dist', 'cli.js')

// ビルドされていれば undefined、無ければ理由の文。expect(...).toBeUndefined() の差分に理由が出る
export function builtCliProblem(): string | undefined {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 固定の dist/cli.js の有無を見るだけ
  return existsSync(cliEntry) ? undefined : `${cliEntry} がありません。pnpm run build を先に流してください`
}
