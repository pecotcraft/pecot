// テーマの置き場（ThemeStore）への取得。
//
// git kind は `${storeRoot}/<hash>/<tag>/` に、取得物（`package/`）と `stamp.json` を置く。
// 手順は git でタグだけを解決し、pnpm で依存を入れ、patch を当て、stamp を書いて rename で置く。
// 途中で失敗したものは一時ディレクトリごと消すので、半端な置き場は残らない。
// file kind は置き場に取り込まず、作り手のディレクトリの実体を指す。
//
// 置き場の形・stamp・失敗の分類は domain/slidev-theme/store-layout.ts にある。
// ここは外部 I/O（git・pnpm・patch-package の子プロセスとファイル）を担う。
//
// 子プロセスは runner（spawnPromise と同じ signature）で起こす。テストは呼び出しを数えるために差し替える。
// 読み書きするのは呼び出し元が渡す storeRoot と baseDirectory の配下だけ。
// そのため本ファイル全体で security/detect-non-literal-fs-filename を disable する。
/* eslint-disable security/detect-non-literal-fs-filename */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { compareStrings } from '../../domain/_shared/compare-strings.js'
import { isRecord } from '../../domain/_shared/json.js'
import type { PatchDigest } from '../../domain/_shared/patch-digest.js'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import {
  classifyGitFailure,
  computeInputsHash,
  gitFailureAdvice,
  parseThemeStamp,
  ThemeFetchError,
  type ThemeFetchErrorReason,
  themeStoreDirectory,
  type ThemeStamp,
  type ThemeStoreSpec,
} from '../../domain/slidev-theme/store-layout.js'
import type { ThemeSpec } from '../../domain/slidev-theme/theme-spec.js'
import { resolveDependency } from '../_shared/dependency-root.js'
import { LOCK_CONFLICT_EXIT_CODE, withFlock } from '../_shared/flock.js'
import { applyPatches, scanPatchDigests } from '../_shared/patch-apply.js'
import { resolvePluginRoot } from '../_shared/plugin-root.js'
import { resolvePnpmCommand } from '../_shared/pnpm.js'
import { spawnPromise, type SpawnPromiseOptions } from '../_shared/process.js'

/**
子プロセスを起こす港。既定は spawnPromise。
*/
export type ThemeStoreRunner = (
  command: string,
  commandArguments: readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- spawnPromise に合わせる
  options: SpawnPromiseOptions,
) => Promise<SpawnResult>

export interface FetchThemeOptions {
  /**
  置き場のルート（`themeStoreRoot()` の値）。
  */
  readonly storeRoot: string
  /**
  file kind の相対パスを解く基準（talk-dir）。
  */
  readonly baseDirectory: string
  /**
  本体の依存ルート。patch-package の解決と、同名の依存の検出に使う。
  */
  readonly dependencyRoot: string
  readonly runner?: ThemeStoreRunner | undefined
  readonly signal?: AbortSignal | undefined
  /**
  警告の出力先。既定は出さない。
  */
  readonly warn?: ((message: string) => void) | undefined
}

export interface FetchedTheme {
  /**
  テーマの package.json の name。`node_modules/<name>` の項目名になる。
  */
  readonly name: string
  /**
  テーマ本体のディレクトリ（git kind は `<置き場>/package`、file kind は実体）。
  */
  readonly directory: string
  /**
  stamp で再利用したか。
  */
  readonly reused: boolean
}

/**
子プロセス 1 本あたりの上限時間 (ms)。実行時依存の取得（631MB で 37 秒）に合わせた余裕を取る。
*/
const FETCH_TIMEOUT_MS = 600_000

/**
クラッシュで残った一時ディレクトリとみなす経過時間 (ms)。
他プロセスが取得中の一時ディレクトリを消さないよう、子プロセスの上限より十分長く取る。
*/
const STALE_TEMPORARY_AGE_MS = 60 * 60 * 1000

const PNPM_INSTALL_ARGUMENTS: readonly string[] = [
  'install',
  '--prod',
  '--ignore-scripts',
  '--ignore-workspace',
  '--config.auto-install-peers=false',
  '--config.node-linker=hoisted',
  '--config.pm-on-fail=ignore',
  // CI=true では pnpm が frozen-lockfile を既定にする。同梱の lock がずれていても、置き場の中で更新して通す。
  '--config.frozen-lockfile=false',
  // 既定の hard link では、patch が pnpm の store（と file: の元ディレクトリ）の実体を書き換える。コピーで入れる。
  '--config.package-import-method=copy',
]

