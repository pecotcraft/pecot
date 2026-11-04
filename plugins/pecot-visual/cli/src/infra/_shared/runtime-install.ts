// 永続層（`${データ置き場}/mcp-dist`）への実行時依存の取得。
//
// 単体配布でだけ動く。
// プラグイン配布の実行時依存は、bin/pecotv の作る実行用ミラー（wrapper が渡す `PECOTV_DEPENDENCY_ROOT`）に置かれる。
// そのため `setup` ツールは、取得済みと判定して何もしない。
// 判定は infra/_shared/dependency-root.ts の areRuntimeDependenciesInstalled が行う。
//
// 取得するパッケージの根拠は、本体が持つ実行時依存の manifest（assets/slidev/runtime/package.json）に置く。
// talk-dir は依存ルートの `node_modules` へ symlink を張って slidev build を回す。
// よって永続層に必要なのは、manifest の宣言する runtime 依存そのものになる。
// 二重管理を避けるため、ここで列挙し直さず読み取る。
// `overrides` も同じ理由で、manifest から写す。
// 本体の実行時依存は patch を持たない。テーマの patch はテーマの置き場（infra/slidev-theme/store.ts）が当てる。
//
// 読み書きするのは、runtimeDependencyRoot() 配下と、引数で渡る manifest だけ。
// 呼び出し元から任意のパスは渡らないため、本ファイル全体で security/detect-non-literal-fs-filename を disable する。
/* eslint-disable security/detect-non-literal-fs-filename */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { isRecord } from '../../domain/_shared/json.js'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import { runtimeDependencyRoot, runtimeInstallStampPath } from './dependency-root.js'
import { withFlock } from './flock.js'
import { spawnPromise } from './process.js'

/**
本体の実行時依存の manifest を置く dir。プラグインのルートからの相対パス。

単体配布の install 対象はこの dir の package.json から得る。
*/
export const RUNTIME_MANIFEST_DIRECTORY = path.join('assets', 'slidev', 'runtime')

/**
取得の上限時間 (ms)。

計測では 631MB / 455 エントリで 37 秒かかった（`.pecot/work/982/exp/persist-deps.sh`）。
chromium 取得（計測 33 秒に対し上限 300 秒）と同じだけの余裕を取る。
*/
export const RUNTIME_INSTALL_TIMEOUT_MS = 600_000

/**
slidev 中核パッケージの固定版。

manifest は `@slidev/cli` / `@slidev/client` を完全一致の版で宣言する。ただし、宣言が範囲に変わっても固定版で入れる。
永続層は `--no-package-lock` で install するため、そのまま渡すと時点ごとに別の 53.x へ解決される。
slidev の中核パッケージは、互いを完全一致の版で要求する。
npm レジストリの `@slidev/cli@53.0.0` の dependencies で確認した。
`@slidev/parser` / `@slidev/client` / `@slidev/types` を、いずれも `53.0.0` 固定で引く。
そのため cli だけが上位版へ動くと、nested に別版の parser / client が入る。
すると、pptx 差分キャッシュの slideHash を求める parser と、slidev build の parser がずれる。
cli/package.json の slidev-parser-pin-reason と同じ理由。

対処として lockfile を持たせる案もある。
ただし lockfile は「解決結果を再現する」だけで、中核パッケージ同士の版一致は保証しない。
初回解決が cli 52.16 / parser 52.15 なら、その食い違いを固定してしまう。
よって中核パッケージを同一版に固定する方を採る。
この値はプラグイン配布の構成と同じで、中核 4 本（cli / client / parser / types）とも 53.0.0 になる。
cli/package.json の `@slidev/parser` の pin と同値であることを、unit test で固定する。
`@slidev/theme-default` は別の版系列（0.25.x）なので対象に含めない。
*/
export const SLIDEV_CORE_VERSION = '53.0.0'

/**
固定版で install する slidev 中核パッケージ。
*/
const SLIDEV_CORE_PACKAGES: ReadonlySet<string> = new Set([
  '@slidev/cli',
  '@slidev/client',
  '@slidev/parser',
  '@slidev/types',
])

