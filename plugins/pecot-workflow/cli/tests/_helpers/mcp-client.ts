// MCP のサーバを同じプロセスの中でクライアントにつなぐ。tools/list・tools/call の応答の形を、子プロセスなしで確かめる。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の型は mutable */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { OUTCOME_META_KEY } from '../../src/mcp/result.js'

const OutcomeSchema = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() })
const MetaSchema = z.object({ _meta: z.record(z.string(), OutcomeSchema) })

/**
ツールの結果の _meta から、終了コードと stdout・stderr を読む。_meta が無ければ例外
*/
export function outcomeOf(result: Readonly<Record<string, unknown>>): z.output<typeof OutcomeSchema> {
  const outcome = new Map(Object.entries(MetaSchema.parse(result)._meta)).get(OUTCOME_META_KEY)
  if (outcome === undefined) throw new Error('結果の _meta に outcome がありません')
  return outcome
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
