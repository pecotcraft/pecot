// 全ツール共通の入出力スキーマと、許可リストのエントリを 1 本の実行手順へ通す処理。
// 秘匿化と上限の掛け忘れを防ぐため、検証から切り詰めまでの手順はここに 1 本だけ置く。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- call.signal は mutable */

import { z } from 'zod'

import type { StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server'

import {
  PROFILE_PATTERN,
  REGION_PATTERN,
  type AllowlistEntry,
  type FailureKind,
} from '../../domain/allowlist.js'
import { buildArguments, validateInput, type CommonOptions } from '../../domain/arguments.js'
import { classifyFailure } from '../../domain/failure.js'
import { redactSecrets } from '../../domain/redact.js'
import { ensureAwscli, OUTPUT_LIMIT_BYTES, runAwscli } from '../../infra/awscli.js'
import type { LoginRegistry } from '../../infra/sso/login-registry.js'
import { standardOutputSchema, toolOutputSchema, type SuccessRequired } from '../output-schema.js'
import { limitOutput, toCallToolResult, type ExecutionResult } from '../result.js'
import type { ToolCallContext, ToolDefinition } from '../server.js'

/**
1 回の awscli 呼び出しに与える既定の制限時間。
*/
export const TOOL_TIMEOUT_MS = 120_000

/**
`profile` だけの入力。SSO の 2 件は region を取らないので、共通入力から切り出す。
*/
export const PROFILE_INPUT_SHAPE = {
  profile: z.string().regex(PROFILE_PATTERN).optional()
    .describe('AWS profile name. If omitted, the awscli default resolution applies'),
}

/**
全ツール共通の任意入力。書式は allowlist.ts の PROFILE_PATTERN / REGION_PATTERN を載せ、tools/list で契約を見せる。
*/
export const COMMON_INPUT_SHAPE = {
  ...PROFILE_INPUT_SHAPE,
  region: z.string().regex(REGION_PATTERN).optional()
    .describe('AWS region (e.g. ap-northeast-1). If omitted, the awscli default resolution applies'),
}

/**
クライアント側ページング（`--max-items` / `--starting-token`）を持つツールの入力。
*/
export const MAX_ITEMS_PAGINATION_SHAPE = {
  max_items: z.number().int().min(1).optional().describe('Maximum number of items in one response'),
  starting_token: z.string().optional().describe('nextToken from the previous response. Fetches the next page'),
}

/**
API 固有ページング（`logs get-log-events`）を持つツールの入力。
*/
export const LIMIT_NEXT_TOKEN_PAGINATION_SHAPE = {
  limit: z.number().int().min(1).max(10_000).optional().describe('Maximum number of events to return (1-10000)'),
  next_token: z.string().optional().describe('nextForwardToken / nextBackwardToken from the previous response'),
  start_from_head: z.boolean().default(false).describe('If true, returns the oldest events first'),
}

/**
全ツールの outputSchema に並べる共通の 4 項目。
*/
export const COMMON_OUTPUT_SHAPE = {
  kind: z.string().optional().describe('Failure kind (failure only): not-allowed / invalid-input = rejected before running, timeout, awscli-missing, and the awscli failure kinds'),
  detail: z.string().optional().describe('Full text of the failure and how to recover (failure only)'),
  log: z.string().optional().describe('Redacted awscli output, only the beginning when it exceeds the limit (failure only)'),
  warnings: z.array(z.string()).optional()
    .describe('Warnings raised during the run, such as top-level keys of the awscli JSON output that the tool does not declare and dropped (omitted when there are none)'),
}

/**
awscli の出力から pecot-tools が作る項目。JSON のツールも、出力を JSON の object として読めないと lines を返す。
*/
const AWSCLI_OUTPUT_SHAPE = {
  lines: z.array(z.string()).optional()
    .describe('Output split into lines (success only). Returned when the output is not a JSON object: commands without JSON output, empty output, or warnings only'),
  output: z.string().optional()
    .describe('Beginning of the redacted output when it exceeds the limit (success only, together with truncated)'),
  truncated: z.boolean().optional()
    .describe('true when the output exceeded the limit and output holds only its beginning (success only)'),
}

const NEXT_TOKEN_OUTPUT_SHAPE = {
  NextToken: z.string().optional()
    .describe('Pagination token that awscli adds when max_items cut the result (success only). Same value as nextToken'),
  nextToken: z.string().optional()
    .describe('Pass as starting_token to fetch the next page (success only). Present only when max_items cut the result'),
}

const FILE_OUTPUT_SHAPE = {
  file: z.string().optional().describe('Local absolute path the object was written to (success only)'),
}

/**
AWS の応答の最上位のキーごとの型。入れ子の中は AWS が決める形なので開いたまま宣言する。
*/
export type ResponseShape = Readonly<Record<string, z.ZodType>>

/**
AWS の日時。awscli の出力は ISO 8601 の文字列だが、`cli_timestamp_format = none` の設定があると epoch 秒の数になる。
*/
export function awsTimestamp(description: string): z.ZodType {
  return z.union([z.string(), z.number()]).describe(description)
}

/**
AWS が中身を決める object 1 つ。
*/
export function awsObject(description: string): z.ZodType {
  return z.looseObject({}).describe(description)
}

/**
AWS が中身を決める object の配列。
*/
export function awsObjects(description: string): z.ZodType {
  return z.array(z.looseObject({})).describe(description)
}

/**
落としたキーを知らせる warnings の 1 行。
*/
function droppedKeysWarning(keys: readonly string[]): string {
  return `Dropped undeclared top-level keys: ${keys.join(', ')}`
}

/**
失敗種別ごとの再試行方法。detail の後半に載せる。
*/
const FAILURE_HINTS: Record<FailureKind, string> = {
  'not-allowed': 'Operation not allowed. Use only the exposed tools',
  'invalid-input': 'Fix the input and run again',
  'awscli-missing': 'Install awscli v2 (2.22 or later) and add it to PATH',
  'auth-missing': 'Not authenticated. Run aws_sso_login or specify a profile',
  'auth-expired': 'Authentication has expired. Run aws_sso_login to sign in again',
  'permission-denied': 'Permission denied. Check the profile / role',
  'resource-not-found': 'Resource not found. Check the name and region',
  'timeout': 'Timed out. Narrow the range and run again',
  'other': 'awscli failed. Check log',
}

/**
出力が上限を超えたときの案内。
*/
const TRUNCATION_MESSAGE
  = `Output exceeded the limit of ${String(OUTPUT_LIMIT_BYTES)} bytes, so only the beginning is returned. `
    + 'Reduce max_items or split the request with starting_token.'

/**
log が上限で切り詰められたときに detail へ足す注記。
*/
const LOG_TRUNCATION_NOTE = '(log exceeded the limit, so only the beginning is included)'

/**
実行前に拒否したときの理由。awscli は起動しない。
*/
export interface PreExecutionRejection {
  readonly kind: 'not-allowed' | 'invalid-input'
  readonly message: string
}

export interface ExecuteOptions {
  /**
  既定は TOOL_TIMEOUT_MS。
  */
  readonly timeoutMs?: number
  /**
  静的宣言で表せない拒否条件。awscli 未導入で拒否が awscli-missing に化けないよう、存在確認より前に評価する。
  */
  readonly reject?: (arguments_: Readonly<Record<string, unknown>>) => PreExecutionRejection | undefined
  /**
  成功時に file の項目へ載せる書き出し先。切り詰めの有無に依らず適用する。
  */
  readonly fileOf?: (arguments_: Readonly<Record<string, unknown>>) => string | undefined
  /**
  JSON 出力のうち残す最上位のキー。無ければ絞らない。
  */
  readonly responseKeys?: ReadonlySet<string>
}

/**
ツール定義を組み立てるときの調整点。テストが timeoutMs を短縮する。
*/
export interface ToolOptions {
  readonly timeoutMs?: number
  /**
  SSO の 2 件が使うログインレジストリ。既定はプロセス共有のインスタンス。
  */
  readonly loginRegistry?: LoginRegistry
}

/**
allowlistedTool へ渡すツール 1 件の宣言。
*/
export interface AllowlistedToolSpec {
  readonly entry: AllowlistEntry
  readonly title: string
  readonly description: string
  readonly inputSchema: z.ZodObject
  readonly reject?: ExecuteOptions['reject']
  readonly fileOf?: ExecuteOptions['fileOf']
  /**
  AWS の応答の最上位のキー（API リファレンスの Response Syntax）。awscli の JSON を出すツールだけが持つ。
  awscli のページングが足す NextToken は allowlistedTool が足すので、ここには書かない。
  */
  readonly responseShape?: ResponseShape
  /**
  AWS の応答で必ず返る最上位のキー。根拠は awscli 同梱の botocore のモデルの出力の shape の required。
  */
  readonly responseRequired?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value instanceof Object && !Array.isArray(value)
}

function commonOptions(arguments_: Readonly<Record<string, unknown>>): CommonOptions {
  const profile = arguments_['profile']
  const region = arguments_['region']
  return {
    ...((typeof profile === 'string') && { profile }),
    ...((typeof region === 'string') && { region }),
  }
}

function parseJsonOutput(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  }
  catch {
    // JSON として読めない出力（空・警告のみ等）は行配列へ落とす。
    return undefined
  }
}

