// ツールの実行結果表現と、SDK の CallToolResult への変換。
//
// 各ツールは、「許可リストのエントリに従って awscli を呼び、その成否・出力を一様な形で返す」構造を持つ。
// そのためコマンド固有の戻り値ではなく、ExecutionResult に正規化してからプロトコル表現へ変換する。

import type { CallToolResult } from '@modelcontextprotocol/server'
import type { FailureKind } from '../domain/allowlist.js'
// 上限（research R8）の定義は infra 側に置く。子プロセスの捕捉上限が同じ値を基準にするが、
// 依存方向が infra → mcp を許さないため。
import { OUTPUT_LIMIT_BYTES } from '../infra/awscli.js'

/**
ツール 1 回分の実行結果（data-model.md の ExecutionResult）。data はツールの項目で、structuredContent の最上位に並ぶ。
*/
export type ExecutionResult = SucceededExecution | FailedExecution

export interface SucceededExecution {
  readonly ok: true
  readonly kind?: never
  readonly data: Readonly<Record<string, unknown>>
  /**
  content の 1 つ目の text に入るエージェント向けの 1 行。
  */
  readonly message: string
}

export interface FailedExecution {
  readonly ok: false
  /**
  終了コードの代わりに読む原因の名前。実行前拒否は not-allowed / invalid-input、時間切れは timeout、awscli 不在は awscli-missing。
  */
  readonly kind: FailureKind
  /**
  失敗の文と再試行方法。structuredContent の detail と、content の 1 つ目の text に入る。
  */
  readonly detail: string
  /**
  awscli の秘匿化した出力（log）など。kind・detail と同じ名前は共通の値で上書きされる。
  */
  readonly data: Readonly<Record<string, unknown>>
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

content は文の text と、structuredContent と 1 字も違わない JSON の text（MCP の仕様の SHOULD）。
戻り値は SDK 側の mutable 型のまま返す。SDK が readonly 型を公開していないため。
*/
export function toCallToolResult(result: Readonly<ExecutionResult>): CallToolResult {
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
    // exactOptionalPropertyTypes 下で「成功時は isError キー自体を持たない」を表現する。
    ...(!result.ok && { isError: true }),
    structuredContent,
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
