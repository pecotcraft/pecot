// `pecotv slide sync` の domain ロジック。
//
// 役割は次の 2 つ。
// - `assertTalkDirectory`: 絶対パスチェック + dir 存在 + slides.md 存在を、usage / runtime error に振り分ける。
//   infra fs helper を呼ぶが、infra → domain の逆依存は作らない。
// - `runSlideSync`: talk-dir を 3 通りに分けて、sync の工程をオーケストレーションする。
//   移行前（テンプレートのコピーを持つ形）に `--theme` を付けると、テーマを参照する形へ移す。
//   移行済みと `--node-modules-only` は、テーマの取得と node_modules の張り直しだけを行う。
//   `pecot-theme.json` を持つテーマの dir は、移行前に入れず usage error で止める。

import path from 'node:path'

import { isThemeError } from '../slidev-theme/error-reason.js'
import { themeRootMessage, type TalkThemeKind } from '../slidev-theme/talk-theme.js'
import { SlideCreateRuntimeError } from './errors.js'
import type { ViteConfigOptions } from './generated-files.js'
import { talkPackageJsonSource } from './package-json.js'
import { setSlidesTheme } from './slides-md.js'

export type SlideSyncUsageReason
  = 'missing-option'
    | 'relative-dir'
    | 'theme-required'
    | 'theme-root'
    | 'theme-with-node-modules-only'

export type SlideSyncRuntimeReason
  = 'dir-not-found'
    | 'not-a-directory'
    | 'not-talk-dir'
    | 'migrate-failed'
    | 'symlink-failed'
    | 'unknown'

export class SlideSyncUsageError extends Error {
  constructor(message: string, readonly reason: SlideSyncUsageReason) {
    super(message)
    this.name = 'SlideSyncUsageError'
  }
}

export class SlideSyncRuntimeError extends Error {
  constructor(message: string, readonly reason: SlideSyncRuntimeReason) {
    super(message)
    this.name = 'SlideSyncRuntimeError'
  }
}

/**
node_modules に張るテーマ。`name` の項目を `directory` へ張る。
*/
export interface NodeModulesThemeLink {
  readonly name: string
  readonly directory: string
}

/**
取得して張ったテーマ。`spec` は package.json の指定。
*/
export interface LinkedTheme extends NodeModulesThemeLink {
  readonly spec: string
}

export interface NodeModulesLinkSummary {
  readonly nodeModulesTarget: string
  readonly entries: number
}

export interface SlideSyncFsAdapter {
  readonly talkDirectoryExists: (directory: string) => Promise<{ readonly exists: boolean, readonly isDirectory: boolean }>
  readonly doesSlidesMdExist: (directory: string) => Promise<boolean>
  readonly readSlidesMd: (talkDirectory: string) => Promise<string>
  readonly writeSlidesMd: (talkDirectory: string, content: string) => Promise<void>
  /**
  テンプレート由来の名前を消し、消した名前（talk-dir からの相対パス）を返す。
  */
  readonly removeTemplateEntries: (talkDirectory: string) => Promise<readonly string[]>
  readonly writePackageJson: (talkDirectory: string, content: string) => Promise<void>
  readonly syncGeneratedFiles: (talkDirectory: string, options: Readonly<ViteConfigOptions>) => Promise<readonly string[]>
  readonly linkNodeModules: (
    talkDirectory: string,
    dependencyRoot: string,
    themes: readonly NodeModulesThemeLink[],
  ) => Promise<NodeModulesLinkSummary>
}

export interface SlideSyncDomainOptions {
  readonly directory: string
  readonly nodeModulesOnly: boolean
  /**
  移行先のテーマの指定（git の指定か `file:`）。移行前の talk-dir にだけ使う。
  */
  readonly theme?: string | undefined
}

/**
sync が行った処理。`migrate` は移行前の talk-dir をテーマを参照する形へ移したこと、
`relink` はテーマの取得と node_modules の張り直しだけ。
*/
export type SlideSyncMode = 'migrate' | 'relink'

export interface SlideSyncSummary {
  readonly directory: string
  readonly nodeModulesTarget: string
  readonly nodeModulesOnly: boolean
  readonly mode: SlideSyncMode
  /**
  張ったテーマ。`spec` は package.json に書いた指定。テーマを参照しない talk-dir の張り直しでは undefined。
  */
  readonly theme: LinkedTheme | undefined
  /**
  移行で消した名前（talk-dir からの相対パス）。移行以外は空。
  */
  readonly removed: readonly string[]
  /**
  利用者に伝える警告。テーマの宣言の警告と、使わなかった `--theme`。
  */
  readonly warnings: readonly string[]
}

