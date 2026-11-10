// talk-dir が参照するテーマを探す。
// `<talk>/slides.md` の frontmatter `theme:` と、`<talk>/package.json` の `dependencies` から名前を決める。
// テーマ root（`<talk>/node_modules/<name>`）を返す。取得はしない（読み取りだけ）。
// 形の契約は specs/016-slidev-theme-split/contracts/cli-mcp.md。

import path from 'node:path'

import { parse } from 'yaml'

import { isRecord } from '../_shared/json.js'
import { THEME_DECLARATION_FILE_NAME } from './declaration.js'
import type { ThemeFiles } from './ports.js'

export type ThemeResolveErrorReason = 'theme-unlinked' | 'theme-none'

export class ThemeResolveError extends Error {
  constructor(message: string, readonly reason: ThemeResolveErrorReason) {
    super(message)
    this.name = 'ThemeResolveError'
  }
}

export interface TalkTheme {
  // パッケージ名
  readonly name: string
  // dependencies の値（`<theme-spec>`）
  readonly spec: string
  // テーマ root の絶対パス
  readonly directory: string
  // talk-dir 直下の node_modules で見つかったか。
  // 上位の node_modules（pnpm workspace の hoist など）で見つかったときは false
  readonly linked: boolean
}

const NO_THEME = 'none'

// 失敗の文言に添える、復旧の案内。CLI と MCP のどちらから呼ばれても読めるよう、両方の手順を 1 か所で持つ。
function relinkAdvice(talkDirectory: string): string {
  return `run slide sync --dir ${talkDirectory} --node-modules-only to relink`
    + ` (MCP: slide_sync with dir: ${talkDirectory}, node_modules_only: true)`
}

/**
移行前の talk-dir を止めるときの案内。CLI と MCP のどちらから読んでも打てるよう、両方の手順を持つ。
*/
export const MIGRATE_ADVICE = 'to migrate to a theme reference, run slide sync --theme <theme-spec>'
  + ' (MCP: slide_sync with theme: <theme-spec>)'

/**
`<talk>/slides.md` の frontmatter `theme:` を読む。
無い・読めない・`none` は undefined（テーマを指していない）。
*/
async function readThemeField(files: ThemeFiles, talkDirectory: string): Promise<string | undefined> {
  const text = await files.readText(path.join(talkDirectory, 'slides.md'))
  if (text === undefined) return undefined
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (match === null) return undefined
  let frontmatter: unknown
  try {
    frontmatter = parse(match[1] ?? '')
  }
  catch {
    return undefined
  }
  if (!isRecord(frontmatter)) return undefined
  const { theme } = frontmatter
  return typeof theme === 'string' && theme !== '' && theme !== NO_THEME ? theme : undefined
}

