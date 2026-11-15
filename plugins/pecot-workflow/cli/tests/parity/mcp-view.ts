// MCP 経由の結果と CLI の stderr を、同じ文字列（warning の文と、失敗の data.detail）にそろえて比べる。
// MCP の結果は stdout・stderr を持たないので、golden の stderr から同じ項目を取り出して比べる。
import { detailOf, splitWarnings } from '../../src/mcp/result.js'

export interface McpView {
  readonly warnings: readonly string[]
  /**
  失敗のときだけ
  */
  readonly detail?: string | undefined
}

/**
比べる形の文字列。warning ごとに 1 つ、失敗なら detail を最後に置く
*/
export function renderMcpView(view: Readonly<McpView>): string {
  const warnings = view.warnings.map(text => `warning: ${text}\n`).join('')
  return view.detail === undefined ? warnings : `${warnings}detail: ${view.detail}\n`
}

/**
CLI の stderr から、MCP の結果が持つはずの warning の文と detail を取り出す。MCP の結果と同じく、成功では detail を持たない
*/
export function mcpViewOfStderr(stderr: string, exitCode: number): string {
  return renderMcpView({ warnings: splitWarnings(stderr).warnings, ...exitCode !== 0 && { detail: detailOf(stderr, '') } })
}