const GIT_ENVIRONMENT_REMOVED: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']

/**
テーマを置き場へ取得する。取得済みで中身が合えば再利用する。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal と関数を持つ
export async function fetchTheme(spec: Readonly<ThemeSpec>, options: Readonly<FetchThemeOptions>): Promise<FetchedTheme> {
  return spec.kind === 'file' ? referenceLocalTheme(spec.path, options) : fetchGitTheme(spec, options)
}

interface PackageManifest {
  readonly name: string | undefined
  /**
  package.json の `dependencies` のキー。推移依存は含まない。
  */
  readonly dependencyNames: readonly string[]
}

// npm のパッケージ名の 1 区間の規則。先頭に . と _ は使えない。
const PACKAGE_NAME_SEGMENT = /^[a-z0-9~-][a-z0-9._~-]*$/u

/**
npm のパッケージ名か。/ は `@scope/name` の 1 個だけ許す。
*/
function isPackageName(name: string): boolean {
  const segments = name.startsWith('@') ? name.slice(1).split('/') : [name]
  const expected = name.startsWith('@') ? 2 : 1
  return segments.length === expected && segments.every(segment => PACKAGE_NAME_SEGMENT.test(segment))
}

function parseManifest(text: string): PackageManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    parsed = undefined
  }
  if (!isRecord(parsed)) return { name: undefined, dependencyNames: [] }
  const dependencies = parsed['dependencies']
  return {
    name: typeof parsed['name'] === 'string' && parsed['name'] !== '' ? parsed['name'] : undefined,
    dependencyNames: isRecord(dependencies) ? Object.keys(dependencies) : [],
  }
}

function requireName(manifest: Readonly<PackageManifest>, directory: string): string {
  if (manifest.name === undefined) {
    throw new ThemeFetchError(`theme package.json has no name: ${directory}`, 'unknown')
  }
  if (!isPackageName(manifest.name)) {
    throw new ThemeFetchError(`theme package.json name is not a valid package name: ${manifest.name}`, 'unknown')
  }
  return manifest.name
}

/**
file kind。置き場に取り込まず、実体を指す。install はしない（作り手の node_modules を壊さない）。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal と関数を持つ
async function referenceLocalTheme(themePath: string, options: Readonly<FetchThemeOptions>): Promise<FetchedTheme> {
  const directory = path.resolve(options.baseDirectory, themePath)
  let text: string
  try {
    text = await readFile(path.join(directory, 'package.json'), 'utf8')
  }
  catch {
    throw new ThemeFetchError(`theme directory has no package.json: ${directory}`, 'unknown')
  }
  const manifest = parseManifest(text)
  if (manifest.dependencyNames.length > 0 && !existsSync(path.join(directory, 'node_modules'))) {
    throw new ThemeFetchError(`node_modules not found in the theme directory: ${directory} (fix: run install there)`, 'install')
  }
  return { name: requireName(manifest, directory), directory, reused: false }
}

/**
置き場が取得済みとして使えるか。使えるなら name を返す。

stamp の spec が一致し、置き場の実体から再計算した inputsHash が一致するときだけ使う。
dependencies を持つときは `package/node_modules/.modules.yaml` の存在も見る。
利用者が node_modules だけ消した置き場を、取得済みにしないため。
*/
async function reusableName(directory: string, spec: Readonly<ThemeStoreSpec>): Promise<string | undefined> {
  let stamp: ThemeStamp | undefined
  let manifestText: string
  try {
    stamp = parseThemeStamp(await readFile(path.join(directory, 'stamp.json'), 'utf8'))
    manifestText = await readFile(path.join(directory, 'package', 'package.json'), 'utf8')
  }
  catch {
    return undefined
  }
  if (stamp?.spec.url !== spec.url || stamp.spec.tag !== spec.tag) return undefined
  const scan = scanPatchDigests(path.join(directory, 'package', 'patches'))
  if (scan.error !== undefined || computeInputsHash(manifestText, scan.digests) !== stamp.inputsHash) return undefined
  const manifest = parseManifest(manifestText)
  return manifest.dependencyNames.length > 0 && !existsSync(path.join(directory, 'package', 'node_modules', '.modules.yaml')) ? undefined : manifest.name
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }
  for (const name of GIT_ENVIRONMENT_REMOVED) Reflect.deleteProperty(environment, name)
  return environment
}

