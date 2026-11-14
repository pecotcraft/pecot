// `pecotv slide theme` コマンドのファサード。
// talk-dir が参照するテーマを引き、その宣言（pecot-theme.json）とレイアウトの一覧を返す。
// スキル・lint・hooks・slide_page はこの結果を受け取り、宣言を自分で解釈しない。
//
// ネットワークには出ない。呼ぶ順は次のとおり。
// resolveTalkTheme
// readThemeDeclaration
// resolveLayoutReferences
// readLayoutCategories
// buildLayoutCatalog
//
// commander DI / exitOverride / configureOutput.writeErr の形は slidev-project/lint.ts を踏襲する。

import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import path from 'node:path'

import { Command } from 'commander'

import {
  THEME_DECLARATION_FILE_NAME,
  readThemeDeclaration,
} from '../../domain/slidev-theme/declaration.js'
import { createDiagnostics, passthrough, writeData } from '../../diagnostics.js'
import type { ResolvedThemeDeclaration } from '../../domain/slidev-theme/declaration.js'
import type { DeckLintInput } from '../../domain/slidev-theme/deck-lint-input.js'
import { themeErrorReason } from '../../domain/slidev-theme/error-reason.js'
import type { ThemeFiles } from '../../domain/slidev-theme/ports.js'
import {
  buildLayoutCatalog,
  readLayoutCategories,
  resolveLayoutReferences,
} from '../../domain/slidev-theme/references.js'
import type { LayoutCatalog, LayoutReferences } from '../../domain/slidev-theme/references.js'
import { resolveTalkTheme } from '../../domain/slidev-theme/talk-theme.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'

export interface SlideThemeOptions {
  readonly dir: string
}

export interface SlideThemeDependencies {
  // テーマと宣言を読む port。テストが差し替える。
  readonly files: ThemeFiles
  // `--dir` を省いたときの talk-dir
  readonly currentDirectory: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
}

/**
`--json` の `theme`。`spec` は `package.json` の dependencies の値。
*/
export interface SlideThemeInfo {
  readonly name: string
  readonly spec: string
  // pecot-theme.json があるか。キー名は contracts/cli-mcp.md の「宣言の有無」に合わせた JSON の契約

  readonly declared: boolean
  // テーマ root の絶対パス
  readonly directory: string
  // talk-dir 直下の node_modules で見つかったか。上位の node_modules なら false
  readonly linked: boolean
}

export interface SlideThemeData {
  readonly event: 'slide.theme.done'
  readonly theme: SlideThemeInfo
  readonly declaration: ResolvedThemeDeclaration
  readonly layouts: LayoutCatalog['layouts']
  readonly categories: LayoutCatalog['categories']
  // deck-lint.config.js・hooks はこれをそのまま使う
  readonly lint: DeckLintInput
  readonly warnings: readonly string[]
}

export interface SlideThemeExecution {
  readonly data: SlideThemeData
  // 参照 yaml の絶対パスを持つ内部用の結果。`--json` と MCP の data には載せない。
  // slide_page がレイアウトの参照 yaml を開くのに使う。
  readonly references: LayoutReferences
}

const LINK_COLOR_WARNING
  = 'pptx.linkColor is omitted, so links are not converted in PPTX (no hyperlinks are added) '
    + `(fix: set pptx.linkColor in ${THEME_DECLARATION_FILE_NAME} to a 6-digit hex value to convert links)`

/**
`slide theme` の実処理。CLI action と MCP ツール（slide_theme）、lint・page・convert もここを通る。

失敗は例外で返す。`ThemeResolveError`（theme-unlinked / theme-none）と
`ThemeDeclarationError`（invalid-shape / unknown-rule）。
*/
export async function executeSlideTheme(
  options: Readonly<SlideThemeOptions>,
  dependencies: Readonly<Pick<SlideThemeDependencies, 'files'>>,
): Promise<SlideThemeExecution> {
  const { files } = dependencies
  const talkDirectory = options.dir
  const theme = await resolveTalkTheme(files, talkDirectory)
  const { declaration, warnings: declarationWarnings } = await readThemeDeclaration(files, theme.directory)
  const references = await resolveLayoutReferences(files, {
    themeRoot: theme.directory,
    talkDirectory,
    referencesDirectory: declaration.layouts.references,
  })
  const vocabulary = await readLayoutCategories(files, references.directories)
  const catalog = buildLayoutCatalog(references, vocabulary.categories)

  const isDeclared = (await files.readText(path.join(theme.directory, THEME_DECLARATION_FILE_NAME))) !== undefined
  const warnings = [
    ...declarationWarnings,
    ...vocabulary.warnings,
    ...catalog.warnings,
    ...(declaration.pptx.linkColor === undefined ? [LINK_COLOR_WARNING] : []),
  ]
  return {
    references,
    data: {
      event: 'slide.theme.done',
      theme: { name: theme.name, spec: theme.spec, declared: isDeclared, directory: theme.directory, linked: theme.linked },
      declaration,
      layouts: catalog.layouts,
      categories: catalog.categories,
      lint: {
        referencesDirectories: references.directories,
        panels: declaration.drawio.panels,
        markerLayouts: declaration.drawio.markerLayouts,
        rules: declaration.lint.rules,
      },
      warnings,
    },
  }
}

