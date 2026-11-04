// `pecotv mcp` を実プロセスとして起動する E2E 用ヘルパ。
//
// 利用者ルート (plugins/pecot-visual/bin/pecotv mcp) を spawn するときの env・transport・stderr の扱いを 1 箇所に集約する。
// stdio ルートを見る E2E は複数ファイルに分かれる。
// 接続と終了の振る舞いは mcp-stdio.test.ts、ツールの呼び出しは mcp-tools.test.ts が見る。
// 起動条件がファイルごとにずれると、「片方でだけ bootstrap ルートに入る」ような差分の原因になる。

import path from 'node:path'
import type { Stream } from 'node:stream'

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// tests/_helpers → tests → cli
const HERE = import.meta.dirname
export const CLI_ROOT = path.resolve(HERE, '..', '..')
export const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
export const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')
export const CLI_DIST = path.join(CLI_ROOT, 'dist', 'cli.js')
export const PLUGIN_MANIFEST = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')

/**
子プロセスへ渡す環境変数。

StdioClientTransport は親の環境変数をそのまま渡さない。
そのため CLAUDE_PLUGIN_ROOT / PECOTV_BOOTSTRAP_SKIP / PATH / HOME を明示注入する。
注入しないと、bin/pecotv が bootstrap ルートへ入る。
tests/integration/no-python-runtime.test.ts と同型。
*/
export function serverEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    PECOTV_BOOTSTRAP_SKIP: '1',
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: process.env['HOME'] ?? '/tmp',
    ...overrides,
  }
}

/**
bin/pecotv mcp を子プロセスとして起動する transport。

overrides は子プロセスの環境変数に上書きで載せる。chromium の取得状況のように
「サーバプロセス側の環境」でしか作れない条件を組むための口で、既定の起動条件は
serverEnvironment() に集約したまま保つ。
*/
export function makeTransport(
  overrides: Readonly<Record<string, string>> = {},
): StdioClientTransport {
  return new StdioClientTransport({
    command: BIN_PECOTV,
    args: ['mcp'],
    env: serverEnvironment(overrides),
    cwd: CLI_ROOT,
    stderr: 'pipe',
  })
}

/**
プロセスが消えているか (kill(pid, 0) が ESRCH を返すか)。

終了ルートを見る e2e は複数ファイルに分かれる (stdin EOF = mcp-stdio.test.ts、SIGTERM = mcp-tools.test.ts)。
そのため判定はここに 1 本だけ置く。
*/
export function isReaped(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  }
  catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

/**
子プロセスの stderr を読み切り、溜めた内容を取り出す関数を返す。

pipe した stderr を誰も読まないとパイプバッファが埋まった時点で子が write で block する。
読み捨てずに保持し、失敗時の assert メッセージに載せて分け材料にする。
*/
export function drainStderr(stream: Stream | null): () => string {
  const chunks: string[] = []
  stream?.on('data', (chunk: Readonly<Buffer> | string) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  })
  return () => chunks.join('')
}
