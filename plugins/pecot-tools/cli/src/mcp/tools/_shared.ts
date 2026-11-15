// 全ツール共通の入出力スキーマと、許可リストのエントリを 1 本の実行手順へ通す処理。
// 秘匿化と上限の掛け忘れを防ぐため、検証から切り詰めまでの手順はここに 1 本だけ置く。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- call.signal は mutable */

import { z } from 'zod'

import type { ToolAnnotations } from '@modelcontextprotocol/server'

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

const WARNINGS_SCHEMA = z.array(z.string()).optional().describe('Warnings raised during the run (omitted when there are none)')

/**
全ツール共通の outputSchema。最上位は awscli の JSON 出力か行の配列なので、開いた object にする。名前を持つのは共通の 4 項目だけ。
*/
export const TOOL_OUTPUT_SCHEMA = z.looseObject({
  kind: z.string().optional().describe('Failure kind (failure only): not-allowed / invalid-input = rejected before running, timeout, awscli-missing, and the awscli failure kinds'),
  detail: z.string().optional().describe('Full text of the failure and how to recover (failure only)'),
  log: z.string().optional().describe('Redacted awscli output, only the beginning when it exceeds the limit (failure only)'),
  warnings: WARNINGS_SCHEMA,
})

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
成功時の data。JSON 出力はそのまま、非 JSON 出力は行配列にする。
*/
function successData(entry: Readonly<AllowlistEntry>, stdout: string): Record<string, unknown> {
  const parsed = entry.jsonOutput ? parseJsonOutput(stdout) : undefined
  if (parsed === undefined) return { lines: toLines(stdout) }

  const nextToken = parsed['NextToken']
  return typeof nextToken === 'string' && entry.pagination === 'max-items' ? { ...parsed, nextToken } : parsed
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
    data: { ...successData(entry, limited.text), ...filePart },
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
許可リストのエントリ 1 件を MCP ツール定義にする。zod の検証は SDK が済ませるので、ハンドラで再 parse しない。
*/
export function allowlistedTool(
  spec: Readonly<AllowlistedToolSpec>,
  options: Readonly<ToolOptions> = {},
): ToolDefinition {
  const executeOptions: ExecuteOptions = {
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    ...(spec.reject !== undefined && { reject: spec.reject }),
    ...(spec.fileOf !== undefined && { fileOf: spec.fileOf }),
  }

  return {
    name: spec.entry.toolName,
    config: {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: annotationsOf(spec.entry),
    },
    handler: async (arguments_: Readonly<Record<string, unknown>>, call: ToolCallContext) =>
      toCallToolResult(await executeAllowlisted(spec.entry, arguments_, call, executeOptions)),
  }
}
