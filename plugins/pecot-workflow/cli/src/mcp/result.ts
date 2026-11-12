// MCP のツールの結果。コマンドの出力を文字列に集め、CLI と同じ stdout・stderr・終了コードを結果の形にする。
import type { CallToolResult } from '@modelcontextprotocol/server'

import type { CommandIo } from '../commands/registry.js'

export interface CommandOutcome {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CollectedIo {
  /**
  readLine を持たない。標準入力の無い io は、入力の終端と同じ扱い
  */
  readonly io: CommandIo
  readonly stdout: () => string
  readonly stderr: () => string
}

/**
stdout・stderr に書かれた文字列を集める io
*/
export function collectIo(): CollectedIo {
  const out: string[] = []
  const error: string[] = []
  return {
    io: {
      stdout: (text) => {
        out.push(text)
      },
      stderr: (text) => {
        error.push(text)
      },
    },
    stdout: () => out.join(''),
    stderr: () => error.join(''),
  }
}

/**
結果の _meta で、終了コードと stdout・stderr を載せるキー。モデルには届かず、SDK のクライアントには届く
*/
export const OUTCOME_META_KEY = 'io.github.pecotcraft/outcome'

interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

function textBlock(text: string): TextBlock {
  return { type: 'text', text }
}

// 2 個目の本文。stderr に、終了コードが 0 でなければ `exit code: <n>` の行を足す
function diagnosticText(outcome: Readonly<CommandOutcome>): string {
  if (outcome.exitCode === 0) return outcome.stderr
  const separator = outcome.stderr === '' || outcome.stderr.endsWith('\n') ? '' : '\n'
  return `${outcome.stderr}${separator}exit code: ${String(outcome.exitCode)}\n`
}

/**
content は stdout、続けて stderr（あれば）。stdout・stderr が空で終了コード 0 なら空。
structuredContent は付けない（Claude Code が content を落とし、Copilot CLI は二重に渡すため）。終了コードと 2 つの出力は _meta に入れる
*/
export function toToolResult(outcome: Readonly<CommandOutcome>): CallToolResult {
  const diagnostic = diagnosticText(outcome)
  return {
    content: [...outcome.stdout === '' ? [] : [textBlock(outcome.stdout)], ...diagnostic === '' ? [] : [textBlock(diagnostic)]],
    ...outcome.exitCode !== 0 && { isError: true },
    _meta: { [OUTCOME_META_KEY]: { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr } },
  }
}

/**
コマンドを呼ぶ前に入力を断った結果。終了コードが無いので _meta は付けない
*/
export function toRejectedResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
