// pecot-tools CLI のエントリポイント。MCP SDK は action 内の dynamic import に閉じる。
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { Command, CommanderError } from 'commander'

import { createDiagnostics } from './diagnostics.js'
import { checkNodeRuntime } from './node-runtime.js'
import { readVersion } from './version.js'

export function createProgram(): Command {
  const program = new Command()
  program.name('pecot-tools').version(readVersion())

  const mcp = program
    .command('mcp')
    .description('Serve as an MCP server over stdio (stdin/stdout)')

  /* c8 ignore start -- 実 stdin/stdout へ接続する。tests/e2e/mcp-stdio.test.ts が担保 */
  mcp.action(async () => {
    const { executeMcpServe, mcpServeDefaultDependencies } = await import('./mcp/serve.js')
    executeMcpServe(mcpServeDefaultDependencies)
  })
  /* c8 ignore stop */

  return program
}

/**
commander の process.exit() 直呼びを止め、例外へ振り替える。再帰で全サブコマンドに適用する
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- exitOverride() で変更する
export function applyExitOverrideRecursively(command: Command): void {
  command.exitOverride()
  for (const child of command.commands) applyExitOverrideRecursively(child)
}

export function main(nodeVersion: string = process.versions.node): void {
  const runtimeError = checkNodeRuntime(nodeVersion)
  if (runtimeError !== undefined) {
    createDiagnostics(process.stderr).error(runtimeError)
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
  // import.meta.url は実体パスなので argv[1] も realpath に揃える。symlink 経由起動で一致しなくなるため。
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 起動された自分自身のパス
  const selfUrl = pathToFileURL(realpathSync(process.argv[1])).href
  if (import.meta.url === selfUrl) {
    main()
  }
}
/* v8 ignore stop */
