// MCP のツールの結果。コマンドの出力と、MCP の io だけが受ける項目・warning を集め、仕様の content・structuredContent・isError の形にする。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は readonly にできない */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import type { CallToolResult, JsonSchemaType, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { FailureKind } from '../commands/failure-kind.js'
import { WARNING_PREFIX } from '../commands/output.js'
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
  失敗の detail を決めるためだけに使う。結果には載せない
  */
  readonly stderr: string
  /**
  失敗の原因の名前。終了コードが 0 でないのに無ければ other
  */
  readonly kind?: FailureKind | undefined
  /**
  失敗の detail の代わりの文。warning を除いた stderr が空のときに使う
  */
  readonly message?: string | undefined
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
}

/**
stdout・stderr に書かれた文字列と、失敗の原因の名前、最初の結果の行、項目、warning の文を集める io
*/
export function collectIo(): CollectedIo {
  const out: string[] = []
  const error: string[] = []
  let failureKind: FailureKind | undefined
  let firstResult: string | undefined
  // createOutput を何度も呼ぶコマンドがあるので、項目はここで重ねる
  let fields: Record<string, unknown> = {}
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
      warning: (text) => {
        warnings.push(text)
      },
    },
    stdout: () => out.join(''),
    stderr: () => error.join(''),
    kind: () => failureKind,
    resultLine: () => firstResult,
    data: () => fields,
    warnings: () => [...warnings],
  }
}

/**
ツールの項目と並べて structuredContent の最上位に置く、全ツールに共通の 4 項目
*/
export const COMMON_OUTPUT_PROPERTIES = {
  kind: { type: 'string', description: 'Failure kind (failure only)' },
  detail: { type: 'string', description: 'Full failure text: the error message and the guidance lines that follow it (failure only)' },
  log: { type: 'string', description: 'Raw output of a child process (failure only; omitted when not captured)' },
  warnings: { type: 'array', items: { type: 'string' }, description: 'Warning messages, without the "warning: " prefix (omitted when there is none)' },
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

const ERROR_PREFIX = 'error: '
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

// 失敗の detail の代わりの文。渡された message、無ければ最初の error の行の文、それも無ければ stderr の最初の行
function failureMessageOf(outcome: Readonly<CommandOutcome>): string {
  if (outcome.message !== undefined) return outcome.message
  const lines = linesOf(outcome.stderr)
  const errorLine = lines.find(line => line.startsWith(ERROR_PREFIX))
  return errorLine === undefined ? (lines.at(0)?.trim() ?? '') : errorLine.slice(ERROR_PREFIX.length)
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
  const detail = detailOf(outcome.stderr, failureMessageOf(outcome))
  return {
    isOk: false,
    text: detail,
    structured: { kind: outcome.kind ?? 'other', detail, ...outcome.data, ...warned },
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
  return toToolResult({ exitCode: USAGE_EXIT_CODE, stdout: '', stderr: '', kind: 'invalid-input', message })
}

/**
中断（notifications/cancelled か接続の切断）で本体を呼ばなかった結果。応答はクライアントに届かない
*/
export function toAbortedResult(): CallToolResult {
  return toToolResult({ exitCode: 1, stdout: '', stderr: '', kind: 'aborted', message: 'cancelled' })
}
