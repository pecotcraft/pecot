/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が渡すリポジトリルート配下 */
// 変更した nx プロジェクトから PR タイトルの scope を算出する。
//
// 割り当ては `.githooks/pre-push/check-version-plan-required.sh` と同じ規則。
// nx の project graph → git diff → project root との最長一致、の順で求める。
// 判定できない場合は例外ではなく undefined を返し、呼び出し側が警告して割り当てを飛ばす（フェイルオープン）。

import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { isJsonObject, jsonField, tryParseJsonText } from '../domain/json.js'
import { compareStrings, pythonRepr } from '../domain/python-format.js'
import { GitCommandError, runGit } from './git.js'
import { isFileNotFound } from './os-error.js'
import { TMP_DIR } from './paths.js'
import { readTextFile } from './text-file.js'

/**
nx graph の実行上限（秒）
*/
export const NX_GRAPH_TIMEOUT_SECONDS = 120

/**
どの nx プロジェクトにも属さないファイルを表す scope
*/
export const REPOSITORY_SCOPE = 'repo'

// nx 固定のリリース用メタデータ。scope の算出から除外する
const VERSION_PLANS_PREFIX = '.nx/version-plans/'

// `type(scope): ...` の scope 部分。破壊的変更の印が付く形も受ける
const TITLE_SCOPE_PATTERN = /^[A-Za-z]+\(([^()]*)\)!?:/u

function isExecutableFile(target: string): boolean {
  try {
    if (statSync(target).isDirectory()) return false
    accessSync(target, constants.X_OK)
    return true
  }
  catch {
    // stat・access が投げるのはシステムエラーだけ。Python の os.access と同じく、使えないものは偽にする
    return false
  }
}

// PATH 上の実行ファイル（shutil.which と同じ。PATH の空の要素は、カレントディレクトリとして探す）
function whichExecutable(name: string): string | undefined {
  const searchPath = process.env['PATH'] ?? '/bin:/usr/bin'
  return searchPath.split(path.delimiter).map(directory => path.join(directory, name)).find(candidate => isExecutableFile(candidate))
}

/**
nx 実行ファイルを返す（`<toplevel>/node_modules/.bin/nx` → PATH 上の `nx`）。
`npx --no-install` は未導入時に registry へ問い合わせ、symlink 経由では別 worktree の nx を拾うため使わない
*/
export function resolveNx(toplevel: string): string | undefined {
  const local = path.join(toplevel, 'node_modules', '.bin', 'nx')
  return isExecutableFile(local) ? local : whichExecutable('nx')
}

function rootsFromGraph(text: string): ReadonlyMap<string, string> | undefined {
  const graph = tryParseJsonText(text)
  const roots = new Map<string, string>()
  const nodes = jsonField(jsonField(graph, 'graph'), 'nodes')
  if (!isJsonObject(nodes)) return undefined
  for (const [name, node] of Object.entries(nodes)) {
    const root = jsonField(jsonField(node, 'data'), 'root')
    // root は文字列のはず。他の型も Python の str() と同じ文字列にする
    if (root === undefined) return undefined
    roots.set(name, (typeof root === 'string' ? root : pythonRepr(root)).replace(/\/+$/u, '') || '.')
  }
  return roots
}

export interface NxGraphOptions {
  /**
  nx graph の実行上限（秒）。既定は NX_GRAPH_TIMEOUT_SECONDS
  */
  readonly timeoutSeconds?: number | undefined
}

