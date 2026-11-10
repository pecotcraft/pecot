import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Command, CommanderError } from 'commander'

import {
  createChromiumHostDependenciesCommand,
  hostDependenciesCommandDefaultDependencies,
} from './commands/chromium/host-dependencies.js'
import {
  createDrawioExportCommand,
  drawioExportDefaultDependencies,
} from './commands/drawio/export.js'
import {
  createDrawioUrlCommand,
  drawioUrlDefaultDependencies,
} from './commands/drawio/url.js'
import {
  createEvidenceCreateCommand,
  evidenceCreateDefaultDependencies,
} from './commands/evidence-xlsx/create.js'
import {
  createPptxPreviewCommand,
  pptxPreviewDefaultDependencies,
} from './commands/pptx-ooxml/preview.js'
import {
  createSlideCreateCommand,
  slideCreateDefaultDependencies,
} from './commands/slidev-project/create.js'
import {
  createSlideLintCommand,
  slideLintDefaultDependencies,
} from './commands/slidev-project/lint.js'
import {
  createSlideThemeCommand,
  slideThemeDefaultDependencies,
} from './commands/slidev-project/theme.js'
import {
  createSlideConvertCommand,
  slideConvertDefaultDependencies,
} from './commands/slidev-to-pptx/convert.js'
import {
  createSlideSyncCommand,
  slideSyncDefaultDependencies,
} from './commands/slidev-project/sync.js'
import { createDiagnostics, writeData } from './diagnostics.js'
import { checkNodeRuntime } from './node-runtime.js'
import { readVersion } from './version.js'

export function createProgram(): Command {
  const program = new Command()
  program.name('pecotv').version(readVersion())

  program
    .command('hello')
    .description('greet from TS runtime')
    .action(() => {
      writeData(process.stdout, 'hello from pecotv (ts)')
    })

  const pptx = new Command('pptx').description('PPTX に対する操作')
  pptx.addCommand(createPptxPreviewCommand(pptxPreviewDefaultDependencies))
  program.addCommand(pptx)

  const slide = new Command('slide').description('Slidev プロジェクト操作')
  slide.addCommand(createSlideCreateCommand(slideCreateDefaultDependencies))
  slide.addCommand(createSlideConvertCommand(slideConvertDefaultDependencies))
  slide.addCommand(createSlideSyncCommand(slideSyncDefaultDependencies))
  slide.addCommand(createSlideLintCommand(slideLintDefaultDependencies))
  slide.addCommand(createSlideThemeCommand(slideThemeDefaultDependencies))
  program.addCommand(slide)

  const drawio = new Command('drawio').description('drawio に対する操作')
  drawio.addCommand(createDrawioUrlCommand(drawioUrlDefaultDependencies))
  drawio.addCommand(createDrawioExportCommand(drawioExportDefaultDependencies))
  program.addCommand(drawio)

  const chromiumCommand = new Command('chromium').description('Playwright Chromium の実行環境に対する操作')
  chromiumCommand.addCommand(createChromiumHostDependenciesCommand(hostDependenciesCommandDefaultDependencies))
  program.addCommand(chromiumCommand)

  const evidence = new Command('evidence').description('エビデンス xlsx に対する操作')
  evidence.addCommand(createEvidenceCreateCommand(evidenceCreateDefaultDependencies))
  program.addCommand(evidence)

  // mcp の実装は src/mcp/ に置く (ESLint zone: commands → mcp の import 禁止)。
  // ここでは Command の外形だけを組み、MCP SDK を引き込む実装は action 内の dynamic import に
  // 遅らせる。静的 import にすると `pecotv --help` を含む全コマンドの起動が SDK の読み込み分
  // (計測 約 60ms) 重くなるため。
  const mcp = program
    .command('mcp')
    .description('MCP サーバとして stdio (stdin/stdout) で待ち受ける')

  /* c8 ignore start -- action は dynamic import して実 process.stdin/stdout へ接続する。
     単体テストから起動すると vitest worker の stdout ごと差し替えてしまう。このルートは
     tests/e2e/mcp-stdio.test.ts が実プロセスの spawn で担保する。 */
  mcp.action(async () => {
    const { executeMcpServe, mcpServeDefaultDependencies } = await import('./mcp/serve.js')
    executeMcpServe(mcpServeDefaultDependencies)
  })
  /* c8 ignore stop */

  return program
}

// commander 14 の addCommand は親の exitOverride を継承しない。
// そのため group command (pptx / slide / drawio / evidence) は素のままだと自前で process.exit(1) してしまう。
// program から辿れる全 command へ再帰適用して、想定内終了を必ず CommanderError として
// main() の catch まで同期伝播させる。引数なしの exitOverride() は leaf の自前設定と同一で冪等。
// exitOverride() で対象 Command を変更するため readonly 化できない。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
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
    // exitOverride() を有効にしたサブコマンドからの想定内終了 (validation エラー / --help / --version)。
    // configureOutput が writeErr で stdout/stderr 出力を済ませているため、ここでは exit code のみ反映する。
    // 非 CommanderError ルートは commander の仕様上 parse から発生しない (action 内例外は Promise reject ルートへ)。
    /* c8 ignore start */
    if (!(error instanceof CommanderError)) throw error
    /* c8 ignore stop */
    process.exitCode = error.exitCode === 0 ? 0 : 2
  }
}

/* v8 ignore start -- 直接起動時のみ通るルート。挙動は tests/e2e/version.test.ts で担保 */
if (process.argv[1] !== undefined) {
  // import.meta.url は symlink を解決した実体パスを指すため、argv[1] 側も realpath に揃える。
  // 揃えないと bin ラッパー等の symlink 経由起動で一致せず、何もせず exit 0 で終わる。
  // main() を import して呼ぶルートでも、import 元プロセスの argv[1] が実ファイルである必要がある。
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 起動された自分自身のパス
  const selfUrl = pathToFileURL(realpathSync(process.argv[1])).href
  if (import.meta.url === selfUrl) {
    main()
  }
}
/* v8 ignore stop */