/**
失敗の reason。テーマに関わる例外は `theme-<reason>` で、それ以外は `unknown`。
変換は domain の `themeErrorReason` が 1 か所で持つ。
*/
export function errorToReason(error: unknown): FailureReason {
  return themeErrorReason(error) ?? 'unknown'
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */

function doesArgvWantJson(argv: readonly string[]): boolean {
  return argv.includes('--json')
}

function writeHumanReport(
  data: Readonly<SlideThemeData>,
  // WritableStream の write は mutate。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stdout: NodeJS.WritableStream,
  // 警告は結果と分けて stderr に出す。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stderr: NodeJS.WritableStream,
): void {
  const { theme } = data
  writeData(stdout, `slide theme: ${theme.name} (${theme.spec})`)
  writeData(stdout, `  theme root: ${theme.directory}`)
  writeData(stdout, `  declaration: ${theme.declared ? 'present' : 'absent'}`)
  writeData(stdout, `  layouts: ${String(data.layouts.length)}`)
  for (const category of data.categories) {
    writeData(stdout, `  --- ${category.label}: ${category.question} ---`)
    const members = data.layouts.filter(entry => entry.category === category.id)
    for (const layout of members) {
      writeData(stdout, `    - ${layout.deprecated ? '[deprecated] ' : ''}${layout.layout}: ${layout.description}`)
    }
  }
  for (const warning of data.warnings) {
    createDiagnostics(stderr).warning(warning)
  }
}

/**
commander コマンドファクトリ。コマンド名は `theme`、`slide` グループ配下に登録する想定。

受け付ける options:
- `--dir <path>`: talk-dir。省くとカレント
- `--json`: machine-readable な JSON を stdout に出す

exit code: 成功 = 0 / 解決・宣言の失敗 = 1 / usage error = 2（commander 専用）。
*/
export function createSlideThemeCommand(
  buildDependencies: () => SlideThemeDependencies,
): Command {
  const command = new Command('theme')
    .description('print the theme declaration and layout list referenced by a talk-dir')
    .option('--dir <path>', 'talk-dir path (default: current directory)')
    .option('--json', 'print machine-readable JSON to stdout', false)
    .exitOverride()
    .configureOutput({
      writeErr: (string_: string) => {
        const dependencies = buildDependencies()
        if (doesArgvWantJson(process.argv)) {
          writeData(dependencies.stdout, JSON.stringify({
            event: 'slide.theme.error',
            reason: 'invalid-option',
            detail: string_.replace(/^error:[ \t]*/i, '').trim(),
          }))
        }
        else {
          passthrough(dependencies.stderr, string_)
        }
      },
    })
    .action(async (raw: Readonly<Record<string, unknown>>) => {
      const dependencies = buildDependencies()
      const isWantsJson = raw['json'] === true
      const directory = path.resolve(dependencies.currentDirectory, typeof raw['dir'] === 'string' ? raw['dir'] : '.')

      try {
        const { data } = await executeSlideTheme({ dir: directory }, dependencies)
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify(data))
        }
        else {
          writeHumanReport(data, dependencies.stdout, dependencies.stderr)
        }
      }
      catch (error: unknown) {
        const reason = errorToReason(error)
        const detail = formatError(error)
        if (isWantsJson) {
          writeData(dependencies.stdout, JSON.stringify({ event: 'slide.theme.error', reason, detail }))
        }
        else {
          createDiagnostics(dependencies.stderr).error(`slide theme failed: ${detail}`)
        }
        process.exitCode = 1
      }
    })
  return command
}

export function slideThemeDefaultDependencies(): SlideThemeDependencies {
  return {
    files: new NodeThemeFiles(),
    currentDirectory: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  }
}
