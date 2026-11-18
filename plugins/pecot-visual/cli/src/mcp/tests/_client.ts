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
      return Promise.resolve(toCallToolResult(spyResultOf(tool.name)))
    },
  }))
  const connected = await connectMcp(spied, { era })
  return { ...connected, calls }
}

const SPY_STAGE = { installed: true, downloaded: false, durationMs: 0 }
const SPY_SKIPPED_LINT = { skipped: true, detail: 'spy' }

/**
spy が返す成功の項目。ツールごとに、成功のときに必ず返る項目を持たせ、outputSchema の検証を通す。
*/
const SPY_DATA: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map(Object.entries({
  drawio_create: { event: 'spy', theme: { source: 'default', fonts: { body: [] } } },
  drawio_export: { event: 'spy', file: '/spy.svg', sourceSha256: 'spy', icons: 0 },
  evidence_create: { event: 'spy', outPath: '/spy.xlsx', items: 0, annotations: 0, skipped: [] },
  runtime_setup: { event: 'spy', runtime: SPY_STAGE, chromium: SPY_STAGE, hostDeps: SPY_STAGE },
  slide_convert: { event: 'spy', input: '/spy', output: '/spy.pptx', durationMs: 0, errors: [], animationTimingRemovedSlides: 0 },
  slide_create: { event: 'spy', projectDir: '/spy', theme: { name: 'spy', spec: 'spy' }, categories: [], layouts: [], lint: SPY_SKIPPED_LINT },
  slide_dev: { event: 'spy', dir: '/spy' },
  slide_lint: {
    event: 'spy',
    dir: '/spy',
    outcome: 'clean',
    lintedFileCount: 0,
    errorCount: 0,
    warningCount: 0,
    violations: [],
    skippedSymlinkDirectories: [],
  },
  slide_page: {
    event: 'spy',
    layout: 'spy',
    category: 'spy',
    deprecated: false,
    path: '/spy.md',
    skeleton: '',
    reference: '',
    includes: {},
  },
  slide_sync: {
    event: 'spy',
    dir: '/spy',
    nodeModulesTarget: '/spy',
    nodeModulesOnly: false,
    // eslint-disable-next-line unicorn/no-null -- テーマを参照しない talk-dir の契約は null
    theme: null,
    // eslint-disable-next-line unicorn/no-null -- 移行しなかったときの契約は null
    migration: null,
    categories: [],
    layouts: [],
    lint: SPY_SKIPPED_LINT,
  },
  slide_theme: {
    event: 'spy',
    theme: { name: 'spy', spec: 'spy', declared: true, directory: '/spy', linked: true },
    declaration: {
      schema: 1,
      slide: { width: 0, height: 0 },
      fonts: { body: [], heading: [] },
      fontSizes: { heading: 0, headingSm: 0, body: 0, bodySm: 0, label: 0 },
      pptx: {},
      lint: { rules: {} },
      layouts: { references: 'spy' },
      drawio: { panels: {}, markerLayouts: [] },
    },
    categories: [],
    layouts: [],
    lint: { referencesDirectories: [], panels: {}, markerLayouts: [], rules: {} },
  },
}))

/**
spy が返す成功の項目。
*/
export function spyDataOf(name: string): Readonly<Record<string, unknown>> {
  const data = SPY_DATA.get(name)
  if (data === undefined) throw new Error(`${name} の spy の結果がありません`)
  return data
}

/**
spy が返す成功結果。
*/
export function spyResultOf(name: string): ToolResult {
  return { ok: true, data: spyDataOf(name), message: 'spy' }
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
