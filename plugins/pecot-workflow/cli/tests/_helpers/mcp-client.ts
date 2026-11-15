// MCP のサーバを同じプロセスの中でクライアントにつなぐ。tools/list・tools/call の応答の形を、子プロセスなしで確かめる。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の型は mutable */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

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