/**
git kind。
*/
async function fetchGitTheme(
  spec: Readonly<ThemeSpec & { kind: 'git' }>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal と関数を持つ
  options: Readonly<FetchThemeOptions>,
): Promise<FetchedTheme> {
  const storeSpec: ThemeStoreSpec = { url: spec.url, tag: spec.tag }
  const directory = themeStoreDirectory(options.storeRoot, storeSpec)
  const hashDirectory = path.dirname(directory)
  await mkdir(hashDirectory, { recursive: true })

  const cached = await reusableName(directory, storeSpec)
  if (cached !== undefined) return reusedTheme(directory, cached)

  await removeStaleTemporaries(hashDirectory, spec.tag)

  // 使えない置き場（途中で止まった、書き換えられた）は、place が rename の行き先を空けて置き直す。
  const temporary = await mkdtemp(path.join(hashDirectory, `.${spec.tag}.tmp-`))
  try {
    const populated = await populate({
      storeSpec,
      directory,
      temporary,
      lockPath: path.join(hashDirectory, `.${spec.tag}.lock`),
      pluginRoot: resolvePluginRoot(),
    }, options)
    if (populated.adopted) {
      await rm(temporary, { recursive: true, force: true })
      return reusedTheme(directory, populated.name)
    }
    return await place(temporary, directory, storeSpec, populated.name)
  }
  catch (error) {
    await rm(temporary, { recursive: true, force: true })
    await removeEmptyHashDirectory(hashDirectory)
    throw error
  }
}

function reusedTheme(directory: string, name: string): FetchedTheme {
  return { name, directory: path.join(directory, 'package'), reused: true }
}

interface PopulateContext {
  readonly storeSpec: Readonly<ThemeStoreSpec>
  /**
  置き場の行き先（`<hash>/<tag>`）。別プロセスが先に置いたかの再確認に使う。
  */
  readonly directory: string
  readonly temporary: string
  readonly lockPath: string
  readonly pluginRoot: string
}

interface Populated {
  readonly name: string
  /**
  別プロセスが先に置いた有効な置き場を使うことにした。temporary の中身は使わない。
  */
  readonly adopted: boolean
}

/**
取得物を一時ディレクトリの中に作る。成功したら name を返す。
時間のかかる pnpm と patch の前に行き先を確かめ、別プロセスが先に置いていれば、そこで打ち切って既存を使う。
*/
async function populate(
  context: Readonly<PopulateContext>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal と関数を持つ
  options: Readonly<FetchThemeOptions>,
): Promise<Populated> {
  const { storeSpec, directory, temporary, lockPath, pluginRoot } = context
  const packageDirectory = path.join(temporary, 'package')
  await mkdir(packageDirectory)

  const run = async (
    command: string,
    commandArguments: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string = packageDirectory,
  ): Promise<SpawnResult> => {
    const locked = withFlock(lockPath, command, commandArguments)
    return (options.runner ?? spawnPromise)(locked.command, locked.commandArguments, {
      cwd,
      env: environment,
      timeoutMs: FETCH_TIMEOUT_MS,
      signal: options.signal,
    })
  }
  const placedElsewhere = async (): Promise<Populated | undefined> => {
    const existing = await reusableName(directory, storeSpec)
    return existing === undefined ? undefined : { name: existing, adopted: true }
  }

  await fetchTag(storeSpec, packageDirectory, run)

  // pnpm は package.json が無いと自分の言葉で失敗する。先に読んで、原因をそのまま伝える。
  const manifestText = await readManifestText(packageDirectory)
  // 名前が使えないテーマは、依存を入れる前に止める。
  const name = requireName(parseManifest(manifestText), packageDirectory)

  const beforePnpm = await placedElsewhere()
  if (beforePnpm !== undefined) return beforePnpm
  const pnpm = resolvePnpmCommand(pluginRoot, packageDirectory)
  // cwd がテーマ側のため、テーマの packageManager で corepack が止まらないようにする。
  // npx を使うときは cwd を / にする（テーマの devEngines で npm が止まらないようにする）。対象は --dir で渡す。
  const installed = await run(
    pnpm.command,
    [...pnpm.commandArguments, ...PNPM_INSTALL_ARGUMENTS],
    { ...process.env, COREPACK_ENABLE_STRICT: '0' },
    pnpm.cwd,
  )
  assertStarted(installed, 'pnpm', 'install')
  if (installed.exitCode !== 0) throw installFailure('failed to fetch the theme dependencies with pnpm', installed)

  const patchesDirectory = path.join(packageDirectory, 'patches')
  const scan = scanPatchDigests(patchesDirectory)
  if (scan.error !== undefined) throw new ThemeFetchError(scan.error, 'install')
  const beforePatch = await placedElsewhere()
  if (beforePatch !== undefined) return beforePatch
  await applyThemePatches(packageDirectory, patchesDirectory, scan.digests, lockPath, options)

  await warnSameNameDependencies(parseManifest(manifestText).dependencyNames, options)

  const stamp: ThemeStamp = {
    spec: storeSpec,
    fetchedAt: new Date().toISOString(),
    inputsHash: computeInputsHash(manifestText, scan.digests),
  }
  await writeFile(path.join(temporary, 'stamp.json'), `${JSON.stringify(stamp, undefined, 2)}\n`, 'utf8')
  return { name, adopted: false }
}