/**
永続層へ入れる patch-package の版。完全一致で固定する。

本体の実行時依存は patch を持たない。
patch-package を入れる理由は、テーマの置き場が使うことにある。
使う箇所は infra/slidev-theme/store.ts の applyThemePatches の中。
`resolveDependency('patch-package/package.json')` で解決する。

永続層は `--no-package-lock` で install するため、caret のままだと時点ごとに別の 8.x へ解決される。
slidev 中核パッケージと同じ理由で、検証した版だけを配る（Epic #152）。

監査 manifest（scripts/release/runtime-manifest.mjs）は同じ規則を写して、同値比較で固定している。

値は plugins/pecot-visual/package.json の devDependencies と同値にし、unit test で固定する。
*/
export const PATCH_PACKAGE_RANGE = '8.0.1'

/**
ローカル参照の依存。配布ツリーではパッケージとして解決できないので install 対象から外す。
*/
const LOCAL_PROTOCOL_PATTERN = /^(?:workspace|link|file|portal):/u

/**
package.json の依存フィールドを `名前 → range` へ narrowing する（`as` を使わない）。
*/
function dependencyMap(value: unknown): Record<string, string> {
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {}
}

/**
manifest を読む。読めない・object でないときは空の manifest 扱い。
*/
function readManifest(manifestPath: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  }
  catch {
    parsed = {}
  }
  return isRecord(parsed) ? parsed : {}
}

/**
永続層へ書く内容。specs は npm の引数、overrides は install 先 package.json へ写す。
*/
export interface RuntimeInstallPlan {
  readonly specs: readonly string[]
  readonly overrides: Readonly<Record<string, unknown>>
}

/**
永続層へ install する内容を実行時依存の manifest から組み立てる。

specs には次を入れる。
- manifest の `dependencies`。`workspace:` 等のローカル参照は除く。
- `devDependencies` の `dom-to-pptx`。pptx 変換の bundle 供給元になる。
- `@slidev/parser`。

slidev 中核パッケージは、range ではなく `SLIDEV_CORE_VERSION` で固定する。

overrides には、manifest の `overrides` をそのまま写す。
manifest は推移依存の版を overrides で pin している。
install 対象を manifest から導く設計なので、解決の pin だけ落とすと、
永続層とプラグイン配布で別の推移依存を掴む。

manifest が読めないときも、取得は諦めない。
最低限 `@slidev/parser` は返し、npm 側のエラーを呼び出し元へ見せる。
ここで空を返すと、「install は成功したのに何も入らない」という判別しづらい状態になる。
*/
export function runtimeInstallPlan(manifestPath: string): RuntimeInstallPlan {
  const manifest = readManifest(manifestPath)

  const specs = Object.entries(dependencyMap(manifest['dependencies']))
    .filter(([, range]) => !LOCAL_PROTOCOL_PATTERN.test(range))
    .map(([name, range]) => `${name}@${pinnedRange(name, range)}`)

  const domToPptx = dependencyMap(manifest['devDependencies'])['dom-to-pptx']
  if (domToPptx !== undefined) specs.push(`dom-to-pptx@${domToPptx}`)

  specs.push(`@slidev/parser@${SLIDEV_CORE_VERSION}`, `patch-package@${PATCH_PACKAGE_RANGE}`)

  const overrides = manifest['overrides']
  return {
    specs,
    overrides: isRecord(overrides) ? overrides : {},
  }
}

/**
slidev 中核パッケージは宣言 range ではなく固定版で install する。
*/
function pinnedRange(name: string, range: string): string {
  return SLIDEV_CORE_PACKAGES.has(name) ? SLIDEV_CORE_VERSION : range
}

/**
永続層へ install する specifier。
*/
export function runtimeInstallSpecs(manifestPath: string): readonly string[] {
  return runtimeInstallPlan(manifestPath).specs
}

/**
永続層の取得済み判定に使う印。install 対象（specs と overrides）の内容から導く。

永続層は版を持たない固定パスなので、利用者が新版へ上げて manifest の依存が変わっても、
「解決できる」だけでは前の版の残骸と区別できない。
印には、pecotv の版そのものではなく install 対象の内容を使う。
依存が変わらない版上げで、600MB の再取得を強いないため。
*/
export function runtimeInstallStamp(manifestPath: string): string {
  return stampOf(runtimeInstallPlan(manifestPath))
}

function stampOf(plan: Readonly<RuntimeInstallPlan>): string {
  return createHash('sha256')
    .update(JSON.stringify({
      specs: plan.specs,
      overrides: plan.overrides,
    }))
    .digest('hex')
}

