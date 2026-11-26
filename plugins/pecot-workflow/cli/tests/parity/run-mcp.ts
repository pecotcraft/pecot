// シナリオ 1 件を、MCP のクライアントからツールを 1 回呼ぶ形で流す。サーバは Node の CLI の `mcp` を子プロセスで起動し、シナリオの cwd と env を渡す。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の Client と stream は mutable */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Client, SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { z } from 'zod'

import { toolNameOf } from '../../src/commands/registry.js'
import { parseJson } from '../../../../../libs/workflow-core/tests/_helpers/json.js'
import { outputSchemaIssues, toolOutcomeOf } from '../_helpers/mcp-client.js'
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

// 入力の検証でコマンドを呼ばずに断った結果の detail の前置き（server.ts の rejected）
const REJECTED_PREFIX = 'invalid input: '

const generatedCache: { entries?: readonly z.output<typeof OutputEntrySchema>[] } = {}

/**
generated.json の項目。シナリオごとに読み直さないよう、最初に読んで parse した結果を使い回す
*/
function generatedEntries(): readonly z.output<typeof OutputEntrySchema>[] {
  if (generatedCache.entries === undefined) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- plugin の interface/ の下の固定のファイル
    const text = readFileSync(path.join(pluginRoot, 'interface', 'generated.json'), 'utf8')
    generatedCache.entries = OutputEntriesSchema.parse(parseJson(text)).entries
  }
  return generatedCache.entries
}

/**
定義書の項目を、client が成功の structuredContent を outputSchema で検証するための toolDefinition にする
*/
function toolDefinitionOf(name: string): { name: string, inputSchema: z.output<typeof InputSchemaShape>, outputSchema: z.output<typeof InputSchemaShape> } {
  const entry = generatedEntries().find(item => item.surfaces.mcp.tool === name)
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
    const definition = toolDefinitionOf(name)
    const result = await client.callTool({ name, arguments: { ...input } }, { timeout: CHILD_TIMEOUT_MS, toolDefinition: definition })
    const { isError, structured, text } = toolOutcomeOf(result)
    // client は失敗の結果を検証しないので、同じ outputSchema でここで確かめる
    const issues = isError ? await outputSchemaIssues(definition.outputSchema, structured) : []
    if (issues.length > 0) throw new Error(`失敗の structuredContent が定義書の outputSchema に合いません: ${issues.join('; ')}`)
    const detail = typeof structured['detail'] === 'string' ? structured['detail'] : undefined
    // 入力の検証の誤り（コマンドを呼んでいない）は、本体の結果と分けるため、detail を stdout に残して -1 にする
    if (structured['kind'] === 'invalid-input' && detail?.startsWith(REJECTED_PREFIX) === true) {
      return { stdout: detail, stderr: serverStderr, code: undefined, signal: undefined, spawnError: undefined, timedOut: false, data: structured }
    }
    const warnings = Array.isArray(structured['warnings']) ? structured['warnings'].map(String) : []
    // MCP の結果は終了コードを持たないので、成否を 0 と 1 にする。golden の側も同じく写して比べる（parity.test.ts）
    return { stdout: '', stderr: renderMcpView({ warnings, detail: isError ? String(detail) : undefined }), code: isError ? 1 : 0, signal: undefined, spawnError: undefined, timedOut: false, data: structured, ...text !== undefined && { text } }
  }
  catch (error: unknown) {
    return failed(error)
  }
  finally {
    await closeQuietly(client)
  }
}
