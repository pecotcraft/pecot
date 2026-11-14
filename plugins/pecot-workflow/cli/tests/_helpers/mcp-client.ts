// MCP のサーバを同じプロセスの中でクライアントにつなぐ。tools/list・tools/call の応答の形を、子プロセスなしで確かめる。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の型は mutable */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { TOOL_OUTPUT_SCHEMA } from '../../src/mcp/result.js'

const StructuredSchema = z.object({ structuredContent: TOOL_OUTPUT_SCHEMA })

/**
ツールの結果の structuredContent を読む。無いか形が違えば例外
*/
export function structuredOf(result: Readonly<Record<string, unknown>>): z.output<typeof TOOL_OUTPUT_SCHEMA> {
  return StructuredSchema.parse(result).structuredContent
}

/**
structuredContent から、終了コードと stdout・stderr（無ければ空）を読む
*/
export function outcomeOf(result: Readonly<Record<string, unknown>>): { readonly exitCode: number, readonly stdout: string, readonly stderr: string } {
  const { exitCode, stdout = '', stderr = '' } = structuredOf(result)
  return { exitCode, stdout, stderr }
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
