// talk-dir の node_modules にテーマが今の値で張られているかを確かめ、違えば張り直す。
// あわせて、本体の生成ファイル（`vite.config.ts`・`start.mjs`）を本体の今の内容にそろえる。
// dev・convert・`sync --node-modules-only` と、移行済みの talk-dir の通常の `sync` が呼ぶ。
//
// 順は次のとおり。
// `package.json` の spec を読み、`fetchTheme` を通してから、生成ファイルをそろえる。
// そのあと印と比べ、違えば `linkNodeModules` を呼ぶ。
// 生成ファイルは、張り直しが要らない普段の起動でも、今の内容と違えば書き直す。
// 書かないのは、テーマを参照しない talk-dir、pecotv が取得しない指定（registry の版など）。
// 取得済みの置き場は stamp を比べるだけで、ネットワークには出ない。
// 比べるのは、印の依存ルート（実行用ミラーの世代）と、テーマの directory。
// 実行用ミラーの世代交代や、テーマの置き場の変更に、手で sync を打たなくても追従できる。
//
// 取得や宣言の失敗はそのまま投げる。古い node_modules で描画を続けない。
// 原因ごとの文言は、取得側の例外が持つ。reason は `themeErrorReason` で `theme-<reason>` にする。

import { SlideCreateRuntimeError } from '../../domain/slidev-project/errors.js'
import type { ThemeFiles } from '../../domain/slidev-theme/ports.js'
import { ThemeFetchError } from '../../domain/slidev-theme/store-layout.js'
import { ThemeResolveError, findTalkThemeDependency, resolveTalkTheme, themeNoneError } from '../../domain/slidev-theme/talk-theme.js'
import { ThemeSpecError, parseThemeSpec } from '../../domain/slidev-theme/theme-spec.js'
import type { ThemeSpec } from '../../domain/slidev-theme/theme-spec.js'
import type { LinkedTheme, NodeModulesThemeLink } from '../../domain/slidev-project/sync.js'
import { themeStoreRoot } from '../../infra/_shared/dependency-root.js'
import { isNodeModulesLinkCurrent, linkNodeModules, syncGeneratedFiles } from '../../infra/slidev-project/fs.js'
import { NodeThemeFiles } from '../../infra/slidev-theme/fs.js'
import { fetchTheme } from '../../infra/slidev-theme/store.js'

/**
テーマの取得に渡す、呼び出しごとの文脈。キャンセルと警告の出力先。
*/
export interface ThemeLinkContext {
  readonly signal?: AbortSignal | undefined
  readonly warn?: ((message: string) => void) | undefined
}

export interface LinkedThemeDependencies {
  readonly files: ThemeFiles
  /**
  node_modules の項目の元になる依存ルート。
  */
  readonly dependencyRoot: string
  /**
  テーマの置き場。決められないときは undefined。
  */
  readonly storeRoot: () => string | undefined
  readonly fetchTheme: typeof fetchTheme
  readonly isLinkCurrent: typeof isNodeModulesLinkCurrent
  readonly linkNodeModules: typeof linkNodeModules
  /**
  本体の生成ファイルを今の内容にそろえる。書いたファイル名を返す。
  */
  readonly syncGeneratedFiles: typeof syncGeneratedFiles
  /**
  取得中の警告の出力先。
  */
  readonly warn?: (message: string) => void
  readonly signal?: AbortSignal
}

export interface EnsureThemeLinkedResult {
  /**
  今回 node_modules を張り直したか。
  */
  readonly relinked: boolean
  /**
  今回、本体の生成ファイルを書き直したか。
  */
  readonly regenerated: boolean
  /**
  張る対象のテーマ。`theme:` が none か未指定（テーマを参照しない talk-dir）は undefined。
  */
  readonly theme: LinkedTheme | undefined
  /**
  張り直したときの、依存ルートの node_modules。張り直さなければ undefined。
  */
  readonly nodeModulesTarget: string | undefined
}

export interface EnsureThemeLinkedOptions {
  /**
  テーマを参照しない talk-dir を、`theme-none` で止めるか。
  dev・convert は止める（移行前の形は描画しない）。`sync --node-modules-only` は止めず、テーマ無しで張り直す。
  */
  readonly requireTheme?: boolean
}

/**
pecotv が取得する指定 (git / file:) ならその ThemeSpec を返す。解釈できない形 (unsupported-spec) は undefined。
タグ無しなど、取得の指定として誤っているものは ThemeSpecError のまま投げる。
*/
function parseSpecIfManaged(text: string): ThemeSpec | undefined {
  try {
    return parseThemeSpec(text)
  }
  catch (error: unknown) {
    if (error instanceof ThemeSpecError && error.reason === 'unsupported-spec') return undefined
    throw error
  }
}

