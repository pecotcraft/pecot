// slide_theme ツールのファサード。
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
// DI の形は slidev-project/lint.ts を踏襲する。

import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import path from 'node:path'

import {
  THEME_DECLARATION_FILE_NAME,
  readThemeDeclaration,
} from '../../domain/slidev-theme/declaration.js'
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
  // dir を省いたときの talk-dir
  readonly currentDirectory: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
}

/**
結果の `theme`。`spec` は `package.json` の dependencies の値。
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
  // 参照 yaml の絶対パスを持つ内部用の結果。MCP の data には載せない。
  // slide_page がレイアウトの参照 yaml を開くのに使う。
  readonly references: LayoutReferences
}

const LINK_COLOR_WARNING
  = 'pptx.linkColor is omitted, so links are not converted in PPTX (no hyperlinks are added) '
    + `(fix: set pptx.linkColor in ${THEME_DECLARATION_FILE_NAME} to a 6-digit hex value to convert links)`

/**
slide_theme の実処理。lint・page・convert もここを通る。

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

export function slideThemeDefaultDependencies(): SlideThemeDependencies {
  return {
    files: new NodeThemeFiles(),
    currentDirectory: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  }
}
