// patch-package で patches/ のパッチを当てる処理の共用先。
//
// 使うのはテーマの置き場への取得（infra/slidev-theme/store.ts）。
// 「root の node_modules に入れた依存へ、patchesDirectory のパッチを当てる」形になる。
//
// 読むのは呼び出し元が渡す root と patchesDirectory の配下だけで、任意のパスは外から渡らない。
// そのため本ファイル全体で security/detect-non-literal-fs-filename を disable する。
/* eslint-disable security/detect-non-literal-fs-filename */

import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { isRecord } from '../../domain/_shared/json.js'
import { digestPatch, type PatchDigest, sortPatchDigests } from '../../domain/_shared/patch-digest.js'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import { withFlock } from './flock.js'
import { spawnPromise } from './process.js'

/**
パッチ適用の上限時間 (ms)。
*/
const PATCH_APPLY_TIMEOUT_MS = 600_000

/**
patch-package が exit 0 のまま適用件数を満たさなかったときに返す exit code。

patch-package 自身の exit code と取り違えないよう、この値を使う。
*/
export const PATCH_INCOMPLETE_EXIT_CODE = 65

/**
patches/ の走査結果。読み切れなかったときは error が入り digests は空になる。
*/
export interface PatchScan {
  readonly digests: readonly PatchDigest[]
  readonly error: string | undefined
}

/**
ENOENT（対象が無い）か。それ以外の I/O 例外は「パッチ無し」に丸めない。
*/
function isNotFound(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT'
}

/**
例外の表示文字列。
*/
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
patches/ 配下のパッチを patches/ 起点の相対パス順に (相対パス, 内容ハッシュ) で並べる。

取得済み判定の印に入れるため。
依存の宣言が変わらなくても、パッチの中身が変われば実体は別物になる。
そこで、パッチだけの更新でも再取得と再適用を起こす。

走査の規則は patch-package に合わせる。
`klaw-sync(patchesDir, { nodir: true })` で再帰的に拾い、`.patch` で絞る。
1 階層だけ見ると、サブディレクトリのパッチは適用されるのに印に入らない。
すると、そのパッチだけを更新した版が「取得済み」と判定される。

ENOENT だけを「パッチ無し」として扱い、他の例外は error として返す。
全例外を空に丸めると、権限やディスクの問題で読めなかったときに、
「当てるべきなのに当てない」まま印が置かれる。
*/
export function scanPatchDigests(patchesDirectory: string): PatchScan {
  const digests: PatchDigest[] = []
  const error = collectPatchDigests(patchesDirectory, '', digests)
  return error === undefined ? { digests: sortPatchDigests(digests), error: undefined } : { digests: [], error }
}

/**
patches/ 配下を再帰的に辿って digests へ積む。読めなければ理由を返して打ち切る。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 再帰の accumulator
function collectPatchDigests(root: string, relative: string, digests: PatchDigest[]): string | undefined {
  const directory = path.join(root, relative)
  let entries: readonly { readonly name: string, readonly isFile: () => boolean, readonly isDirectory: () => boolean }[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  }
  catch (error) {
    return isNotFound(error) ? undefined : `patches ディレクトリを読めません (${directory}): ${describeError(error)}`
  }

  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) {
      const nested = collectPatchDigests(root, child, digests)
      if (nested !== undefined) return nested
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.patch')) continue
    try {
      const contents = readFileSync(path.join(root, child))
      digests.push(digestPatch(child, contents))
    }
    catch (error) {
      if (isNotFound(error)) continue
      return `パッチファイルを読めません (${path.join(root, child)}): ${describeError(error)}`
    }
  }
  return undefined
}

export interface ApplyPatchesOptions {
  /**
  パッチを当てる対象の node_modules を持つディレクトリ。patch-package の cwd になる。
  */
  readonly root: string
  readonly patchesDirectory: string
  readonly patches: readonly PatchDigest[]
  /**
  patch-package の index.js。node で直に実行する。
  */
  readonly patchPackageEntry: string
  /**
  取得を直列化するロックのパス。決められなければ undefined（ロックなしで動く）。
  */
  readonly lockPath: string | undefined
  readonly nodeCommand?: string | undefined
  /**
  子プロセスを起こす港。既定は spawnPromise。テストが差し替える。
  */
  readonly runner?: typeof spawnPromise | undefined
  readonly signal?: AbortSignal | undefined
}

