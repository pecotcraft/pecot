// mcp の各テストで共用する MCP クライアント結線ヘルパ。
//
// serveStdio に InMemoryTransport を差し込んでクライアントと直結し、実プロセスを起こさずに
// tools/list・tools/call の応答形を観測する。serveStdio は接続ごとに 2025 系と 2026-07-28 系の
// どちらかを選ぶので、クライアント側の設定でどちらの接続も通せる。実プロセス経由の検証は
// tests/e2e/ が担う。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の Client は mutable なクラス型 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'

import { isRecord } from '../../../tests/_helpers/records.js'
import { toCallToolResult, type ExecutionResult } from '../result.js'
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
  /**
  クライアントの onerror に届いたエラー。破棄済みのトークン宛の progress など、送ってはいけない通知を送った場合の観測点になる。
  */
  readonly errors: readonly Readonly<Error>[]
}

/**
周期送出の `count` 回分だけ待つ。
*/
export function waitIntervals(intervalMs: number, count: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, intervalMs * count)
  })
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
  const errors: Readonly<Error>[] = []
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- SDK の Protocol は onerror 経由で通知する
  client.onerror = (error: Readonly<Error>) => {
    errors.push(error)
  }
  await client.connect(clientTransport)
  return { handle, client, errors }
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

inputSchema / outputSchema / annotations は本番の定義のまま通るので、awscli を起こさずに
SDK の入力検証層を全ツールで観測できる。spy は成功結果を返す。
*/
export async function connectSpied(era: ProtocolEra = 'legacy'): Promise<SpiedMcp> {
  const calls: SpyCall[] = []
  const spied = allTools().map((tool): ToolDefinition => ({
    ...tool,
    handler: (arguments_) => {
      calls.push({ name: tool.name, arguments: arguments_ })
      return Promise.resolve(toCallToolResult(spyResultOf(tool.name)))
    },
  }))
  const connected = await connectMcp(spied, { era })
  return { ...connected, calls }
}

/**
spy が返す成功結果。outputSchema は閉じていて成功の必須項目も求めるので、対象のツールに合う形で作る。
*/
export function spyResultOf(name: string): ExecutionResult {
  const data = name === 'aws_sso_login'
    ? { state: 'pending', profile: '' }
    : (name === 'aws_sso_login_status' ? { state: 'pending' } : { lines: ['spy'] })
  return { ok: true, data, message: 'spy' }
}

function outputSchemaOf(tool: Readonly<ToolDefinition>): StandardSchemaWithJSON {
  const schema = tool.config.outputSchema
  if (schema === undefined) throw new Error(`${tool.name} に outputSchema がありません`)
  return schema
}

/**
ツールの outputSchema の JSON Schema（tools/list に載る形）。
*/
export function outputJsonSchemaOf(tool: Readonly<ToolDefinition>): Record<string, unknown> {
  return outputSchemaOf(tool)['~standard'].jsonSchema.output({ target: 'draft-2020-12' })
}

/**
structuredContent が outputSchema に合わない理由。SDK が成功の結果に使うのと同じ validator で、失敗の結果も確かめる。
*/
export async function outputSchemaIssues(tool: Readonly<ToolDefinition>, value: unknown): Promise<readonly string[]> {
  const checked = await outputSchemaOf(tool)['~standard'].validate(value)
  return checked.issues === undefined ? [] : checked.issues.map(issue => issue.message)
}

/**
tools/call の入力が SDK の検証層でどう扱われたか。
*/
export type CallOutcome = 'accepted' | 'schema-rejected' | 'unknown-tool'

/**
未知ツールの tools/call に SDK が返す JSON-RPC エラーコード (InvalidParams)。
*/
const INVALID_PARAMS_CODE = -32_602

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
