// COMMANDS の全コマンドを MCP のツールとして登録するサーバ。CLI と同じ定義の run を呼び、結果の形だけが違う。
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
import type { FailureKind } from '../commands/failure-kind.js'
import { isRecord } from '../commands/input-schema.js'
import { COMMANDS } from '../commands/registry.js'
import { findRenamedInput, renamedInputNote } from '../commands/renamed-commands.js'
import type { CommandDefinition, PreparedCommand } from '../commands/registry.js'
import { outputWidth } from '../commands/rich-panel.js'
import { UsageError } from '../commands/usage-error.js'
import { readVersion } from '../version.js'
import { collectIo, standardOutputSchema, toAbortedResult, toolOutputSchema, toRejectedResult, toToolResult } from './result.js'
import type { CollectedIo } from './result.js'

export const MCP_SERVER_NAME = 'pecot-workflow'

export interface McpServerOptions {
  /**
  対象のリポを決められなかった理由。あるとき、どのツールの呼び出しもコマンドを呼ばず、この理由を失敗（終了コード 1、kind は session-directory-unresolved）で返す。tools/list は変わらない
  */
  readonly unavailableReason?: string | undefined
  /**
  プログラムの誤り（報告できる失敗でも使い方の誤りでもない例外）と、それまでに集めた出力を、切り分けのために伝える先。結果は kind が other の失敗にする
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
  if (unknown.length > 0) {
    const notes = unknown.map((key) => {
      const renamed = findRenamedInput(definition.path, key)
      return renamed === undefined ? '' : renamedInputNote(key, renamed)
    })
    return rejected(`unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map(key => `'${key}'`).join(', ')}${notes.join('')}`)
  }
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
  return toToolResult({ exitCode: 1, stdout: collected.stdout(), stderr: collected.stderr(), kind: 'session-directory-unresolved' })
}

function unexpectedMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function invoke(definition: Readonly<CommandDefinition>, raw: unknown, options: Readonly<McpServerOptions>, signal: Readonly<AbortSignal>): Promise<CallToolResult> {
  if (options.unavailableReason !== undefined) return unavailableResult(options.unavailableReason)
  const collected = collectIo()
  // interface-env: TERMINAL_WIDTH COLUMNS
  const width = outputWidth(process.env, undefined)
  let exitCode: number
  let message: string | undefined
  try {
    resolveApiUrlOverride()
    const preparation = prepare(definition, raw)
    if (preparation.kind === 'rejected') return toRejectedResult(preparation.message)
    try {
      exitCode = await preparation.command.run({ ...collected.io, signal })
    }
    catch (error: unknown) {
      throw withUsage(error, usageOf(definition))
    }
  }
  catch (error: unknown) {
    // 使い方の誤りは枠で出すので、error の行の代わりに例外の文の 1 行目を message にする
    if (error instanceof UsageError) message = error.message.split('\n', 1)[0]
    try {
      exitCode = exitCodeOfFailure(error, collected.io, width)
    }
    catch (error_: unknown) {
      options.reportUnexpected?.(error_, { stdout: collected.stdout(), stderr: collected.stderr() })
      return finish(definition, collected, { exitCode: 1, message: unexpectedMessage(error_), kind: 'other' }, options)
    }
  }
  return finish(definition, collected, { exitCode, message }, options)
}

interface Ended {
  readonly exitCode: number
  readonly message: string | undefined
  /**
  無ければコマンドが io で渡した kind
  */
  readonly kind?: FailureKind
}

// SDK の検証に任せると、合わない結果は structuredContent の無い文字列だけになるので、ここで検証する
function finish(definition: Readonly<CommandDefinition>, collected: CollectedIo, ended: Ended, options: Readonly<McpServerOptions>): CallToolResult {
  const stdout = collected.stdout()
  const stderr = collected.stderr()
  const outcome = {
    exitCode: ended.exitCode,
    stdout,
    stderr,
    kind: ended.kind ?? collected.kind(),
    message: ended.message,
    resultLine: collected.resultLine(),
    warnings: collected.warnings(),
  }
  const raw = collected.data()
  if (ended.exitCode === 0) {
    const parsed = definition.output.safeParse(raw)
    if (parsed.success) return toToolResult({ ...outcome, data: parsed.data })
    options.reportUnexpected?.(parsed.error, { stdout, stderr })
    // 書き込みが済んだ後の食い違いもありうるので、呼び直さないよう伝える。項目は失敗と同じく省略可の形で検証して残す
    const message = `the command finished, but its data does not match the output schema: ${issuesMessage(parsed.error)}; the operation may already be done, so do not call it again`
    return toToolResult({ ...outcome, exitCode: 1, stderr: '', kind: 'other', message, data: partialData(definition, raw, stdout, stderr, options) })
  }
  return toToolResult({ ...outcome, data: partialData(definition, raw, stdout, stderr, options) })
}

// 失敗の結果は SDK とクライアントが検証しない。省略可の形に合わなければ、kind などを保ち、ツールの項目だけを捨てる
function partialData(definition: Readonly<CommandDefinition>, raw: Readonly<Record<string, unknown>>, stdout: string, stderr: string, options: Readonly<McpServerOptions>): Readonly<Record<string, unknown>> | undefined {
  const parsed = definition.output.partial().safeParse(raw)
  if (parsed.success) return parsed.data
  options.reportUnexpected?.(parsed.error, { stdout, stderr })
  return undefined
}

// コマンドは process.cwd()（起動のときに serve.ts が決めたセッションのディレクトリ）と .pecot/ の状態ファイルを読み書きするので、呼び出しは 1 件ずつ実行する。接続が複数あっても共有する
const sequence: { tail: Promise<boolean> } = { tail: Promise.resolve(true) }

async function inSequence(signal: Readonly<AbortSignal>, task: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const previous = sequence.tail
  const turn = Promise.withResolvers<boolean>()
  sequence.tail = turn.promise
  await previous
  try {
    // 待っている間に中断（notifications/cancelled）か接続の切断があれば、本体を呼ばない。応答は届かない
    return signal.aborted ? toAbortedResult() : await task()
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
      { description: definition.description, inputSchema: passthroughSchema(definition), outputSchema: standardOutputSchema(toolOutputSchema(definition.output)) },
      async (arguments_, serverContext) => await inSequence(serverContext.mcpReq.signal, async () => await invoke(definition, arguments_, options, serverContext.mcpReq.signal)),
    )
  }
  return server
}
