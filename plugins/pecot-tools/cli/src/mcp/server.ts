// MCP サーバのファクトリ。ツール登録シームと上限付き並行実行器の所有をここで持つ。
//
// ツール 1 件以上のときは McpServer.registerTool だけを使う。
// 低レベルの setRequestHandler('tools/list', ...) で一覧ハンドラを先に張る。
// すると、後から registerTool したときに SDK が「handler already exists」で throw する。
// 一方でツール 0 件の McpServer は、tools capability と一覧ハンドラを持たない。
// そのため tools/list に -32601 を返す。
// 0 件のときだけ明示登録する。両者は排他。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- ツールハンドラの第 2 引数は mutable。
   SDK の ServerContext が signal / notify 等のメンバを持つ。
   readonly 化すると、registerTool のコールバック型と適合しなくなる。 */

import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { readVersion } from '../version.js'
import { createBoundedExecutor } from './executor.js'
import { ignoreRejection } from '../infra/ignore-rejection.js'

/**
progress ハートビートの送出周期 (ms)。

守る相手は MCP クライアントの「無音タイムアウト」。
Claude Code で計測した値は、30 分の idle watchdog (progress 受信でリセット・判定周期 30s)。
10s はそこから十分な余裕があり、かつ長時間ツール 1 件で通知が積み上がりすぎない粒度になる。
*/
const PROGRESS_HEARTBEAT_INTERVAL_MS = 10_000

/**
tools/call の同時実行数の上限 (research R9)。
*/
const CONCURRENCY_LIMIT = 4

/**
MCP サーバ名。initialize の serverInfo.name として返る値。

`.mcp.json` の `mcpServers` の登録キーと必ず揃える。食い違うとクライアント側の表示と
ツール名の名前空間（`mcp__plugin_pecot-t_<サーバ名>__*`）が噛み合わなくなる。
*/
export const MCP_SERVER_NAME = 'pecot-tools'

/**
registerTool に渡すツールのメタ情報。

inputSchema / outputSchema は自前の zod の `z.object()` で書く。SDK は渡されたスキーマ自身から JSON Schema を作る。
そのため SDK 同梱の zod と混在しない。引数を取らないツールは inputSchema に
`z.object({})` を渡す。
*/
export interface ToolConfig {
  readonly title?: string
  readonly description?: string
  readonly inputSchema: z.ZodObject
  /**
  指定すると SDK が structuredContent をこのスキーマで検証する。
  */
  readonly outputSchema?: z.ZodObject
  /**
  readOnlyHint / destructiveHint 等、クライアントの実行判断に使われるヒント。
  */
  readonly annotations?: ToolAnnotations
}

/**
tools/call ハンドラの第 2 引数。ハンドラが使う面だけを SDK の ServerContext から切り出す。

signal はクライアントのキャンセル (notifications/cancelled) と stdin の EOF で abort される。
SDK の型を直接渡さないのは、ツール側とテストのフェイクを SDK の型から切り離すため。
*/
export interface ToolCallContext {
  readonly signal: AbortSignal
}

/**
tools/call のハンドラ。arguments_ は inputSchema で検証済みの値。
*/
export type ToolHandler = (
  arguments_: Readonly<Record<string, unknown>>,
  call: ToolCallContext,
) => Promise<CallToolResult>

/**
サーバへ登録するツール 1 件の定義。
*/
export interface ToolDefinition {
  readonly name: string
  readonly config: ToolConfig
  readonly handler: ToolHandler
}

interface ProgressHeartbeat {
  /**
  実行枠の待機を抜けたことを、以降の通知の message へ反映する。
  */
  markRunning(): void
  /**
  周期送出を止める。呼び出しの完了時 (成功・失敗どちらも) に必ず呼ぶ。
  */
  stop(): void
}

/**
tools/call 1 件分の progress 通知を開始し、即座に 1 発目 (順番待ち中) を送る。

MCP では progressToken を伴わないリクエストに notifications/progress を返せない。
そのためクライアントが token を付けてこなかった場合は、何も送らず undefined を返す。

送出は run() の前から始める。守りたいのは実行中だけでなく「上限に掛かって順番待ちしている
間も無音時計が進む」区間で、ハンドラ内に置くラッパーでは待機中を守れない。
*/
function startProgressHeartbeat(toolName: string, serverContext: ServerContext, intervalMs: number): ProgressHeartbeat | undefined {
  const { signal } = serverContext.mcpReq
  const progressToken = serverContext.mcpReq._meta?.progressToken
  if (progressToken === undefined) return undefined

  let progress = 0
  let phase = 'queued'

  const send = (): void => {
    progress += 1
    // 通知はベストエフォート。クライアント切断後の reject を await の流れに乗せると、
    // ハンドラの例外に化けて ok: false になる。そのため、ここで握り潰す。
    void ignoreRejection(serverContext.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken, progress, message: `${toolName}: ${phase}` },
    }))
  }

  const timer = setInterval(send, intervalMs)

  // キャンセル済みの呼び出しへ通知を送ると、クライアントは破棄済みのトークン宛の progress を
  // 受けて onerror に落とす。abort した時点で周期送出を止める。
  const stop = (): void => {
    clearInterval(timer)
    signal.removeEventListener('abort', stop)
  }

  if (signal.aborted) {
    stop()
  }
  else {
    signal.addEventListener('abort', stop, { once: true })
    send()
  }

  return {
    markRunning: () => { phase = 'running' },
    stop,
  }
}

interface McpServerOptions {
  /**
  progress ハートビートの送出周期 (ms)。既定は PROGRESS_HEARTBEAT_INTERVAL_MS で、テストが短縮する。
  */
  readonly progressIntervalMs?: number
}

/**
MCP サーバを生成し、渡されたツール定義を登録する。

各ハンドラは登録時に実行器で包む。tools/call が並行に届いても、同時に実行されるのは 4 件までになる
(上限はここで構造的に保証し、ツール実装側には依存しない)。
あわせて progress ハートビートもここで包む。全ツールに一律で適用され、ツール実装側の適用判断が要らなくなる。

呼び出しごとに新しい McpServer と実行器を生成する (singleton にしない)。
*/
export function createMcpServer(tools: readonly ToolDefinition[] = [], options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: readVersion() })

  if (tools.length === 0) {
    // registerTool を 1 件もしないと tools capability 自体が宣言されないため、明示的に張る。
    // コンストラクタの capabilities で宣言すると listChanged: true が付くので使わない。
    server.server.registerCapabilities({ tools: {} })
    server.server.setRequestHandler('tools/list', () => ({ tools: [] }))
    return server
  }

  const executor = createBoundedExecutor(CONCURRENCY_LIMIT)
  const intervalMs = options.progressIntervalMs ?? PROGRESS_HEARTBEAT_INTERVAL_MS
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      tool.config,
      async (arguments_: Readonly<Record<string, unknown>>, serverContext: ServerContext) => {
        const heartbeat = startProgressHeartbeat(tool.name, serverContext, intervalMs)
        try {
          return await executor.run(() => {
            heartbeat?.markRunning()
            return tool.handler(arguments_, { signal: serverContext.mcpReq.signal })
          })
        }
        finally {
          heartbeat?.stop()
        }
      },
    )
  }

  return server
}