function toLines(text: string): string[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body === '' ? [] : body.split('\n')
}

function failureMessage(toolName: string, kind: FailureKind): string {
  // eslint-disable-next-line security/detect-object-injection -- kind は FailureKind の列挙値
  return `${toolName} failed (${kind}). ${FAILURE_HINTS[kind]}`
}

/**
宣言したキーだけを残す。outputSchema は閉じているので、宣言に無いキーを返すと SDK が呼び出しごと止めるため。
*/
function keepDeclaredKeys(
  parsed: Readonly<Record<string, unknown>>,
  responseKeys: ReadonlySet<string> | undefined,
): Record<string, unknown> {
  if (responseKeys === undefined) return { ...parsed }

  const dropped = Object.keys(parsed).filter(key => !responseKeys.has(key))
  const kept = Object.fromEntries(Object.entries(parsed).filter(([key]) => responseKeys.has(key)))
  return dropped.length === 0 ? kept : { ...kept, warnings: [droppedKeysWarning(dropped)] }
}

/**
成功時の data。JSON 出力は宣言したキーを、非 JSON 出力は行配列にする。
*/
function successData(
  entry: Readonly<AllowlistEntry>,
  stdout: string,
  responseKeys: ReadonlySet<string> | undefined,
): Record<string, unknown> {
  const parsed = entry.jsonOutput ? parseJsonOutput(stdout) : undefined
  if (parsed === undefined) return { lines: toLines(stdout) }

  const data = keepDeclaredKeys(parsed, responseKeys)
  const nextToken = parsed['NextToken']
  return typeof nextToken === 'string' && entry.pagination === 'max-items' ? { ...data, nextToken } : data
}

