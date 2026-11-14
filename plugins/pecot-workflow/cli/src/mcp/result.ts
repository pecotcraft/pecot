// MCP のツールの結果。コマンドの出力を文字列に集め、CLI と同じ stdout・stderr・終了コードを、pecot-tools・pecot-visual と同じ形の結果にする。
import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { FailureKind } from '../commands/failure-kind.js'
import type { CommandIo } from '../commands/registry.js'
import { USAGE_EXIT_CODE } from '../commands/usage-error.js'

export interface CommandOutcome {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /**
  失敗の原因の名前。終了コードが 0 でないのに無ければ other
  */
  readonly kind?: FailureKind | undefined
  /**
  失敗の message に使う文。無ければ stderr の行から決める
  */
  readonly message?: string | undefined
  /**
  成功の message に使う結果の行（片付けの行を除いた最初のもの）。無ければ stdout の最初の空でない行
  */
  readonly resultLine?: string | undefined
}

export interface CollectedIo {
  /**
  readLine を持たない。標準入力の無い io は、入力の終端と同じ扱い
  */
  readonly io: CommandIo
  readonly stdout: () => string
  readonly stderr: () => string
  readonly kind: () => FailureKind | undefined
  readonly resultLine: () => string | undefined
}

/**
stdout・stderr に書かれた文字列と、失敗の原因の名前、最初の結果の行を集める io
*/
export function collectIo(): CollectedIo {
  const out: string[] = []
  const error: string[] = []
  let failureKind: FailureKind | undefined
  let firstResult: string | undefined
  return {
    io: {
      stdout: (text) => {
        out.push(text)
      },
      stderr: (text) => {
        error.push(text)
      },
      surface: 'mcp',
      failureKind: (kind) => {
        failureKind ??= kind
      },
      resultLine: (line) => {
        firstResult ??= line
      },
    },
    stdout: () => out.join(''),
    stderr: () => error.join(''),
    kind: () => failureKind,
    resultLine: () => firstResult,
  }
}

/**
全ツールが共有する outputSchema。pecot-tools・pecot-visual と項目の名前をそろえる
*/
export const TOOL_OUTPUT_SCHEMA = z.object({
  ok: z.boolean().describe('Whether the tool completed its intended run'),
  exitCode: z.number().describe('Exit code (0 = success)'),
  kind: z.string().optional().describe('Failure kind (omitted on success)'),
  artifacts: z.array(z.string()).describe('Absolute paths of files and directories created or updated'),
  data: z.record(z.string(), z.unknown()).describe('Object with the details of the run'),
  message: z.string().describe('One-line summary for the calling agent. On success, the first result line or else the first stdout line; empty when there is neither'),
  stdout: z.string().optional().describe('Captured stdout (omitted when empty)'),
  stderr: z.string().optional().describe('Captured stderr (omitted when empty)'),
})

type ToolOutput = z.output<typeof TOOL_OUTPUT_SCHEMA>

const ERROR_PREFIX = 'error: '

function linesOf(text: string): readonly string[] {
  return text.split('\n').filter(line => line.trim() !== '')
}

// 失敗は最初の error の行の文、無ければ stderr の最初の行。成功は結果の行、無ければ stdout の最初の行
function messageOf(outcome: Readonly<CommandOutcome>): string {
  if (outcome.exitCode === 0) return outcome.resultLine ?? linesOf(outcome.stdout).at(0)?.trim() ?? ''
  const lines = linesOf(outcome.stderr)
  if (outcome.message !== undefined) return outcome.message
  const errorLine = lines.find(line => line.startsWith(ERROR_PREFIX))
  return errorLine === undefined ? (lines.at(0)?.trim() ?? '') : errorLine.slice(ERROR_PREFIX.length)
}

function toOutput(outcome: Readonly<CommandOutcome>): ToolOutput {
  const isOk = outcome.exitCode === 0
  return {
    ok: isOk,
    exitCode: outcome.exitCode,
    ...!isOk && { kind: outcome.kind ?? 'other' },
    artifacts: [],
    data: {},
    message: messageOf(outcome),
    ...outcome.stdout !== '' && { stdout: outcome.stdout },
    ...outcome.stderr !== '' && { stderr: outcome.stderr },
  }
}

/**
structuredContent と、同じ JSON を本文にした content の両方で返す。ホストがどちらを渡しても同じ中身が届く
*/
export function toToolResult(outcome: Readonly<CommandOutcome>): CallToolResult {
  const output = toOutput(outcome)
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: { ...output },
    ...!output.ok && { isError: true },
  }
}

/**
コマンドを呼ぶ前に入力を断った結果。終了コードは使い方の誤りと同じ 2
*/
export function toRejectedResult(message: string): CallToolResult {
  return toToolResult({ exitCode: USAGE_EXIT_CODE, stdout: '', stderr: '', kind: 'invalid-input', message })
}

/**
中断（notifications/cancelled か接続の切断）で本体を呼ばなかった結果。応答はクライアントに届かない
*/
export function toAbortedResult(): CallToolResult {
  return toToolResult({ exitCode: 1, stdout: '', stderr: '', kind: 'aborted', message: 'cancelled' })
}
