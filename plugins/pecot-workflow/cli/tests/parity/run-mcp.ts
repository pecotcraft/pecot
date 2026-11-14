// シナリオ 1 件を、MCP のクライアントからツールを 1 回呼ぶ形で流す。サーバは Node の CLI の `mcp` を子プロセスで起動し、シナリオの cwd と env を渡す。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の Client と stream は mutable */
import { Client, SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { z } from 'zod'

import { TOOL_OUTPUT_SCHEMA } from '../../src/mcp/result.js'
import { toolNameOf } from '../../src/commands/registry.js'
import { readToolShape, toolInputOf } from './mcp-input.js'
import type { ChildResult, Launcher } from './run.js'
import { CHILD_TIMEOUT_MS } from './run.js'
import type { Scenario } from './scenario.js'

const StructuredSchema = z.object({ structuredContent: TOOL_OUTPUT_SCHEMA })

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
    const result = await client.callTool({ name: toolNameOf(scenario.command.path), arguments: { ...input } }, { timeout: CHILD_TIMEOUT_MS })
    const outcome = StructuredSchema.parse(result).structuredContent
    // 入力の検証の誤り（コマンドを呼んでいない）は出力を持たない。本体の終了コードと分けるため、message を stdout に残して -1 にする
    return outcome.kind === 'invalid-input' && outcome.stdout === undefined && outcome.stderr === undefined ? { stdout: outcome.message, stderr: serverStderr, code: undefined, signal: undefined, spawnError: undefined, timedOut: false } : { stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '', code: outcome.exitCode, signal: undefined, spawnError: undefined, timedOut: false }
  }
  catch (error: unknown) {
    return failed(error)
  }
  finally {
    await closeQuietly(client)
  }
}
