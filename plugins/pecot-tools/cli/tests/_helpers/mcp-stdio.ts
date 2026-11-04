// `pecot-tools mcp` を実プロセスとして起動する E2E 用ヘルパ。
//
// 起動条件（コマンド・env・stderr の扱い）を 1 箇所へ集約する。ファイルごとに条件がずれると、
// 「片方でだけ別の処理に入る」ような差分の原因になる。

import path from 'node:path'
import type { Stream } from 'node:stream'

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// tests/_helpers → tests → cli
const HERE = import.meta.dirname
export const CLI_ROOT = path.resolve(HERE, '..', '..')
export const CLI_DIST = path.join(CLI_ROOT, 'dist', 'cli.js')
export const PLUGIN_MANIFEST = path.join(CLI_ROOT, '..', '.claude-plugin', 'plugin.json')

/**
子プロセスへ渡す環境変数。

StdioClientTransport は親の環境変数を素通ししないため、PATH / HOME を明示注入する。
*/
export function serverEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: process.env['HOME'] ?? '/var/tmp',
    ...overrides,
  }
}

/**
ビルド済み `dist/cli.js mcp` を子プロセスとして起動する transport。
*/
export function makeTransport(
  overrides: Readonly<Record<string, string>> = {},
): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [CLI_DIST, 'mcp'],
    env: serverEnvironment(overrides),
    cwd: CLI_ROOT,
    stderr: 'pipe',
  })
}

/**
子プロセスの stderr を読み切り、溜めた内容を取り出す関数を返す。

pipe した stderr を誰も読まないとパイプバッファが埋まった時点で子が write で block する。
読み捨てずに保持し、失敗時の assert メッセージに載せて切り分け材料にする。
*/
export function drainStderr(stream: Stream | null): () => string {
  const chunks: string[] = []
  stream?.on('data', (chunk: Readonly<Buffer> | string) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  })
  return () => chunks.join('')
}
