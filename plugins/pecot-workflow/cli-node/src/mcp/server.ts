// COMMANDS の 34 個を MCP のツールとして登録するサーバ。CLI と同じ定義の run を呼び、結果の形だけが違う。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod と SDK の型は readonly にできない */
import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { InvalidValueError } from '../domain/errors.js'
import { parseOwnerRepository } from '../domain/repository-resolver.js'
import { resolveApiUrlOverride } from '../infra/github/client.js'
import { usageOf, withUsage } from '../commands/command-binding.js'
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
  プログラムの誤り（報告できる失敗でも使い方の誤りでもない例外）を、切り分けのために伝える先。SDK は message だけの結果にする
  */
  readonly reportUnexpected?: (error: unknown) => void
}

type Preparation
  = | { readonly kind: 'prepared', readonly command: PreparedCommand }
    | { readonly kind: 'rejected', readonly message: string }

function rejected(message: string): Preparation {
  return { kind: 'rejected', message: `invalid input: ${message}` }
}

/**
SDK に渡す入力のスキーマ。tools/list の形は定義書と同じ z.toJSONSchema の形で、検証は素通しにする。
SDK に zod を渡すと、検証の後に未知のキーを捨てた値が届き、未知のキーを誤りにできない
*/
function passthroughSchema(definition: Readonly<CommandDefinition>): StandardSchemaWithJSON {
  const jsonSchema = (): Record<string, unknown> => z.toJSONSchema(definition.input, { io: 'input' })
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
  const input = raw ?? {}
  if (!isRecord(input)) return rejected('arguments must be an object')
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

async function invoke(definition: Readonly<CommandDefinition>, raw: unknown, options: Readonly<McpServerOptions>): Promise<CallToolResult> {
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
      options.reportUnexpected?.(error_)
      throw error_
    }
  }
  return toToolResult({ exitCode, stdout: collected.stdout(), stderr: collected.stderr() })
}

// コマンドは process.cwd() と .pecot/ の状態ファイルを読み書きするので、呼び出しは 1 件ずつ実行する。接続が複数あっても共有する
const sequence: { tail: Promise<boolean> } = { tail: Promise.resolve(true) }

async function inSequence(task: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const previous = sequence.tail
  const turn = Promise.withResolvers<boolean>()
  sequence.tail = turn.promise
  await previous
  try {
    return await task()
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
      async arguments_ => await inSequence(async () => await invoke(definition, arguments_, options)),
    )
  }
  return server
}