/**
nx の project graph から `{プロジェクト名: root}` を返す。root の `.` はリポジトリ直下。
`nx graph --file=<一時 json>` に書かせて読む（stdout のパイプでは大きな JSON が途中で切れる）。
一時ファイルは `<toplevel>/.pecot/tmp` に作成し、終了時に削除する。
nx が無い・実行失敗・部分 graph・JSON の解析失敗なら undefined
*/
export function nxProjectRoots(toplevel: string, options: Readonly<NxGraphOptions> = {}): ReadonlyMap<string, string> | undefined {
  const nx = resolveNx(toplevel)
  if (nx === undefined) return undefined
  const temporaryBase = path.join(toplevel, TMP_DIR)
  let work: string
  try {
    mkdirSync(temporaryBase, { recursive: true })
    work = mkdtempSync(path.join(temporaryBase, 'nx-scope.'))
  }
  catch {
    return undefined
  }
  try {
    const graphFile = path.join(work, 'graph.json')
    const result = spawnSync(nx, ['graph', `--file=${graphFile}`], {
      cwd: toplevel,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: (options.timeoutSeconds ?? NX_GRAPH_TIMEOUT_SECONDS) * 1000,
      killSignal: 'SIGKILL',
      env: { ...process.env, NX_DAEMON: 'false' },
    })
    if (result.error !== undefined || result.status !== 0 || result.stderr.includes('Showing partial graph')) return undefined
    let text: string
    try {
      text = readTextFile(graphFile)
    }
    catch {
      return undefined
    }
    const roots = rootsFromGraph(text)
    return roots === undefined || roots.size === 0 ? undefined : roots
  }
  finally {
    try {
      rmSync(work, { recursive: true, force: true })
    }
    catch {
      // 後始末の失敗で、本文の結果や例外を上書きしない（Python の ignore_errors=True と同じ）
    }
  }
}

/**
`baseReference...head` の変更ファイル（リポジトリ root からの相対パス）を返す。
rename 検出だと移動元のプロジェクトが漏れ、`core.quotePath` だと非 ASCII パスが一致しなくなるため、`--no-renames` と NUL 区切りで取る。
baseReference / head が解決できない・git 失敗・git が無いなら undefined
*/
export function changedFiles(toplevel: string, baseReference: string, head: string): readonly string[] | undefined {
  try {
    for (const reference of [baseReference, head]) {
      runGit(['rev-parse', '--verify', '--quiet', [reference, '^{commit}'].join('')], { cwd: toplevel, check: true })
    }
    const result = runGit(['diff', '-z', '--name-only', '--no-renames', `${baseReference}...${head}`], { cwd: toplevel, check: true })
    return result.stdout.split('\0').filter(file => file !== '')
  }
  catch (error: unknown) {
    if (error instanceof GitCommandError || isFileNotFound(error)) return undefined
    throw error
  }
}

function isUnder(file: string, root: string): boolean {
  return root === '.' || file === root || file.startsWith(`${root}/`)
}

/**
変更ファイルから期待する scope（プロジェクト名の一覧）を返す。
- ファイルの持ち主は、project root との最長一致で決める（nx の `findProjectForPath` と同じ）。
- どのプロジェクトにも属さないファイルがあれば、末尾に `repo` を加える。
- `.nx/version-plans/` 配下は数えない。

結果は、プロジェクト名の昇順に、必要なら `repo` を足したもの。数えるファイルが無ければ空。
*/
export function expectedScope(files: readonly string[], roots: ReadonlyMap<string, string>): readonly string[] {
  const ordered = [...roots].toSorted((a, b) => b[1].length - a[1].length)
  const names = new Set<string>()
  let hasOutside = false
  const counted = files.filter(item => !item.startsWith(VERSION_PLANS_PREFIX))
  for (const file of counted) {
    const owner = ordered.find(([, root]) => isUnder(file, root))
    if (owner === undefined) hasOutside = true
    else names.add(owner[0])
  }
  const scope = [...names].toSorted(compareStrings)
  return hasOutside ? [...scope, REPOSITORY_SCOPE] : scope
}

/**
PR タイトルの `type(scope):` から scope を `,` で分けて返す。空白は削らない（規則は空白なしの `,` 区切り）。
scope が無い・空なら undefined
*/
export function parseTitleScope(title: string): readonly string[] | undefined {
  const scope = TITLE_SCOPE_PATTERN.exec(title)?.[1]
  return scope === undefined || scope === '' ? undefined : scope.split(',')
}
