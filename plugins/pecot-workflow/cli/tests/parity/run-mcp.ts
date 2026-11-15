// シナリオ 1 件を、MCP のクライアントからツールを 1 回呼ぶ形で流す。サーバは Node の CLI の `mcp` を子プロセスで起動し、シナリオの cwd と env を渡す。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の Client と stream は mutable */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Client, SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { z } from 'zod'

import { toolNameOf } from '../../src/commands/registry.js'
import { parseJson } from '../../src/tests/_helpers/json.js'
import { structuredOf } from '../_helpers/mcp-client.js'
import { readToolShape, toolInputOf } from './mcp-input.js'
import { renderMcpView } from './mcp-view.js'
import type { ChildResult, Launcher } from './run.js'
import { CHILD_TIMEOUT_MS } from './run.js'
import type { Scenario } from './scenario.js'
import { pluginRoot } from './setup.js'

const InputSchemaShape = z.looseObject({ type: z.literal('object') })
const McpSurfaceSchema = z.object({ mcp: z.object({ tool: z.string() }) })
const OutputEntrySchema = z.looseObject({ surfaces: McpSurfaceSchema, input: InputSchemaShape, mcp: z.object({ output: InputSchemaShape }) })
const OutputEntriesSchema = z.object({ entries: z.array(OutputEntrySchema) })

// 入力の検証でコマンドを呼ばずに断った結果の message の前置き（server.ts の rejected）
const REJECTED_PREFIX = 'invalid input: '

/**
定義書の項目を、client が成功の structuredContent を outputSchema で検証するための toolDefinition にする
*/
function toolDefinitionOf(name: string): { name: string, inputSchema: z.output<typeof InputSchemaShape>, outputSchema: z.output<typeof InputSchemaShape> } {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- plugin の interface/ の下の固定のファイル
  const text = readFileSync(path.join(pluginRoot, 'interface', 'generated.json'), 'utf8')
  const generated = OutputEntriesSchema.parse(parseJson(text))
  const entry = generated.entries.find(item => item.surfaces.mcp.tool === name)
  if (entry === undefined) throw new Error(`定義書に ${name} がありません`)
  return { name, inputSchema: entry.input, outputSchema: entry.mcp.output }
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close()
  }
  catch {
    // 後始末の失敗は結果に関係しない
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runMcpChild(launcher: Launcher, scenario: Scenario, cwd: string, environment: Readonly<Record<string, string>>): Promise<ChildResult> {
  const transport = new StdioClientTransport({ command: launcher.command, args: [...launcher.args, 'mcp'], env: { ...environment }, cwd, stderr: 'pipe' })
  // 読み切らないと、パイプが埋まった時点でサーバが止まる
  let serverStderr = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    serverStderr += String(chunk)
  })
  const client = new Client({ name: 'parity', version: '0.0.0' })
  const failed = (error: unknown): ChildResult => {
    const message = messageOf(error)
    return { stdout: '', stderr: '', code: undefined, signal: undefined, spawnError: `${message}${serverStderr === '' ? '' : `\n${serverStderr}`}`, timedOut: SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout }
  }
  try {
    await client.connect(transport, { timeout: CHILD_TIMEOUT_MS })
    // scenario.stdin は渡さない。MCP のツールは標準入力を持たず、stdin のシナリオは呼び出し側で除いている
    const input = toolInputOf(readToolShape(scenario.command.path), scenario.command.args)
    const name = toolNameOf(scenario.command.path)
    // toolDefinition を渡すと、client が成功の structuredContent を定義書の outputSchema で検証し、合わなければ例外にする
    const result = await client.callTool({ name, arguments: { ...input } }, { timeout: CHILD_TIMEOUT_MS, toolDefinition: toolDefinitionOf(name) })
    const outcome = structuredOf(result)
    // 入力の検証の誤り（コマンドを呼んでいない）は、本体の終了コードと分けるため、message を stdout に残して -1 にする
    if (outcome.kind === 'invalid-input' && outcome.message.startsWith(REJECTED_PREFIX) && outcome.data['detail'] === outcome.message) {
      return { stdout: outcome.message, stderr: serverStderr, code: undefined, signal: undefined, spawnError: undefined, timedOut: false, data: outcome.data }
    }
    const warnings = Array.isArray(outcome.data['warnings']) ? outcome.data['warnings'].map(String) : []
    const detail = outcome.ok ? undefined : String(outcome.data['detail'])
    return { stdout: '', stderr: renderMcpView({ warnings, detail }), code: outcome.exitCode, signal: undefined, spawnError: undefined, timedOut: false, data: outcome.data }
  }
  catch (error: unknown) {
    return failed(error)
  }
  finally {
    await closeQuietly(client)
  }
}