/**
永続層への取得を排他するロックのパス。場所を決められなければ undefined。

chromium 側（installLockPath）は依存ルートの `node_modules` に置く。
こちらは `node_modules` を作る側なので、永続層の直下に置く（install 前に mkdir する）。
*/
export function runtimeInstallLockPath(): string | undefined {
  const root = runtimeDependencyRoot()
  return root === undefined ? undefined : path.join(root, '.pecotv-runtime-install.lock')
}

/**
失敗した段。取得は npm の 1 段だけで、失敗したときの回復手順は取得先とプロキシの確認になる。
*/
export type RuntimeInstallStage = 'npm'

/**
install の結果。失敗したときだけ failedStage が入る。
*/
export interface RuntimeInstallResult extends SpawnResult {
  readonly failedStage?: RuntimeInstallStage | undefined
}

export interface InstallRuntimeDependenciesOptions {
  /**
  実行時依存の manifest（package.json）の場所。
  */
  readonly manifestPath: string
  /**
  呼び出し元（MCP の tools/call）がキャンセルされたら取得も打ち切る。
  */
  readonly signal?: AbortSignal | undefined
  /**
  起動するパッケージマネージャ。既定は `npm`（テストが stub を差し込む）。
  */
  readonly npmCommand?: string | undefined
}

/**
永続層へ実行時依存を install する。取得先は無ければここで作る（runtimeDependencyRoot は作らない）。

`--prefix` を有効にするには、install 先に package.json が必要になる。
無いと npm は上位へ遡り、HOME 直下など意図しない場所へ書き込む。
毎回書き直すのは冪等だからで、途中終了した前回の残骸（package.json だけ欠けた状態）から復帰する意味もある。

単体配布は MCP クライアントごとに別プロセスが立つ。
そのため複数セッションからの `setup` が、同じ `node_modules` へ同時に実行され得る。
chromium 取得と同じ flock(1) で直列化する。
flock(1) が無い環境では、ロックなしで実行する。

stamp は install が成功したときにだけ置く。
先に消しておくのは、途中で失敗した install の残骸を「取得済み」と誤判定させないため。

npm 自体は、npx 経由の起動なら必ず同居する。
解決できない環境では spawnPromise が `exitCode: null` を返し、呼び出し元が理由付きの失敗として扱う。

env は利用者環境のものを引き継ぐ。
取得先と proxy の指定は利用者側の変数で行われるため、絞り込まない。
プロキシの CA は利用者が `NODE_EXTRA_CA_CERTS` で渡す。
*/
export async function installRuntimeDependencies(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal 用
  options: Readonly<InstallRuntimeDependenciesOptions>,
): Promise<RuntimeInstallResult> {
  const root = runtimeDependencyRoot()
  if (root === undefined) {
    return {
      // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
      exitCode: null,
      // eslint-disable-next-line unicorn/no-null -- 同上
      signal: null,
      stdout: '',
      stderr: 'HOME と XDG_DATA_HOME が未設定のため、実行時依存の取得先 (データ置き場の mcp-dist/) を決められません。PLUGIN_DATA に絶対パスを指定してください',
      timedOut: false,
      failedStage: 'npm',
    }
  }

  const plan = runtimeInstallPlan(options.manifestPath)

  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'pecotv-runtime',
    version: '0.0.0',
    private: true,
    ...(Object.keys(plan.overrides).length > 0 && { overrides: plan.overrides }),
  }, undefined, 2)}\n`, 'utf8')

  const stampPath = runtimeInstallStampPath()
  if (stampPath !== undefined) await rm(stampPath, { force: true })

  const locked = withFlock(runtimeInstallLockPath(), options.npmCommand ?? 'npm', [
    'install',
    '--prefix', root,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    ...plan.specs,
  ])
  const result = await spawnPromise(
    locked.command,
    locked.commandArguments,
    {
      env: process.env,
      timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS,
      signal: options.signal,
    },
  )

  if (result.exitCode !== 0) return { ...result, failedStage: 'npm' }

  if (stampPath !== undefined) {
    // 判定側と同じ内容から導く。install した plan をそのまま印にする。
    await writeFile(stampPath, `${stampOf(plan)}\n`, 'utf8')
  }
  return result
}
