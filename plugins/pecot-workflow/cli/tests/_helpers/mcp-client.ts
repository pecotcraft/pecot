// MCP のサーバを同じプロセスの中でクライアントにつなぐ。tools/list・tools/call の応答の形を、子プロセスなしで確かめる。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の型は mutable */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { CommandDefinition } from '../../src/commands/registry.js'
import { standardOutputSchema } from '../../src/mcp/result.js'
import { createMcpServer } from '../../src/mcp/server.js'

const TextBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() })

const CallToolResultSchema = z.looseObject({
  content: z.array(TextBlockSchema).min(1).max(2),
  structuredContent: z.record(z.string(), z.unknown()),
  isError: z.literal(true).optional(),
})

export interface ToolOutcome {
  readonly isError: boolean
  /**
  structuredContent。成功はツールの項目、失敗は kind・detail と途中まで進んだ項目
  */
  readonly structured: Readonly<Record<string, unknown>>
  /**
  content の 1 つ目の文。JSON の text だけのときは undefined
  */
  readonly text: string | undefined
}

/**
ツールの結果を読む。content の最後の text が structuredContent の JSON と 1 字も違わないこと、文の text が空でないことも確かめ、違えば例外
*/
export function toolOutcomeOf(result: Readonly<Record<string, unknown>>): ToolOutcome {
  const { content, structuredContent, isError } = CallToolResultSchema.parse(result)
  const json = content.at(-1)?.text
  if (json !== JSON.stringify(structuredContent)) throw new Error(`content の最後の text が structuredContent の JSON と違います: ${String(json)}`)
  const text = content.length === 2 ? content[0]?.text : undefined
  if (text === '') throw new Error('content の文の text が空です')
  return { isError: isError === true, structured: structuredContent, text }
}

/**
ツールの結果の structuredContent を読む。無いか形が違えば例外
*/
export function structuredOf(result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return toolOutcomeOf(result).structured
}

/**
成否と、失敗の detail・warnings（無ければ空）を読む
*/
export function outcomeOf(result: Readonly<Record<string, unknown>>): { readonly isError: boolean, readonly detail: string | undefined, readonly warnings: readonly string[] } {
  const { isError, structured } = toolOutcomeOf(result)
  const detail = typeof structured['detail'] === 'string' ? structured['detail'] : undefined
  const warnings = Array.isArray(structured['warnings']) ? structured['warnings'].map(String) : []
  return { isError, detail, warnings }
}

/**
structuredContent が outputSchema（JSON Schema）に合うか。SDK が成功の結果に使うのと同じ ajv で、失敗の結果も確かめる
*/
export async function outputSchemaIssues(schema: Readonly<Record<string, unknown>>, value: unknown): Promise<readonly string[]> {
  const checked = await standardOutputSchema(schema)['~standard'].validate(value)
  return checked.issues === undefined ? [] : checked.issues.map(issue => issue.message)
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

// 偽のタイマーを進めると SDK の要求の期限（既定 60 秒）も進むため、待つツールでは期限を長くする
const FAKE_DELAY_REQUEST_TIMEOUT = 24 * 60 * 60 * 1000

/**
commands から MCP のサーバを作り、同じプロセスの中のクライアントからツールを 1 回呼んで、成否と structuredContent を返す。cwd は呼ぶ側が決める。
失敗の detail が空か、行が `error: ` で始まれば例外（実物のコマンドの失敗は、どれも読める文を持つ）
*/
export async function callToolOnce(commands: readonly CommandDefinition[], name: string, arguments_: Readonly<Record<string, unknown>>, settle: Settle = awaitAsIs): Promise<ToolOutcome> {
  const connected = await connectInMemory(createMcpServer(commands))
  try {
    const outcome = toolOutcomeOf(await settle(connected.client.callTool({ name, arguments: { ...arguments_ } }, settle === awaitAsIs ? undefined : { timeout: FAKE_DELAY_REQUEST_TIMEOUT })))
    const detail = outcome.structured['detail']
    if (outcome.isError && (typeof detail !== 'string' || detail.trim() === '')) throw new Error(`${name}: 失敗の detail が空です`)
    if (typeof detail === 'string' && /^error: /mu.test(detail)) throw new Error(`${name}: detail の行が error: で始まります: ${detail}`)
    return outcome
  }
  finally {
    await connected.close()
  }
}
