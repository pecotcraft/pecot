#!/usr/bin/env node
// MCP サーバの起動ファイル。引数は読まない（`pecot-workflow-mcp mcp` の登録もサーバになる）。
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// eslint-disable-next-line unicorn/no-exports-in-scripts -- entry.test.ts が import する
export async function main(): Promise<void> {
  const { executeMcpServe } = await import('./mcp/serve.js')
  if (executeMcpServe() !== 0) process.exitCode = 1
}

/* v8 ignore start -- 直接起動時にだけ通る。tests/mcp/session-directory.test.ts がビルド済みのサーバで担保 */
if (process.argv[1] !== undefined) {
  // import.meta.url は実体パスなので argv[1] も realpath に揃える。npx は node_modules/.bin の symlink から起動するため。
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 起動された自分自身のパス
  const selfUrl = pathToFileURL(realpathSync(process.argv[1])).href
  if (import.meta.url === selfUrl) {
    await main()
  }
}
/* v8 ignore stop */
