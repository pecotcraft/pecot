// MCP ツールの結果表現 (ToolResult) と、SDK の CallToolResult への変換。

import path from 'node:path'
import { Writable } from 'node:stream'

import { fromJsonSchema } from '@modelcontextprotocol/server'
import type { CallToolResult, JsonSchemaType, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { FailureKind } from '../domain/_shared/failure-kind.js'
import { createWarningCollector, WARNING_LIMIT_BYTES } from './warnings.js'
import { toPosixPath } from './windows-path.js'

/**
捕捉と log で保持する出力の上限 (バイト)。失敗の直接原因は末尾に出るため、超えたら先頭を捨てる。
*/
const OUTPUT_CAPTURE_LIMIT_BYTES = 64 * 1024

/**
切り詰めが起きたことを text() の先頭に 1 行で明示するマーカー。
*/
const TRUNCATION_MARKER = `[pecotv] output exceeded the ${String(OUTPUT_CAPTURE_LIMIT_BYTES)}-byte limit; the beginning was truncated\n`

/**
ツールの結果。toCallToolResult が MCP の CallToolResult に変える。
data はツールごとの項目で、structuredContent の最上位にそのまま並ぶ。宣言は各ツールの outputSchema で、tools/list へは toolOutputSchema で JSON Schema にして渡す。
*/
export type ToolResult = SucceededToolResult | FailedToolResult

export interface SucceededToolResult {
  readonly ok: true
  readonly kind?: never
  readonly data: Readonly<Record<string, unknown>>
  /**
  content の 1 つ目の text に入る文。空なら JSON の text だけを返す。
  */
  readonly message: string
}

export interface FailedToolResult {
  readonly ok: false
  readonly kind: FailureKind
  /**
  失敗の全文と直し方。structuredContent の detail と、content の 1 つ目の text に入る。
  */
  readonly detail: string
  /**
  途中まで進んだ分の項目。kind・detail と同じ名前は共通の値で上書きされる。
  */
  readonly data: Readonly<Record<string, unknown>>
}

/**
content は文の text と、structuredContent と 1 字も違わない JSON の text (MCP の仕様の SHOULD)。
*/
export function toCallToolResult(result: Readonly<ToolResult>): CallToolResult {
  const structuredContent = result.ok
    ? { ...result.data }
    : { ...result.data, kind: result.kind, detail: result.detail }
  const text = result.ok ? result.message : result.detail
  const sentence: CallToolResult['content'] = text === '' ? [] : [{ type: 'text', text }]
  return {
    content: [
      ...sentence,
      { type: 'text', text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
    // exactOptionalPropertyTypes 下で「成功時は isError キー自体を持たない」を表現する。
    ...(!result.ok && { isError: true }),
  }
}

/**
CLI の `--json` の失敗の payload から、共通の項目と重なる reason・detail を外す。原因の名前は kind、全文は detail で返すため。
*/
export function withoutCommonFailureFields(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { reason: _reason, detail: _detail, ...rest } = data
  return rest
}

/**
1 つの戻り値に畳み、確認を通した後に変換前の値を使う取り違えを型で防ぐ。
*/
export type PathArgumentsResult<Output>
  = | { readonly rejected: ToolResult, readonly input?: never }
    | { readonly rejected?: never, readonly input: Output }

/**
パラメータ 1 件分の変換結果。拒否結果の `convertedPaths` に載せて、渡した値との対応を見せる。
*/
interface ConvertedPath {
  readonly from: string
  readonly to: string
}

/**
引数の parse と、パス引数の変換・絶対パスの確認 (FR-011) を 1 つで行う。分けると変換の取りこぼしが起きるため。
`..` を含む絶対パスは通す。FR-011 は cwd の曖昧さを除く決まりで、アクセス範囲の制限ではない。
*/
export function parsePathArguments<Output extends Readonly<Record<string, unknown>>>(
  // zod のスキーマはメソッドを持つクラス型で、readonly 化すると parse を呼べない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  schema: z.ZodType<Output>,
  arguments_: Readonly<Record<string, unknown>>,
  keys: readonly (keyof Output & string)[],
): PathArgumentsResult<Output> {
  const parsed = schema.parse(arguments_)
  const draft: Record<string, unknown> = { ...parsed }
  /**
  パラメータ名 → 変換内容。拒否結果に載せて「どう解釈したか」を利用者に見せる。
  */
  const converted: Record<string, ConvertedPath> = {}
  const unsupportedPaths: string[] = []
  const unsupportedDetails: string[] = []
  const relativePaths: string[] = []

  for (const key of keys) {
    // eslint-disable-next-line security/detect-object-injection -- key は各ツールが定数で渡すパス引数名
    const value: unknown = parsed[key]
    // 省略された任意パラメータは素通しする (undefined 以外が来ることは inputSchema が防ぐ)。
    if (typeof value !== 'string') continue

    const conversion = toPosixPath(value)
    if (conversion.kind === 'unsupported') {
      unsupportedPaths.push(`${key}=${value}`)
      unsupportedDetails.push(`${key}=${value} (${conversion.reason})`)
      continue
    }
    if (conversion.kind === 'converted') {
      // eslint-disable-next-line security/detect-object-injection -- key は各ツールが定数で渡すパス引数名
      converted[key] = { from: value, to: conversion.path }
      // eslint-disable-next-line security/detect-object-injection -- key は各ツールが定数で渡すパス引数名
      draft[key] = conversion.path
      continue
    }
    if (!path.isAbsolute(value)) relativePaths.push(`${key}=${value}`)
  }

  const convertedPart = Object.keys(converted).length === 0 ? {} : { convertedPaths: converted }
  const invalidPaths = [...unsupportedPaths, ...relativePaths]

  if (invalidPaths.length > 0) {
    const messages = [
      ...(unsupportedDetails.length > 0 ? [`cannot resolve Windows-style path: ${unsupportedDetails.join(' / ')}`] : []),
      ...(relativePaths.length > 0 ? [`must be an absolute path: ${relativePaths.join(', ')}`] : []),
    ]
    return {
      rejected: {
        ok: false,
        kind: 'invalid-path',
        detail: messages.join('; '),
        data: { invalidPaths, ...convertedPart },
      },
    }
  }

  // draft は parsed のパス引数の値を、string のまま差し替えただけなので、再 parse せず Output として返す。
  // eslint-disable-next-line no-restricted-syntax -- 上記の理由により draft は Output と同型 (unknown 経由の narrowing)
  return ({ input: Object.keys(converted).length === 0 ? parsed : draft as unknown as Output })
}

/**
Writable を通さない出力 (SpawnResult) を、出力の捕捉と同じ上限・同じマーカーで切り詰める。
*/
export function truncateCapturedText(text: string): string {
  const buffer = Buffer.from(text, 'utf8')
  return buffer.length <= OUTPUT_CAPTURE_LIMIT_BYTES
    ? text
    : TRUNCATION_MARKER + buffer.subarray(buffer.length - OUTPUT_CAPTURE_LIMIT_BYTES).toString('utf8')
}

/**
捕捉した出力をつないで上限で切り詰める。各部分の切り詰めのマーカーは外し、印を冒頭の 1 つにまとめる。
*/
export function joinCapturedText(parts: readonly string[]): string {
  const wasTruncated = parts.some(part => part.startsWith(TRUNCATION_MARKER))
  const joined = parts
    .map(part => (part.startsWith(TRUNCATION_MARKER) ? part.slice(TRUNCATION_MARKER.length) : part))
    .filter(part => part !== '')
    .join('\n')
  const text = truncateCapturedText(joined)
  return wasTruncated && text === joined ? TRUNCATION_MARKER + text : text
}

/**
改行を待つ間に持つ 1 行の上限。warning の文の上限に、接頭辞 `warning: ` の分の余裕を足す。
*/
const PENDING_LINE_LIMIT_BYTES = WARNING_LIMIT_BYTES + 16

export interface OutputCapture {
  /**
  既存コマンドの DI (deps.stdout / deps.stderr) にそのまま渡せる書き込み先。
  */
  readonly stream: Writable
  /**
  ここまでに書き込まれた内容を連結して返す (上限超過時は末尾側だけを保持する)。
  */
  text(): string
  /**
  ここまでに書き込まれた `warning: ` の文。text() の切り詰めと関係なく、早く出たものから保つ。
  */
  warnings(): string[]
}

/**
MCP サーバの stdout は JSON-RPC 専有なので、既存コマンドの stdout / stderr をこれに差し替えて捕捉する。
*/
export function createOutputCapture(): OutputCapture {
  // chunk 境界のマルチバイト文字を正しくデコードするため、Buffer のまま溜めて取り出すときにデコードする。
  const chunks: Buffer[] = []
  let retainedBytes = 0
  let isTruncated = false
  const collector = createWarningCollector()
  let pending: Buffer[] = []
  let pendingBytes = 0

  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は可変の型
  const keepPending = (part: Buffer): void => {
    const room = PENDING_LINE_LIMIT_BYTES - pendingBytes
    if (room <= 0 || part.length === 0) return
    const kept = part.length <= room ? part : part.subarray(0, room)
    pending.push(kept)
    pendingBytes += kept.length
  }

  /**
  改行 (0x0A) で行に分けて warning の収集へ渡す。UTF-8 では 0x0A がマルチバイト文字の途中に現れない。
  */
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer は可変の型
  const feedLines = (buffered: Buffer): void => {
    let start = 0
    for (let index = buffered.indexOf(0x0A); index !== -1; index = buffered.indexOf(0x0A, start)) {
      keepPending(buffered.subarray(start, index))
      collector.addLine(Buffer.concat(pending).toString('utf8'))
      pending = []
      pendingBytes = 0
      start = index + 1
    }
    keepPending(buffered.subarray(start))
  }

  /**
  保持量が上限に収まるまで先頭から捨てる。境界にかかる chunk は途中から切り出す。
  */
  const dropOverflow = (): void => {
    while (retainedBytes > OUTPUT_CAPTURE_LIMIT_BYTES) {
      const head = chunks[0]
      /* c8 ignore next -- retainedBytes > 0 なら chunks は非空なので到達不能、防御網のみ */
      if (head === undefined) return
      isTruncated = true
      const excess = retainedBytes - OUTPUT_CAPTURE_LIMIT_BYTES
      if (head.length <= excess) {
        chunks.shift()
        retainedBytes -= head.length
      }
      else {
        chunks[0] = head.subarray(excess)
        retainedBytes -= excess
      }
    }
  }

  const stream = new Writable({
    // Node stream の _write シグネチャに揃える必要があり、readonly 化できない。
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      const buffered = Buffer.from(chunk)
      feedLines(buffered)
      chunks.push(buffered)
      retainedBytes += buffered.length
      dropOverflow()
      callback()
    },
  })
  return {
    stream,
    // 切り詰めた先頭はマルチバイト文字の途中から始まりうる (その 1 文字が U+FFFD になる)。
    text: () => (isTruncated ? TRUNCATION_MARKER : '') + Buffer.concat(chunks).toString('utf8'),
    warnings: () => collector.list(pendingBytes === 0 ? undefined : Buffer.concat(pending).toString('utf8')),
  }
}

/**
ツールの項目と並べて structuredContent の最上位に置く、全ツールに共通の 4 項目
*/
export const COMMON_OUTPUT_PROPERTIES = {
  kind: { type: 'string', description: 'Failure kind (failure only)' },
  detail: { type: 'string', description: 'Full text of the failure and how to recover (failure only)' },
  log: {
    type: 'string',
    description: 'Raw output of the command or child process (failure only). Over 64KB, the end is kept and the first line notes the truncation',
  },
  warnings: {
    type: 'array',
    items: { type: 'string' },
    description: 'Warnings raised during the run (omitted when there are none). Beyond 100 warnings or 64KB, the last item tells how many were omitted',
  },
}

const FAILURE_REQUIRED: readonly string[] = ['kind', 'detail']

const JsonObjectSchema = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
})

/**
ツールの outputSchema（JSON Schema）。最上位の properties にツールの項目と共通の 4 項目を並べ、
anyOf の枝で「成功の必須項目」か「kind と detail」を求める。成功の必須項目が無ければ anyOf を置かない
*/
// zod の型は readonly にできない。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
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
