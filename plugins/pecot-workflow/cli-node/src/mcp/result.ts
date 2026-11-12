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
content[0].text は stdout。isError は終了コードが 0 でないとき。structuredContent は { exitCode, stdout, stderr }
*/
export function toToolResult(outcome: Readonly<CommandOutcome>): CallToolResult {
  return {
    content: [{ type: 'text', text: outcome.stdout }],
    ...outcome.exitCode !== 0 && { isError: true },
    structuredContent: { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr },
  }
}

/**
コマンドを呼ぶ前に入力を断った結果。終了コードが無いので structuredContent は付けない
*/
export function toRejectedResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
