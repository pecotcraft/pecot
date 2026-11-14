// COMMANDS の 37 個を MCP のツールとして登録するサーバ。CLI と同じ定義の run を呼び、結果の形だけが違う。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod と SDK の型は readonly にできない */
import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { InvalidValueError } from '../domain/errors.js'
import { parseOwnerRepository } from '../domain/repository-resolver.js'
import { resolveApiUrlOverride } from '../infra/github/client.js'
import { usageOf, withUsage } from '../commands/command-binding.js'
import { createOutput } from '../commands/output.js'
import { exitCodeOfFailure } from '../commands/failure.js'
import { isRecord } from '../commands/input-schema.js'
import { COMMANDS } from '../commands/registry.js'
import type { CommandDefinition, PreparedCommand } from '../commands/registry.js'
import { outputWidth } from '../commands/rich-panel.js'
import { readVersion } from '../version.js'
import { collectIo, toRejectedResult, toToolResult } from './result.js'

export const MCP_SERVER_NAME = 'pecot-workflow'

export interface McpServerOptions {
  /**
  対象のリポを決められなかった理由。あるとき、どのツールの呼び出しもコマンドを呼ばず、この理由を失敗（exit code 1）で返す。tools/list は変わらない
  */
  readonly unavailableReason?: string | undefined
  /**
  プログラムの誤り（報告できる失敗でも使い方の誤りでもない例外）と、それまでに集めた出力を、切り分けのために伝える先。SDK は message だけの結果にする
  */
  readonly reportUnexpected?: (error: unknown, collected: { readonly stdout: string, readonly stderr: string }) => void
}

type Preparation
  = | { readonly kind: 'prepared', readonly command: PreparedCommand }
    | { readonly kind: 'rejected', readonly message: string }

function rejected(message: string): Preparation {
  return { kind: 'rejected', message: `invalid input: ${message}` }
}

/**
SDK に渡す入力のスキーマ。tools/list の形は定義書と同じ z.toJSONSchema の形に additionalProperties: false を足し、検証は素通しにする。
SDK に zod を渡すと、検証の後に未知のキーを捨てた値が届き、未知のキーを誤りにできない
*/
function passthroughSchema(definition: Readonly<CommandDefinition>): StandardSchemaWithJSON {
  const jsonSchema = (): Record<string, unknown> => ({ ...z.toJSONSchema(definition.input, { io: 'input' }), additionalProperties: false })
  return {
    '~standard': {
      version: 1,
      vendor: MCP_SERVER_NAME,
      jsonSchema: { input: jsonSchema, output: jsonSchema },
      validate: value => ({ value }),
    },
  }
}

function issuesMessage(error: Readonly<z.ZodError>): string {
  return error.issues.map(issue => issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

/**
入力を検証する。順は CLI と同じ（未知のキー → repo の形 → definition.parse）。誤りならコマンドを呼ばない
*/
function prepare(definition: Readonly<CommandDefinition>, raw: unknown): Preparation {
  // arguments が配列や null なら SDK が先に -32602 で断るので、ここに来る非 object は省略（undefined）だけ
  const input = isRecord(raw) ? raw : {}
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(definition.input.shape, key))
  if (unknown.length > 0) return rejected(`unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map(key => `'${key}'`).join(', ')}`)
  const repository = input['repo']
  if (typeof repository === 'string' && !definition.hasOwnRepo) {
    try {
      parseOwnerRepository(repository)
    }
    catch (error: unknown) {
      if (!(error instanceof InvalidValueError)) throw error
      return rejected(`repo: ${error.message}`)
    }
  }
  try {
    return { kind: 'prepared', command: definition.parse(input) }
  }
  catch (error: unknown) {
    if (!(error instanceof z.ZodError)) throw error
    return rejected(issuesMessage(error))
  }
}

// 対象のリポを決められなかったとき、コマンドを呼ばずに理由を失敗で返す
function unavailableResult(reason: string): CallToolResult {
  const collected = collectIo()
  createOutput(false, collected.io).error(reason)
  return toToolResult({ exitCode: 1, stdout: collected.stdout(), stderr: collected.stderr() })
}

async function invoke(definition: Readonly<CommandDefinition>, raw: unknown, options: Readonly<McpServerOptions>): Promise<CallToolResult> {
  if (options.unavailableReason !== undefined) return unavailableResult(options.unavailableReason)
  const collected = collectIo()
  // interface-env: TERMINAL_WIDTH COLUMNS
  const width = outputWidth(process.env, undefined)
  let exitCode: number
  try {
    resolveApiUrlOverride()
    const preparation = prepare(definition, raw)
    if (preparation.kind === 'rejected') return toRejectedResult(preparation.message)
    try {
      exitCode = await preparation.command.run(collected.io)
    }
    catch (error: unknown) {
      throw withUsage(error, usageOf(definition))
    }
  }
  catch (error: unknown) {
    try {
      exitCode = exitCodeOfFailure(error, collected.io, width)
    }
    catch (error_: unknown) {
      options.reportUnexpected?.(error_, { stdout: collected.stdout(), stderr: collected.stderr() })
      throw error_
    }
  }
  return toToolResult({ exitCode, stdout: collected.stdout(), stderr: collected.stderr() })
}

// コマンドは process.cwd()（起動のときに serve.ts が決めたセッションのディレクトリ）と .pecot/ の状態ファイルを読み書きするので、呼び出しは 1 件ずつ実行する。接続が複数あっても共有する
const sequence: { tail: Promise<boolean> } = { tail: Promise.resolve(true) }

async function inSequence(signal: Readonly<AbortSignal>, task: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const previous = sequence.tail
  const turn = Promise.withResolvers<boolean>()
  sequence.tail = turn.promise
  await previous
  try {
    // 待っている間に中断（notifications/cancelled）か接続の切断があれば、本体を呼ばない。応答は届かないので中身は何でもよい
    return signal.aborted ? toRejectedResult('cancelled') : await task()
  }
  finally {
    turn.resolve(true)
  }
}

/**
MCP サーバを作り、commands のそれぞれをツールとして登録する。名前は toolName、説明は description、並びは commands の順
*/
export function createMcpServer(commands: readonly CommandDefinition[] = COMMANDS, options: Readonly<McpServerOptions> = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: readVersion() })
  for (const definition of commands) {
    server.registerTool(
      definition.toolName,
      { description: definition.description, inputSchema: passthroughSchema(definition) },
      async (arguments_, serverContext) => await inSequence(serverContext.mcpReq.signal, async () => await invoke(definition, arguments_, options)),
    )
  }
  return server
}
