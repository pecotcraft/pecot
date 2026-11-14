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

// 終了コードの規約は、許可リストの呼び出しと SSO の呼び出しで同じ値を使う。
// 応答を読む側が 1 つの表で解釈できるようにするため。SSO 側（tools/sso.ts）から参照するので export する。
/**
awscli を起動せずに拒否したときの終了コード（UsageError 相当）。
*/
export const PRE_EXECUTION_EXIT_CODE = 2
/**
時間切れの終了コード（coreutils timeout の慣習）。
*/
export const TIMEOUT_EXIT_CODE = 124
/**
コマンドが見つからないときの終了コード（シェルの慣習）。
*/
export const COMMAND_NOT_FOUND_EXIT_CODE = 127
/**
終了コードを持たない失敗（シグナル終了等）の既定値。
*/
export const UNKNOWN_FAILURE_EXIT_CODE = 1

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
ExecutionResult と同形の outputSchema。全ツールで共有する。
*/
export const TOOL_OUTPUT_SCHEMA = z.object({
  ok: z.boolean().describe('Whether the awscli run succeeded'),
  exitCode: z.number().describe('Exit code (0 = success, 2 = rejected before running, 124 = timeout, 127 = not installed)'),
  kind: z.string().optional().describe('Failure kind (omitted on success)'),
  data: z.record(z.string(), z.unknown()).describe('awscli JSON output, or an array of lines'),
  artifacts: z.array(z.string()).describe('Absolute paths of the local files written'),
  message: z.string().describe('One-line summary for the calling agent'),
  stderr: z.string().optional().describe('Redacted awscli stderr (only on failure)'),
})

/**
失敗種別ごとの再試行方法。message の後半に載せる。
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
  'other': 'awscli failed. Check stderr',
}

/**
出力が上限を超えたときの案内。
*/
const TRUNCATION_MESSAGE
  = `Output exceeded the limit of ${String(OUTPUT_LIMIT_BYTES)} bytes, so only the beginning is returned. `
    + 'Reduce max_items or split the request with starting_token.'

/**
stderr が上限で切り詰められたときに message へ足す注記。
*/
const STDERR_TRUNCATION_NOTE = '(stderr exceeded the limit, so only the beginning is included)'

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
  成功時に artifacts へ載せる書き出し先。切り詰めの有無に依らず適用する。
  */
  readonly artifactsOf?: (arguments_: Readonly<Record<string, unknown>>) => readonly string[]
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
  readonly artifactsOf?: ExecuteOptions['artifactsOf']
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

/**
失敗種別と awscli の終了コードから応答の exitCode を決める。exitCode を持たない失敗は 1 以上へ畳む。
*/
export function resolveExitCode(kind: FailureKind, exitCode?: number | null): number {
  if (kind === 'timeout') return TIMEOUT_EXIT_CODE
  if (kind === 'awscli-missing') return COMMAND_NOT_FOUND_EXIT_CODE
  return exitCode ?? UNKNOWN_FAILURE_EXIT_CODE
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
許可リストのエントリ 1 件を実行し、ExecutionResult を返す。検証で弾けば awscli を起動せず（exitCode 2）、出力は秘匿化と上限を通す。
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
      exitCode: PRE_EXECUTION_EXIT_CODE,
      kind: invalid.kind,
      data: {},
      artifacts: [],
      message: invalid.message,
    }
  }

  const rejected = options.reject?.(arguments_)
  if (rejected !== undefined) {
    return {
      ok: false,
      exitCode: PRE_EXECUTION_EXIT_CODE,
      kind: rejected.kind,
      data: {},
      artifacts: [],
      message: rejected.message,
    }
  }

  const probe = await ensureAwscli()
  if (!probe.ok) {
    return {
      ok: false,
      exitCode: COMMAND_NOT_FOUND_EXIT_CODE,
      kind: probe.kind,
      data: {},
      artifacts: [],
      message: probe.message,
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
    // 巨大な stderr は先頭だけを載せる。通知せず欠けると読み手が全文だと誤認するため、
    // 切り詰めたことを message に残す。
    const limitedStderr = limitOutput(redactSecrets(result.stderr))
    return {
      ok: false,
      exitCode: resolveExitCode(kind, result.exitCode),
      kind,
      data: {},
      artifacts: [],
      message: failureMessage(entry.toolName, kind)
        + (limitedStderr.truncated ? STDERR_TRUNCATION_NOTE : ''),
      stderr: limitedStderr.text,
    }
  }

  // artifacts は切り詰めの有無に依らず載せる。書き出しは awscli 側で完了しており、
  // 応答の切り詰めは「出力が長い」ことしか意味しないため。
  const artifacts = options.artifactsOf?.(arguments_) ?? []
  const limited = limitOutput(redactSecrets(result.stdout))
  if (limited.truncated) {
    return {
      ok: true,
      exitCode: 0,
      data: { output: limited.text, truncated: true },
      artifacts,
      message: TRUNCATION_MESSAGE,
    }
  }

  return {
    ok: true,
    exitCode: 0,
    data: successData(entry, limited.text),
    artifacts,
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
    ...(spec.artifactsOf !== undefined && { artifactsOf: spec.artifactsOf }),
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
