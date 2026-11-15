// MCP のツールの結果。コマンドの出力と、MCP の io だけが受ける data・artifacts・warning を集め、pecot-tools・pecot-visual と同じ形の結果にする。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { FailureKind } from '../commands/failure-kind.js'
import type { CommandIo } from '../commands/registry.js'
import { USAGE_EXIT_CODE } from '../commands/usage-error.js'

export interface CommandOutcome {
  readonly exitCode: number
  /**
  成功の message を決めるためだけに使う。結果には載せない
  */
  readonly stdout: string
  /**
  失敗の message と data.detail を決めるためだけに使う。結果には載せない
  */
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
  /**
  コマンドの output で検証した後の data の項目。失敗では途中まで進んだ結果
  */
  readonly data?: Readonly<Record<string, unknown>> | undefined
  readonly artifacts?: readonly string[] | undefined
  readonly warnings?: readonly string[] | undefined
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
  readonly data: () => Readonly<Record<string, unknown>>
  readonly artifacts: () => readonly string[]
  readonly warnings: () => readonly string[]
}

/**
stdout・stderr に書かれた文字列と、失敗の原因の名前、最初の結果の行、data の項目、作ったパス、warning の文を集める io
*/
export function collectIo(): CollectedIo {
  const out: string[] = []
  const error: string[] = []
  let failureKind: FailureKind | undefined
  let firstResult: string | undefined
  // createOutput を何度も呼ぶコマンドがあるので、項目はここで重ねる
  let fields: Record<string, unknown> = {}
  const paths: string[] = []
  const warnings: string[] = []
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
      data: (added) => {
        fields = { ...fields, ...added }
      },
      artifact: (file) => {
        if (!paths.includes(file)) paths.push(file)
      },
      warning: (text) => {
        warnings.push(text)
      },
    },
    stdout: () => out.join(''),
    stderr: () => error.join(''),
    kind: () => failureKind,
    resultLine: () => firstResult,
    data: () => fields,
    artifacts: () => [...paths],
    warnings: () => [...warnings],
  }
}

const WARNINGS_SCHEMA = z.array(z.string()).describe('Warning messages, without the "warning: " prefix (omitted when there is none)')

/**
ツールの outputSchema。最上位は pecot-tools・pecot-visual と同じ 6 つの名前。
data は、成功の型（コマンドの output と warnings）と、失敗の型（共通の reason・detail・warnings・log と、成功の項目を省略可にしたもの）の anyOf
*/
export function toolOutputSchema(output: z.ZodObject): z.ZodObject {
  const success = output.extend({ warnings: WARNINGS_SCHEMA.optional() })
  const failure = output.partial().extend({
    reason: z.string().describe('Failure kind, the same value as kind'),
    detail: z.string().describe('Full failure text: the error message and the guidance lines that follow it'),
    warnings: WARNINGS_SCHEMA.optional(),
    log: z.string().optional().describe('Raw output of a child process (failure only; omitted when not captured)'),
  })
  return z.object({
    ok: z.boolean().describe('Whether the tool completed its intended run'),
    exitCode: z.number().describe('Exit code (0 = success)'),
    kind: z.string().optional().describe('Failure kind (omitted on success)'),
    artifacts: z.array(z.string()).describe('Absolute paths of files and directories created or updated'),
    data: z.union([success, failure]).describe('On success, the tool\'s result fields. On failure, reason and detail, plus any result fields reached before the failure'),
    message: z.string().describe('One-line summary for the calling agent. On success, the first result line or else the first stdout line; empty when there is neither'),
  })
}

interface ToolOutput {
  readonly ok: boolean
  readonly exitCode: number
  readonly kind?: string
  readonly artifacts: readonly string[]
  readonly data: Readonly<Record<string, unknown>>
  readonly message: string
}

const ERROR_PREFIX = 'error: '
const WARNING_PREFIX = 'warning: '
const CONTINUATION = '  '

function linesOf(text: string): readonly string[] {
  return text.split('\n').filter(line => line.trim() !== '')
}

/**
stderr を、warning の文（前置きと続きの行の字下げを除く）と、それ以外の行に分ける。続きの行は、warning の行の後の空白 2 つで始まる行
*/
export function splitWarnings(stderr: string): { readonly warnings: readonly string[], readonly rest: readonly string[] } {
  const warnings: string[] = []
  const rest: string[] = []
  let current: string[] | undefined
  for (const line of stderr.split('\n')) {
    if (line.startsWith(WARNING_PREFIX)) {
      current = [line.slice(WARNING_PREFIX.length)]
      warnings.push('')
    }
    else if (current !== undefined && line.startsWith(CONTINUATION)) {
      current.push(line.slice(CONTINUATION.length))
    }
    else {
      current = undefined
      rest.push(line)
    }
    if (current !== undefined) warnings[warnings.length - 1] = current.join('\n')
  }
  return { warnings, rest }
}

/**
失敗の全文。warning を除いた stderr の、最初の error の行から後（前置きを除く）。error の行が無ければ warning を除いた stderr の全部、それも空なら message
*/
export function detailOf(stderr: string, message: string): string {
  const { rest } = splitWarnings(stderr)
  const start = rest.findIndex(line => line.startsWith(ERROR_PREFIX))
  const kept = start === -1 ? rest : rest.slice(start).with(0, rest.at(start)?.slice(ERROR_PREFIX.length) ?? '')
  const text = kept.join('\n').replaceAll(/^\n+|\n+$/g, '')
  return text === '' ? message : text
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
  const message = messageOf(outcome)
  const warnings = outcome.warnings ?? []
  const kind = outcome.kind ?? 'other'
  const data = {
    ...outcome.data,
    ...!isOk && { reason: kind, detail: detailOf(outcome.stderr, message) },
    ...warnings.length > 0 && { warnings },
  }
  return {
    ok: isOk,
    exitCode: outcome.exitCode,
    ...!isOk && { kind },
    artifacts: outcome.artifacts ?? [],
    data,
    message,
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
