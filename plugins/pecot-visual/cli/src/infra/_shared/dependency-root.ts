// 実行時依存を解決するルートの切り替え。
//
// プラグイン配布の実行時依存は、bin/pecotv がデータ置き場へ作る実行用ミラーに置かれる。
// ミラーは `${データ置き場}/runtime/<deps-hash>-<src-hash>/node_modules` にある。
// wrapper は依存ルートとして `PECOTV_DEPENDENCY_ROOT`（= `${データ置き場}/runtime/current`）を渡す。
// 同梱アセット（テンプレート・アイコン・plugin.json）の起点は別物で `CLAUDE_PLUGIN_ROOT`
// （plugin-root.ts）。開発・テストで wrapper を通さないときは、従来どおり
// `CLAUDE_PLUGIN_ROOT/node_modules` が依存ルートになる。
//
// 単体配布（`npx git+https://…` で MCP サーバだけを起動する形）では、
// npx が起動のたびに `_npx/<hash>/node_modules` を作り直す。
// 重量依存は起動時 install に載せられない。
// 重量依存とは、@slidev/cli / dom-to-pptx / @slidev/parser を指す。
// 本体の実行時依存の manifest（assets/slidev/runtime/package.json）が宣言する依存も含む。
// 計測では 631MB / 37 秒かかる。
// これは MCP クライアントの接続タイムアウトを超える。
// Claude Code の MCP_TIMEOUT は既定 30000ms。
//
// そこで重量依存だけをデータ置き場の `mcp-dist/node_modules` へ置き、`setup` ツールが取得する。
// この領域は npx の作り直しの影響を受けず残る。
// chromium が `~/.cache/ms-playwright` を使うのと同じ構造になる。
// データ置き場の解決は bin/_lib.sh の plugin_data_dir_resolve と同じ。
// 順序は CLAUDE_PLUGIN_DATA → PLUGIN_DATA → 既定の場所。
// 単体配布では登録の `env` に `PLUGIN_DATA` を書くと置き場を選べる。
//
// 永続層は版を持たない固定パスなので、「解決できる」だけでは前の版の残骸と区別できない。
// install 対象の内容から導く stamp を永続層に記録し、判定で比べる
// （areRuntimeDependenciesInstalled / runtimeInstallStampPath）。
//
// 2 つの配布形態の差は、このモジュールの中に閉じる。
// 利用側は「どちらのルートに置かれているか」を知らない。

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { parse as parseYaml } from 'yaml'

const DATA_DIRECTORY_PROJECT = 'pecot-visual'

/**
データ置き場として有効な値なら、末尾の改行と CR を落とした値。無効なら undefined。

bin/_lib.sh の plugin_data_dir_normalize と同じ判定にする。
条件は、空でない絶対パスで、先頭が変数展開の書式でないこと。
実在は問わない（作成は installRuntimeDependencies が行う）。
値は trim しない（bash 側も空白を落とさない）。
*/
function normalizedDataDirectory(raw: string | undefined): string | undefined {
  const value = raw?.replace(/[\r\n]+$/, '')
  return value === undefined || value === '' || value.startsWith('${') || !path.isAbsolute(value) ? undefined : value
}

/**
データ置き場。作らずに値を返す。
有効な HOME と有効な XDG_DATA_HOME がどちらも無いときは undefined。

bin/_lib.sh の plugin_data_dir_resolve と同じ解決順で、同じ入力なら同じ結果になる。
この対応は tests/unit/infra/dependency-root.test.ts が固定する。
順序は CLAUDE_PLUGIN_DATA、PLUGIN_DATA、XDG_DATA_HOME、HOME の順。
XDG_DATA_HOME の下は `pecot/pecot-visual`、HOME の下は `.local/share/pecot/pecot-visual`。
XDG_DATA_HOME が絶対パスでなければ未設定として扱う。
HOME が使えるのは絶対パスのときだけ。
*/
export function dataDirectory(): string | undefined {
  const client = normalizedDataDirectory(process.env['CLAUDE_PLUGIN_DATA']) ?? normalizedDataDirectory(process.env['PLUGIN_DATA'])
  if (client !== undefined) return client
  const xdg = normalizedDataDirectory(process.env['XDG_DATA_HOME'])
  if (xdg !== undefined) return `${xdg}/pecot/${DATA_DIRECTORY_PROJECT}`
  const home = normalizedDataDirectory(process.env['HOME'])
  return home === undefined ? undefined : `${home}/.local/share/pecot/${DATA_DIRECTORY_PROJECT}`
}

/**
永続層のルート（`${データ置き場}/mcp-dist`）。配下の `node_modules` が単体配布の依存ルートになる。

作らずに値を返すだけで、作成は installRuntimeDependencies が行う。
プラグインの `runtime/` とは別のディレクトリなので、bin/pecotv の世代削除とは干渉しない。
置き場を決められない環境では undefined。
*/
export function runtimeDependencyRoot(): string | undefined {
  const data = dataDirectory()
  return data === undefined ? undefined : path.join(data, 'mcp-dist')
}