/**
talk-dir マーカー検証。
- 絶対パスでない: `relative-dir` (usage error / exit 2)。
- 存在しない: `dir-not-found` (runtime error / exit 1)。
- ディレクトリでない: `not-a-directory` (runtime error / exit 1)。
- `slides.md` を含まない: `not-talk-dir` (runtime error / exit 1)。
  誤って ~/Documents に sync を撒かないための marker check。
*/
export async function assertTalkDirectory(
  directory: string,
  fs: Readonly<Pick<SlideSyncFsAdapter, 'talkDirectoryExists' | 'doesSlidesMdExist'>>,
): Promise<void> {
  if (!path.isAbsolute(directory)) {
    throw new SlideSyncUsageError(
      `--dir には絶対パスを指定してください (受け取った値: '${directory}')`,
      'relative-dir',
    )
  }

  const info = await fs.talkDirectoryExists(directory)
  if (!info.exists) {
    throw new SlideSyncRuntimeError(
      `'${directory}' はディレクトリとして存在しません`,
      'dir-not-found',
    )
  }
  if (!info.isDirectory) {
    throw new SlideSyncRuntimeError(
      `'${directory}' はディレクトリではありません`,
      'not-a-directory',
    )
  }

  const hasSlidesMd = await fs.doesSlidesMdExist(directory)
  if (!hasSlidesMd) {
    throw new SlideSyncRuntimeError(
      `'${directory}' に slides.md が無いため talk-dir として扱えません。`
      + ' pecotv slide create で作成された talk-dir を指定してください。',
      'not-talk-dir',
    )
  }
}

/**
張り直しだけを行う sync（`--node-modules-only` と移行済みの talk-dir）が、テーマの取得と張り直しを任せる港。
`theme` は張る対象のテーマで、テーマを参照しない talk-dir（`theme: none`）は undefined。
`relinked` が true なら、すでに張り直しを終えている（`nodeModulesTarget` を持つ）。
`regenerated` が true なら、本体の生成ファイル（`vite.config.ts`・`start.mjs`）を書き直している。
*/
export type EnsureThemeLinkedPort = (talkDirectory: string) => Promise<{
  readonly relinked: boolean
  readonly regenerated: boolean
  readonly theme: LinkedTheme | undefined
  readonly nodeModulesTarget: string | undefined
}>

/**
取得して宣言を確かめた、移行先のテーマ。
*/
export interface PreparedTheme {
  readonly name: string
  /**
  テーマ root の絶対パス。
  */
  readonly directory: string
  /**
  talk-dir の package.json の `dependencies` に書く指定。
  */
  readonly spec: string
  /**
  宣言を読んだときの警告。
  */
  readonly warnings: readonly string[]
}

/**
`--theme` の指定を解釈し、依存ルートを確かめ、テーマを取得し、宣言を読む。何も書き換えない。
*/
export type PrepareThemePort = (themeSpec: string, talkDirectory: string) => Promise<PreparedTheme>

export interface SlideSyncDependencies {
  readonly dependencyRoot: string
  readonly fs: SlideSyncFsAdapter
  readonly ensureThemeLinked: EnsureThemeLinkedPort
  /**
  talk-dir を移行済み・テーマの dir・移行前に分ける。
  判定の失敗（package.json が読めないなど）は、何も書き換えずそのまま呼び出し元へ返す。
  */
  readonly classifyTalk: (talkDirectory: string) => Promise<TalkThemeKind>
  readonly prepareTheme: PrepareThemePort
}

function themeRequiredMessage(directory: string): string {
  return `${directory} はテーマを参照していない移行前の talk-dir です。移行するテーマを指定してください: `
    + `slide sync --dir ${directory} --theme <theme-spec>`
    + `（MCP では slide_sync の dir: ${directory}, theme: <theme-spec>）`
}

const IGNORED_THEME_WARNING = '--theme は使いませんでした。この talk-dir はすでにテーマを参照しています。'
  + 'テーマや版を替えるときは、package.json の依存を書き換えてから sync してください'

/**
sync の工程。talk-dir を 3 通りに分けて進める。

- `--node-modules-only`: 分けずに、テーマの取得と node_modules の張り直しだけを行う。
  移行前の talk-dir は、テーマ無しで張り直す。`--theme` との同時指定は usage error。
- 移行済み: 張り直しだけを行う。依存の版を書き換えてから打てば、その版のテーマで張り直す。
  `--theme` を付けても使わず、警告に出す。
- テーマの dir（`pecot-theme.json` を持つ）: 何も書き換えず usage error で止める。
  移行前に入れると、layouts・components を消しうるため。
- 移行前: `--theme` が必須（無ければ usage error）。次の順で移す。
  1. `prepareTheme` が指定の解釈・依存ルートの確認・取得・宣言の読み取りを済ませる。
  2. slides.md と package.json の新しい中身を組み立てる。
  3. ここまでで失敗したら何も消さない。
  4. テンプレート由来の名前を消し、slides.md の `theme:`・package.json・生成ファイルを書く。
  5. テーマ付きで node_modules を張る。
*/
export async function runSlideSync(
  options: Readonly<SlideSyncDomainOptions>,
  dependencies: Readonly<SlideSyncDependencies>,
): Promise<SlideSyncSummary> {
  await assertTalkDirectory(options.directory, dependencies.fs)

  if (options.nodeModulesOnly) {
    if (options.theme !== undefined) {
      throw new SlideSyncUsageError(
        '--node-modules-only と --theme は同時に指定できません。'
        + 'node_modules の張り直しだけなら --node-modules-only を、移行なら --theme を指定してください',
        'theme-with-node-modules-only',
      )
    }
    return await relink(options, dependencies, [])
  }

  // 判定の失敗は握らない。握って進むと、利用者の依存の行が失われる。
  const kind = await dependencies.classifyTalk(options.directory)
  if (kind === 'migrated') {
    return await relink(options, dependencies, options.theme === undefined ? [] : [IGNORED_THEME_WARNING])
  }
  if (kind === 'theme-root') {
    throw new SlideSyncUsageError(themeRootMessage(options.directory), 'theme-root')
  }
  if (options.theme === undefined) {
    throw new SlideSyncUsageError(themeRequiredMessage(options.directory), 'theme-required')
  }
  return await migrate(options.directory, options.theme, dependencies)
}

