// MCP サーバのファクトリ。ツール登録シームと上限付き並行実行器の所有をここで持つ。
// 1 件以上は registerTool だけを使う（先に一覧ハンドラを張ると SDK が throw する）。
// 0 件のときだけ一覧ハンドラを明示登録する。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- ツールハンドラの第 2 引数は mutable */

import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { readVersion } from '../version.js'
import { createBoundedExecutor } from './executor.js'
import { ignoreRejection } from '../infra/ignore-rejection.js'

/**
progress ハートビートの送出周期 (ms)。クライアントの無音タイムアウト（Claude Code で 30 分）に十分な余裕を取る。
*/
const PROGRESS_HEARTBEAT_INTERVAL_MS = 10_000

/**
tools/call の同時実行数の上限 (research R9)。
*/
const CONCURRENCY_LIMIT = 4

/**
MCP サーバ名。`.mcp.json` の `mcpServers` の登録キーと揃える。食い違うとツール名の名前空間が噛み合わない。
*/
export const MCP_SERVER_NAME = 'pecot-tools'

/**
registerTool に渡すツールのメタ情報。スキーマは自前の zod で書き、SDK 同梱の zod と混在させない。
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
tools/call ハンドラの第 2 引数。使う面だけを切り出し、ツール側とテストのフェイクを SDK の型から切り離す。
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
tools/call 1 件分の progress 通知を開始する。token が無ければ undefined。順番待ちの間も守るため、run() の前から始める。
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
MCP サーバを生成し、ツール定義を登録する。ハンドラは実行器と progress ハートビートで包み、呼び出しごとに新しく作る。
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
