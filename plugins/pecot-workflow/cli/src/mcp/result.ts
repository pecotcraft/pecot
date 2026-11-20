// MCP のツールの結果。コマンドの出力と、MCP の io だけが受ける項目・warning を集め、仕様の content・structuredContent・isError の形にする。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import type { CallToolResult, JsonSchemaType, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { FailureKind } from '../commands/failure-kind.js'
import type { CommandIo } from '../commands/registry.js'
import { USAGE_EXIT_CODE } from '../commands/usage-error.js'

export interface CommandOutcome {
  /**
  成否を決めるためだけに使う。結果には載せない
  */
  readonly exitCode: number
  /**
  成功の文を決めるためだけに使う。結果には載せない
  */
  readonly stdout: string
  /**
  失敗の原因の名前。終了コードが 0 でないのに無ければ other
  */
  readonly kind?: FailureKind | undefined
  /**
  失敗の detail の代わりの文。errors が空のときに使う
  */
  readonly message?: string | undefined
  /**
  コマンドが渡した失敗の文。改行でつないで detail にする
  */
  readonly errors?: readonly string[] | undefined
  /**
  子プロセスの生の出力。失敗の log にする
  */
  readonly log?: string | undefined
  /**
  成功の文に使う結果の行（片付けの行を除いた最初のもの）。無ければ stdout の最初の空でない行
  */
  readonly resultLine?: string | undefined
  /**
  コマンドの output で検証した後の項目。失敗では途中まで進んだ結果
  */
  readonly data?: Readonly<Record<string, unknown>> | undefined
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
  readonly warnings: () => readonly string[]
  readonly errors: () => readonly string[]
  readonly log: () => string | undefined
}

/**
stdout・stderr に書かれた文字列と、失敗の原因の名前、最初の結果の行、項目、warning と失敗の文、子プロセスの出力を集める io。signal は io にそのまま渡す
*/
export function collectIo(signal?: Readonly<AbortSignal>): CollectedIo {
  const out: string[] = []
  const error: string[] = []
  let failureKind: FailureKind | undefined
  let firstResult: string | undefined
  // createOutput を何度も呼ぶコマンドがあるので、項目はここで重ねる
  let fields: Record<string, unknown> = {}
  const warnings: string[] = []
  const errors: string[] = []
  const logs: string[] = []
  return {
    io: {
      stdout: (text) => {
        out.push(text)
      },
      stderr: (text) => {
        error.push(text)
      },
      surface: 'mcp',
      ...(signal !== undefined && { signal }),
      failureKind: (kind) => {
        failureKind ??= kind
      },
      resultLine: (line) => {
        firstResult ??= line
      },
      data: (added) => {
        fields = { ...fields, ...added }
      },
      warning: (text) => {
        warnings.push(text)
      },
      error: (text) => {
        errors.push(text)
      },
      log: (text) => {
        logs.push(text)
      },
    },
    stdout: () => out.join(''),
    stderr: () => error.join(''),
    kind: () => failureKind,
    resultLine: () => firstResult,
    data: () => fields,
    warnings: () => [...warnings],
    errors: () => [...errors],
    log: () => logs.length === 0 ? undefined : logs.join('\n'),
  }
}

/**
ツールの項目と並べて structuredContent の最上位に置く、全ツールに共通の 4 項目
*/
export const COMMON_OUTPUT_PROPERTIES = {
  kind: { type: 'string', description: 'Failure kind (failure only)' },
  detail: { type: 'string', description: 'Full failure text: the error message and the guidance lines that follow it (failure only)' },
  log: { type: 'string', description: 'Raw output of a child process (failure only; omitted when not captured)' },
  warnings: { type: 'array', items: { type: 'string' }, description: 'Warning messages; continuation lines of a message are indented by two spaces (omitted when there is none)' },
}

const FAILURE_REQUIRED: readonly string[] = ['kind', 'detail']

const JsonObjectSchema = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
})

/**
ツールの outputSchema（JSON Schema）。最上位の properties にコマンドの output の項目と共通の 4 項目を並べ、
anyOf の枝で「成功の必須項目」か「kind と detail」を求める。成功の必須項目が無ければ anyOf を置かない
*/
export function toolOutputSchema(output: z.ZodObject): Record<string, unknown> {
  const generated = Object.entries(z.toJSONSchema(output, { io: 'output' })).filter(([key]) => key !== '$schema')
  const { required = [], properties = {}, ...rest } = JsonObjectSchema.parse(Object.fromEntries(generated))
  return {
    type: 'object',
    properties: { ...properties, ...COMMON_OUTPUT_PROPERTIES },
    // 定義書に書き出す順（type・properties・additionalProperties）に合わせる
    ...rest,
    ...required.length > 0 && { anyOf: [{ required }, { required: [...FAILURE_REQUIRED] }] },
  }
}

/**
手組みの JSON Schema を、SDK が受ける形にする。検証は SDK の ajv（2020-12）で、値を変えない
*/
export function standardOutputSchema(schema: Readonly<Record<string, unknown>>): StandardSchemaWithJSON {
  // eslint-disable-next-line no-restricted-syntax -- JsonSchemaType は全キーワードの型で、組み立てた object を当てられない
  return fromJsonSchema(schema as JsonSchemaType)
}

function linesOf(text: string): readonly string[] {
  return text.split('\n').filter(line => line.trim() !== '')
}

interface ToolOutput {
  readonly isOk: boolean
  readonly text: string
  readonly structured: Readonly<Record<string, unknown>>
}

function toOutput(outcome: Readonly<CommandOutcome>): ToolOutput {
  const warnings = outcome.warnings ?? []
  const warned = warnings.length > 0 ? { warnings } : {}
  if (outcome.exitCode === 0) {
    return {
      isOk: true,
      text: outcome.resultLine ?? linesOf(outcome.stdout).at(0)?.trim() ?? '',
      structured: { ...outcome.data, ...warned },
    }
  }
  const errors = outcome.errors ?? []
  const detail = errors.length > 0 ? errors.join('\n') : (outcome.message ?? '')
  return {
    isOk: false,
    text: detail,
    structured: { kind: outcome.kind ?? 'other', detail, ...outcome.log !== undefined && { log: outcome.log }, ...outcome.data, ...warned },
  }
}

/**
content は、文の text（空なら省く）と、structuredContent と 1 字も違わない JSON の text。ホストがどちらを渡しても同じ中身が届く
*/
export function toToolResult(outcome: Readonly<CommandOutcome>): CallToolResult {
  const { isOk, text, structured } = toOutput(outcome)
  const json: CallToolResult['content'][number] = { type: 'text', text: JSON.stringify(structured) }
  return {
    content: text === '' ? [json] : [{ type: 'text', text }, json],
    structuredContent: { ...structured },
    ...!isOk && { isError: true },
  }
}

/**
コマンドを呼ぶ前に入力を断った結果。終了コードは使い方の誤りと同じ 2
*/
export function toRejectedResult(message: string): CallToolResult {
  return toToolResult({ exitCode: USAGE_EXIT_CODE, stdout: '', kind: 'invalid-input', message })
}

/**
中断（notifications/cancelled か接続の切断）で、本体を呼ばなかったか途中で止めた結果。応答はクライアントに届かない
*/
export function toAbortedResult(): CallToolResult {
  return toToolResult({ exitCode: 1, stdout: '', kind: 'aborted', message: 'cancelled' })
}
