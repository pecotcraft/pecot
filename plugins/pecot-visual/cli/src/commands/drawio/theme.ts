// drawio url が書体と文字サイズを確かめるときの、テーマの宣言の決め方。
//
// 優先順は、`--theme`、図の祖先の talk-dir、本体の既定値。
// - `--theme git+...#tag`: 置き場から取得する（fetchTheme）。
// - `--theme file:<path>`: pecot-theme.json を直接読む。install は要らない。
// - `--theme <path>`: talk-dir かテーマ root。slides.md か pecot-theme.json が無ければ invalid-theme。
// - talk-dir: 祖先 D が slides.md を持ち、図が D/public/ の下にあるときだけ。
// 書体は常に確かめる。5 段のサイズは、talk-dir の中か `--theme` 指定のときだけ確かめる。
// 移行前の talk-dir（theme-none）は既定値で続ける。解けないテーマ（theme-unlinked・取得や宣言の失敗）は止める。
// 宣言の欠落や schema の違いの警告は、図の作者には直せない。[info] で出し、exit 3 の件数に数えない。

import path from 'node:path'

import { isRecord } from '../../domain/_shared/json.js'
import type { ThemeFontSizes, ThemeFonts } from '../../domain/drawio/url.js'
import { THEME_DECLARATION_FILE_NAME, readThemeDeclaration } from '../../domain/slidev-theme/declaration.js'
import { DEFAULT_THEME_DECLARATION } from '../../domain/slidev-theme/defaults.js'
import { findDiagramTalkDirectory } from '../../domain/slidev-theme/diagram-talk-directory.js'
import type { ThemeFiles } from '../../domain/slidev-theme/ports.js'
import { MIGRATE_ADVICE, ThemeResolveError, resolveTalkTheme } from '../../domain/slidev-theme/talk-theme.js'
import { parseThemeSpec } from '../../domain/slidev-theme/theme-spec.js'
import { themeStoreRoot } from '../../infra/_shared/dependency-root.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'
import { fetchTheme } from '../../infra/slidev-theme/store.js'
import { DrawioUrlRuntimeError, DrawioUrlUsageError } from './errors.js'

export type DrawioThemeSource = 'talk-dir' | 'option' | 'default'

/**
図の確認に使うテーマ。`fontSizes` はサイズを確かめるときだけ持つ。
*/
export interface DrawioTheme {
  readonly source: DrawioThemeSource
  /**
  テーマのパッケージ名。既定値では undefined。
  */
  readonly name: string | undefined
  readonly fonts: ThemeFonts
  readonly fontSizes: ThemeFontSizes | undefined
}

export interface DrawioThemeDependencies {
  /**
  同梱アセットの起点。dependencyRoot を省いたときの依存ルートにもなる。
  */
  readonly pluginRoot: string
  readonly dependencyRoot?: string
  readonly files?: ThemeFiles
  readonly fetchTheme?: typeof fetchTheme
  readonly themeStoreRoot?: () => string | undefined
  /**
  `--theme` の相対パスを絶対化する基準。省略時はカレント。
  */
  readonly currentDirectory?: string
  readonly signal?: AbortSignal
}

const GIT_PREFIX = 'git+'
const FILE_PREFIX = 'file:'
const SLIDES_FILE_NAME = 'slides.md'

const FALLBACK_THEME: DrawioTheme = {
  source: 'default',
  name: undefined,
  fonts: { body: DEFAULT_THEME_DECLARATION.fonts.body, eastAsian: DEFAULT_THEME_DECLARATION.fonts.eastAsian },
  fontSizes: undefined,
}

/**
`--json` と MCP の data に載せる `theme`。
*/
export function themeData(theme: Readonly<DrawioTheme>): Readonly<Record<string, unknown>> {
  return {
    source: theme.source,
    ...(theme.name !== undefined && { name: theme.name }),
    fonts: {
      body: [...theme.fonts.body],
      ...(theme.fonts.eastAsian !== undefined && { eastAsian: theme.fonts.eastAsian }),
    },
    ...(theme.fontSizes !== undefined && { fontSizes: { ...theme.fontSizes } }),
  }
}

/**
PNG 撮影のページが読み込む書体名。本文の書体に和文の書体を足す。
*/
export function themeFontNames(theme: Readonly<DrawioTheme>): readonly string[] {
  return [...theme.fonts.body, ...(theme.fonts.eastAsian === undefined ? [] : [theme.fonts.eastAsian])]
}

/**
テーマ root の宣言を読み、図の確認で使う形へ変える。宣言の警告は info で出す。
*/
async function themeFromRoot(
  files: ThemeFiles,
  source: 'talk-dir' | 'option',
  name: string,
  directory: string,
  info: (message: string) => void,
): Promise<DrawioTheme> {
  const { declaration, warnings } = await readThemeDeclaration(files, directory)
  for (const warning of warnings) info(warning)
  return {
    source,
    name,
    fonts: { body: declaration.fonts.body, eastAsian: declaration.fonts.eastAsian },
    fontSizes: declaration.fontSizes,
  }
}