/**
root の node_modules へ patchesDirectory のパッチを当てる。当てるものが無ければ undefined を返して飛ばす。

起動する実体は、呼び出し元が渡す patch-package の index.js を node で直に実行する。
PATH 上の patch-package や npx の解決には依存させない。

patch-package は、`--patch-dir` が `/` 始まりだと throw する。
メッセージは `--patch-dir must be a relative path` で、dist/index.js の patchDir を調べる処理が出す。
そのため絶対パスは渡せない。
パッチの置き場は root の外にあり得る。
そこで cwd を root にして、root からの相対パスを渡す。
patch-package は、cwd から package.json を遡って appPath を決める。

`--error-on-fail` を付ける。
付けないと patch-package はローカル実行で、「当たらなかった」を警告に留めて exit 0 で終える。
すると版上げでパッチが外れても、取得成功として通ってしまう。
ただし `--error-on-fail` が反応するのは、errors が非空のときだけ。
patch-dir が実体を指さなければ、patch-package は `No patch files found` を出して exit 0 で終える。
exit code だけでは 0 件適用を成功と取り違える。
そこで stdout の適用結果を、patches の件数と比べる。

パッチファイル名の版が install された版と違っても、内容が当たれば patch-package は warning 止まりで exit 0 を返す。
`--error-on-warn` は付けていない。
版ずれの検出は、呼び出し元のテストが担う。

同じパッチを当て直しても失敗しない。
パッチが 1 パッケージ 1 本の構成では、patch-package は逆当ての dry-run で適用済みを判定する。
2 回目以降は no-op で exit 0 を返す。

lockPath のロックで直列化する。
ロックは子プロセス単位で取り直すため、呼び出し元の install 段との間は覆わない。
*/
export async function applyPatches(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal 用
  options: Readonly<ApplyPatchesOptions>,
): Promise<SpawnResult | undefined> {
  if (options.patches.length === 0) return undefined

  // 子プロセスの `process.cwd()` は、symlink を解決した実体パスを返す。
  // patch-package はその cwd から appPath を決めて、`--patch-dir` を継ぎ足す。
  // 論理パスのまま相対化すると、パスの途中に symlink があったときに別の場所を指す。
  // 確認した例では、worktree の .pecot/work が base への symlink で、論理パス基準の相対が base 側の patches/ に当たった。
  // そこで両端を実体パスへ揃えてから相対化する。
  // 解決できないまま論理パスへ倒すと、root と patches の基準が食い違った相対パスを渡すことになる。
  // そのため失敗として返す。
  const resolvedRoot = realpathOrUndefined(options.root)
  const resolvedPatches = realpathOrUndefined(options.patchesDirectory)
  if (resolvedRoot === undefined || resolvedPatches === undefined) {
    return startFailure(
      `パッチ適用の基準パスを解決できません (${resolvedRoot === undefined ? options.root : options.patchesDirectory})`)
  }

  const locked = withFlock(options.lockPath, options.nodeCommand ?? process.execPath, [
    options.patchPackageEntry,
    '--patch-dir', path.relative(resolvedRoot, resolvedPatches),
    '--error-on-fail',
  ])
  const result = await (options.runner ?? spawnPromise)(locked.command, locked.commandArguments, {
    cwd: options.root,
    env: process.env,
    timeoutMs: PATCH_APPLY_TIMEOUT_MS,
    signal: options.signal,
  })
  if (result.exitCode !== 0) return result

  const shortfall = patchAppShortfall(result.stdout, options.patches.length)
  if (shortfall === undefined) return result
  return {
    ...result,
    exitCode: PATCH_INCOMPLETE_EXIT_CODE,
    stderr: result.stderr === '' ? shortfall : `${result.stderr}\n${shortfall}`,
  }
}

/**
patch-package の stdout から、適用件数が足りない理由を返す。足りていれば undefined。

適用 1 件につき、`<pkg>@<version> ✔` を 1 行出す（dist/applyPatches.js の logPatchApplication）。
patch-dir が実体を指さないときは、`No patch files found` だけを出して exit 0 で終える。
*/
function patchAppShortfall(stdout: string, expected: number): string | undefined {
  if (stdout.includes('No patch files found')) {
    return `patch-package がパッチを 1 件も見つけませんでした (期待 ${String(expected)} 件)。--patch-dir の指す先が違います。`
  }
  const applied = (stdout.match(/✔/gu) ?? []).length
  return applied >= expected ? undefined : `patch-package の適用が ${String(applied)} 件で、期待の ${String(expected)} 件に足りません。`
}

/**
起動する前に諦めた失敗。SpawnResult は起動なしを exitCode: null で表す。
*/
function startFailure(reason: string): SpawnResult {
  return {
    // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
    exitCode: null,
    // eslint-disable-next-line unicorn/no-null -- 同上
    signal: null,
    stdout: '',
    stderr: reason,
    timedOut: false,
  }
}

/**
symlink を解決した実体パス。解決できなければ undefined。
*/
function realpathOrUndefined(target: string): string | undefined {
  try {
    return realpathSync(target)
  }
  catch {
    return undefined
  }
}