async function readDependencies(files: ThemeFiles, talkDirectory: string): Promise<ReadonlyMap<string, string>> {
  const file = path.join(talkDirectory, 'package.json')
  const text = await files.readText(file)
  if (text === undefined) {
    throw new ThemeResolveError(
      `file not found: ${file}; the theme must be in dependencies of the talk-dir package.json; `
      + relinkAdvice(talkDirectory),
      'theme-unlinked',
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ThemeResolveError(`cannot read ${file} as JSON: ${reason}; ${relinkAdvice(talkDirectory)}`, 'theme-unlinked')
  }
  const record = isRecord(raw) ? raw : {}
  const rawDependencies = isRecord(record['dependencies']) ? record['dependencies'] : {}
  const dependencies = new Map<string, string>()
  for (const [name, spec] of Object.entries(rawDependencies)) {
    if (typeof spec === 'string') dependencies.set(name, spec)
  }
  return dependencies
}

const SCOPED_THEME_PREFIX = '@slidev/theme-'
const THEME_PREFIX = 'slidev-theme-'

/**
パス形式の `theme:`（`./theme`・`../theme`・`/abs`・`@/x`・スラッシュを含む非スコープの名前）か。
Slidev はこれをパッケージ名でなくパスとして扱う。
*/
function isPathTheme(theme: string): boolean {
  const isExplicitPath = theme.startsWith('.') || theme.startsWith('/') || theme.startsWith('@/')
  return isExplicitPath || (theme.includes('/') && !theme.startsWith('@'))
}

/**
Slidev のテーマ名の解決。
`@` 始まりか `slidev-theme-` の接頭辞付きの名前は、完全な名前として候補 1 つにする。
短い名前（`default` など）は `@slidev/theme-<x>`、`slidev-theme-<x>`、`<x>` の順で探す。
*/
function candidateNames(theme: string): readonly string[] {
  return theme.startsWith('@') || theme.startsWith(THEME_PREFIX) ? [theme] : [`${SCOPED_THEME_PREFIX}${theme}`, `${THEME_PREFIX}${theme}`, theme]
}

async function isThemeRoot(files: ThemeFiles, directory: string): Promise<boolean> {
  return (await files.readText(path.join(directory, 'package.json'))) !== undefined
}

/**
Node の解決と同じく、talk-dir から上位へ `node_modules/<name>` を順に探す。
最初に `package.json` が読めた dir を返す。ルートまで無ければ undefined。
*/
async function findThemeRoot(files: ThemeFiles, talkDirectory: string, name: string): Promise<string | undefined> {
  let current = talkDirectory
  for (;;) {
    const candidate = path.join(current, 'node_modules', name)
    if (await isThemeRoot(files, candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function requireThemeDependency(
  files: ThemeFiles,
  talkDirectory: string,
  theme: string,
): Promise<{ readonly name: string, readonly spec: string }> {
  if (isPathTheme(theme)) {
    throw new ThemeResolveError(
      `theme in slides.md is a path: ${theme}; path themes are not supported by pecotv; ${MIGRATE_ADVICE}`,
      'theme-none',
    )
  }
  const dependencies = await readDependencies(files, talkDirectory)
  const name = candidateNames(theme).find(candidate => dependencies.has(candidate))
  const spec = name === undefined ? undefined : dependencies.get(name)
  if (name === undefined || spec === undefined) {
    throw new ThemeResolveError(
      `no package for the theme in slides.md is in dependencies of package.json: ${theme} `
      + `(searched names: ${candidateNames(theme).join(', ')}); add the theme to dependencies, then `
      + relinkAdvice(talkDirectory),
      'theme-unlinked',
    )
  }
  return { name, spec }
}

/**
talk-dir が `dependencies` で参照するテーマの名前と指定（spec）を返す。node_modules には触れない。
`theme:` が none か未指定（テーマを参照しない talk-dir）は undefined。
`theme:` に当たるパッケージが `dependencies` に無ければ `theme-unlinked`。
張り直しが、張られていないテーマの取得元を知るために使う。
*/
export async function findTalkThemeDependency(
  files: ThemeFiles,
  talkDirectory: string,
): Promise<{ readonly name: string, readonly spec: string } | undefined> {
  const theme = await readThemeField(files, talkDirectory)
  return theme === undefined ? undefined : await requireThemeDependency(files, talkDirectory, theme)
}

/**
talk-dir が参照するテーマの名前・指定・root を返す。
- 通常: `theme:` の名前を Slidev の解決順で `dependencies` で探し、`<talk>/node_modules/<name>` を root にする。
  無ければ上位の `node_modules/<name>` を順に探す（pnpm workspace の hoist）。
- 止める場合: root が無ければ `theme-unlinked`、テーマを指していない talk-dir は `theme-none`。
  テーマを指していない dir が `pecot-theme.json` を持つなら、テーマの dir を talk-dir として読んだ誤りなので、
  文言を分けて `theme-none` で止める。
*/
export async function resolveTalkTheme(files: ThemeFiles, talkDirectory: string): Promise<TalkTheme> {
  const theme = await readThemeField(files, talkDirectory)

  if (theme === undefined) {
    throw await themeNoneError(files, talkDirectory)
  }

  const { name, spec } = await requireThemeDependency(files, talkDirectory, theme)

  const directory = await findThemeRoot(files, talkDirectory, name)
  if (directory === undefined) {
    throw new ThemeResolveError(
      `theme not found in ${path.join(talkDirectory, 'node_modules', name)} or in any parent node_modules: ${name}; `
      + relinkAdvice(talkDirectory),
      'theme-unlinked',
    )
  }
  return { name, spec, directory, linked: directory === path.join(talkDirectory, 'node_modules', name) }
}

export type TalkThemeKind = 'migrated' | 'theme-root' | 'legacy'

/**
`pecot-theme.json` を持つ dir（テーマの dir）か。
*/
async function hasThemeDeclaration(files: ThemeFiles, directory: string): Promise<boolean> {
  return (await files.readText(path.join(directory, THEME_DECLARATION_FILE_NAME))) !== undefined
}

/**
テーマを参照していない dir を `theme-none` で止める例外。
テーマの dir（`pecot-theme.json` を持つ）なら、移行の案内ではなく、テーマの dir だと伝える文言にする。
*/
export async function themeNoneError(files: ThemeFiles, talkDirectory: string): Promise<ThemeResolveError> {
  const message = await hasThemeDeclaration(files, talkDirectory)
    ? themeRootMessage(talkDirectory)
    : `${talkDirectory} does not reference a theme (theme in slides.md is none or unset); ${MIGRATE_ADVICE}`
  return new ThemeResolveError(message, 'theme-none')
}

/**
テーマの dir を talk-dir として読んだときに止める文言。
テーマの dir を移行前の talk-dir と取り違えると、sync が layouts・components を消しうるため、文言を分けて止める。
*/
export function themeRootMessage(directory: string): string {
  return `not a talk-dir (it is a theme dir with ${THEME_DECLARATION_FILE_NAME}): ${directory}; `
    + 'create a separate talk-dir that references the theme and specify that dir'
}

/**
talk-dir がテーマをどう持つかを 3 通りに分ける。node_modules には触れない。
- `migrated`: `theme:` がパッケージ名で、`dependencies` がそれを指す。
- `theme-root`: `theme:` が none か未指定で、その dir 自身が `pecot-theme.json` を持つ。テーマの dir であり、talk-dir ではない。
  移行前に入れると、`sync --theme` が layouts・components を消しうるため、別に分けて止める。
- `legacy`: テンプレートのコピーを持つ移行前の形。`theme:` が none・未指定・パス形式で、`pecot-theme.json` が無い。
  パス形式は、`resolveTalkTheme` が `theme-none` で止める形と同じなので、ここに入れる。
`theme:` がパッケージ名なのに `dependencies` に無ければ、`theme-unlinked` で止める。
*/
export async function classifyTalkTheme(files: ThemeFiles, talkDirectory: string): Promise<TalkThemeKind> {
  const theme = await readThemeField(files, talkDirectory)
  if (theme === undefined) {
    return await hasThemeDeclaration(files, talkDirectory) ? 'theme-root' : 'legacy'
  }
  if (isPathTheme(theme)) return 'legacy'
  await requireThemeDependency(files, talkDirectory, theme)
  return 'migrated'
}
