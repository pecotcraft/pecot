// MCP 経由の結果と CLI の stderr を、同じ文字列（warning の文と、失敗の detail）にそろえて比べる。
// MCP の結果は stdout・stderr を持たないので、golden の stderr から同じ項目を取り出して比べる。
const WARNING_PREFIX = 'warning: '
const ERROR_PREFIX = 'error: '
const CONTINUATION = '  '

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

interface Split {
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
  readonly rest: readonly string[]
}

/**
stderr を、warning の文・error の文・それ以外の行に分ける。文は前置きを除き、続きの行（空白 2 つで始まる行）を字下げのまま持つ
*/
export function splitStderr(stderr: string): Split {
  const warnings: string[][] = []
  const errors: string[][] = []
  const rest: string[] = []
  let current: string[] | undefined
  for (const line of stderr.split('\n')) {
    if (line.startsWith(WARNING_PREFIX)) {
      current = [line.slice(WARNING_PREFIX.length)]
      warnings.push(current)
    }
    else if (line.startsWith(ERROR_PREFIX)) {
      current = [line.slice(ERROR_PREFIX.length)]
      errors.push(current)
    }
    else if (current !== undefined && line.startsWith(CONTINUATION)) {
      current.push(line)
    }
    else {
      current = undefined
      rest.push(line)
    }
  }
  return { warnings: warnings.map(lines => lines.join('\n')), errors: errors.map(lines => lines.join('\n')), rest }
}

/**
CLI の stderr から、MCP の結果が持つはずの warning の文と detail を取り出す。MCP の結果と同じく、成功では detail を持たない。
error の行が無い失敗（Aborted. など）は、warning を除いた残りの全部を detail にする
*/
export function mcpViewOfStderr(stderr: string, exitCode: number): string {
  const { warnings, errors, rest } = splitStderr(stderr)
  if (exitCode === 0) return renderMcpView({ warnings })
  const detail = errors.length > 0 ? errors.join('\n') : rest.join('\n').replaceAll(/^\n+|\n+$/g, '')
  return renderMcpView({ warnings, detail })
}
