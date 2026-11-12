// シナリオ 1 件を、MCP のクライアントからツールを 1 回呼ぶ形で流す。サーバは Node の CLI の `mcp` を子プロセスで起動し、シナリオの cwd と env を渡す。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の Client と stream は mutable */
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { z } from 'zod'

import { OUTCOME_META_KEY } from '../../src/mcp/result.js'
import { toolNameOf } from '../../src/commands/registry.js'
import { readToolShape, toolInputOf } from './mcp-input.js'
import type { ChildResult, Launcher } from './run.js'
import { CHILD_TIMEOUT_MS } from './run.js'
import type { Scenario } from './scenario.js'

const OutcomeSchema = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() })
const MetaSchema = z.object({ _meta: z.record(z.string(), OutcomeSchema) })
const ContentSchema = z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))

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
    return { stdout: '', stderr: '', code: undefined, signal: undefined, spawnError: `${message}${serverStderr === '' ? '' : `\n${serverStderr}`}`, timedOut: /timed out/iu.test(message) }
  }
  try {
    await client.connect(transport, { timeout: CHILD_TIMEOUT_MS })
    const input = toolInputOf(readToolShape(scenario.command.path), scenario.command.args)
    const result = await client.callTool({ name: toolNameOf(scenario.command.path), arguments: { ...input } }, { timeout: CHILD_TIMEOUT_MS })
    const meta = MetaSchema.safeParse(result).data?._meta
    const outcome = meta === undefined ? undefined : new Map(Object.entries(meta)).get(OUTCOME_META_KEY)
    if (outcome !== undefined) {
      return { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.exitCode, signal: undefined, spawnError: undefined, timedOut: false }
    }
    // 入力の検証の誤り（コマンドを呼んでいない）。終了コードが無いので、本文を stdout に残して -1 にする
    const text = ContentSchema.parse(result.content).map(block => block.text ?? '').join('')
    return { stdout: text, stderr: serverStderr, code: undefined, signal: undefined, spawnError: undefined, timedOut: false }
  }
  catch (error: unknown) {
    return failed(error)
  }
  finally {
    await closeQuietly(client)
  }
}
