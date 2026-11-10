// MCP サーバのファクトリ。ツール登録シームと逐次実行キューの所有をここで持つ。
//
// ツール 1 件以上のときは McpServer.registerTool だけを使う。
// 低レベルの setRequestHandler('tools/list', ...) で一覧ハンドラを先に張る場合を考える。
// 後から registerTool したときに SDK が「handler already exists」で throw する。
// 一方でツール 0 件の McpServer は tools capability と一覧ハンドラを持たず、tools/list に -32601 を返す。
// そのため 0 件のときだけ明示登録する。両者は排他。

// ツールハンドラの第 2 引数 (SDK の ServerContext) は mcpReq.signal / notify 等の mutable なメンバを持つ。
// readonly 化すると registerTool のコールバック型と適合しなくなる。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */

import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { readVersion } from '../version.js'
import { createExecutionQueue } from './queue.js'
import { ignoreRejection } from '../domain/_shared/ignore-rejection.js'

/**
progress ハートビートの送出周期 (ms)。

守る相手は MCP クライアントの「無音タイムアウト」で、Claude Code の計測は 30 分の
idle watchdog (progress 受信でリセット・判定周期 30s)。10s はそこから十分な余裕があり、
かつ長時間ツール 1 件で通知が積み上がりすぎない粒度になる。
*/
const PROGRESS_HEARTBEAT_INTERVAL_MS = 10_000

/**
MCP サーバ名。plugins/pecot-visual/.mcp.json の mcpServers のキーと一致させる。
*/
export const MCP_SERVER_NAME = 'pecot-visual'

/**
registerTool に渡すツールのメタ情報。

inputSchema / outputSchema は自前の zod で組み立てた object スキーマ (`z.object({ ... })`)。
SDK は渡されたスキーマ自身で JSON Schema を作るため、ツール定義側の zod と SDK 同梱の zod が
混在しない。引数を取らないツールは inputSchema に `z.object({})` を渡す。
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
tools/call ハンドラの第 2 引数。ツールが SDK のコンテキスト型に縛られないよう、使うものだけを渡す。
progress の送出はハートビートが担うため、ツール側は signal (キャンセル) だけを見る。
*/
export interface ToolCallContext {
  /**
  クライアントが tools/call をキャンセルしたとき、または接続が閉じたときに abort される。
  */
  readonly signal: AbortSignal
}

/**
createMcpServer がハンドラへ渡す、サーバ側の機能への入り口。
*/
export interface ToolContext {
  /**
  以降の progress 通知の文言を差し替え、その場で 1 発送る。長時間ツールが工程や件数を
  利用者へ見せるために使う。progressToken の無い呼び出しでは何もしない。
  */
  readonly reportProgress: (message: string) => void
}

/**
tools/call のハンドラ。arguments_ は inputSchema で検証済みの値。
context は createMcpServer 経由の呼び出しで必ず渡る（ハンドラを直接呼ぶテストでは省略できる）。
*/
export type ToolHandler = (
  arguments_: Readonly<Record<string, unknown>>,
  call: ToolCallContext,
  context?: ToolContext,
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
  キュー待機を抜けて実処理に入ったことを、以降の通知の message へ反映する。
  */
  markRunning(): void
  /**
  文言を差し替えて即座に 1 発送る。以降の周期送出もこの文言を使う。停止後は何も送らない。
  */
  report(message: string): void
  /**
  周期送出を止める。呼び出しの完了時 (成功・失敗どちらも) に必ず呼ぶ。キャンセル時は自動で止まる。
  */
  stop(): void
}

/**
tools/call 1 件分の progress 通知を開始し、即座に 1 発目 (キュー待機中) を送る。

MCP では progressToken を伴わないリクエストに notifications/progress を返せない。
そのためクライアントが token を付けてこなかった場合は何も送らず undefined を返す。
判定は SDK 公式のパターンに従い、`context.mcpReq._meta` の progressToken の有無で行う。

送出は enqueue の前から始める。守りたいのは実行中だけでなく「直列キューで順番待ちしている
間も無音時計が進む」区間で、ハンドラ内に置くラッパーではデキュー前を守れない。

クライアントがキャンセル (notifications/cancelled) した後は、周期送出と reportProgress のどちらからも
送らない。キャンセル済みのリクエストへ通知を返し続けると、クライアント側の onerror に
未知トークン宛の通知が積み上がる。
*/
function startProgressHeartbeat(toolName: string, context: ServerContext, intervalMs: number): ProgressHeartbeat | undefined {
  const progressToken = context.mcpReq._meta?.progressToken
  if (progressToken === undefined) return undefined

  const { signal } = context.mcpReq
  let progress = 0
  let phase = 'waiting in queue'
  let isStopped = false

  // 周期送出と reportProgress のどちらも通る関門。停止後・キャンセル後は何も送らない。
  const send = (): void => {
    if (isStopped) return
    progress += 1
    // 通知はベストエフォート。クライアント切断後の reject を await ルートに乗せると
    // ハンドラの例外に化けて ok: false になるため、ここで握り潰す。
    void ignoreRejection(context.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken, progress, message: `${toolName}: ${phase}` },
    }))
  }

  const timer = setInterval(send, intervalMs)
  const stop = (): void => {
    isStopped = true
    clearInterval(timer)
    signal.removeEventListener('abort', stop)
  }

  if (signal.aborted) {
    stop()
  }
  else {
    send()
    signal.addEventListener('abort', stop, { once: true })
  }

  return {
    markRunning: () => { phase = 'running' },
    report: (message) => {
      phase = message
      send()
    },
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

各ハンドラは登録時にキューで包むため、tools/call が並行に届いても実行は 1 件ずつになる
(直列化はここで構造的に保証し、ツール実装側には依存しない)。キューは再入を禁止するので、
ハンドラ内から同じキューへ積み直すと ReentrantEnqueueError で失敗する。

あわせて progress ハートビートもここで包む。全ツールに一律で働き、ツール実装側の
適用判断が要らなくなる。

呼び出しごとに新しい McpServer とキューを生成する (singleton にしない)。
*/
export function createMcpServer(tools: readonly ToolDefinition[] = [], options: McpServerOptions = {}): McpServer {
  // サーバ名は .mcp.json のキーと揃える (initialize の serverInfo.name として返る値)。
  const server = new McpServer({ name: MCP_SERVER_NAME, version: readVersion() })

  if (tools.length === 0) {
    // registerTool を 1 件もしないと tools capability 自体が宣言されないため、明示的に張る。
    // コンストラクタの capabilities で宣言すると listChanged: true が付くので使わない。
    server.server.registerCapabilities({ tools: {} })
    server.server.setRequestHandler('tools/list', () => ({ tools: [] }))
    return server
  }

  const queue = createExecutionQueue()
  const intervalMs = options.progressIntervalMs ?? PROGRESS_HEARTBEAT_INTERVAL_MS

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      tool.config,
      async (arguments_: Readonly<Record<string, unknown>>, serverContext: ServerContext) => {
        const heartbeat = startProgressHeartbeat(tool.name, serverContext, intervalMs)
        const context: ToolContext = {
          reportProgress: (message) => { heartbeat?.report(message) },
        }
        try {
          return await queue.enqueue(() => {
            heartbeat?.markRunning()
            return tool.handler(arguments_, { signal: serverContext.mcpReq.signal }, context)
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
