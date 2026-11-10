// MCP ツールの結果表現と、SDK の CallToolResult への変換。
//
// pecotv の各ツールは「既存 CLI コマンドの実処理を呼び、その成否・生成物・出力を一様な形で返す」構造になる。
// そのためコマンド固有の戻り値ではなく ToolResult に正規化してからプロトコル表現へ変換する。加えて parsePathArguments が、引数の parse とパス引数への
// Windows 形式パス変換 (windows-path.ts) をまとめて担う。

import path from 'node:path'
import { Writable } from 'node:stream'

import type { CallToolResult } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import { toPosixPath } from './windows-path.js'

/**
解決できないパス (相対パス / 変換できない Windows 形式) を受け取ったときの exit code (UsageError 相当)。
*/
const USAGE_ERROR_EXIT_CODE = 2

/**
1 本の捕捉で保持する出力の上限 (バイト)。

捕捉した出力は ToolResult に載って MCP クライアントのコンテキストへ入る。
長時間ツール (slide_convert 等) の進捗ログが際限なく積み上がると、メモリとクライアント側コンテキストを圧迫する。超過分は「新しい方を残す」= 先頭を捨てる:
失敗の直接原因は末尾に出るため、切り詰めるなら古い側から捨てるのが妥当。
*/
const OUTPUT_CAPTURE_LIMIT_BYTES = 64 * 1024

/**
切り詰めが起きたことを text() の先頭に 1 行で明示するマーカー。
*/
const TRUNCATION_MARKER = `[pecotv] output exceeded the ${String(OUTPUT_CAPTURE_LIMIT_BYTES)}-byte limit; the beginning was truncated\n`

export interface ToolResult {
  /**
  ツールが目的を達成したか。false のとき CallToolResult は isError: true になる。
  */
  readonly ok: boolean
  /**
  対応する CLI コマンドの exit code 規約をそのまま載せる (0 = success, 3 = warnings 等)。
  */
  readonly exitCode: number
  /**
  生成・更新したファイル・ディレクトリの絶対パス。
  */
  readonly artifacts: readonly string[]
  /**
  ツール固有の構造化データ (URL・件数など)。
  */
  readonly data: Readonly<Record<string, unknown>>
  /**
  呼び出し元エージェント向けの 1 行サマリ。
  */
  readonly message: string
  /**
  捕捉した stdout。未捕捉のときは省略する。
  */
  readonly stdout?: string
  /**
  捕捉した stderr。未捕捉のときは省略する。
  */
  readonly stderr?: string
}

/**
ToolResult を MCP の CallToolResult へ変換する。

content には structuredContent と同じ内容の JSON テキストを載せる。structuredContent を
読めないクライアントでもツール結果を解釈できるようにするための二重化で、
MCP 仕様が推奨する形。

引数は deep readonly だが、戻り値は SDK 側の mutable 型のまま返す。
SDK が readonly 型を公開していないため、この非対称は境界として許容する。
*/
export function toCallToolResult(result: Readonly<ToolResult>): CallToolResult {
  const structuredContent = toStructuredContent(result)
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    // exactOptionalPropertyTypes 下で「成功時は isError キー自体を持たない」を表現する。
    ...(!result.ok && { isError: true }),
  }
}

function toStructuredContent(result: Readonly<ToolResult>): Record<string, unknown> {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    artifacts: [...result.artifacts],
    data: { ...result.data },
    message: result.message,
    ...(result.stdout !== undefined && { stdout: result.stdout }),
    ...(result.stderr !== undefined && { stderr: result.stderr }),
  }
}

/**
parsePathArguments の結果。`rejected` の有無で分岐し、受理時だけ `input` を持つ。

拒否用の ToolResult と検証済み引数を 1 つの戻り値に畳むのは、ハンドラ側で
「確認は通したが変換前の値を使う」という取り違えを型として起こせなくするため。
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
引数の parse と、パスパラメータ群の変換・絶対パス確認 (FR-011) をまとめて行う。

受理したときは変換済みの値を載せた同型オブジェクトを返す。ハンドラ側に未変換の束縛を残さないための形にしている。
パスを下流へ渡すルートが 1 箇所でも取りこぼすと、Windows のクライアントには「変換されたりされなかったり」に見える。
そのため確認と変換を別々の関数に割らない。

拒否するのは (1) Windows 形式だが POSIX パスへ畳めないもの (他 distro の UNC 等) と
(2) 変換後も絶対パスにならないものの 2 つ。両方が同じ呼び出しに含まれるときは、
一方を返して他方を隠すと利用者が取りこぼすため invalidPaths に両方を列挙する。
message は解決不能側 (1) を主文にする。cwd 依存の曖昧さより「渡した値をそもそも
解釈できない」方が原因の特定に時間がかかるため。MCP クライアントの cwd はサーバ
プロセスの cwd と一致する保証が無いため、相対パスは解決せず即座に弾く。invalidPaths
には利用者が渡した元の値を載せる (変換後の値だけを見せると、渡した引数との対応が取れない)。

見るのは「cwd 非依存で一意に解決できるか」だけで、`/a/../etc/passwd` のような
`..` を含む絶対パスは通す。FR-011 は cwd の曖昧さを排除する規約で、
サンドボックス境界ではない。アクセス範囲の制限は本関数の責務ではない。
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
        exitCode: USAGE_ERROR_EXIT_CODE,
        artifacts: [],
        data: { invalidPaths, ...convertedPart },
        message: messages.join('; '),
      },
    }
  }

  // 変換が 1 件も無ければ parse 済みの値をそのまま返す。変換があれば、
  // draft は parsed のキー集合と型をそのまま保ち、パス引数の値だけを toPosixPath が返した
  // 文字列へ差し替えている (schema の他フィールドには一切触れない)。差し替え後の値も
  // string で schema 側の型と矛盾しないため、再 parse せず Output として返す。
  // eslint-disable-next-line no-restricted-syntax -- 上記の理由により draft は Output と同型 (unknown 経由の narrowing)
  return ({ input: Object.keys(converted).length === 0 ? parsed : draft as unknown as Output })
}

/**
既に文字列として手元にある出力を、出力捕捉と同じ上限・同じマーカーで切り詰める。

子プロセスの結果 (SpawnResult) のように Writable を経由しない出力にも同じ上限を働かせる
ためのエントリ。上限を超える出力をそのまま ToolResult に載せると、エージェントのコンテキストを
際限なく食う (`playwright install` は非 TTY でも進捗を stdout へ書く)。
*/
export function truncateCapturedText(text: string): string {
  const buffer = Buffer.from(text, 'utf8')
  // createOutputCapture と同じく新しい方 (末尾) を残す。失敗の直接原因は末尾に出る。
  return buffer.length <= OUTPUT_CAPTURE_LIMIT_BYTES
    ? text
    : TRUNCATION_MARKER + buffer.subarray(buffer.length - OUTPUT_CAPTURE_LIMIT_BYTES).toString('utf8')
}

export interface OutputCapture {
  /**
  既存コマンドの DI (deps.stdout / deps.stderr) にそのまま渡せる書き込み先。
  */
  readonly stream: Writable
  /**
  ここまでに書き込まれた内容を連結して返す (上限超過時は末尾側だけを保持する)。
  */
  text(): string
}

/**
メモリ上に蓄積する Writable を作る。

MCP サーバのプロセス stdout は JSON-RPC 専有なので、既存コマンドの stdout / stderr は
これに差し替えて捕捉し、ToolResult へ転写する。

蓄積量は OUTPUT_CAPTURE_LIMIT_BYTES で頭打ちにし、超えた分は先頭から捨てる。
*/
export function createOutputCapture(): OutputCapture {
  // Buffer のまま溜めて取り出し時に一括デコードする。chunk 単位でデコードすると
  // マルチバイト文字が chunk 境界で破損しうる。
  // decodeStrings は既定 true なので、文字列を write しても _write には Buffer で届く。
  const chunks: Buffer[] = []
  let retainedBytes = 0
  let isTruncated = false

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
      chunks.push(buffered)
      retainedBytes += buffered.length
      dropOverflow()
      callback()
    },
  })
  return {
    stream,
    // 切り詰めた場合、残った先頭は多バイト文字の途中から始まりうる (その 1 文字だけが
    // U+FFFD になる)。バイト数で頭打ちにする以上避けられないので、マーカーで明示する。
    text: () => (isTruncated ? TRUNCATION_MARKER : '') + Buffer.concat(chunks).toString('utf8'),
  }
}
