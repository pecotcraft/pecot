// 全ツール共通の入出力スキーマと、許可リストのエントリを 1 本の実行手順へ通す処理。
//
// 系統別のツール定義（`mcp/tools/{sts,lambda,logs,sqs,athena,s3}.ts`）が宣言するのは、使うエントリと入力スキーマだけ。
// 検証 → 実行前拒否 → 引数組み立て → awscli 起動 → 失敗種別判定 → 秘匿化 → 切り詰め、という手順はここに 1 本だけ置く。
// 手順をツール側へ複製すると、秘匿化や上限の適用を忘れるおそれがある。

/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- call.signal は mutable なメンバを持つ。
   readonly 化すると、SDK 側の型と適合しなくなる。 */

import { z } from 'zod'

import type { ToolAnnotations } from '@modelcontextprotocol/server'

import {
  PROFILE_PATTERN,
  REGION_PATTERN,
  type AllowlistEntry,
  type FailureCategory,
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
`profile` だけの入力。

SSO の 2 件は region を取らない（contracts/mcp-tools.md §SSO 認証）。
そのため共通入力から profile だけを切り出し、両方が同じ書式・同じ説明文を公開できるようにする。
*/
export const PROFILE_INPUT_SHAPE = {
  profile: z.string().regex(PROFILE_PATTERN).optional()
    .describe('AWS profile name. If omitted, the awscli default resolution applies'),
}

/**
全ツール共通の任意入力。

書式の定義は domain/allowlist.ts の PROFILE_PATTERN / REGION_PATTERN にある。
ここはその定数をそのまま inputSchema へ載せる（契約書の共通規約を tools/list で見せるため）。
値を書き写さないので、定義は 1 箇所のまま。書式違反はハンドラ到達前に入力検証エラーとなる。Does not run awscli。
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
  category: z.string().optional().describe('Failure category (omitted on success)'),
  data: z.record(z.string(), z.unknown()).describe('awscli JSON output, or an array of lines'),
  artifacts: z.array(z.string()).describe('Absolute paths of the local files written'),
  message: z.string().describe('One-line summary for the calling agent'),
  stderr: z.string().optional().describe('Redacted awscli stderr (only on failure)'),
})

/**
失敗種別ごとの再試行方法。message の後半に載せる。
*/
const FAILURE_HINTS: Record<FailureCategory, string> = {
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
実行前に拒否したときの理由。Does not run awscli。
*/
export interface PreExecutionRejection {
  readonly category: 'not-allowed' | 'invalid-input'
  readonly message: string
}

export interface ExecuteOptions {
  /**
  既定は TOOL_TIMEOUT_MS。
  */
  readonly timeoutMs?: number
  /**
  許可リストの静的宣言だけでは表せない拒否条件（Athena の変更系クエリ、既存ファイルの上書き）。

  validateInput の直後・awscli の存在確認より前に評価する。存在確認を先にすると、
  awscli 未導入の環境で「拒否されるはずの呼び出し」が awscli-missing に化ける。
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
失敗種別と awscli の終了コードから応答の exitCode を決める。

exitCode を持たない失敗（シグナル終了・awscli を起動していない SSO の状態遷移）は
省略するか null で渡し、1 以上へ畳む。ok: false と exitCode 0 が同居しないようにする。
*/
export function resolveExitCode(category: FailureCategory, exitCode?: number | null): number {
  if (category === 'timeout') return TIMEOUT_EXIT_CODE
  if (category === 'awscli-missing') return COMMAND_NOT_FOUND_EXIT_CODE
  return exitCode ?? UNKNOWN_FAILURE_EXIT_CODE
}

function failureMessage(toolName: string, category: FailureCategory): string {
  // eslint-disable-next-line security/detect-object-injection -- category は FailureCategory の列挙値
  return `${toolName} failed (${category}). ${FAILURE_HINTS[category]}`
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
許可リストのエントリ 1 件を実行し、ExecutionResult を返す。

検証で弾いた場合は awscli を起動しない（exitCode 2）。awscli の失敗は種別判定にかけ、
応答へ載せる stdout / stderr は必ず秘匿化と上限を通す。
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
      category: invalid.category,
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
      category: rejected.category,
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
      category: probe.category,
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
    const category = classifyFailure({
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
      exitCode: resolveExitCode(category, result.exitCode),
      category,
      data: {},
      artifacts: [],
      message: failureMessage(entry.toolName, category)
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
annotations を許可リストの kind から導く。

契約表の「読取専用」列は read だけが true で、fetch（ローカルへ書き出す）と
execute（Athena のクエリ起動）は false。destructiveHint は fetch だけ true にする:
`overwrite: true` の呼び出しはローカルの既存ファイルを上書きして戻せない。
openWorldHint は AWS API へ到達するので全件 true。

契約書の共通規約も destructiveHint を fetch 2 件だけ true と定めており、ここはそれと一致する。
*/
function annotationsOf(entry: Readonly<AllowlistEntry>): ToolAnnotations {
  return {
    readOnlyHint: entry.kind === 'read',
    destructiveHint: entry.kind === 'fetch',
    openWorldHint: true,
  }
}

/**
許可リストのエントリ 1 件を MCP ツール定義にする。

入力の検証は 2 段になる。
inputSchema（型・列挙・書式）は SDK がハンドラ到達前に見て、入力検証エラーを返す。
許可リスト側の規則（先頭 '-'・排他・shorthand の構成要素）は、executeAllowlisted が見て isError の応答にする。ハンドラで再度 zod parse はしない
（SDK が既に未知キーの除去と default の適用を済ませている）。
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