/**
テーマ root の package.json の name。読めなければディレクトリ名。
*/
async function packageNameOf(files: ThemeFiles, directory: string): Promise<string> {
  const text = await files.readText(path.join(directory, 'package.json'))
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text)
      const name = isRecord(parsed) ? parsed['name'] : undefined
      if (typeof name === 'string' && name !== '') return name
    }
    catch {
      // 読めない package.json はディレクトリ名で代える
    }
  }
  return path.basename(directory)
}

async function hasTheme(files: ThemeFiles, directory: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if ((await files.readText(path.join(directory, name))) !== undefined) return true
  }
  return false
}

function invalidTheme(option: string, detail: string): DrawioUrlUsageError {
  return new DrawioUrlUsageError(`option --theme '${option}' ${detail}`, 'invalid-theme')
}

async function themeFromOption(
  option: string,
  // DI の port（関数と AbortSignal）を持つため readonly 化できない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: Readonly<DrawioThemeDependencies>,
  files: ThemeFiles,
  currentDirectory: string,
  info: (message: string) => void,
): Promise<DrawioTheme> {
  if (option.startsWith(GIT_PREFIX)) {
    const spec = parseThemeSpec(option)
    const storeRoot = (dependencies.themeStoreRoot ?? themeStoreRoot)()
    if (storeRoot === undefined) {
      throw new DrawioUrlRuntimeError(
        'テーマの置き場を決められません。データ置き場（CLAUDE_PLUGIN_DATA）を確認してください',
        'theme-unknown',
      )
    }
    const fetched = await (dependencies.fetchTheme ?? fetchTheme)(spec, {
      storeRoot,
      baseDirectory: currentDirectory,
      dependencyRoot: dependencies.dependencyRoot ?? dependencies.pluginRoot,
      signal: dependencies.signal,
      warn: info,
    })
    return await themeFromRoot(files, 'option', fetched.name, fetched.directory, info)
  }

  if (option.startsWith(FILE_PREFIX)) {
    const spec = parseThemeSpec(option)
    /* c8 ignore next 3 -- FILE_PREFIX で始まる指定は parseThemeSpec が必ず file kind にする */
    if (spec.kind !== 'file') throw invalidTheme(option, 'を解釈できません')
    const directory = path.resolve(currentDirectory, spec.path)
    if (!(await hasTheme(files, directory, [THEME_DECLARATION_FILE_NAME, 'package.json']))) {
      throw invalidTheme(option, `のテーマ ${directory} に ${THEME_DECLARATION_FILE_NAME} も package.json もありません`)
    }
    return await themeFromRoot(files, 'option', await packageNameOf(files, directory), directory, info)
  }

  const directory = path.resolve(currentDirectory, option)
  if (!(await hasTheme(files, directory, [SLIDES_FILE_NAME]))) {
    // slides.md が無い dir は、テーマ root として宣言を直接読む（talk-dir を経由しない）。
    if (await hasTheme(files, directory, [THEME_DECLARATION_FILE_NAME])) {
      return await themeFromRoot(files, 'option', await packageNameOf(files, directory), directory, info)
    }
    throw invalidTheme(
      option,
      `は talk-dir とテーマ root のどちらでもありません（${directory} に ${SLIDES_FILE_NAME} と ${THEME_DECLARATION_FILE_NAME} が無い）。`
      + 'git+https://<host>/<owner>/<repo>.git#<tag>・file:<path>・talk-dir のパスのどれかで指定してください',
    )
  }
  const resolved = await resolveTalkTheme(files, directory)
  return await themeFromRoot(files, 'option', resolved.name, resolved.directory, info)
}

/**
図の確認に使うテーマを決める。
`--theme`・図の祖先の talk-dir・既定値の順。解けないテーマは例外で止める（古い値で確かめ続けない）。
info は取得や宣言の警告と、移行前の案内の出力先。
*/
export async function resolveDrawioTheme(
  diagramPath: string,
  themeOption: string | undefined,
  // DI の port（関数と AbortSignal）を持つため readonly 化できない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: Readonly<DrawioThemeDependencies>,
  info: (message: string) => void,
): Promise<DrawioTheme> {
  const files = dependencies.files ?? new NodeThemeFiles()
  const currentDirectory = dependencies.currentDirectory ?? process.cwd()

  if (themeOption !== undefined && themeOption !== '') {
    return await themeFromOption(themeOption, dependencies, files, currentDirectory, info)
  }

  const talk = await findDiagramTalkDirectory(files, diagramPath)
  if (talk === undefined) return FALLBACK_THEME

  try {
    const resolved = await resolveTalkTheme(files, talk)
    return await themeFromRoot(files, 'talk-dir', resolved.name, resolved.directory, info)
  }
  catch (error: unknown) {
    // 移行前の talk-dir は、今は動いている図の作成を止めず、既定値で続ける。
    if (error instanceof ThemeResolveError && error.reason === 'theme-none') {
      info(
        `${talk} はテーマを参照していないため、本体の既定の書体で確かめます。${MIGRATE_ADVICE}`,
      )
      return FALLBACK_THEME
    }
    throw error
  }
}