type Run = (command: string, commandArguments: readonly string[], environment: Readonly<NodeJS.ProcessEnv>) => Promise<SpawnResult>

/**
git でタグだけを解決する。`git clone --branch` は同名のブランチを優先するため使わない。
annotated tag でも FETCH_HEAD はコミットへ剥がれる。
*/
async function fetchTag(spec: Readonly<ThemeStoreSpec>, packageDirectory: string, run: Run): Promise<void> {
  const environment = gitEnvironment()
  const steps: readonly (readonly string[])[] = [
    ['init', '-q'],
    ['-c', 'advice.detachedHead=false', 'fetch', '-q', '--depth', '1', spec.url, `refs/tags/${spec.tag}`],
    ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', 'FETCH_HEAD'],
  ]
  for (const step of steps) {
    const result = await run('git', step, environment)
    assertStarted(result, 'git', 'connection')
    if (result.exitCode === 0) continue
    const kind = classifyGitFailure(result.stderr)
    throw new ThemeFetchError(`${gitFailureAdvice(kind, spec)}\n${result.stderr.trim()}`, kind)
  }
  // 取得物に .git は要らない。置き場の中身を取得物だけにする。
  await rm(path.join(packageDirectory, '.git'), { recursive: true, force: true })
}

async function readManifestText(packageDirectory: string): Promise<string> {
  try {
    return await readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  }
  catch {
    throw new ThemeFetchError('theme repository has no package.json at its root', 'install')
  }
}

function installFailure(summary: string, result: Readonly<SpawnResult>): ThemeFetchError {
  return new ThemeFetchError(`${summary}\n${result.stderr.trim()}`, 'install')
}

/**
終了コードの文言で分ける前に、ロック待ちの超過・時間切れ・起動失敗を、対処付きの失敗にする。
timedOutReason は時間切れの分類。git は接続の待ちなので connection、それ以外は install。
*/
function assertStarted(result: Readonly<SpawnResult>, tool: string, timedOutReason: ThemeFetchErrorReason): void {
  if (result.exitCode === LOCK_CONFLICT_EXIT_CODE) {
    throw new ThemeFetchError('another process is fetching the same theme; wait for it to finish and run again', 'install')
  }
  if (result.timedOut) {
    throw new ThemeFetchError(`${tool} timed out; check the network and run again`, timedOutReason)
  }
  if (result.exitCode !== null) return
  const detail = result.stderr.trim()
  throw new ThemeFetchError(`cannot start ${tool}; check that it is installed${detail === '' ? '' : `\n${detail}`}`, 'install')
}

/**
package/patches/ のパッチを当てる。パッチが無ければ何もしない。
patch-package の実体は本体の依存から解決する。解決できなければ install の失敗として返す。
*/
async function applyThemePatches(
  packageDirectory: string,
  patchesDirectory: string,
  patches: readonly PatchDigest[],
  lockPath: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal と関数を持つ
  options: Readonly<FetchThemeOptions>,
): Promise<void> {
  if (patches.length === 0) return
  const manifestPath = resolveDependency('patch-package/package.json', import.meta.url)
  /* c8 ignore start -- 本体の依存に patch-package を同梱しているため、テストでは再現できない防御網 */
  if (manifestPath === undefined) {
    throw new ThemeFetchError('cannot apply the theme patches because patch-package cannot be resolved from the core dependencies', 'install')
  }
  /* c8 ignore stop */
  const result = await applyPatches({
    root: packageDirectory,
    patchesDirectory,
    patches,
    patchPackageEntry: path.join(path.dirname(manifestPath), 'index.js'),
    lockPath,
    runner: options.runner,
    signal: options.signal,
  })
  if (result !== undefined) assertStarted(result, 'patch-package', 'install')
  if (result !== undefined && result.exitCode !== 0) throw installFailure('failed to apply the theme patches', result)
}

