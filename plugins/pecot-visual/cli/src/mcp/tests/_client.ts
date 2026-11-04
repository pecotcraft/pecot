// mcp の各テストで共用する MCP クライアント結線ヘルパ。
//
// serveStdio に InMemoryTransport を差し込んでクライアントと直結し、実プロセスを起こさずに
// tools/list・tools/call の応答形を観測する。serveStdio は接続ごとに 2025 系と 2026-07-28 系の
// どちらかを選ぶので、クライアント側の設定でどちらのルートも通せる。実プロセス経由の検証は
// tests/e2e/ が担う。

// SDK の Client / StdioServerHandle はいずれも mutable なクラス型で、readonly 化すると引数に渡せない。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'

import { isRecord } from '../../../tests/_helpers/records.js'
import { toCallToolResult, type ToolResult } from '../result.js'
import { createMcpServer, type ToolDefinition } from '../server.js'
import { allTools } from '../tools/index.js'

/**
クライアントが交渉するプロトコル世代。legacy は 2025 系、modern は 2026-07-28。
*/
export type ProtocolEra = 'legacy' | 'modern'

/**
両世代を通す表で使う。
*/
export const PROTOCOL_ERAS: readonly ProtocolEra[] = ['legacy', 'modern']

const LEGACY_PROTOCOL_VERSION = '2025-11-25'
const MODERN_PROTOCOL_VERSION = '2026-07-28'

/**
era ごとにクライアントが交渉して合意するはずのプロトコル版。
*/
export function negotiatedVersionOf(era: ProtocolEra): string {
  return era === 'modern' ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION
}

export interface ConnectOptions {
  readonly progressIntervalMs?: number
  /**
  既定は legacy。
  */
  readonly era?: ProtocolEra
}

export interface ConnectedMcp {
  readonly handle: StdioServerHandle
  readonly client: Client
}

/**
渡したツール定義を登録したサーバへ接続済みのクライアントを返す。
*/
export async function connectMcp(
  tools: readonly ToolDefinition[] = [],
  options: ConnectOptions = {},
): Promise<ConnectedMcp> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const handle = serveStdio(
    () => createMcpServer(tools, options),
    { transport: serverTransport },
  )
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    options.era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } } : {},
  )
  await client.connect(clientTransport)
  return { handle, client }
}

export async function closeMcp(connected: ConnectedMcp): Promise<void> {
  await connected.client.close()
  await connected.handle.close()
}

/**
spy ハンドラが受け取った tools/call 1 件。arguments は SDK の検証・既定値適用後の値。
*/
export interface SpyCall {
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface SpiedMcp extends ConnectedMcp {
  /**
  実ツール定義の handler まで届いた呼び出し。検証で拒否された呼び出しは載らない。
  */
  readonly calls: SpyCall[]
}

/**
実ツール定義の handler だけを spy に差し替えたサーバへ接続する。

inputSchema / outputSchema / annotations は本番の定義のまま通る。
そのため awscli と Slidev を起こさずに、SDK の入力検証層を全ツールで観測できる。spy は成功結果を返す。
*/
export async function connectSpied(era: ProtocolEra = 'legacy'): Promise<SpiedMcp> {
  const calls: SpyCall[] = []
  const spied = allTools().map((tool): ToolDefinition => ({
    ...tool,
    handler: (arguments_) => {
      calls.push({ name: tool.name, arguments: arguments_ })
      return Promise.resolve(toCallToolResult(SPY_RESULT))
    },
  }))
  const connected = await connectMcp(spied, { era })
  return { ...connected, calls }
}

/**
spy が返す成功結果。outputSchema 検証を通る完全な形にしておく。
*/
export const SPY_RESULT: ToolResult = {
  ok: true,
  exitCode: 0,
  data: { spy: true },
  artifacts: [],
  message: 'spy',
}

/**
tools/call の入力が SDK の検証層でどう扱われたか。
*/
export type CallOutcome = 'accepted' | 'schema-rejected' | 'unknown-tool'

/**
未知ツールの tools/call に SDK が返す JSON-RPC エラーコード (InvalidParams)。
*/
export const INVALID_PARAMS_CODE = -32_602

function textOf(result: Readonly<CallToolResult>): string {
  return result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

/**
tools/call を発行し、検証層の扱いを分類する。

スキーマ拒否は isError 結果で本文に `Input validation error` を含み、structuredContent を
持たない。未知ツールは JSON-RPC エラー (-32602) になる。client と server は別バンドルなので
エラー型は instanceof で判定せず、code で見る。
*/
export async function classifyCall(
  client: Client,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<CallOutcome> {
  let result: CallToolResult
  try {
    result = await client.callTool({ name, arguments: { ...arguments_ } })
  }
  catch (error: unknown) {
    if (isRecord(error) && error['code'] === INVALID_PARAMS_CODE) return 'unknown-tool'
    throw error
  }
  const isRejected = result.isError === true
    && result.structuredContent === undefined
    && textOf(result).includes('Input validation error')
  return isRejected ? 'schema-rejected' : 'accepted'
}
