// TOOLS の全ツールを MCP のツールとして、テンプレートを resource として登録するサーバ。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod と SDK の型は readonly にできない */
import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { CancelledError, InvalidValueError } from '@pecot/workflow-core/domain/errors.js'
import { parseOwnerRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import { resolveApiUrlOverride } from '@pecot/workflow-core/infra/github/client.js'
import { cancelledBy } from '@pecot/workflow-core/infra/process-run.js'
import { AbortedError, createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { exitCodeOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import type { FailureKind } from '@pecot/workflow-core/commands-shared/failure-kind.js'
import { isRecord } from '../commands/input-schema.js'
import { TOOLS } from '../commands/registry.js'
import type { PreparedCommand, ToolDefinition } from '../commands/registry.js'
import { UsageError } from '@pecot/workflow-core/commands-shared/usage-error.js'
import { readVersion } from '../version.js'
import { toolAnnotationsOf } from './annotations.js'
import { collectIo, standardOutputSchema, toAbortedResult, toolOutputSchema, toRejectedResult, toToolResult } from './result.js'
import type { CollectedIo } from './result.js'
import { readTemplate, TEMPLATE_MIME_TYPE, TEMPLATE_RESOURCES, templateResourceName, templateUri } from './templates.js'

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
  /**
  要求の取り消しでコマンドを止めたとき、その理由を伝える先（仕様が理由の記録を求める）
  */
  readonly reportCancelled?: (reason: string) => void
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
function passthroughSchema(definition: Readonly<ToolDefinition>): StandardSchemaWithJSON {
  const jsonSchema = (): Record<string, unknown> => ({ ...z.toJSONSchema(z.strictObject(definition.input.shape), { io: 'input' }), additionalProperties: false })
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
入力を検証する。順は未知のキー → repo の形 → definition.parse。誤りならツールを呼ばない
*/
function prepare(definition: Readonly<ToolDefinition>, raw: unknown): Preparation {
  // arguments が配列や null なら SDK が先に -32602 で断るので、ここに来る非 object は省略（undefined）だけ
  const input = isRecord(raw) ? raw : {}
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(definition.input.shape, key))
  if (unknown.length > 0) {
    return rejected(`unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.map(key => `'${key}'`).join(', ')}`)
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
  return toToolResult({ exitCode: 1, stdout: collected.stdout(), kind: 'session-directory-unresolved', errors: collected.errors() })
}

function unexpectedMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function invoke(definition: Readonly<ToolDefinition>, raw: unknown, options: Readonly<McpServerOptions>, signal: Readonly<AbortSignal>): Promise<CallToolResult> {
  if (options.unavailableReason !== undefined) return unavailableResult(options.unavailableReason)
  const collected = collectIo(signal)
  let exitCode: number
  let message: string | undefined
  try {
    resolveApiUrlOverride()
    const preparation = prepare(definition, raw)
    if (preparation.kind === 'rejected') return toRejectedResult(preparation.message)
    exitCode = await preparation.command.run(collected.io)
  }
  catch (error: unknown) {
    if (error instanceof CancelledError) {
      options.reportCancelled?.(error.message)
      return toAbortedResult()
    }
    // 使い方の誤りと確認の中止は error の行を出さないので、例外の文を message にする
    if (error instanceof UsageError || error instanceof AbortedError) message = error.message
    try {
      exitCode = exitCodeOfFailure(error, collected.io)
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
function finish(definition: Readonly<ToolDefinition>, collected: CollectedIo, ended: Ended, options: Readonly<McpServerOptions>): CallToolResult {
  const stdout = collected.stdout()
  const stderr = collected.stderr()
  const outcome = {
    exitCode: ended.exitCode,
    stdout,
    kind: ended.kind ?? collected.kind(),
    message: ended.message,
    resultLine: collected.resultLine(),
    warnings: collected.warnings(),
    errors: collected.errors(),
    log: collected.log(),
  }
  const raw = collected.data()
  if (ended.exitCode === 0) {
    const parsed = definition.output.safeParse(raw)
    if (parsed.success) return toToolResult({ ...outcome, data: parsed.data })
    options.reportUnexpected?.(parsed.error, { stdout, stderr })
    // 書き込みが済んだ後の食い違いもありうるので、呼び直さないよう伝える。項目は失敗と同じく省略可の形で検証して残す
    const message = `the command finished, but its data does not match the output schema: ${issuesMessage(parsed.error)}; the operation may already be done, so do not call it again`
    return toToolResult({ ...outcome, exitCode: 1, errors: [], kind: 'other', message, data: partialData(definition, raw, stdout, stderr, options) })
  }
  return toToolResult({ ...outcome, data: partialData(definition, raw, stdout, stderr, options) })
}

// 失敗の結果は SDK とクライアントが検証しない。省略可の形に合わなければ、kind などを保ち、ツールの項目だけを捨てる
function partialData(definition: Readonly<ToolDefinition>, raw: Readonly<Record<string, unknown>>, stdout: string, stderr: string, options: Readonly<McpServerOptions>): Readonly<Record<string, unknown>> | undefined {
  const parsed = definition.output.partial().safeParse(raw)
  if (parsed.success) return parsed.data
  options.reportUnexpected?.(parsed.error, { stdout, stderr })
  return undefined
}

// コマンドは process.cwd()（起動のときに serve.ts が決めたセッションのディレクトリ）と .pecot/ の状態ファイルを読み書きするので、呼び出しは 1 件ずつ実行する。接続が複数あっても共有する
const sequence: { tail: Promise<boolean> } = { tail: Promise.resolve(true) }

async function inSequence(signal: Readonly<AbortSignal>, options: Readonly<McpServerOptions>, task: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const previous = sequence.tail
  const turn = Promise.withResolvers<boolean>()
  sequence.tail = turn.promise
  await previous
  try {
    // 待っている間に中断（notifications/cancelled）か接続の切断があれば、本体を呼ばない。応答は届かない
    if (!signal.aborted) return await task()
    options.reportCancelled?.(cancelledBy(signal).message)
    return toAbortedResult()
  }
  finally {
    turn.resolve(true)
  }
}

export const MCP_INSTRUCTIONS = [
  'Templates for Issues, comments and PRs are the pecot-template:// resources.',
  'Write a copy to .pecot/tmp/output/ under the project root and fill it in; its frontmatter keys are the argument names of the official GitHub MCP tool that writes it.',
  'Pass Issues and comments through issue_check, issue_dependency_check and issue_comment_check, then write them with the official tools (issue_write, issue_dependency_write, add_issue_comment, update_issue_comment).',
  'For a PR, pass the path as file to pr_create.',
  'In a batch of Issues, blocked_by and {{issue:key}} point at another Issue by its key, the file name without the extension.',
].join(' ')

// テンプレートはリポに依存しないので、unavailableReason のときも読める
function registerTemplates(server: McpServer): void {
  for (const template of TEMPLATE_RESOURCES) {
    const uri = templateUri(template)
    server.registerResource(
      templateResourceName(template),
      uri,
      { title: template.title, description: template.description, mimeType: TEMPLATE_MIME_TYPE },
      () => ({ contents: [{ uri, mimeType: TEMPLATE_MIME_TYPE, text: readTemplate(template) }] }),
    )
  }
}

/**
MCP サーバを作り、tools のそれぞれをツールとして、テンプレートを resource として登録する。並びは tools の順
*/
export function createMcpServer(tools: readonly ToolDefinition[] = TOOLS, options: Readonly<McpServerOptions> = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: readVersion() }, { instructions: MCP_INSTRUCTIONS })
  registerTemplates(server)
  for (const definition of tools) {
    server.registerTool(
      definition.name,
      { title: definition.title, description: definition.description, inputSchema: passthroughSchema(definition), outputSchema: standardOutputSchema(toolOutputSchema(definition.output)), annotations: toolAnnotationsOf(definition) },
      async (arguments_, serverContext) => await inSequence(serverContext.mcpReq.signal, options, async () => await invoke(definition, arguments_, options, serverContext.mcpReq.signal)),
    )
  }
  return server
}
