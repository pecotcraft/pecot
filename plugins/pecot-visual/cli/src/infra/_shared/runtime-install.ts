// 永続層（`${データ置き場}/mcp-dist`）への実行時依存の取得。単体配布でだけ動く。
// 取得対象は assets/slidev/runtime/package.json から読み、ここで列挙し直さない。
//
// 読み書きするのは、runtimeDependencyRoot() 配下と、引数で渡る manifest だけ。任意のパスは渡らない。
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
*/
export const RUNTIME_MANIFEST_DIRECTORY = path.join('assets', 'slidev', 'runtime')

/**
取得の上限時間 (ms)。計測 37 秒（631MB）に対し、chromium 取得と同じ約 10 倍の余裕を取る。
*/
export const RUNTIME_INSTALL_TIMEOUT_MS = 600_000

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
永続層へ入れる patch-package の版（完全一致）。テーマの patch 適用が使う。
plugins/pecot-visual/package.json の devDependencies と同値で、unit test が固定する。
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
manifest を読む。読めない・object でないときは空の manifest 扱い（版が無いので呼び出し側が throw する）。
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
slidev 中核パッケージは manifest の `@slidev/cli` の版で固定し、overrides は manifest から写す。
manifest が読めない、または `@slidev/cli` の版が無い・空のときは配布の破損として throw する（版なしの install を避ける）。
*/
export function runtimeInstallPlan(manifestPath: string): RuntimeInstallPlan {
  const manifest = readManifest(manifestPath)

  const dependencies = dependencyMap(manifest['dependencies'])
  const coreVersion = dependencies['@slidev/cli']
  if (coreVersion === undefined || coreVersion === '') {
    throw new Error(`${manifestPath} の dependencies に @slidev/cli の版指定がありません（配布物の破損）`)
  }

  const specs = Object.entries(dependencies)
    .filter(([, range]) => !LOCAL_PROTOCOL_PATTERN.test(range))
    .map(([name, range]) => `${name}@${pinnedRange(name, range, coreVersion)}`)

  const domToPptx = dependencyMap(manifest['devDependencies'])['dom-to-pptx']
  if (domToPptx !== undefined) specs.push(`dom-to-pptx@${domToPptx}`)

  specs.push(`@slidev/parser@${coreVersion}`, `patch-package@${PATCH_PACKAGE_RANGE}`)

  const overrides = manifest['overrides']
  return {
    specs,
    overrides: isRecord(overrides) ? overrides : {},
  }
}

/**
slidev 中核パッケージは宣言 range ではなく coreVersion（`@slidev/cli` の版）で、それ以外は宣言 range で install する。
*/
function pinnedRange(name: string, range: string, coreVersion: string): string {
  return SLIDEV_CORE_PACKAGES.has(name) ? coreVersion : range
}

/**
永続層へ install する specifier。
*/
export function runtimeInstallSpecs(manifestPath: string): readonly string[] {
  return runtimeInstallPlan(manifestPath).specs
}

/**
永続層の取得済み判定に使う印。install 対象（specs と overrides）の内容から導く。
pecotv の版ではなく内容を使うのは、依存が変わらない版上げで 600MB の再取得を避けるため。
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
`node_modules` を作る側なので、chromium 側と違い永続層の直下に置く。
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
永続層へ実行時依存を install する。取得先は無ければここで作る。
`--prefix` を使うには install 先に package.json が要る（無いと npm は上位へ遡る）ので、毎回書き直す。
複数セッションの `setup` が並走し得るため、flock(1) で直列化する（無い環境ではロックなし）。
stamp は成功時だけ置き、先に消す。途中で失敗した残骸を取得済みと誤判定させないため。
manifest から plan を組めないときは、起動失敗（exitCode: null, failedStage: 'npm'）として返す。
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

  let plan: RuntimeInstallPlan
  try {
    plan = runtimeInstallPlan(options.manifestPath)
  }
  catch (error) {
    return {
      // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
      exitCode: null,
      // eslint-disable-next-line unicorn/no-null -- 同上
      signal: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      failedStage: 'npm',
    }
  }

  // 配布時に catalog: は範囲へ置き換わる。残っていれば npm は解決できないので、起動せずに配布物の破損として返す。
  const unresolved = plan.specs.filter(spec => /^.+@catalog:/u.test(spec))
  if (unresolved.length > 0) {
    return {
      // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
      exitCode: null,
      // eslint-disable-next-line unicorn/no-null -- 同上
      signal: null,
      stdout: '',
      stderr: `${options.manifestPath} の依存が catalog: のままです: ${unresolved.join(', ')}（配布物の破損。配布時に範囲へ置き換わっていません）`,
      timedOut: false,
      failedStage: 'npm',
    }
  }

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