/**
許可リストのエントリ 1 件を実行し、ExecutionResult を返す。検証で弾けば awscli を起動せず、出力は秘匿化と上限を通す。
*/
export async function executeAllowlisted(
  entry: Readonly<AllowlistEntry>,
  arguments_: Readonly<Record<string, unknown>>,
  call: ToolCallContext,
  options: Readonly<ExecuteOptions> = {},
): Promise<ExecutionResult> {
  const invalid = validateInput(entry, arguments_)
  if (invalid !== undefined) {
    return {
      ok: false,
      kind: invalid.kind,
      detail: invalid.message,
      data: {},
    }
  }

  const rejected = options.reject?.(arguments_)
  if (rejected !== undefined) {
    return {
      ok: false,
      kind: rejected.kind,
      detail: rejected.message,
      data: {},
    }
  }

  const probe = await ensureAwscli()
  if (!probe.ok) {
    return {
      ok: false,
      kind: probe.kind,
      detail: probe.message,
      data: {},
    }
  }

  const result = await runAwscli(buildArguments(entry, arguments_, commonOptions(arguments_)), {
    timeoutMs: options.timeoutMs ?? TOOL_TIMEOUT_MS,
    signal: call.signal,
  })

  if (result.timedOut || result.exitCode !== 0) {
    const kind = classifyFailure({
      exitCode: result.exitCode,
      stderr: result.stderr,
      timedOut: result.timedOut,
      ...(result.spawnErrorCode !== undefined && { spawnErrorCode: result.spawnErrorCode }),
    })
    // 巨大な出力は先頭だけを log に載せる。通知せず欠けると読み手が全文だと誤認するため、
    // 切り詰めたことを detail に残す。
    const limitedStderr = limitOutput(redactSecrets(result.stderr))
    return {
      ok: false,
      kind,
      detail: failureMessage(entry.toolName, kind)
        + (limitedStderr.truncated ? LOG_TRUNCATION_NOTE : ''),
      data: limitedStderr.text === '' ? {} : { log: limitedStderr.text },
    }
  }

  // 書き出し先は切り詰めの有無に依らず載せる。書き出しは awscli 側で完了しており、
  // 応答の切り詰めは「出力が長い」ことしか意味しないため。
  const file = options.fileOf?.(arguments_)
  const filePart = file === undefined ? {} : { file }
  const limited = limitOutput(redactSecrets(result.stdout))
  if (limited.truncated) {
    return {
      ok: true,
      data: { output: limited.text, truncated: true, ...filePart },
      message: TRUNCATION_MESSAGE,
    }
  }

  return {
    ok: true,
    data: { ...successData(entry, limited.text, options.responseKeys), ...filePart },
    message: `${entry.toolName} succeeded`,
  }
}

