// MCP のサーバを同じプロセスの中でクライアントにつなぐ。tools/list・tools/call の応答の形を、子プロセスなしで確かめる。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の型は mutable */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { CommandDefinition } from '../../src/commands/registry.js'
import { createMcpServer } from '../../src/mcp/server.js'

/**
全ツールに共通の入れ物。最上位は 6 つの名前だけで、stdout・stderr を持たない。data の中身はツールごとの outputSchema が決める
*/
export const ToolEnvelopeSchema = z.strictObject({
  ok: z.boolean(),
  exitCode: z.number(),
  kind: z.string().optional(),
  artifacts: z.array(z.string()),
  data: z.record(z.string(), z.unknown()),
  message: z.string(),
})

export type ToolEnvelope = z.output<typeof ToolEnvelopeSchema>

const StructuredSchema = z.looseObject({ structuredContent: ToolEnvelopeSchema })

/**
ツールの結果の structuredContent を読む。無いか形が違えば例外
*/
export function structuredOf(result: Readonly<Record<string, unknown>>): ToolEnvelope {
  return StructuredSchema.parse(result).structuredContent
}

/**
structuredContent から、終了コードと、失敗の data.detail・data.warnings（無ければ空）を読む
*/
export function outcomeOf(result: Readonly<Record<string, unknown>>): { readonly exitCode: number, readonly detail: string | undefined, readonly warnings: readonly string[] } {
  const { exitCode, data } = structuredOf(result)
  const detail = typeof data['detail'] === 'string' ? data['detail'] : undefined
  const warnings = Array.isArray(data['warnings']) ? data['warnings'].map(String) : []
  return { exitCode, detail, warnings }
}

export interface ConnectedClient {
  readonly client: Client
  readonly close: () => Promise<void>
}

export async function connectInMemory(server: McpServer): Promise<ConnectedClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/**
ツールの呼び出しの Promise を受けて、待ち方を変える関数。偽のタイマーを進めながら待つときに渡す
*/
export type Settle = <T>(pending: Promise<T>) => Promise<T>

const awaitAsIs: Settle = async pending => await pending

/**
commands から MCP のサーバを作り、同じプロセスの中のクライアントからツールを 1 回呼んで、structuredContent を返す。cwd は呼ぶ側が決める
*/
export async function callToolOnce(commands: readonly CommandDefinition[], name: string, arguments_: Readonly<Record<string, unknown>>, settle: Settle = awaitAsIs): Promise<ToolEnvelope> {
  const connected = await connectInMemory(createMcpServer(commands))
  try {
    return structuredOf(await settle(connected.client.callTool({ name, arguments: { ...arguments_ } })))
  }
  finally {
    await connected.close()
  }
}
