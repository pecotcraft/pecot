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
import type { JsonValue } from '../domain/python-format.js'
import { compareStrings, isJsonArray, pythonRepr } from '../domain/python-format.js'
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

// PR タイトルの scope を宣言する nx の tag の接頭辞
const SCOPE_TAG_PREFIX = 'scope:'

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

// tag `scope:<名前>` の値。無い・空ならプロジェクト名
function scopeOf(name: string, tags: JsonValue | undefined): string {
  if (!isJsonArray(tags)) return name
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.startsWith(SCOPE_TAG_PREFIX) && tag.length > SCOPE_TAG_PREFIX.length) return tag.slice(SCOPE_TAG_PREFIX.length)
  }
  return name
}

function projectsFromGraph(text: string): ReadonlyMap<string, NxProject> | undefined {
  const graph = tryParseJsonText(text)
  const projects = new Map<string, NxProject>()
  const nodes = jsonField(jsonField(graph, 'graph'), 'nodes')
  if (!isJsonObject(nodes)) return undefined
  for (const [name, node] of Object.entries(nodes)) {
    const data = jsonField(node, 'data')
    const root = jsonField(data, 'root')
    // root は文字列のはず。他の型も Python の str() と同じ文字列にする
    if (root === undefined) return undefined
    projects.set(name, {
      root: (typeof root === 'string' ? root : pythonRepr(root)).replace(/\/+$/u, '') || '.',
      scope: scopeOf(name, jsonField(data, 'tags')),
    })
  }
  return projects
}

export interface NxProject {
  /**
  リポジトリ直下からの root（`.` はリポジトリ直下）
  */
  readonly root: string
  /**
  PR タイトルの scope。tag `scope:<名前>` の値、無ければプロジェクト名
  */
  readonly scope: string
}

export interface NxGraphOptions {
  /**
  nx graph の実行上限（秒）。既定は NX_GRAPH_TIMEOUT_SECONDS
  */
  readonly timeoutSeconds?: number | undefined
}

/**
nx の project graph から `{プロジェクト名: NxProject}` を返す。stdout では大きな JSON が切れるため、一時ファイルに書かせて読む。
nx が無い・実行失敗・部分 graph・JSON の解析失敗なら undefined
*/
export function nxProjects(toplevel: string, options: Readonly<NxGraphOptions> = {}): ReadonlyMap<string, NxProject> | undefined {
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
      // interface-env: none
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
    const projects = projectsFromGraph(text)
    return projects === undefined || projects.size === 0 ? undefined : projects
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
`baseReference...head` の変更ファイル（リポジトリ root からの相対パス）を返す。baseReference は、ブランチのほか、コミットの SHA（base の記録の位置）も受ける。
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
変更ファイルから期待する scope を、昇順で返す。持ち主は project root との最長一致で決め、どれにも属さないファイルがあれば末尾に `repo` を足す。
`.nx/version-plans/` 配下は数えない。
*/
export function expectedScope(files: readonly string[], projects: ReadonlyMap<string, NxProject>): readonly string[] {
  const ordered = [...projects].map(([, project]) => project).toSorted((a, b) => b.root.length - a.root.length)
  const scopes = new Set<string>()
  let hasOutside = false
  const counted = files.filter(item => !item.startsWith(VERSION_PLANS_PREFIX))
  for (const file of counted) {
    const owner = ordered.find(project => isUnder(file, project.root))
    if (owner === undefined) hasOutside = true
    else scopes.add(owner.scope)
  }
  const scope = [...scopes].filter(item => item !== REPOSITORY_SCOPE).toSorted(compareStrings)
  return hasOutside || scopes.has(REPOSITORY_SCOPE) ? [...scope, REPOSITORY_SCOPE] : scope
}

/**
PR タイトルの `type(scope):` から scope を `,` で分けて返す。空白は削らない（規則は空白なしの `,` 区切り）。
scope が無い・空なら undefined
*/
export function parseTitleScope(title: string): readonly string[] | undefined {
  const scope = TITLE_SCOPE_PATTERN.exec(title)?.[1]
  return scope === undefined || scope === '' ? undefined : scope.split(',')
}
