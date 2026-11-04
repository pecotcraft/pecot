// pecot-tools CLI のエントリポイント。MCP サーバの起動 (`mcp`) だけを持つ薄い Command で、
// MCP SDK の読み込みは action 内の dynamic import に閉じる。
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { Command, CommanderError } from 'commander'

import { checkNodeRuntime } from './node-runtime.js'
import { readVersion } from './version.js'

export function createProgram(): Command {
  const program = new Command()
  program.name('pecot-tools').version(readVersion())

  const mcp = program
    .command('mcp')
    .description('MCP サーバとして stdio (stdin/stdout) で待ち受ける')

  /* c8 ignore start -- action は dynamic import して実 process.stdin/stdout へ接続する。
     単体テストから起動すると vitest worker の stdout ごと差し替えてしまう。
     tests/e2e/mcp-stdio.test.ts が実プロセスの spawn で担保する。 */
  mcp.action(async () => {
    const { executeMcpServe, mcpServeDefaultDependencies } = await import('./mcp/serve.js')
    executeMcpServe(mcpServeDefaultDependencies)
  })
  /* c8 ignore stop */

  return program
}

/**
commander の既定である process.exit() 直呼びを止め、例外へ振り替える。
サブコマンドを足したときに取りこぼさないよう再帰で適用する。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- exitOverride() で変更する
export function applyExitOverrideRecursively(command: Command): void {
  command.exitOverride()
  for (const child of command.commands) applyExitOverrideRecursively(child)
}

export function main(nodeVersion: string = process.versions.node): void {
  const runtimeError = checkNodeRuntime(nodeVersion)
  if (runtimeError !== undefined) {
    process.stderr.write(`pecot-tools: ${runtimeError}\n`)
    process.exitCode = 1
    return
  }
  const program = createProgram()
  applyExitOverrideRecursively(program)
  try {
    program.parse(process.argv)
  }
  catch (error: unknown) {
    /* c8 ignore start -- commander 以外の例外は握り潰さずに再送出する */
    if (!(error instanceof CommanderError)) throw error
    /* c8 ignore stop */
    process.exitCode = error.exitCode === 0 ? 0 : 2
  }
}

/* v8 ignore start -- 直接起動時にだけ通る。挙動は tests/e2e/version.test.ts で担保 */
if (process.argv[1] !== undefined) {
  // import.meta.url は symlink を解決した実体パスを指すため、argv[1] 側も realpath に揃える。
  // 揃えないと bin ラッパー等の symlink 経由起動で一致せず、何もせず exit 0 で終わる。
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 起動された自分自身のパス
  const selfUrl = pathToFileURL(realpathSync(process.argv[1])).href
  if (import.meta.url === selfUrl) {
    main()
  }
}
/* v8 ignore stop */