/**
テーマの取得と node_modules の張り直しだけを行う。他のファイルは変えない。
*/
async function relink(
  options: Readonly<SlideSyncDomainOptions>,
  dependencies: Readonly<SlideSyncDependencies>,
  warnings: readonly string[],
): Promise<SlideSyncSummary> {
  let nodeModulesTarget: string
  let theme: LinkedTheme | undefined
  try {
    // テーマの失敗（取得・宣言・指定）は、原因ごとの文言のまま呼び出し元へ返す。
    const ensured = await dependencies.ensureThemeLinked(options.directory)
    theme = ensured.theme
    if (ensured.relinked && ensured.nodeModulesTarget !== undefined) {
      nodeModulesTarget = ensured.nodeModulesTarget
    }
    else {
      // 取得済みで印が今の値と同じだったとき、またはテーマ無し。張り直しを求められているので、張り直す。
      const themes = theme === undefined ? [] : [{ name: theme.name, directory: theme.directory }]
      const linked = await dependencies.fs.linkNodeModules(options.directory, dependencies.dependencyRoot, themes)
      nodeModulesTarget = linked.nodeModulesTarget
    }
  }
  catch (error: unknown) {
    throw wrapLinkError(error)
  }
  return {
    directory: options.directory,
    nodeModulesTarget,
    nodeModulesOnly: options.nodeModulesOnly,
    mode: 'relink',
    theme,
    removed: [],
    warnings,
  }
}

async function migrate(
  directory: string,
  themeSpec: string,
  dependencies: Readonly<SlideSyncDependencies>,
): Promise<SlideSyncSummary> {
  // 取得まで済ませる。ここで失敗しても、何も書き換えていない。
  const prepared = await dependencies.prepareTheme(themeSpec, directory)
  const packageJson = talkPackageJsonSource({
    name: path.basename(path.resolve(directory)),
    themeName: prepared.name,
    themeSpec: prepared.spec,
  })

  let removed: readonly string[]
  try {
    const slidesMd = setSlidesTheme(await dependencies.fs.readSlidesMd(directory), prepared.name)
    removed = await dependencies.fs.removeTemplateEntries(directory)
    await dependencies.fs.writeSlidesMd(directory, slidesMd)
    await dependencies.fs.writePackageJson(directory, packageJson)
    await dependencies.fs.syncGeneratedFiles(directory, { themeName: prepared.name })
  }
  catch (error: unknown) {
    if (error instanceof SlideSyncRuntimeError || error instanceof SlideSyncUsageError) throw error
    throw new SlideSyncRuntimeError(`移行に失敗しました: ${formatError(error)}`, 'migrate-failed')
  }

  let nodeModulesTarget: string
  try {
    const link: NodeModulesThemeLink = { name: prepared.name, directory: prepared.directory }
    const linked = await dependencies.fs.linkNodeModules(directory, dependencies.dependencyRoot, [link])
    nodeModulesTarget = linked.nodeModulesTarget
  }
  catch (error: unknown) {
    throw wrapLinkError(error)
  }

  return {
    directory,
    nodeModulesTarget,
    nodeModulesOnly: false,
    mode: 'migrate',
    theme: { name: prepared.name, directory: prepared.directory, spec: prepared.spec },
    removed,
    warnings: prepared.warnings,
  }
}

/**
張り直しの失敗を、原因を持つ例外はそのまま、それ以外は symlink-failed に包んで返す。
*/
function wrapLinkError(error: unknown): Error {
  if (error instanceof SlideSyncRuntimeError || error instanceof SlideSyncUsageError) return error
  if (isThemeError(error)) return error
  // theme-name-mismatch など、原因の文言を持つ例外は包み直さない。
  if (error instanceof SlideCreateRuntimeError) return error
  return new SlideSyncRuntimeError(
    `node_modules の張り直しに失敗しました: ${formatError(error)}`,
    'symlink-failed',
  )
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */
