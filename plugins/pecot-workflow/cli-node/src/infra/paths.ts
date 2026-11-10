/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が決める。ここは解決と予約だけ */
// pecot リポジトリ基準のパス解決。`.pecot/` 配下のパス定義の唯一の置き場。
// projectRoot() でプロジェクトルートを解決し、一時ファイルの出力先を固定する。

import { closeSync, existsSync, mkdirSync, openSync, realpathSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { PecotError, ProjectRootNotFoundError } from '../domain/errors.js'
import { gitToplevel } from './git.js'
import { isFileNotFound, hasErrorCode } from './os-error.js'

// プロジェクトルート基準の相対パス
export const PECOT_DIR = '.pecot'
// フック状態の保存先
export const STATE_DIR = `${PECOT_DIR}/state`
// 人・エージェントの作業ファイル置き場（タスク ID = Issue 番号単位）
export const WORK_DIR = `${PECOT_DIR}/work`
// 設定ファイルの置き場
export const CONFIG_DIR = `${PECOT_DIR}/config`
// CLI / hooks 専用の一時ファイル置き場
export const TMP_DIR = `${PECOT_DIR}/tmp`
// CLI が生成する一時ファイルの出力先
export const OUTPUT_DIR = `${TMP_DIR}/output`

// .pecot/ 配下の生成物を git 管理外にする ignore（hook と pecot worktree が生成）
export const PECOT_GITIGNORE_FILENAME = `${PECOT_DIR}/.gitignore`

// ワークツリー設定（symlink / setup_command）
export const WORKTREE_CONFIG_FILENAME = `${CONFIG_DIR}/worktree-config.json`
// ワークツリー作成時のコピー除外パターン（gitignore 形式）
export const WORKTREE_IGNORE_FILENAME = `${CONFIG_DIR}/.worktreeignore`
// フック設定
export const HOOKS_CONFIG_FILENAME = `${CONFIG_DIR}/hooks-config.json`
// アクティブなプロジェクト設定のポインタ
export const ACTIVE_PROJECT_FILENAME = `${CONFIG_DIR}/projects/.active`

/**
候補名を使い切っても出力パスを予約できなかった
*/
export class OutputPathReservationError extends PecotError {}

/**
パス文字列を Python の Path と同じ形にする（空のセグメントと `.` を落とし、末尾のスラッシュを落とす）
*/
export function normalizePath(text: string): string {
  const segments = text.split('/').filter(segment => segment !== '' && segment !== '.')
  return `${text.startsWith('/') ? '/' : ''}${segments.join('/')}` || '.'
}

/**
シンボリックリンクを解決した絶対パス。存在しない部分は、存在する最も深い親を解決して字句どおりにつなぐ（Python の Path.resolve()）
*/
export function resolveRealPath(target: string): string {
  const absolute = path.resolve(target)
  try {
    return realpathSync(absolute)
  }
  catch (error: unknown) {
    const parent = path.dirname(absolute)
    if (parent !== absolute && isFileNotFound(error)) return path.join(resolveRealPath(parent), path.basename(absolute))
    throw error
  }
}

/**
cwd がセッションの worktree の .pecot/work の実体配下なら、その worktree を返す。
セッション開始時の SessionStart hook が PECOT_SESSION_PROJECT_DIR に書いた値を起点にする。git は呼ばない。
hooks の project-root.sh と同じ判定を使う。cwd の文字列が `.pecot/work` で終わるか `.pecot/work/` を含み、実体が起点の .pecot/work の実体配下にある。
かつ途中に `.git` を持つディレクトリ（入れ子の git リポ）が無いときだけ対象にする
*/
function sessionWorkOwner(cwd: string): string | undefined {
  const sessionDirectory = process.env['PECOT_SESSION_PROJECT_DIR']
  if (sessionDirectory === undefined || sessionDirectory === '') return undefined
  // 安価な文字列の判定を、realpath の解決より先に行う
  if (!(cwd.endsWith(`/${WORK_DIR}`) || cwd.includes(`/${WORK_DIR}/`))) return undefined
  let workReal: string
  let cwdReal: string
  try {
    workReal = resolveRealPath(path.join(sessionDirectory, WORK_DIR))
    cwdReal = resolveRealPath(cwd)
  }
  catch (error: unknown) {
    if (hasErrorCode(error)) return undefined
    throw error
  }
  if (cwdReal !== workReal && !cwdReal.startsWith(`${workReal}/`)) return undefined
  for (let directory = cwdReal; ; directory = path.dirname(directory)) {
    if (directory === workReal) break
    if (existsSync(path.join(directory, '.git'))) return undefined
    if (path.dirname(directory) === directory) break
  }
  return resolveRealPath(sessionDirectory)
}

export interface ProjectRootOptions {
  /**
  起点のディレクトリ。省略すると呼び出し元の作業ディレクトリ
  */
  readonly cwd?: string | undefined
}

function currentDirectory(options: Readonly<ProjectRootOptions>): string | undefined {
  try {
    return options.cwd ?? process.cwd()
  }
  catch (error: unknown) {
    // 作業ディレクトリが消えているとき
    if (hasErrorCode(error)) return undefined
    throw error
  }
}

/**
プロジェクトルートを取得する。
1. CLAUDE_PROJECT_DIR があれば使う（テスト上書き用）。
2. cwd が PECOT_SESSION_PROJECT_DIR の .pecot/work 配下（入れ子の git リポを除く）なら、その実体パス。
   worktree の .pecot/work は base への symlink で、そこでは git toplevel が base になる。
3. なければ git rev-parse --show-toplevel で解決する（GIT_* を除いて実行する）。

どれも得られなければ ProjectRootNotFoundError
*/
export function projectRoot(options: Readonly<ProjectRootOptions> = {}): string {
  const fromEnvironment = process.env['CLAUDE_PROJECT_DIR']
  if (fromEnvironment !== undefined && fromEnvironment !== '') return normalizePath(fromEnvironment)

  const cwd = currentDirectory(options)
  if (cwd !== undefined) {
    const sessionRoot = sessionWorkOwner(cwd)
    if (sessionRoot !== undefined) return sessionRoot
  }

  // git push 等のフック内では GIT_DIR 等が設定され、作業ディレクトリの代わりに参照される。
  // そのため GIT_* を除いて作業ディレクトリ基準で解決する
  const toplevel = gitToplevel({ cwd, stripGitEnvironment: true })
  if (toplevel !== undefined) return toplevel

  throw new ProjectRootNotFoundError('project root not found: run inside a git repository or set the CLAUDE_PROJECT_DIR environment variable')
}

/**
出力ディレクトリ（`{プロジェクトルート}/.pecot/tmp/output`）
*/
export function outputDirectory(options: Readonly<ProjectRootOptions> = {}): string {
  return path.join(projectRoot(options), OUTPUT_DIR)
}

export interface ReserveOptions {
  /**
  試行する候補名の数。既定は 60
  */
  readonly maxAttempts?: number | undefined
  /**
  現在時刻。省略すると new Date()（テストで固定するために差し替える）
  */
  readonly now?: (() => Date) | undefined
}

function formatTimestamp(milliseconds: number): string {
  const date = new Date(milliseconds)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

/**
outputDirectory 配下に空ファイルを排他作成して返す。
nameFor には `YYYYMMDD-HHMMSS` 形式の文字列を渡し、返ってきた名前で作る。既に同名があれば 1 秒進めた候補で再試行する。
時刻は生成物の一意性と生成順の目安であり、実時刻の記録ではない。衝突した分だけ実時刻より先に進む。
候補をすべて使い切ったら OutputPathReservationError
*/
export function reserveOutputPath(output: string, nameFor: (timestamp: string) => string, options: Readonly<ReserveOptions> = {}): string {
  const { maxAttempts = 60, now = () => new Date() } = options
  mkdirSync(output, { recursive: true })
  const baseMilliseconds = now().getTime()
  let candidate = output
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const timestamp = formatTimestamp(baseMilliseconds + offset * 1000)
    candidate = path.join(output, nameFor(timestamp))
    try {
      const descriptor = openSync(candidate, 'wx')
      closeSync(descriptor)
    }
    catch (error: unknown) {
      if (hasErrorCode(error) && error.code === 'EEXIST') continue
      throw error
    }
    return candidate
  }
  throw new OutputPathReservationError(`could not reserve an output path: all ${String(maxAttempts)} candidate names are in use (last candidate: ${candidate})`)
}

/**
reserveOutputPath で予約したパスを本文に渡し、本文が例外を投げたら予約を撤去する。
予約から書き込みまでの間で異常終了しても、0 バイトのファイルを出力先へ残さない。正常に終われば何もしない
*/
export function withReservedOutputPath<T>(output: string, nameFor: (timestamp: string) => string, body: (reserved: string) => T, options: Readonly<ReserveOptions> = {}): T {
  const reserved = reserveOutputPath(output, nameFor, options)
  try {
    return body(reserved)
  }
  catch (error: unknown) {
    removeQuietly(reserved)
    throw error
  }
}

/**
withReservedOutputPath の、本文が非同期のもの
*/
export async function withReservedOutputPathAsync<T>(output: string, nameFor: (timestamp: string) => string, body: (reserved: string) => Promise<T>, options: Readonly<ReserveOptions> = {}): Promise<T> {
  const reserved = reserveOutputPath(output, nameFor, options)
  try {
    return await body(reserved)
  }
  catch (error: unknown) {
    removeQuietly(reserved)
    throw error
  }
}

// 後始末の失敗は握る。本文が投げた元の例外を隠さないため
function removeQuietly(target: string): void {
  try {
    unlinkSync(target)
  }
  catch {
    // 撤去できなくても、元の例外を優先する
  }
}

function normalizedDataDirectory(raw: string | undefined): string | undefined {
  const value = raw?.replace(/[\r\n]+$/u, '')
  return value === undefined || value === '' || value.startsWith('${') || !value.startsWith('/') ? undefined : value
}

const DATA_DIRECTORY_PROJECT = 'pecot-workflow'

/**
データ置き場。作らずに値を返す。有効な HOME と有効な XDG_DATA_HOME がどちらも無いときは undefined。

bin/_lib.sh の plugin_data_dir_resolve と同じ解決順で、同じ入力なら同じ結果になる。
この対応は infra/tests/paths.test.ts が固定する。
順序は CLAUDE_PLUGIN_DATA、PLUGIN_DATA、XDG_DATA_HOME、HOME。
有効な値は、空でない絶対パスだけ。
先頭が変数展開の書式（ドル記号と開き波括弧）の値は無効とする。
末尾の改行と CR は落とす。
XDG_DATA_HOME の下は `pecot/pecot-workflow`、HOME の下は `.local/share/pecot/pecot-workflow`
*/
export function dataDirectory(): string | undefined {
  const client = normalizedDataDirectory(process.env['CLAUDE_PLUGIN_DATA']) ?? normalizedDataDirectory(process.env['PLUGIN_DATA'])
  if (client !== undefined) return client
  const xdg = normalizedDataDirectory(process.env['XDG_DATA_HOME'])
  if (xdg !== undefined) return `${xdg}/pecot/${DATA_DIRECTORY_PROJECT}`
  const home = normalizedDataDirectory(process.env['HOME'])
  return home === undefined ? undefined : `${home}/.local/share/pecot/${DATA_DIRECTORY_PROJECT}`
}