/**
annotations を許可リストの kind から導く。destructiveHint は fetch だけ true（`overwrite: true` で既存ファイルを上書きするため）。
*/
function annotationsOf(entry: Readonly<AllowlistEntry>): ToolAnnotations {
  return {
    readOnlyHint: entry.kind === 'read',
    destructiveHint: entry.kind === 'fetch',
    openWorldHint: true,
  }
}

/**
AWS の応答のキーのうち、残す最上位のキー。max-items のツールは awscli が足す NextToken も残す。
*/
function responseShapeOf(spec: Readonly<AllowlistedToolSpec>): Record<string, z.ZodType> {
  if (spec.entry.jsonOutput !== (spec.responseShape !== undefined)) {
    throw new TypeError(`${spec.entry.toolName}: responseShape is required exactly when the command has JSON output`)
  }
  const undeclared = (spec.responseRequired ?? []).filter(key => !Object.hasOwn(spec.responseShape ?? {}, key))
  if (undeclared.length > 0) {
    throw new TypeError(`${spec.entry.toolName}: responseRequired has keys not in responseShape: ${undeclared.join(', ')}`)
  }
  const optional = Object.fromEntries(Object.entries(spec.responseShape ?? {}).map(([key, type]) => [key, type.optional()]))
  return spec.entry.pagination === 'max-items' ? { ...optional, NextToken: NEXT_TOKEN_OUTPUT_SHAPE.NextToken } : optional
}

/**
成功の形ごとの必須項目。JSON のツールは、AWS の応答で必ず返るキーを言えるときだけ枝を置く（言えなければ `{}` の成功もありうる）。
*/
function successRequiredOf(spec: Readonly<AllowlistedToolSpec>): SuccessRequired {
  const awscliOutput = [['lines'], ['output', 'truncated']]
  if (!spec.entry.jsonOutput) return awscliOutput
  const required = spec.responseRequired ?? []
  return required.length > 0 ? [required, ...awscliOutput] : []
}

/**
ツール 1 件の outputSchema。AWS の応答のキー・pecot-tools が足す項目・共通の 4 項目を、閉じた object に並べる。
*/
function outputSchemaOf(spec: Readonly<AllowlistedToolSpec>, responseShape: Readonly<Record<string, z.ZodType>>): StandardSchemaWithJSON {
  const output = z.strictObject({
    ...responseShape,
    ...AWSCLI_OUTPUT_SHAPE,
    ...(spec.entry.pagination === 'max-items' && { nextToken: NEXT_TOKEN_OUTPUT_SHAPE.nextToken }),
    ...(spec.fileOf !== undefined && FILE_OUTPUT_SHAPE),
    ...COMMON_OUTPUT_SHAPE,
  })
  return standardOutputSchema(toolOutputSchema(output, successRequiredOf(spec)))
}

/**
許可リストのエントリ 1 件を MCP ツール定義にする。zod の検証は SDK が済ませるので、ハンドラで再 parse しない。
*/
export function allowlistedTool(
  spec: Readonly<AllowlistedToolSpec>,
  options: Readonly<ToolOptions> = {},
): ToolDefinition {
  const responseShape = responseShapeOf(spec)
  const executeOptions: ExecuteOptions = {
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    ...(spec.reject !== undefined && { reject: spec.reject }),
    ...(spec.fileOf !== undefined && { fileOf: spec.fileOf }),
    ...(spec.entry.jsonOutput && { responseKeys: new Set(Object.keys(responseShape)) }),
  }

  return {
    name: spec.entry.toolName,
    config: {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: outputSchemaOf(spec, responseShape),
      annotations: annotationsOf(spec.entry),
    },
    handler: async (arguments_: Readonly<Record<string, unknown>>, call: ToolCallContext) =>
      toCallToolResult(await executeAllowlisted(spec.entry, arguments_, call, executeOptions)),
  }
}