/**
取得せず、張り直さないテーマ。解決できれば、その root を返す (上位の node_modules に置かれたテーマを含む)。
解決できないときは、`requireTheme` なら `theme-unlinked` で止め、そうでなければ theme を持たない。
*/
async function unmanagedTheme(
  talkDirectory: string,
  files: ThemeFiles,
  options: Readonly<EnsureThemeLinkedOptions>,
): Promise<EnsureThemeLinkedResult> {
  try {
    const resolved = await resolveTalkTheme(files, talkDirectory)
    return { relinked: false, regenerated: false, theme: { name: resolved.name, spec: resolved.spec, directory: resolved.directory }, nodeModulesTarget: undefined }
  }
  catch (error: unknown) {
    // ここへ来た時点で theme: は依存を指しているので、起こりうるのは theme-unlinked だけ。
    // dev・convert はそのまま Slidev を起こすと一般の起動失敗になり、案内が出ない。案内つきで止める。
    // sync の --node-modules-only は止めず、テーマ無しで張り直す。
    if (error instanceof ThemeResolveError && options.requireTheme !== true) {
      return { relinked: false, regenerated: false, theme: undefined, nodeModulesTarget: undefined }
    }
    throw error
  }
}

/**
talk-dir のテーマが node_modules に今の値で張られていることを保証する。
*/
export async function ensureTalkThemeLinked(
  talkDirectory: string,
  // port に AbortSignal と関数を持つため readonly にできない。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: Readonly<LinkedThemeDependencies>,
  options: Readonly<EnsureThemeLinkedOptions> = {},
): Promise<EnsureThemeLinkedResult> {
  const reference = await findTalkThemeDependency(dependencies.files, talkDirectory)
  if (reference === undefined) {
    if (options.requireTheme !== true) return { relinked: false, regenerated: false, theme: undefined, nodeModulesTarget: undefined }
    // テーマを参照しない talk-dir は theme-none で止める。
    throw await themeNoneError(dependencies.files, talkDirectory)
  }

  // git でも file: でもない指定 (registry の版など) は、pecotv が作った talk-dir ではない。
  // 依存の管理は利用者に任せ、取得せず、張り直さない。宣言が無ければ既定値で進む。
  const spec = parseSpecIfManaged(reference.spec)
  if (spec === undefined) return await unmanagedTheme(talkDirectory, dependencies.files, options)

  const storeRoot = dependencies.storeRoot()
  if (storeRoot === undefined) {
    throw new ThemeFetchError(
      'テーマの置き場を決められません。データ置き場（CLAUDE_PLUGIN_DATA）を確認してください',
      'unknown',
    )
  }
  const fetched = await dependencies.fetchTheme(spec, {
    storeRoot,
    baseDirectory: talkDirectory,
    dependencyRoot: dependencies.dependencyRoot,
    warn: dependencies.warn,
    signal: dependencies.signal,
  })
  if (fetched.name !== reference.name) {
    throw new SlideCreateRuntimeError(
      `package.json の dependencies には ${reference.name} と書かれていますが、取得したテーマの name は ${fetched.name} です。`
      + 'dependencies のキーをテーマの name に合わせてください',
      'theme-name-mismatch',
    )
  }

  // 張り直しが要らない普段の起動でも、生成ファイルは本体の今の内容にそろえる。
  const regeneratedFiles = await dependencies.syncGeneratedFiles(talkDirectory, { themeName: fetched.name })
  const isRegenerated = regeneratedFiles.length > 0
  if (isRegenerated) {
    dependencies.warn?.(
      `本体の今の内容に合わせて ${regeneratedFiles.join('・')} を書き直しました。`
      + '本体が生成するファイルなので、手での編集は残りません。Vite の追加設定は setup/vite-plugins.ts に置いてください',
    )
  }

  const link: NodeModulesThemeLink = { name: fetched.name, directory: fetched.directory }
  const theme: LinkedTheme = { ...link, spec: reference.spec }
  if (await dependencies.isLinkCurrent(talkDirectory, dependencies.dependencyRoot, [link])) {
    return { relinked: false, regenerated: isRegenerated, theme, nodeModulesTarget: undefined }
  }
  const linked = await dependencies.linkNodeModules(talkDirectory, dependencies.dependencyRoot, [link])
  return { relinked: true, regenerated: isRegenerated, theme, nodeModulesTarget: linked.nodeModulesTarget }
}

/**
実ファイル・実 git・実 pnpm で動く既定の依存。
@param dependencyRoot node_modules の項目の元になる依存ルート
@param context 取得中の警告の出力先と、キャンセルの signal
*/
export function linkedThemeDefaultDependencies(
  dependencyRoot: string,
  context: Readonly<ThemeLinkContext> = {},
): LinkedThemeDependencies {
  return {
    files: new NodeThemeFiles(),
    dependencyRoot,
    storeRoot: themeStoreRoot,
    fetchTheme,
    isLinkCurrent: isNodeModulesLinkCurrent,
    linkNodeModules,
    syncGeneratedFiles,
    ...(context.warn !== undefined && { warn: context.warn }),
    ...(context.signal !== undefined && { signal: context.signal }),
  }
}
