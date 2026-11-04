// ツールの実行結果表現と、SDK の CallToolResult への変換。
//
// 各ツールは、「許可リストのエントリに従って awscli を呼び、その成否・出力を一様な形で返す」構造を持つ。
// そのためコマンド固有の戻り値ではなく、ExecutionResult に正規化してからプロトコル表現へ変換する。

import type { CallToolResult } from '@modelcontextprotocol/server'
import type { FailureCategory } from '../domain/allowlist.js'
// 上限（research R8）の定義は infra 側に置く。子プロセスの捕捉上限が同じ値を基準にするが、
// 依存方向が infra → mcp を許さないため。
import { OUTPUT_LIMIT_BYTES } from '../infra/awscli.js'

/**
ツール 1 回分の実行結果（data-model.md の ExecutionResult）。
*/
export interface ExecutionResult {
  readonly ok: boolean
  /**
  awscli の終了コード。実行前拒否は 2、時間切れは 124、awscli 不在は 127。
  */
  readonly exitCode: number
  /**
  失敗時のみ。ok が true のときはキーごと無い。
  */
  readonly category?: FailureCategory
  readonly data: Readonly<Record<string, unknown>>
  /**
  書き出したローカルファイルの絶対パス。
  */
  readonly artifacts: readonly string[]
  /**
  エージェント向けの 1 行サマリ（失敗時は再試行方法を含む）。
  */
  readonly message: string
  /**
  失敗時の awscli stderr（秘匿化済み）。
  */
  readonly stderr?: string
}

/**
limitOutput の戻り値。
*/
export interface LimitedOutput {
  readonly text: string
  readonly truncated: boolean
}

/**
ExecutionResult を MCP の CallToolResult へ変換する。

content には structuredContent と同じ内容の JSON テキストを載せる。structuredContent を
読めないクライアントでも結果を解釈できるようにするための二重化で、MCP 仕様が推奨する形。

引数は deep readonly だが、戻り値は SDK 側の mutable 型のまま返す。
SDK が readonly 型を公開していないため、この非対称は境界として許容する。
*/
export function toCallToolResult(result: Readonly<ExecutionResult>): CallToolResult {
  const structuredContent = toStructuredContent(result)
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    // exactOptionalPropertyTypes 下で「成功時は isError キー自体を持たない」を表現する。
    ...(!result.ok && { isError: true }),
    structuredContent,
  }
}

function toStructuredContent(result: Readonly<ExecutionResult>): Record<string, unknown> {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    ...(result.category !== undefined && { category: result.category }),
    data: { ...result.data },
    artifacts: [...result.artifacts],
    message: result.message,
    ...(result.stderr !== undefined && { stderr: result.stderr }),
  }
}

/**
出力を上限まで切り詰める。

残すのは **先頭側**。pecotv の「末尾を残す」は進捗ログ向けで、JSON 出力では先頭を失うと
構造ごと読めなくなる。先頭を残せば少なくとも先頭要素は読める。

バイト数で切るため、末尾が多バイト文字の途中にかかると U+FFFD が 1 文字だけ残る。
元の出力に無い文字を足さないよう、末尾の U+FFFD は落とす。
*/
export function limitOutput(text: string): LimitedOutput {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= OUTPUT_LIMIT_BYTES) return { text, truncated: false }

  const head = buffer.subarray(0, OUTPUT_LIMIT_BYTES).toString('utf8')
  return { text: head.endsWith('�') ? head.slice(0, -1) : head, truncated: true }
}