/**
node_modules 直下のパッケージ名。`@scope` は配下の名前まで展開し、`.` 始まりの項目は数えない。
*/
async function packageNames(nodeModules: string): Promise<ReadonlySet<string>> {
  const names = new Set<string>()
  let entries: readonly string[]
  try {
    entries = await readdir(nodeModules)
  }
  catch {
    return names
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (!entry.startsWith('@')) {
      names.add(entry)
      continue
    }
    try {
      const children = await readdir(path.join(nodeModules, entry))
      for (const child of children) names.add(`${entry}/${child}`)
    }
    catch {
      // scope ディレクトリを読めなければ、その配下は数えない。
    }
  }
  return names
}

/**
テーマが dependencies に宣言した名前が本体の依存と重なるとき、peerDependencies への移動を促す。
推移依存は利用者が移せないため、宣言した名前だけを比べる。
peer にすれば、生成する vite.config.ts の resolve.dedupe で本体の 1 つに寄る。拒まないのは移行の途中を通すため。
*/
async function warnSameNameDependencies(
  declared: readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal と関数を持つ
  options: Readonly<FetchThemeOptions>,
): Promise<void> {
  if (options.warn === undefined) return
  const base = await packageNames(path.join(options.dependencyRoot, 'node_modules'))
  const overlapping = declared.filter(name => base.has(name)).toSorted((left, right) => compareStrings(left, right))
  if (overlapping.length === 0) return
  options.warn(
    `theme dependencies contain packages with the same names as the core: ${overlapping.join(', ')}`
    + ' (fix: move them to peerDependencies in the theme package.json so that only the core copy is used)',
  )
}

/**
一時ディレクトリを `<tag>/` へ置く。
rename が ENOTEMPTY か EEXIST なら、行き先に先客がいる。
先客が有効な置き場なら、自分の分を消して再利用として返す。
無効（途中で止まった、書き換えられた）なら、先客を消して置き直す。
*/
async function place(
  temporary: string,
  directory: string,
  storeSpec: Readonly<ThemeStoreSpec>,
  name: string,
): Promise<FetchedTheme> {
  try {
    await rename(temporary, directory)
  }
  catch (error) {
    if (!isRecord(error) || (error['code'] !== 'ENOTEMPTY' && error['code'] !== 'EEXIST')) throw error
    const existing = await reusableName(directory, storeSpec)
    if (existing !== undefined) {
      await rm(temporary, { recursive: true, force: true })
      return reusedTheme(directory, existing)
    }
    await rm(directory, { recursive: true, force: true })
    try {
      await rename(temporary, directory)
    }
    /* c8 ignore start -- 消した直後に別プロセスが置く競合で、テストでは再現できない */
    catch {
      // 消した直後に別プロセスが置いた。読めない置き場として止め、利用者の再実行に任せる。
      throw new ThemeFetchError(`cannot recreate the theme directory: ${directory} (fix: delete it and run again)`, 'unknown')
    }
    /* c8 ignore stop */
  }
  return { name, directory: path.join(directory, 'package'), reused: false }
}

/**
取得に失敗したあと、`<hash>/` に `.lock` しか残っていなければ、それらと空の `<hash>/` を消す。
`<tag>/` や他の一時ディレクトリが残っていれば、取得済みか取得中の別プロセスがいるため何もしない。
*/
async function removeEmptyHashDirectory(hashDirectory: string): Promise<void> {
  try {
    const entries = await readdir(hashDirectory)
    if (entries.some(entry => !entry.endsWith('.lock'))) return
    await Promise.all(entries.map(async entry => rm(path.join(hashDirectory, entry), { force: true })))
    // 空でなければ ENOTEMPTY で止まる。別プロセスが何かを置いた場合は消さない。
    await rmdir(hashDirectory)
  }
  catch {
    // 別プロセスが先に消した、または何かを置いた。
  }
}

/**
クラッシュで残った `.<tag>.tmp-*` を消す。
他プロセスが取得中のものを消さないよう、十分古いものだけを対象にする。
*/
async function removeStaleTemporaries(hashDirectory: string, tag: string): Promise<void> {
  const prefix = `.${tag}.tmp-`
  const entries = await readdir(hashDirectory)
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const target = path.join(hashDirectory, entry)
    try {
      const { mtimeMs } = await stat(target)
      if (Date.now() - mtimeMs > STALE_TEMPORARY_AGE_MS) {
        await rm(target, { recursive: true, force: true })
      }
    }
    catch {
      // 別プロセスが先に消した。
    }
  }
}