/**
テーマの置き場（`${データ置き場}/themes`）。置き場を決められなければ undefined。

プラグイン配布と単体配布で、データ置き場の解決（dataDirectory）が同じなので、置き場も同じ場所になる。
作らずに値を返すだけで、作成は取得（infra/slidev-theme/store.ts）が行う。
*/
export function themeStoreRoot(): string | undefined {
  const data = dataDirectory()
  return data === undefined ? undefined : path.join(data, 'themes')
}

/**
`node_modules` を持つ側のディレクトリ。`root` 自身か、`root` を `packages` に含む上位の workspace root。

`root` に `pnpm-workspace.yaml` が無いときだけ、上の dir を最大 3 つまで遡る。無関係な workspace は採らない。
*/
function nodeModulesHolder(root: string): string {
  let current = root
  for (let level = 0; level <= 3; level += 1) {
    const workspace = path.join(current, 'pnpm-workspace.yaml')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 参照先は pnpm-workspace.yaml のみ
    if (existsSync(workspace)) return level === 0 || isIncludedByWorkspace(workspace, path.relative(current, root)) ? current : root
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return root
}

/**
`pnpm-workspace.yaml` の `packages` が、workspace root からの相対パスを含むか。読めない・形が違うときは false。
*/
function isIncludedByWorkspace(workspaceFile: string, relative: string): boolean {
  let packages: unknown
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 参照先は pnpm-workspace.yaml のみ
    const parsed: unknown = parseYaml(readFileSync(workspaceFile, 'utf8'))
    packages = typeof parsed === 'object' && parsed !== null && 'packages' in parsed ? parsed.packages : undefined
  }
  catch {
    return false
  }
  if (!Array.isArray(packages)) return false
  const target = relative.split(path.sep)
  let isIncluded = false
  for (const entry of packages) {
    if (typeof entry !== 'string') continue
    const isNegated = entry.startsWith('!')
    const pattern = (isNegated ? entry.slice(1) : entry).replace(/^\.\//, '').replace(/\/$/, '').split('/')
    if (isMatchingSegments(pattern, target)) isIncluded = !isNegated
  }
  return isIncluded
}

/**
`*`（1 階層の任意の名前）と `**`（0 階層以上）だけを扱う glob の一致の判定。
*/
function isMatchingSegments(pattern: readonly string[], target: readonly string[]): boolean {
  const [head, ...rest] = pattern
  if (head === undefined) return target.length === 0
  if (head === '**') return isMatchingSegments(rest, target) || (target.length > 0 && isMatchingSegments(pattern, target.slice(1)))
  const [first, ...others] = target
  return first !== undefined && (head === '*' || head === first) && isMatchingSegments(rest, others)
}

/**
環境変数の値。未設定・空白のみは undefined。
*/
export function trimmedEnvironment(name: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- name は本ファイル内の固定文字列
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
プラグイン配布の依存ルート。

`PECOTV_DEPENDENCY_ROOT`（bin/pecotv が渡す実行用ミラー）を優先し、無ければ従来どおり
`CLAUDE_PLUGIN_ROOT`。同梱アセットの起点はここではなく resolvePluginRoot()。
*/
export function pluginDependencyRoot(): string | undefined {
  return trimmedEnvironment('PECOTV_DEPENDENCY_ROOT') ?? trimmedEnvironment('CLAUDE_PLUGIN_ROOT')
}

/**
Chromium 取得のロックと OS ライブラリ確認の印を置くディレクトリ（`${データ置き場}/runtime`）。

bin/pecotv と同じ場所にする。
依存ルートの node_modules に置くと、ミラーのハードリンク複製で別世代と inode を共有する。
bin と cli の置き場が食い違うと、確認が毎回実行され、二重取得も起きる。
求め方は、bin/pecotv が渡す `PECOTV_RUNTIME_DIR`（`runtime/<hash>`）の親。
undefined を返すのは、`PECOTV_RUNTIME_DIR` の欠落、相対パス、親の不在のとき。

呼び出し側は、従来の依存ルートの node_modules を使う。
実在しない親では、flock(1) がロックファイルを作れず exit 66 で終わり、印も書けない。
*/
export function runtimeStateDirectory(): string | undefined {
  const mirror = runningMirrorDirectory()
  if (mirror === undefined || !path.isAbsolute(mirror)) return undefined
  const runtime = path.dirname(mirror)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 親の実在確認のみ
  return existsSync(runtime) ? runtime : undefined
}

/**
Chromium 取得のロックと OS ライブラリ確認の印を置くディレクトリ。

`${データ置き場}/runtime`（runtimeStateDirectory）を優先する。
実行用ミラーを使わない場合（開発・単体配布）は、従来どおり依存ルートの node_modules。
どこにも無ければ undefined。
*/
export function stateFileDirectory(): string | undefined {
  return runtimeStateDirectory() ?? existingDependencyNodeModules()
}

/**
実行中のミラー（`PECOTV_RUNTIME_DIR`。bin/pecotv が渡す `runtime/<hash>`）。無ければ undefined。

lint のテンプレートなど、cli 自身と同じ版で揃えたいものの起点に使う。`PECOTV_DEPENDENCY_ROOT`
（`runtime/current`）は別セッションが切り替えた新版を指すので使わない。
*/
export function runningMirrorDirectory(): string | undefined {
  return trimmedEnvironment('PECOTV_RUNTIME_DIR')
}

/**
依存を探すルートを優先順に返す。プラグイン配布 → 永続層の順。

返すのは `node_modules` を持つ側のディレクトリで、`node_modules` は付けない。
`createRequire` の基準点にも npm の `--prefix` にも、この形で渡すため。
プラグイン配布を先に見るのは、永続層が併存していても、従来どおり同梱の依存を使うため。
*/
export function dependencyRoots(): readonly string[] {
  return [pluginDependencyRoot(), runtimeDependencyRoot()]
    .filter((root): root is string => root !== undefined)
}

/**
与えられたルート列のうち、`node_modules` が実在する最初のものの `node_modules`。

存在だけを見てよいのは、取得ロックの置き場所を決めるときだけ。
flock(1) は、親ディレクトリが実在しないとロックファイルを作れない。
「実行時依存が揃っているか」の判定には使わない。
そちらは areProbesResolvableWithin で、代表パッケージの解決可否を見る。
どこにも無ければ undefined。
*/
function firstExistingNodeModules(roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const candidate = path.join(nodeModulesHolder(root), 'node_modules')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 参照先は node_modules のみ
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
実在する依存ルートの `node_modules`（env 由来のプラグインルート → 永続層の順）。
*/
export function existingDependencyNodeModules(): string | undefined {
  return firstExistingNodeModules(dependencyRoots())
}

/**
talk-dir から張る `node_modules` symlink の実体を解決する。

依存ルートは env ではなく引数で受ける。
create / sync は deps 経由で依存ルートを受け取っており、その値と食い違わせないため。
依存ルートは PECOTV_DEPENDENCY_ROOT で、無ければプラグインルート。

判定は `node_modules` の実在ではなく、代表パッケージ（RUNTIME_DEPENDENCY_PROBES）が
その `node_modules` 配下から引けるかで行う。
areRuntimeDependenciesInstalled と基準を揃え、次の食い違いを避ける。
npm が版衝突で `<配布パッケージ>/node_modules` を掘った場合に、
symlink は依存を含まないツリーを指すのに、setup は永続層へ install する状態になる。
*/
export function resolveTalkDirectoryNodeModules(dependencyRoot: string): string | undefined {
  const runtimeRoot = runtimeDependencyRoot()
  const roots = runtimeRoot === undefined ? [dependencyRoot] : [dependencyRoot, runtimeRoot]
  for (const root of roots) {
    if (areProbesResolvableWithin(root)) return path.join(nodeModulesHolder(root), 'node_modules')
  }
  return undefined
}

/**
`specifier` を依存ルート起点で解決する。解決できなければ undefined。

`fromUrl`（呼び出し元モジュールの `import.meta.url`）を先に試す。
プラグイン配布と開発時の hoist 構成で、従来どおりの解決結果を保つため。
そこで見つからないときだけ依存ルートへ降りる。
*/
export function resolveDependency(specifier: string, fromUrl?: string): string | undefined {
  return resolveFrom(
    [
      ...(fromUrl === undefined ? [] : [fromUrl]),
      ...dependencyRoots().map(root => path.join(root, 'package.json')),
    ],
    specifier,
  )
}

/**
`bases` を順に `createRequire` の基準点として `specifier` を解決する。
*/
function resolveFrom(bases: readonly string[], specifier: string): string | undefined {
  for (const base of bases) {
    try {
      return createRequire(base).resolve(specifier)
    }
    catch {
      // 次の候補へ。全滅したときだけ undefined を返す。
    }
  }
  return undefined
}

/**
実行時依存が引けないときに利用者へ示す回復手段。

配布形態ごとに手段が違うため、両方を並べる。
呼び出し元は、自分がどちらの配布形態かを判定しない。
判定できるのは依存ルートの実在だけで、配布形態そのものではない。
*/
export const DEPENDENCY_RECOVERY_HINT
  = 'for the plugin distribution, delete runtime/ in the data directory and restart pecotv (the dependencies are prepared again); '
    + 'for the standalone distribution, call the `setup` tool (it fetches the runtime dependencies)'

/**
実行時依存が揃っているかの判定に使う specifier。

`package.json` を引くのは、exports を経由せずにパッケージの実在だけを見るため。
`@slidev/cli` は bin を exports に載せていない。

`@slidev/client` を含めるのは、talk-dir の symlink 先としての妥当性も同じ集合で見るため
（resolveTalkDirectoryNodeModules）。
slidev build はこの `node_modules` から client を引くので、client を欠くツリーは依存ルートとして使えない。
*/
export const RUNTIME_DEPENDENCY_PROBES: readonly string[] = [
  '@slidev/cli/package.json',
  '@slidev/client/package.json',
  '@slidev/parser/package.json',
  'dom-to-pptx',
]

/**
`root` 配下の `node_modules` から代表パッケージが全て引けるか。

解決先が当の `node_modules` 配下であることまで見る。
Node の解決は基準点の上位ディレクトリへ遡る。
これを見ないと、「祖先の node_modules から引けただけ」を「このルートに依存が揃っている」と誤判定する。
単体配布のプラグインルートは `_npx/<hash>/node_modules/<pkg>` で、祖先が起動層の node_modules になる。
比較は realpath 基準で行う。
bind mount / worktree では、論理パスと物理パスが割れるため。
*/
function areProbesResolvableWithin(root: string): boolean {
  const holder = nodeModulesHolder(root)
  const nodeModules = path.join(holder, 'node_modules')
  let physical: string
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 参照先は node_modules のみ
    physical = realpathSync(nodeModules)
  }
  catch {
    // 実在しない（= まだ取得していない）ルート。
    return false
  }
  const base = path.join(root, 'package.json')
  return RUNTIME_DEPENDENCY_PROBES.every(
    specifier => resolveFrom([base], specifier)?.startsWith(physical + path.sep) === true,
  )
}

/**
永続層に置く install stamp のファイル名（中身は infra/_shared/runtime-install.ts が決める）。
*/
const RUNTIME_STAMP_FILENAME = '.pecotv-runtime-stamp'

/**
永続層の install stamp のパス。場所を決められなければ undefined。
*/
export function runtimeInstallStampPath(): string | undefined {
  const root = runtimeDependencyRoot()
  return root === undefined ? undefined : path.join(root, RUNTIME_STAMP_FILENAME)
}

/**
永続層に記録されている stamp。無ければ undefined。
*/
function readRuntimeInstallStamp(): string | undefined {
  const stampPath = runtimeInstallStampPath()
  if (stampPath === undefined) return undefined
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 参照先は永続層直下の固定名ファイルのみ
    return readFileSync(stampPath, 'utf8').trim()
  }
  catch {
    return undefined
  }
}

/**
実行時依存が解決できる状態か。

同梱依存（プラグイン配布）を先に見る。
本モジュール自身の位置も基準に含めるのは、CLAUDE_PLUGIN_ROOT が立っていなくても、同梱の node_modules から引けるため。
env の有無で「未取得」と誤判定して、`setup` が 600MB の npm install を始めるのを防ぐ。
単体配布では、本モジュールは `_npx/<hash>/node_modules/<pkg>/cli/dist/infra/_shared/` にある。
隣の node_modules には起動層しか無いので、この基準では解決できず永続層へ降りる。

永続層は版を持たない固定パス（`${データ置き場}/mcp-dist`）なので、解決可否だけでは、
「前の版で取得したツリーが残っているだけ」を取得済みと誤判定する。
`expectedStamp`（install 対象の内容から導く印）を渡すと、永続層に記録された stamp と一致するときだけ取得済みとみなす。
同梱依存はプラグイン本体と一緒に版が動くため、stamp を見ない。
*/
export function areRuntimeDependenciesInstalled(expectedStamp?: string): boolean {
  return areBundledDependenciesResolvable() || isRuntimeLayerInstalled(expectedStamp)
}

/**
同梱依存（プラグイン配布）から実行時依存が全て引けるか。
*/
export function areBundledDependenciesResolvable(): boolean {
  const pluginRoot = pluginDependencyRoot()
  const bases = [
    import.meta.url,
    ...(pluginRoot === undefined ? [] : [path.join(pluginRoot, 'package.json')]),
  ]
  return RUNTIME_DEPENDENCY_PROBES.every(specifier => resolveFrom(bases, specifier) !== undefined)
}

/**
永続層に、期待する内容で取得した実体が揃っているか。

`expectedStamp` を省略すると解決可否だけを見る（版の同一性は問わない）。
*/
export function isRuntimeLayerInstalled(expectedStamp?: string): boolean {
  const runtimeRoot = runtimeDependencyRoot()
  return runtimeRoot !== undefined && areProbesResolvableWithin(runtimeRoot) && (expectedStamp === undefined || readRuntimeInstallStamp() === expectedStamp)
}
