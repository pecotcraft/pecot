// git の標準エラーを失敗の文に埋めるときの形。CLI は全文、MCP は理由の行だけにし、全文は log に渡す。
import { surfaceText } from './command-hint.js'
import type { HintedText } from './command-hint.js'

const REASON_LINE = /^(?:fatal|error): /u

/**
git の標準エラーの、最初の `fatal:` か `error:` の行から後。進みの行（`Preparing worktree …` など）を落とす。どちらも無ければ全文
*/
export function gitReasonOf(stderr: string): string {
  const lines = stderr.trim().split('\n')
  const start = lines.findIndex(line => REASON_LINE.test(line))
  return (start === -1 ? lines : lines.slice(start)).join('\n')
}

/**
`<prefix><git の標準エラー>` の文。cliText は CLI に出す形の標準エラー（呼ぶ側が今の形のまま渡す）
*/
export function gitFailureText(prefix: string, cliText: string): HintedText {
  return [prefix, surfaceText(cliText, gitReasonOf(cliText))]
}

/**
例外が持つ子プロセスの生の出力（log）。無いか空なら undefined
*/
export function logOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('log' in error)) return undefined
  const { log } = error
  return typeof log === 'string' && log.trim() !== '' ? log : undefined
}
