// dist/main.js を MCP で起動し、ツールを 1 回呼んで structuredContent を JSON 1 行で stdout に書く。
// 同期の spawnSync で動かす e2e が、MCP の呼び出しを使えるようにするための薄い橋。
// argv[2] は `{ "tool": string, "arguments": object }` の JSON。終了コードは成功 0、ツールの失敗 1、接続などの失敗 3。

import path from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const REQUEST_TIMEOUT_MS = 600_000
const ENTRY = path.resolve(import.meta.dirname, '..', '..', 'dist', 'main.js')

interface ToolCall {
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

function isToolCall(value: unknown): value is ToolCall {
  return typeof value === 'object' && value !== null && 'tool' in value && typeof value.tool === 'string'
    && 'arguments' in value && typeof value.arguments === 'object'
}

async function run(): Promise<number> {
  const parsed: unknown = JSON.parse(process.argv[2] ?? '')
  if (!isToolCall(parsed)) throw new TypeError('argv[2] は { tool, arguments } の JSON である必要があります')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: 'inherit',
  })
  const client = new Client({ name: 'pecotv-e2e-tool-call', version: '0.0.0' })
  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
    const called = await client.callTool(
      { name: parsed.tool, arguments: parsed.arguments },
      { timeout: REQUEST_TIMEOUT_MS },
    )
    const structured = 'structuredContent' in called ? called.structuredContent : undefined
    process.stdout.write(`${JSON.stringify(structured ?? {})}\n`)
    return 'isError' in called && called.isError === true ? 1 : 0
  }
  finally {
    await client.close()
  }
}

try {
  process.exitCode = await run()
}
catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 3
}
